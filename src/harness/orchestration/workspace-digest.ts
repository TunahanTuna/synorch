import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  foldPathCase,
  isCaseInsensitivePlatform,
  normalizePathUnicode,
  sha256,
  workspaceDigest,
  type ContentIdentity,
  type Digest,
  type WorkspaceDigestReader,
} from "../contracts/index.ts";
import { gitHashObjects, gitIgnoredSubset, gitTopLevel, runGit, type GitRunner } from "./git.ts";
import { normalizeWorkspacePath } from "./paths.ts";

/**
 * The single workspace digest and the cross-tree content identity (ADR-19).
 *
 * - `createWorkspaceDigestReader(root)`: `workspaceDigest` of a file's raw bytes in one root. No
 *   decoding, EOL folding or filter, so two byte strings that differ anywhere (cp1254 `ş`/`ğ`,
 *   `0xFF`/`0xFE`, CRLF/LF) never share a digest. It is what packet sources, `read_file` and the
 *   write preconditions agree on.
 * - `contentIdentity(root, path)`: for a file git tracks or would track (not ignored), the blob id
 *   `git hash-object` computes through that tree's clean filter and EOL conversion, so an unchanged
 *   checkout equals the `HEAD` blob in every tree; otherwise the workspace digest. Used only to
 *   compare one path across two trees (integrate), never shown to a model.
 *
 * Both resolve a name the way the file system stores it: a path given in NFC finds a file created
 * with an NFD name (macOS tools, unzip) when no NFC-named file exists.
 */

export interface WorkspaceDigestOptions {
  readonly platform?: NodeJS.Platform;
}

export interface ContentIdentityOptions extends WorkspaceDigestOptions {
  readonly git?: GitRunner;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function containedIn(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * The on-disk spelling of `relative` under `root`: each segment is used as given when it exists,
 * otherwise the single directory entry equal to it in NFC (then, on a case-insensitive platform,
 * under `foldPathCase`). Undefined when a segment is missing or ambiguous. POSIX separators.
 */
export async function resolveOnDiskPath(root: string, relative: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const normalized = normalizeWorkspacePath(relative);
  if (normalized === undefined || normalized === ".") return undefined;
  const resolved: string[] = [];
  for (const segment of relative.replaceAll("\\", "/").split("/").filter((part) => part.length > 0 && part !== ".")) {
    const directory = path.join(root, ...resolved);
    try {
      await lstat(path.join(directory, segment));
      resolved.push(segment);
      continue;
    } catch (error: unknown) {
      if (!isMissing(error)) return undefined;
    }
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return undefined;
    }
    const wanted = normalizePathUnicode(segment);
    let matches = names.filter((name) => normalizePathUnicode(name) === wanted);
    if (matches.length === 0 && isCaseInsensitivePlatform(platform)) {
      const folded = foldPathCase(segment);
      matches = names.filter((name) => foldPathCase(name) === folded);
    }
    if (matches.length !== 1) return undefined;
    resolved.push(matches[0] ?? segment);
  }
  return resolved.length === 0 ? undefined : resolved.join("/");
}

/** Raw bytes of a regular file under `root` (links followed only while they stay inside `root`). */
async function readInside(root: string, relative: string, platform: NodeJS.Platform): Promise<Buffer | undefined> {
  const onDisk = await resolveOnDiskPath(root, relative, platform);
  if (onDisk === undefined) return undefined;
  const file = path.join(root, ...onDisk.split("/"));
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!containedIn(canonicalRoot, canonicalFile)) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}

/** `WorkspaceDigestReader` over one root: `workspaceDigest` of the raw bytes, undefined when absent. */
export function createWorkspaceDigestReader(root: string, options: WorkspaceDigestOptions = {}): WorkspaceDigestReader {
  const platform = options.platform ?? process.platform;
  return async (relativePath, signal) => {
    signal?.throwIfAborted();
    const bytes = await readInside(root, relativePath, platform);
    return bytes === undefined ? undefined : workspaceDigest(bytes);
  };
}

type Present = { readonly onDisk: string; readonly kind: "file"; readonly digest: Digest } | { readonly onDisk: string; readonly kind: "link" | "other"; readonly digest: Digest };

async function presentEntry(root: string, relative: string, platform: NodeJS.Platform): Promise<Present | undefined> {
  const onDisk = await resolveOnDiskPath(root, relative, platform);
  if (onDisk === undefined) return undefined;
  const file = path.join(root, ...onDisk.split("/"));
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return { onDisk, kind: "link", digest: sha256(`link:${await readlink(file).catch(() => "")}`) };
    if (info.isDirectory()) return undefined;
    if (!info.isFile()) return { onDisk, kind: "other", digest: sha256("other") };
    return { onDisk, kind: "file", digest: workspaceDigest(await readFile(file)) };
  } catch {
    return undefined;
  }
}

async function isGitRoot(git: GitRunner, root: string, platform: NodeJS.Platform): Promise<boolean> {
  const top = await gitTopLevel(git, root);
  if (top === undefined) return false;
  try {
    const [a, b] = await Promise.all([realpath(top), realpath(root)]);
    return isCaseInsensitivePlatform(platform) ? foldPathCase(a) === foldPathCase(b) : a === b;
  } catch {
    return false;
  }
}

/**
 * `ContentIdentity` of several paths in one tree; a path that does not exist maps to undefined. A
 * link or special file gets a `workspace` identity no blob id can equal.
 */
export async function contentIdentities(
  root: string,
  relatives: readonly string[],
  signal: AbortSignal,
  options: ContentIdentityOptions = {},
): Promise<Map<string, ContentIdentity | undefined>> {
  const git = options.git ?? runGit;
  const platform = options.platform ?? process.platform;
  const result = new Map<string, ContentIdentity | undefined>();
  const present = new Map<string, Present>();
  for (const relative of relatives) {
    signal.throwIfAborted();
    const entry = await presentEntry(root, relative, platform);
    if (entry === undefined) result.set(relative, undefined);
    else present.set(relative, entry);
  }
  const files = [...present].filter(([, entry]) => entry.kind === "file");
  let hashed = new Map<string, string>();
  if (files.length > 0 && (await isGitRoot(git, root, platform))) {
    const onDisk = files.map(([, entry]) => entry.onDisk);
    const ignored = await gitIgnoredSubset(git, root, onDisk, signal);
    hashed = await gitHashObjects(git, root, onDisk.filter((candidate) => !ignored.has(candidate)), { signal });
  }
  for (const [relative, entry] of present) {
    const oid = entry.kind === "file" ? hashed.get(entry.onDisk) : undefined;
    result.set(relative, oid === undefined ? { scheme: "workspace", digest: entry.digest } : { scheme: "git-blob", oid });
  }
  return result;
}

/** `ContentIdentity` of one path in the tree at `root`; undefined when it does not exist. */
export async function contentIdentity(root: string, relativePath: string, signal: AbortSignal, options: ContentIdentityOptions = {}): Promise<ContentIdentity | undefined> {
  return (await contentIdentities(root, [relativePath], signal, options)).get(relativePath);
}
