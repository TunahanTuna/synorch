import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  DEPENDENCY_LINK_DIRECTORIES,
  foldPathCase,
  HarnessError,
  isCaseInsensitivePlatform,
  isReservedWritePattern,
  pathPatternsOverlap,
  sameContent,
  sha256,
  staticPrefix,
  workspaceDigest,
  type AttemptId,
  type BlobStore,
  type ContentIdentity,
  type Digest,
  type IsolatedWorkspace,
  type IsolationCreateOptions,
  type IsolationFallbackReason,
  type IsolationProvider,
  type ProjectId,
  type TaskContextPacket,
} from "../contracts/index.ts";
import {
  GitCommandError,
  gitAvailable,
  gitCheckIgnored,
  gitDirtyPaths,
  gitHashBytes,
  gitHashObjects,
  gitHead,
  gitIgnoredEntries,
  gitIgnoredSubset,
  gitShowFiltered,
  gitSmudgeBlob,
  gitSubmodulePaths,
  gitTopLevel,
  gitTrackedPaths,
  gitTreeEntries,
  runGit,
  type GitRunner,
  type GitTreeEntry,
} from "./git.ts";
import { findScopeViolations, isLiteralPattern, matchesAny, normalizeWorkspacePath } from "./paths.ts";
import { contentIdentities, createWorkspaceDigestReader, resolveOnDiskPath } from "./workspace-digest.ts";

/**
 * Per-attempt isolation (ADR-07, ADR-19).
 *
 * - `worktree`: a detached git worktree at `<worktrees>/<project-hash>/<attempt-hash>` on `HEAD`
 *   (short hashed names keep Windows paths short; git runs with `core.longpaths=true`). The main
 *   workspace is untouched until `integrate`. Dirty or untracked read inputs are overlaid from the
 *   main tree and ignored dependency directories (`DEPENDENCY_LINK_DIRECTORIES`) are linked in
 *   (junction on Windows); neither is ever integrated back. A retry of the same task reuses the
 *   worktree (`IsolationCreateOptions.reuse`): it is reset to its base instead of recreated. When
 *   creating the worktree fails, a non-high-risk task falls back to `scoped-dir` with a recorded
 *   reason, and nothing is left behind.
 * - `scoped-dir`: writes happen in place, limited by policy to `owned_paths`. A snapshot of the
 *   tree (ignored files included, but not ignored directories outside the owned paths; bounded by
 *   `SCOPED_SNAPSHOT_LIMITS`) is taken first and persisted under `<worktrees>/<project-hash>/
 *   <attempt-hash>.scoped`, so every change is seen (changed ⊆ owned), a failed attempt can be
 *   reverted, and crash recovery can revert a crashed attempt's partial writes
 *   (`pruneOrphanedAttempts`). Scoped-dir attempts of different tasks run one at a time.
 * - `shared-read-only`: explorers and reviewers; nothing may change.
 *
 * Every workspace can pin its changes as an artifact: a canonical JSON document of
 * `{path, before, after, content}` entries whose sha256 is the artifact digest a review binds to.
 * `before`/`after` are `workspaceDigest`s in the attempt's own workspace (ADR-19). Integrate
 * compares the main tree by `ContentIdentity` (filtered git blob id) and writes content in the main
 * tree's representation (smudge filter, EOL), so autocrlf, `.gitattributes eol`, clean/smudge
 * filters and Git LFS never produce a false conflict.
 *
 * Link safety (SEC-H4): integrate, seed and revert resolve every target segment by segment and
 * refuse any path that traverses a symbolic link or junction, resolves elsewhere or is a
 * multiply linked file; they never follow a link out of the workspace. Integrate also refuses a
 * `.gitignore` change that would expose an ignored link unless the link is owned and stays inside.
 * A worktree is always removed with its dependency links unlinked first and with Node's `rm`,
 * which never descends into a link (`git worktree remove` would empty a junction's target).
 */

export const ARTIFACT_FORMAT = "synorch.artifact/v1";
export const ARTIFACT_MEDIA_TYPE = "application/vnd.synorch.artifact+json";
export const SCOPED_BASELINE_FORMAT = "synorch.scoped-baseline/v1";
export const ATTEMPT_OWNER_FORMAT = "synorch.attempt-owner/v1";

/** Bounds of the scoped-dir snapshot. More entries than `maxEntries` refuses scoped-dir (fail closed). */
export const SCOPED_SNAPSHOT_LIMITS = {
  maxEntries: 200_000,
  /** Files up to this size are compared by content hash; larger ones by size and mtime. */
  hashFileBytes: 4 * 1024 * 1024,
  /** Content hashed while taking one snapshot; files beyond it are compared by size and mtime. */
  hashTotalBytes: 512 * 1024 * 1024,
  /** Pre-attempt content kept on disk for revert; changes to files beyond it are detected but reported unrestorable. */
  keepTotalBytes: 256 * 1024 * 1024,
} as const;

/** Length of the hashed project and attempt directory names under the worktrees root. */
export const WORKSPACE_NAME_LENGTH = 12;

const DEPENDENCY_NAMES: ReadonlySet<string> = new Set(DEPENDENCY_LINK_DIRECTORIES);

/**
 * Generated output directories (P0-A): dependency installs, build output and tool caches. Outside a
 * git root (where `git check-ignore` cannot answer) a scoped snapshot never walks them, so they never
 * enter an artifact, its digest, the changed ⊆ owned check, a review or an integration; inside a git
 * root the ignore rules decide instead (a tracked `build/` stays visible).
 */
export const GENERATED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ...DEPENDENCY_LINK_DIRECTORIES,
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".cache",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
]);

/** True when an owned pattern names something at or below `directory` (its literal prefix is inside it), not merely overlaps it (`test/**` does not own `test/node_modules`). */
function ownsInside(ownedPaths: readonly string[], directory: string, platform: NodeJS.Platform): boolean {
  return ownedPaths.some((pattern) => {
    const literal: string[] = [];
    for (const segment of pattern.split("/")) {
      if (/[*?[\]{}]/.test(segment)) break;
      literal.push(segment);
    }
    const prefix = literal.join("/");
    return prefix !== "" && isAtOrBelow(prefix, directory, platform);
  });
}

/** True when `relative` lies inside a generated directory (`GENERATED_DIRECTORY_NAMES`) that no owned path names. */
export function inGeneratedDirectory(relative: string, ownedPaths: readonly string[], platform: NodeJS.Platform): boolean {
  const segments = relative.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!GENERATED_DIRECTORY_NAMES.has(segments[index] ?? "")) continue;
    return !ownsInside(ownedPaths, segments.slice(0, index + 1).join("/"), platform);
  }
  return false;
}

export interface ArtifactChange {
  readonly path: string;
  readonly before: Digest | null;
  readonly after: Digest | null;
}

export interface ChangeSet {
  readonly artifactDigest: Digest;
  readonly artifactBytes: Uint8Array;
  readonly changes: readonly ArtifactChange[];
  readonly contents: ReadonlyMap<string, Buffer | null>;
  /** Changed paths that are links, special files, inside a submodule, ambiguous or not expressible as workspace paths; integrate refuses them. */
  readonly unsafe: readonly string[];
  /** Why an `unsafe` entry cannot be integrated, when more specific than "link or special file". */
  readonly unsafeReasons?: ReadonlyMap<string, string>;
  /** On-disk spelling of a changed path when it differs from its NFC workspace path (an NFD-created name). */
  readonly diskPaths?: ReadonlyMap<string, string>;
}

export interface OrchestratedWorkspace extends IsolatedWorkspace {
  readonly attemptId: AttemptId;
  readonly ownedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  changeSet(signal: AbortSignal): Promise<ChangeSet>;
  /** Restores the pre-attempt content of every changed path; returns the paths it restored. */
  revert(signal: AbortSignal): Promise<readonly string[]>;
}

export interface IsolationProviderDependencies {
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
  /** Parent of `.synorch`; defaults to the user's home directory. */
  readonly home?: string;
  /** Overrides `<home>/.synorch/worktrees` (the composition root passes `<SYNORCH_HOME>/worktrees`). */
  readonly worktreesRoot?: string;
  readonly git?: GitRunner;
  readonly blobs?: BlobStore;
  readonly platform?: NodeJS.Platform;
}

export interface OrchestrationIsolationProvider extends IsolationProvider {
  create(packet: TaskContextPacket, attemptId: AttemptId, signal: AbortSignal, options?: IsolationCreateOptions): Promise<OrchestratedWorkspace>;
  /** Writes a previously pinned artifact into a fresh workspace (a revise attempt continues from it). */
  seed(workspace: OrchestratedWorkspace, artifactBytes: Uint8Array, signal: AbortSignal): Promise<void>;
  worktreePath(attemptId: AttemptId): string;
}

interface ArtifactDocument {
  readonly format: typeof ARTIFACT_FORMAT;
  readonly mode: IsolatedWorkspace["mode"];
  readonly base_commit: string | null;
  readonly changes: readonly { readonly path: string; readonly before: string | null; readonly after: string | null; readonly content: string | null }[];
}

/** Who created an attempt workspace; recovery prunes it only when this process is gone. */
export interface AttemptOwner {
  readonly format: typeof ATTEMPT_OWNER_FORMAT;
  readonly attempt_id: string;
  readonly mode: "worktree" | "scoped-dir";
  readonly pid: number;
  readonly host: string;
  readonly workspace_root: string;
  readonly created_at: string;
  /** Dependency links inside the worktree, unlinked before the worktree is removed. */
  readonly dependency_links?: readonly string[];
}

function isolationError(code: "sandbox_insufficient" | "verification_failed" | "policy_denied" | "internal", message: string): HarnessError {
  return new HarnessError({ code, message: message.slice(0, 2000), workspace_effect: "none", retry_safe: code !== "policy_denied" });
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameFsPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return isCaseInsensitivePlatform(platform) ? foldPathCase(left) === foldPathCase(right) : left === right;
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Short, stable directory name for a project or attempt id (keeps worktree paths short on Windows). */
export function workspaceDirectoryName(id: string): string {
  return sha256(id).slice("sha256:".length, "sha256:".length + WORKSPACE_NAME_LENGTH);
}

/** `<worktreesRoot>/<project-hash>`: where one project's attempt workspaces live. */
export function projectWorkspacesDirectory(worktreesRoot: string, projectId: string): string {
  return path.join(worktreesRoot, workspaceDirectoryName(projectId));
}

function segmentsUnder(prefix: readonly string[], value: readonly string[], platform: NodeJS.Platform): boolean {
  if (prefix.length > value.length) return false;
  return prefix.every((segment, index) => sameFsPath(segment, value[index] ?? "", platform));
}

/** True when `candidate` is `ancestor` or below it (workspace-relative, platform path policy). */
function isAtOrBelow(candidate: string, ancestor: string, platform: NodeJS.Platform): boolean {
  return segmentsUnder(ancestor.split("/"), candidate.split("/"), platform);
}

// ---------------------------------------------------------------------------------------------
// Link-safe file access (SEC-H4)
// ---------------------------------------------------------------------------------------------

interface TargetOptions {
  /** Revert and recovery restore reserved paths (`.git/hooks`, `.synorch`) too; integrate and seed never write them. */
  readonly allowReserved?: boolean;
  /** Removal may unlink a link itself (never what it points to). */
  readonly allowFinalLink?: boolean;
}

function workspaceRelative(relative: string, allowReserved: boolean): string {
  const normalized = normalizeWorkspacePath(relative);
  if (normalized === undefined || normalized === "." || (!allowReserved && isReservedWritePattern(normalized))) {
    throw isolationError("policy_denied", `refusing to touch ${relative}`);
  }
  return normalized;
}

/**
 * The absolute path for writing `relative` under `root`. Each existing segment is checked with
 * `lstat` and `realpath`: a symbolic link, junction or other reparse point, a non-directory
 * parent, a directory target or a multiply linked file is refused, so the write can never land
 * outside `root`. The on-disk spelling is kept (an NFD-created name is written as it is on disk).
 */
export async function resolveLinkSafeTarget(root: string, relative: string, platform: NodeJS.Platform, options: TargetOptions = {}): Promise<string> {
  const normalized = workspaceRelative(relative, options.allowReserved === true);
  const canonicalRoot = await realpath(root);
  const spelled = relative.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0 && segment !== ".");
  // Keep the caller's spelling only when it differs from the workspace path by Unicode form alone.
  const segments = spelled.join("/").normalize("NFC") === normalized ? spelled : normalized.split("/");
  let current = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error: unknown) {
      if (isMissingError(error)) break;
      throw error;
    }
    const last = index === segments.length - 1;
    const at = segments.slice(0, index + 1).join("/");
    if (info.isSymbolicLink()) {
      if (last && options.allowFinalLink === true) break;
      throw isolationError("policy_denied", `refusing to write ${normalized}: ${at} is a symbolic link or junction`);
    }
    const real = await realpath(current);
    if (!sameFsPath(real, current, platform) || !contains(canonicalRoot, real)) {
      throw isolationError("policy_denied", `refusing to write ${normalized}: ${at} resolves elsewhere (link or reparse point)`);
    }
    if (!last && !info.isDirectory()) throw isolationError("policy_denied", `refusing to write ${normalized}: ${at} is not a directory`);
    if (last && info.isDirectory()) throw isolationError("policy_denied", `refusing to write ${normalized}: it is a directory`);
    if (last && info.isFile() && info.nlink > 1) throw isolationError("policy_denied", `refusing to write ${normalized}: it has more than one hard link`);
  }
  return path.join(canonicalRoot, ...segments);
}

async function writeSafe(root: string, relative: string, bytes: Buffer, platform: NodeJS.Platform, options: TargetOptions = {}): Promise<void> {
  const first = await resolveLinkSafeTarget(root, relative, platform, options);
  await mkdir(path.dirname(first), { recursive: true });
  // Re-resolve after creating parents: a link planted meanwhile is refused before any byte is written.
  const target = await resolveLinkSafeTarget(root, relative, platform, options);
  const temporary = `${target}.synorch-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await renameWithRetry(temporary, target);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Windows: a rename over a file another process briefly holds open fails transiently; retry with a bounded backoff. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (attempt >= 8 || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}

async function removeSafe(root: string, relative: string, platform: NodeJS.Platform, options: TargetOptions = {}): Promise<void> {
  const target = await resolveLinkSafeTarget(root, relative, platform, { ...options, allowFinalLink: true });
  try {
    await unlink(target);
  } catch (error: unknown) {
    if (!isMissingError(error)) throw error;
  }
}

/** Removes a symbolic link or junction itself, never what it points to; anything else is left alone. */
async function unlinkLink(file: string): Promise<void> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return;
  }
  if (!info.isSymbolicLink()) return;
  try {
    await unlink(file);
  } catch {
    // A directory junction on some Windows versions only yields to rmdir, which removes the reparse point, not the target.
    await rmdir(file).catch(() => undefined);
  }
}

type Observed =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly bytes: Buffer }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "other" };

/** What `relative` is under `root`, without following any link (a link on the way is reported as a link). */
async function observe(root: string, relative: string): Promise<Observed> {
  const segments = relative.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return { kind: "absent" };
    }
    const last = index === segments.length - 1;
    if (info.isSymbolicLink()) {
      return { kind: "link", target: last ? await readlink(current).catch(() => "") : `through ${segments.slice(0, index + 1).join("/")}` };
    }
    if (!last) {
      if (!info.isDirectory()) return { kind: "absent" };
      continue;
    }
    if (info.isFile()) return { kind: "file", bytes: await readFile(current) };
    return info.isDirectory() ? { kind: "absent" } : { kind: "other" };
  }
  return { kind: "absent" };
}

function observedDigest(observed: Observed): Digest | null {
  switch (observed.kind) {
    case "absent":
      return null;
    case "file":
      return workspaceDigest(observed.bytes);
    case "link":
      return sha256(`link:${observed.target}`);
    case "other":
      return sha256("other");
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await renameWithRetry(temporary, file);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function samePath(left: string, right: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    return sameFsPath(await realpath(left), await realpath(right), platform);
  } catch {
    return false;
  }
}

function encodeArtifact(
  mode: IsolatedWorkspace["mode"],
  baseCommit: string | undefined,
  changes: readonly ArtifactChange[],
  contents: ReadonlyMap<string, Buffer | null>,
): Uint8Array {
  const document: ArtifactDocument = {
    format: ARTIFACT_FORMAT,
    mode,
    base_commit: baseCommit ?? null,
    changes: changes.map((change) => {
      const content = contents.get(change.path);
      return {
        path: change.path,
        before: change.before,
        after: change.after,
        content: content === null || content === undefined ? null : content.toString("base64"),
      };
    }),
  };
  return Buffer.from(canonicalJson(document), "utf8");
}

export function decodeArtifact(bytes: Uint8Array): ArtifactDocument {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<ArtifactDocument>;
  if (parsed.format !== ARTIFACT_FORMAT || !Array.isArray(parsed.changes)) {
    throw isolationError("verification_failed", "not a synorch artifact");
  }
  return parsed as ArtifactDocument;
}

/** Pre-attempt state of an attempt workspace. Paths are as named on disk. */
interface Baseline {
  beforeDigest(relative: string): Promise<Digest | null>;
  /** Pre-attempt bytes; `null` when the path did not exist, `undefined` when no copy is available. */
  beforeContent(relative: string): Promise<Buffer | null | undefined>;
  candidates(signal: AbortSignal): Promise<readonly string[]>;
  /** Candidates that can never be integrated, with the reason (for example: inside a submodule). */
  flagged?(): ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Tree walk and scoped-dir snapshot (SEC-M1, SEC-M3, ADR-19 B9)
// ---------------------------------------------------------------------------------------------

interface TreeEntry {
  readonly relative: string;
  readonly kind: "file" | "link";
}

interface WalkOptions {
  /** Directories not descended into (`relative` is the directory's workspace path). */
  readonly skipDirectory?: (relative: string, name: string) => boolean;
  /** Synorch's own attempt data never counts as a workspace change, even when it lives inside the tree. */
  readonly excluded?: string;
  /** Watch the repository's own `.git/config` and `.git/hooks/` at the root (they execute or configure code). */
  readonly watchGitConfig?: boolean;
}

async function walkTree(root: string, limit: number, options: WalkOptions = {}): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const visit = async (relative: string, filter?: (name: string) => boolean): Promise<void> => {
    const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (filter !== undefined && !filter(child.name)) continue;
      const childRelative = relative === "" ? child.name : `${relative}/${child.name}`;
      if (child.isSymbolicLink()) entries.push({ relative: childRelative, kind: "link" });
      else if (child.isDirectory()) {
        if (options.excluded !== undefined && sameFsPath(path.resolve(directory, child.name), path.resolve(options.excluded), process.platform)) continue;
        if (options.watchGitConfig === true && relative === "" && child.name === ".git") {
          await visit(childRelative, (name) => name === "config" || name === "hooks");
          continue;
        }
        if (options.skipDirectory?.(childRelative, child.name) === true) continue;
        await visit(childRelative);
      } else if (child.isFile()) entries.push({ relative: childRelative, kind: "file" });
      if (entries.length > limit) {
        throw isolationError("sandbox_insufficient", `the workspace has more than ${limit} entries; a scoped-dir snapshot would be unbounded (commit your changes so the attempt can use a worktree)`);
      }
    }
  };
  await visit("");
  return entries;
}

/**
 * Directories a scoped snapshot never walks: `.git` (except config/hooks), the ignored directories
 * git reports (`skipDirs`) and generated directories by name (dependency directories in a git root,
 * `GENERATED_DIRECTORY_NAMES` outside one), unless an owned path names something inside them.
 */
function scopedSkipRule(skipDirs: readonly string[], ownedPaths: readonly string[], platform: NodeJS.Platform, gitRoot: boolean): (relative: string, name: string) => boolean {
  const key = (value: string): string => (isCaseInsensitivePlatform(platform) ? foldPathCase(value) : value);
  const skipped = new Set(skipDirs.map(key));
  const names = gitRoot ? DEPENDENCY_NAMES : GENERATED_DIRECTORY_NAMES;
  return (relative, name) => {
    if (name === ".git") return true;
    if (skipped.has(key(relative))) return true;
    return names.has(name) && !ownsInside(ownedPaths, relative, platform);
  };
}

type Method = "h" | "s" | "l";

interface SnapshotRecord {
  readonly method: Method;
  readonly signature: string;
  readonly digest: Digest;
  readonly kept: boolean;
}

interface Signed {
  readonly method: Method;
  readonly signature: string;
  readonly digest: Digest;
  readonly bytes: Buffer | undefined;
}

async function sign(root: string, entry: TreeEntry, method: Method | undefined, budget: { hashed: number } | undefined): Promise<Signed | undefined> {
  const file = path.join(root, ...entry.relative.split("/"));
  try {
    if (entry.kind === "link") {
      const signature = `link:${await readlink(file)}`;
      return { method: "l", signature, digest: sha256(signature), bytes: undefined };
    }
    const info = await lstat(file);
    if (!info.isFile()) return undefined;
    const hash =
      method === "h" ||
      (method === undefined &&
        info.size <= SCOPED_SNAPSHOT_LIMITS.hashFileBytes &&
        (budget === undefined || budget.hashed + info.size <= SCOPED_SNAPSHOT_LIMITS.hashTotalBytes));
    if (hash) {
      const bytes = await readFile(file);
      if (budget !== undefined) budget.hashed += bytes.byteLength;
      const digest = workspaceDigest(bytes);
      return { method: "h", signature: digest, digest, bytes };
    }
    const signature = `stat:${info.size}:${info.mtimeMs}`;
    return { method: "s", signature, digest: sha256(signature), bytes: undefined };
  } catch {
    return undefined;
  }
}

interface ScopedManifest {
  readonly format: typeof SCOPED_BASELINE_FORMAT;
  readonly attempt_id: string;
  readonly workspace_root: string;
  readonly owned_paths: readonly string[];
  readonly git_head: string | null;
  readonly created_at: string;
  /** Ignored directories the snapshot did not walk (and later walks skip too). */
  readonly skip_dirs?: readonly string[];
  readonly entries: Readonly<Record<string, readonly [Method, string, string, boolean]>>;
}

const SCOPED_STATE_FILE = "state.json";
const SCOPED_OWNER_FILE = "owner.json";
const SCOPED_MANIFEST_FILE = "manifest.json";

class ScopedSnapshot implements Baseline {
  private readonly root: string;
  private readonly directory: string;
  private readonly records: ReadonlyMap<string, SnapshotRecord>;
  private readonly git: { readonly runner: GitRunner; readonly head: string } | undefined;
  private readonly skipDirs: readonly string[];
  private readonly platform: NodeJS.Platform;
  public readonly ownedPaths: readonly string[];

  private constructor(
    root: string,
    directory: string,
    records: ReadonlyMap<string, SnapshotRecord>,
    git: { readonly runner: GitRunner; readonly head: string } | undefined,
    ownedPaths: readonly string[],
    skipDirs: readonly string[],
    platform: NodeJS.Platform,
  ) {
    this.root = root;
    this.directory = directory;
    this.records = records;
    this.git = git;
    this.ownedPaths = ownedPaths;
    this.skipDirs = skipDirs;
    this.platform = platform;
  }

  private walk(): Promise<TreeEntry[]> {
    return walkTree(this.root, SCOPED_SNAPSHOT_LIMITS.maxEntries, {
      excluded: path.dirname(this.directory),
      watchGitConfig: true,
      skipDirectory: scopedSkipRule(this.skipDirs, this.ownedPaths, this.platform, this.git !== undefined),
    });
  }

  public static async take(options: {
    readonly root: string;
    readonly directory: string;
    readonly owner: AttemptOwner;
    readonly ownedPaths: readonly string[];
    readonly git: { readonly runner: GitRunner; readonly head: string } | undefined;
    readonly skipDirs: readonly string[];
    readonly platform: NodeJS.Platform;
    /** Clean tracked files: restorable from the base commit (digest-verified), so no copy is kept. */
    readonly restorableFromGit?: ReadonlySet<string>;
  }): Promise<ScopedSnapshot> {
    const snapshot = new ScopedSnapshot(options.root, options.directory, new Map(), options.git, options.ownedPaths, options.skipDirs, options.platform);
    const entries = await snapshot.walk();
    await rm(options.directory, { recursive: true, force: true });
    await mkdir(path.join(options.directory, "blobs"), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(options.directory, SCOPED_OWNER_FILE), options.owner);
    await writeJsonAtomic(path.join(options.directory, SCOPED_STATE_FILE), { state: "active" });
    const budget = { hashed: 0 };
    let keptBytes = 0;
    const records = new Map<string, SnapshotRecord>();
    const written = new Set<string>();
    for (const entry of entries) {
      const signed = await sign(options.root, entry, undefined, budget);
      if (signed === undefined) continue;
      let kept = false;
      const fromGit = options.git !== undefined && options.restorableFromGit?.has(entry.relative) === true;
      if (!fromGit && signed.bytes !== undefined && keptBytes + signed.bytes.byteLength <= SCOPED_SNAPSHOT_LIMITS.keepTotalBytes) {
        const name = signed.digest.slice("sha256:".length);
        if (!written.has(name)) {
          await writeFile(path.join(options.directory, "blobs", name), signed.bytes, { mode: 0o600 });
          written.add(name);
          keptBytes += signed.bytes.byteLength;
        }
        kept = true;
      }
      records.set(entry.relative, { method: signed.method, signature: signed.signature, digest: signed.digest, kept });
    }
    const manifest: ScopedManifest = {
      format: SCOPED_BASELINE_FORMAT,
      attempt_id: options.owner.attempt_id,
      workspace_root: options.root,
      owned_paths: options.ownedPaths,
      git_head: options.git?.head ?? null,
      created_at: new Date().toISOString(),
      skip_dirs: options.skipDirs,
      entries: Object.fromEntries([...records].map(([relative, record]) => [relative, [record.method, record.signature, record.digest, record.kept] as const])),
    };
    await writeJsonAtomic(path.join(options.directory, SCOPED_MANIFEST_FILE), manifest);
    return new ScopedSnapshot(options.root, options.directory, records, options.git, options.ownedPaths, options.skipDirs, options.platform);
  }

  /** Reloads a persisted snapshot (crash recovery); undefined when it is missing or unreadable. */
  public static async load(directory: string, git: GitRunner, platform: NodeJS.Platform): Promise<ScopedSnapshot | undefined> {
    const manifest = (await readJson(path.join(directory, SCOPED_MANIFEST_FILE))) as Partial<ScopedManifest> | undefined;
    if (manifest?.format !== SCOPED_BASELINE_FORMAT || typeof manifest.workspace_root !== "string" || manifest.entries === undefined) return undefined;
    const records = new Map<string, SnapshotRecord>();
    for (const [relative, value] of Object.entries(manifest.entries)) {
      const [method, signature, digest, kept] = value;
      records.set(relative, { method, signature, digest: digest as Digest, kept });
    }
    const head = typeof manifest.git_head === "string" ? { runner: git, head: manifest.git_head } : undefined;
    return new ScopedSnapshot(manifest.workspace_root, directory, records, head, manifest.owned_paths ?? [], manifest.skip_dirs ?? [], platform);
  }

  public get workspaceRoot(): string {
    return this.root;
  }

  public async beforeDigest(relative: string): Promise<Digest | null> {
    return this.records.get(relative)?.digest ?? null;
  }

  public async beforeContent(relative: string): Promise<Buffer | null | undefined> {
    const record = this.records.get(relative);
    if (record === undefined) return null;
    if (record.method === "l") return undefined;
    if (record.kept) {
      const bytes = await readFile(path.join(this.directory, "blobs", record.digest.slice("sha256:".length))).catch(() => undefined);
      if (bytes !== undefined && workspaceDigest(bytes) === record.digest) return bytes;
    }
    if (this.git !== undefined && record.method === "h") {
      // The checkout form (smudge + EOL) of the base blob; used only when it is byte-identical to the snapshot.
      const bytes = await gitShowFiltered(this.git.runner, this.root, this.git.head, relative);
      if (bytes !== undefined && workspaceDigest(bytes) === record.digest) return bytes;
    }
    return undefined;
  }

  public async candidates(): Promise<readonly string[]> {
    const now = await this.walk();
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const entry of now) {
      seen.add(entry.relative);
      const record = this.records.get(entry.relative);
      const method = record === undefined ? undefined : entry.kind === "link" ? "l" : record.method === "l" ? undefined : record.method;
      const signed = await sign(this.root, entry, method, undefined);
      if (signed === undefined) continue;
      if (record === undefined || record.signature !== signed.signature) changed.push(entry.relative);
    }
    for (const relative of this.records.keys()) if (!seen.has(relative)) changed.push(relative);
    if (this.git === undefined) return changed;
    // New entries git ignores (build output, caches created during the attempt) are generated, not
    // part of the artifact; an owned literal file is always kept (B8).
    const fresh = changed.filter((relative) => !this.records.has(relative) && !this.ownedPaths.some((pattern) => isLiteralPattern(pattern) && pattern === relative));
    // An ignored write outside the owned paths (a stray `.env`) stays visible so integrate refuses it (SEC-M1).
    const ignored = await gitIgnoredSubset(this.git.runner, this.root, fresh).catch(() => new Set<string>());
    const generated = new Set(
      fresh.filter((relative) => inGeneratedDirectory(relative, this.ownedPaths, this.platform) || (ignored.has(relative) && matchesAny(relative, this.ownedPaths, this.platform))),
    );
    return generated.size === 0 ? changed : changed.filter((relative) => !generated.has(relative));
  }

  public async markIntegrated(): Promise<void> {
    await writeJsonAtomic(path.join(this.directory, SCOPED_STATE_FILE), { state: "integrated" }).catch(() => undefined);
  }

  public async destroy(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface RevertOutcome {
  readonly restored: string[];
  readonly unrestorable: string[];
}

/** Restores `paths` (as named on disk) from `baseline`, link-safely; a path that cannot be restored is reported, never forced. */
async function restorePaths(root: string, baseline: Baseline, paths: readonly string[], platform: NodeJS.Platform): Promise<RevertOutcome> {
  const restored: string[] = [];
  const unrestorable: string[] = [];
  for (const relative of paths) {
    try {
      const original = await baseline.beforeContent(relative);
      if (original === undefined) {
        unrestorable.push(relative);
        continue;
      }
      if (original === null) {
        await removeSafe(root, relative, platform, { allowReserved: true });
      } else {
        if ((await observe(root, relative)).kind === "link") await removeSafe(root, relative, platform, { allowReserved: true });
        await writeSafe(root, relative, original, platform, { allowReserved: true });
      }
      restored.push(relative);
    } catch (error: unknown) {
      if (error instanceof HarnessError && error.info.code === "policy_denied") {
        unrestorable.push(relative);
        continue;
      }
      throw error;
    }
  }
  return { restored, unrestorable };
}

// ---------------------------------------------------------------------------------------------
// EOL helpers (integrate keeps the main file's line-ending style when git sees the same blob)
// ---------------------------------------------------------------------------------------------

type EolStyle = "lf" | "crlf" | "mixed" | "none";

function eolStyle(bytes: Buffer): EolStyle {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x0a) {
      if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1;
      else lf += 1;
    } else if (byte === 0x0d && bytes[index + 1] !== 0x0a) return "mixed";
  }
  if (lf === 0 && crlf === 0) return "none";
  if (lf > 0 && crlf > 0) return "mixed";
  return lf > 0 ? "lf" : "crlf";
}

function withEol(bytes: Buffer, style: "lf" | "crlf"): Buffer {
  const lf = Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return style === "lf" ? lf : Buffer.from(lf.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
}

// ---------------------------------------------------------------------------------------------
// Worktree failures (B7)
// ---------------------------------------------------------------------------------------------

function classifyWorktreeFailure(error: unknown): { readonly reason: IsolationFallbackReason; readonly detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.replace(/\s+/g, " ").trim().slice(0, 500);
  if (error instanceof GitCommandError && error.spawnCode !== undefined) return { reason: "git-unavailable", detail };
  if (/filename too long|file name too long|too long|ENAMETOOLONG|too big|path.*exceeds/i.test(message)) return { reason: "path-too-long", detail };
  return { reason: "worktree-create-failed", detail };
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

interface ScopedSlot {
  readonly taskId: string;
  readonly released: Promise<void>;
  release(): void;
  /** Paths another workspace of this provider integrated into the main tree while this one was active. */
  readonly foreign: Map<string, Digest | null>;
}

/** One git worktree on disk; successive attempts of one task may hold it in turn (reuse). */
interface WorktreeLease {
  readonly target: string;
  /** The attempt whose id names the worktree directory and owner file. */
  readonly ownerAttemptId: AttemptId;
  links: string[];
  holder: OrchestratedWorkspace | undefined;
  closed: boolean;
  /** Main-tree identities, at create time, of paths this provider integrated earlier and copied in (`ours`). */
  seededMainIdentities: Map<string, ContentIdentity | undefined>;
}

interface WorkspaceExtras {
  readonly reused?: boolean;
  readonly fallback?: NonNullable<IsolatedWorkspace["fallback"]>;
  readonly overlaid?: readonly string[];
  readonly dependencyLinks?: readonly string[];
  readonly submodules?: readonly string[];
}

function abortable(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(isolationError("internal", "cancelled while waiting for a scoped-dir slot"));
    signal.addEventListener("abort", () => reject(isolationError("internal", "cancelled while waiting for a scoped-dir slot")), { once: true });
  });
}

export function createIsolationProvider(deps: IsolationProviderDependencies): OrchestrationIsolationProvider {
  const git = deps.git ?? runGit;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const slots = new Set<ScopedSlot>();
  const slotOf = new Map<OrchestratedWorkspace, ScopedSlot>();
  const scopedSnapshots = new Map<AttemptId, ScopedSnapshot>();
  const leases = new Map<OrchestratedWorkspace, WorktreeLease>();
  /** Main-tree digests of paths this provider integrated; such dirty paths are ours, not the user's. */
  const integrated = new Map<string, Digest | null>();

  const worktreesRoot = deps.worktreesRoot ?? path.join(home, ".synorch", "worktrees");
  const projectDirectory = projectWorkspacesDirectory(worktreesRoot, deps.projectId);
  const worktreePath = (attemptId: AttemptId): string => path.join(projectDirectory, workspaceDirectoryName(attemptId));
  const ownerFile = (attemptId: AttemptId): string => `${worktreePath(attemptId)}.owner.json`;
  const scopedDirectory = (attemptId: AttemptId): string => `${worktreePath(attemptId)}.scoped`;
  const ownerOf = (attemptId: AttemptId, mode: AttemptOwner["mode"], links: readonly string[] = []): AttemptOwner => ({
    format: ATTEMPT_OWNER_FORMAT,
    attempt_id: attemptId,
    mode,
    pid: process.pid,
    host: hostname(),
    workspace_root: deps.workspaceRoot,
    created_at: new Date().toISOString(),
    ...(links.length > 0 ? { dependency_links: links } : {}),
  });

  const acquireSlot = async (taskId: string, signal: AbortSignal): Promise<ScopedSlot> => {
    for (;;) {
      const blocking = [...slots].filter((slot) => slot.taskId !== taskId);
      if (blocking.length === 0) break;
      await Promise.race([...blocking.map((slot) => slot.released), abortable(signal)]);
    }
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot: ScopedSlot = {
      taskId,
      released,
      release: () => {
        slots.delete(slot);
        release();
      },
      foreign: new Map(),
    };
    slots.add(slot);
    return slot;
  };

  const pinned = async (
    workspace: { readonly mode: IsolatedWorkspace["mode"]; readonly root: string; readonly baseCommit: string | undefined; readonly self: () => OrchestratedWorkspace },
    baseline: Baseline | undefined,
    signal: AbortSignal,
  ): Promise<ChangeSet> => {
    const changes: ArtifactChange[] = [];
    const contents = new Map<string, Buffer | null>();
    const unsafe: string[] = [];
    const unsafeReasons = new Map<string, string>();
    const diskPaths = new Map<string, string>();
    if (baseline !== undefined) {
      const foreign = slotOf.get(workspace.self())?.foreign;
      const candidates = [...new Set(await baseline.candidates(signal))].sort();
      const flagged = baseline.flagged?.() ?? new Map<string, string>();
      const byPath = new Map<string, string[]>();
      for (const candidate of candidates) {
        const normalized = normalizeWorkspacePath(candidate);
        if (normalized === undefined) {
          // Not expressible as a workspace path: never silently dropped from changed ⊆ owned.
          unsafe.push(candidate);
          continue;
        }
        byPath.set(normalized, [...(byPath.get(normalized) ?? []), candidate]);
      }
      for (const [normalized, spellings] of [...byPath].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
        const changed: { readonly onDisk: string; readonly before: Digest | null; readonly after: Digest | null; readonly observed: Observed }[] = [];
        for (const onDisk of spellings) {
          const before = await baseline.beforeDigest(onDisk);
          const observed = await observe(workspace.root, onDisk);
          const after = observedDigest(observed);
          if (before !== after) changed.push({ onDisk, before, after, observed });
        }
        const first = changed[0];
        if (first === undefined) continue;
        if (foreign !== undefined && changed.length === 1 && foreign.has(normalized) && foreign.get(normalized) === first.after) continue;
        if (changed.length > 1) {
          unsafe.push(normalized);
          unsafeReasons.set(normalized, `${changed.length} files differ only in Unicode normalization (${changed.map((entry) => JSON.stringify(entry.onDisk)).join(", ")})`);
        } else if (flagged.has(first.onDisk)) {
          unsafe.push(normalized);
          unsafeReasons.set(normalized, flagged.get(first.onDisk) ?? "cannot be integrated");
        } else if (first.observed.kind === "link" || first.observed.kind === "other") unsafe.push(normalized);
        changes.push({ path: normalized, before: first.before, after: first.after });
        contents.set(normalized, first.observed.kind === "file" ? first.observed.bytes : null);
        if (first.onDisk !== normalized) diskPaths.set(normalized, first.onDisk);
      }
    }
    const artifactBytes = encodeArtifact(workspace.mode, workspace.baseCommit, changes, contents);
    const artifactDigest = sha256(artifactBytes);
    if (deps.blobs !== undefined) await deps.blobs.put(artifactBytes, ARTIFACT_MEDIA_TYPE);
    return {
      artifactDigest,
      artifactBytes,
      changes,
      contents,
      unsafe,
      ...(unsafeReasons.size > 0 ? { unsafeReasons } : {}),
      ...(diskPaths.size > 0 ? { diskPaths } : {}),
    };
  };

  const build = (
    attemptId: AttemptId,
    packet: TaskContextPacket,
    mode: IsolatedWorkspace["mode"],
    root: string,
    baseCommit: string | undefined,
    baseline: Baseline | undefined,
    cleanup: (self: OrchestratedWorkspace) => Promise<void>,
    extras: WorkspaceExtras = {},
    slot?: ScopedSlot,
  ): OrchestratedWorkspace => {
    let disposed = false;
    const workspace: OrchestratedWorkspace = {
      attemptId,
      mode,
      root,
      baseCommit,
      ownedPaths: packet.scope.owned_paths,
      forbiddenPaths: packet.scope.forbidden_paths,
      digest: createWorkspaceDigestReader(root, { platform }),
      ...extras,
      changeSet: (signal) => pinned({ mode, root, baseCommit, self: () => workspace }, baseline, signal),
      async snapshot(signal) {
        const set = await workspace.changeSet(signal);
        return { artifactDigest: set.artifactDigest, changedPaths: set.changes.map((change) => change.path) };
      },
      async revert(signal) {
        if (baseline === undefined) return [];
        const set = await workspace.changeSet(signal);
        // Every change is restored, owned or not (SEC-M1), except a declared input the task only
        // reads: its change is a source change the freshness check attributes to the user, and the
        // re-packaged attempt must see it.
        const sources = packet.context.sources.map((source) => source.path);
        // The workspace-wide read pattern (`**`) is a read grant, not a declared input: it never exempts a change.
        const inputs = [...packet.scope.read_paths.filter((pattern) => pattern !== "**"), ...sources];
        const paths = set.changes
          .map((change) => change.path)
          .filter((relative) => matchesAny(relative, packet.scope.owned_paths, platform) || !matchesAny(relative, inputs, platform));
        const onDisk = paths.map((relative) => set.diskPaths?.get(relative) ?? relative);
        const outcome = await restorePaths(root, baseline, onDisk, platform);
        const back = new Map(paths.map((relative, index) => [onDisk[index] ?? relative, relative]));
        return outcome.restored.map((relative) => back.get(relative) ?? relative);
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        slotOf.delete(workspace);
        try {
          await cleanup(workspace);
        } finally {
          slot?.release();
        }
      },
    };
    if (slot !== undefined) slotOf.set(workspace, slot);
    return workspace;
  };

  /** Deletes a worktree without ever descending into a link: links first, then Node's `rm`, then `worktree prune`. */
  const discardLease = async (lease: WorktreeLease): Promise<void> => {
    lease.closed = true;
    for (const link of lease.links) await unlinkLink(path.join(lease.target, ...link.split("/")));
    await rm(lease.target, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    await git(["worktree", "prune"], deps.workspaceRoot).catch(() => undefined);
    await rm(ownerFile(lease.ownerAttemptId), { force: true }).catch(() => undefined);
  };

  /** Removes everything untracked or ignored in a worktree (like `git clean -fdx`) with Node's `rm`, which never follows a junction. */
  const cleanUntracked = async (target: string, signal: AbortSignal): Promise<void> => {
    const output = (await git(["ls-files", "--others", "--directory", "-z"], target, signal)).stdout.toString("utf8");
    for (const entry of output.split("\0").filter((value) => value.length > 0)) {
      const relative = entry.replace(/\/+$/, "");
      if (relative.length === 0 || relative.split("/").includes("..")) continue;
      await rm(path.join(target, ...relative.split("/")), { recursive: true, force: true, maxRetries: 3 });
    }
  };

  interface PopulateInput {
    readonly packet: TaskContextPacket;
    readonly head: string;
    readonly ours: readonly string[];
    readonly mainDirty: readonly string[];
    readonly overlay: readonly string[];
    readonly submodules: readonly string[];
  }

  /**
   * Fills a fresh or reset worktree: paths this provider integrated earlier (`ours`), overlaid
   * read inputs, dependency links; then records the baseline the change set is computed against.
   */
  const populate = async (lease: WorktreeLease, input: PopulateInput, signal: AbortSignal): Promise<{ baseline: Baseline; overlaid: string[] }> => {
    const target = lease.target;
    const owned = input.packet.scope.owned_paths;
    const seeded = new Map<string, Buffer | null>();
    const copyFromMain = async (relative: string): Promise<boolean> => {
      const observed = await observe(deps.workspaceRoot, relative);
      if (observed.kind === "file") await writeSafe(target, relative, observed.bytes, platform);
      else if (observed.kind === "absent") await removeSafe(target, relative, platform);
      else return false;
      seeded.set(relative, observed.kind === "file" ? observed.bytes : null);
      return true;
    };
    for (const relative of input.ours) await copyFromMain(relative);
    lease.seededMainIdentities = input.ours.length === 0 ? new Map() : await contentIdentities(deps.workspaceRoot, input.ours, signal, { git, platform });

    const overlaid: string[] = [];
    if (input.overlay.length > 0) {
      for (const relative of input.mainDirty) {
        if (seeded.has(relative) || matchesAny(relative, owned, platform) || !matchesAny(relative, input.overlay, platform)) continue;
        if (await copyFromMain(relative)) overlaid.push(normalizeWorkspacePath(relative) ?? relative);
      }
    }

    // Dependency links: ignored, present in the main tree, not overlapping any owned path.
    const links: string[] = [];
    for (const entry of await gitIgnoredEntries(git, deps.workspaceRoot, signal)) {
      if (!entry.endsWith("/")) continue;
      const relative = entry.replace(/\/+$/, "");
      const name = relative.split("/").at(-1) ?? "";
      if (!DEPENDENCY_NAMES.has(name) || owned.some((pattern) => pathPatternsOverlap(pattern, relative))) continue;
      const parent = path.dirname(path.join(target, ...relative.split("/")));
      const parentInfo = await lstat(parent).catch(() => undefined);
      if (parentInfo === undefined || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) continue;
      if ((await lstat(path.join(target, ...relative.split("/"))).catch(() => undefined)) !== undefined) continue;
      links.push(relative);
    }
    if (links.length > 0) {
      // Record the links before creating them: a crash in between must still unlink them before removal.
      lease.links = links;
      await writeJsonAtomic(ownerFile(lease.ownerAttemptId), ownerOf(lease.ownerAttemptId, "worktree", links));
      for (const relative of links) {
        await symlink(path.join(deps.workspaceRoot, ...relative.split("/")), path.join(target, ...relative.split("/")), platform === "win32" ? "junction" : "dir");
      }
    }

    const ownedGitlinks = input.submodules.filter((gitlink) => owned.some((pattern) => pathPatternsOverlap(pattern, gitlink)));
    const literalOwned = owned.filter((pattern) => isLiteralPattern(pattern));
    const excludedPrefixes = [...links];
    const content = async (relative: string): Promise<Buffer | null> => {
      if (seeded.has(relative)) return seeded.get(relative) ?? null;
      return (await gitShowFiltered(git, target, input.head, relative)) ?? null;
    };
    let flagged = new Map<string, string>();
    const baseline: Baseline = {
      beforeContent: content,
      beforeDigest: async (relative) => {
        const bytes = await content(relative);
        return bytes === null ? null : workspaceDigest(bytes);
      },
      async candidates(inner) {
        const found = new Set<string>([...(await gitDirtyPaths(git, target, inner)), ...seeded.keys()]);
        // Owned paths are also scanned directly (B8): an owned literal file git ignores, and anything
        // written inside a submodule directory, which the superproject's status never reports.
        const literalFiles: string[] = [];
        for (const pattern of literalOwned) {
          if ((await observe(target, pattern)).kind === "file" && !found.has(pattern)) literalFiles.push(pattern);
        }
        for (const relative of await gitIgnoredSubset(git, target, literalFiles, inner)) found.add(relative);
        const nextFlagged = new Map<string, string>();
        for (const gitlink of ownedGitlinks) {
          for (const entry of await walkTree(path.join(target, ...gitlink.split("/")), 50_000, { skipDirectory: (_relative, name) => name === ".git" })) {
            const relative = `${gitlink}/${entry.relative}`;
            found.add(relative);
            nextFlagged.set(relative, `it is inside the submodule ${gitlink}; Synorch never integrates writes inside a submodule`);
          }
        }
        flagged = nextFlagged;
        const kept: string[] = [];
        for (const relative of found) {
          if (excludedPrefixes.some((prefix) => isAtOrBelow(relative, prefix, platform))) continue;
          // A new file inside an unignored generated directory (build output, caches) is not part of the artifact.
          if (inGeneratedDirectory(relative, owned, platform) && !seeded.has(relative) && (await content(relative)) === null) continue;
          kept.push(relative);
        }
        return kept;
      },
      flagged: () => flagged,
    };
    return { baseline, overlaid };
  };

  /**
   * Ignored links in the main workspace that the artifact's `.gitignore` changes would expose.
   * `worktreeRoot` already holds the new ignore files, so `check-ignore --no-index` there answers
   * "is this still ignored afterwards".
   */
  const exposedIgnoredLinks = async (changes: readonly ArtifactChange[], worktreeRoot: string, signal: AbortSignal): Promise<string[]> => {
    const ignoreFiles = changes.filter((change) => change.path === ".gitignore" || change.path.endsWith("/.gitignore"));
    if (ignoreFiles.length === 0) return [];
    const scopes = ignoreFiles.map((change) => (change.path === ".gitignore" ? "" : change.path.slice(0, -"/.gitignore".length)));
    const ignored = (await gitIgnoredEntries(git, deps.workspaceRoot, signal)).filter((entry) =>
      scopes.some((scope) => scope === "" || entry === scope || entry.startsWith(`${scope}/`)),
    );
    const stillIgnored = await gitCheckIgnored(git, worktreeRoot, ignored, signal);
    const exposed: string[] = [];
    for (const entry of ignored.filter((candidate) => !stillIgnored.has(candidate))) {
      const relative = entry.replace(/\/+$/, "");
      const links = (await observe(deps.workspaceRoot, relative)).kind === "link" ? [relative] : [];
      if (links.length === 0) {
        for (const child of await walkTree(path.join(deps.workspaceRoot, ...relative.split("/")), 10_000).catch(() => [{ relative: "", kind: "link" as const }])) {
          if (child.kind === "link") links.push(child.relative === "" ? relative : `${relative}/${child.relative}`);
        }
      }
      exposed.push(...links);
    }
    return exposed;
  };

  /** A worktree workspace over `lease`, with the lease's dispose semantics (only the current holder removes it). */
  const worktreeWorkspace = (
    attemptId: AttemptId,
    packet: TaskContextPacket,
    head: string,
    lease: WorktreeLease,
    baseline: Baseline,
    extras: WorkspaceExtras,
  ): OrchestratedWorkspace => {
    const workspace = build(
      attemptId,
      packet,
      "worktree",
      lease.target,
      head,
      baseline,
      async (self) => {
        leases.delete(self);
        // A workspace superseded by a reuse no longer owns the worktree; the reusing one disposes it.
        if (lease.holder !== self || lease.closed) return;
        await discardLease(lease);
      },
      { ...extras, dependencyLinks: [...lease.links] },
    );
    lease.holder = workspace;
    leases.set(workspace, lease);
    return workspace;
  };

  const openWorktree = async (packet: TaskContextPacket, attemptId: AttemptId, input: PopulateInput, extras: WorkspaceExtras, signal: AbortSignal): Promise<OrchestratedWorkspace> => {
    const lease: WorktreeLease = { target: worktreePath(attemptId), ownerAttemptId: attemptId, links: [], holder: undefined, closed: false, seededMainIdentities: new Map() };
    try {
      await mkdir(path.dirname(lease.target), { recursive: true });
      await writeJsonAtomic(ownerFile(attemptId), ownerOf(attemptId, "worktree"));
      await git(["worktree", "add", "--detach", lease.target, input.head], deps.workspaceRoot, signal);
      const { baseline, overlaid } = await populate(lease, input, signal);
      return worktreeWorkspace(attemptId, packet, input.head, lease, baseline, { ...extras, ...(overlaid.length > 0 ? { overlaid } : {}) });
    } catch (error: unknown) {
      await discardLease(lease);
      throw error;
    }
  };

  const reuseWorktree = async (
    previous: OrchestratedWorkspace,
    packet: TaskContextPacket,
    attemptId: AttemptId,
    input: PopulateInput,
    extras: WorkspaceExtras,
    signal: AbortSignal,
  ): Promise<OrchestratedWorkspace | undefined> => {
    const lease = leases.get(previous);
    if (lease === undefined || lease.closed || lease.holder !== previous) return undefined;
    try {
      for (const link of lease.links) await unlinkLink(path.join(lease.target, ...link.split("/")));
      lease.links = [];
      await writeJsonAtomic(ownerFile(lease.ownerAttemptId), ownerOf(lease.ownerAttemptId, "worktree"));
      await git(["checkout", "-q", "-f", "--detach", input.head], lease.target, signal);
      await git(["reset", "-q", "--hard", input.head], lease.target, signal);
      await cleanUntracked(lease.target, signal);
      leases.delete(previous);
      const { baseline, overlaid } = await populate(lease, input, signal);
      return worktreeWorkspace(attemptId, packet, input.head, lease, baseline, { ...extras, reused: true, ...(overlaid.length > 0 ? { overlaid } : {}) });
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      leases.delete(previous);
      await discardLease(lease);
      return undefined;
    }
  };

  const refuseOwnedInsideSubmodule = (owned: readonly string[], submodules: readonly string[]): void => {
    for (const pattern of owned) {
      const prefix = staticPrefix(pattern);
      const gitlink = submodules.find((candidate) => segmentsUnder(candidate.split("/"), prefix, platform));
      if (gitlink !== undefined) {
        throw isolationError(
          "policy_denied",
          `owned path ${pattern} is inside the submodule ${gitlink}; Synorch does not write inside submodules (own paths outside it, or work in the submodule's own repository)`,
        );
      }
    }
  };

  return {
    worktreePath,
    async create(packet, attemptId, signal, options) {
      if (packet.write_mode !== "owned-paths" || packet.scope.owned_paths.length === 0) {
        const root = options?.readRoot ?? deps.workspaceRoot;
        return build(attemptId, packet, "shared-read-only", root, undefined, undefined, async () => {});
      }
      const owned = packet.scope.owned_paths;
      const top = await gitTopLevel(git, deps.workspaceRoot);
      const isGitRoot = top !== undefined && (await samePath(top, deps.workspaceRoot, platform));
      const head = isGitRoot ? await gitHead(git, deps.workspaceRoot) : undefined;
      let reason = isGitRoot ? (head === undefined ? "the repository has no commit" : undefined) : "the workspace is not a git repository";
      const submodules = isGitRoot ? await gitSubmodulePaths(git, deps.workspaceRoot, signal) : [];
      refuseOwnedInsideSubmodule(owned, submodules);
      const ours: string[] = [];
      let mainDirty: string[] = [];
      if (reason === undefined) {
        mainDirty = await gitDirtyPaths(git, deps.workspaceRoot, signal);
        for (const relative of mainDirty) {
          const current = observedDigest(await observe(deps.workspaceRoot, relative));
          const key = normalizeWorkspacePath(relative) ?? relative;
          if (integrated.has(key) && integrated.get(key) === current) ours.push(relative);
        }
        const overlap = mainDirty.filter((relative) => !ours.includes(relative) && matchesAny(relative, owned, platform));
        if (overlap.length > 0) reason = `uncommitted changes overlap owned paths (${overlap.slice(0, 5).join(", ")})`;
      }
      const common: WorkspaceExtras = submodules.length > 0 ? { submodules } : {};
      let fallback: IsolatedWorkspace["fallback"];
      if (packet.isolation === "worktree" && reason === undefined && head !== undefined) {
        const input: PopulateInput = { packet, head, ours, mainDirty, overlay: options?.overlay ?? [], submodules };
        const previous = options?.reuse as OrchestratedWorkspace | undefined;
        if (previous !== undefined) {
          const reused = await reuseWorktree(previous, packet, attemptId, input, common, signal);
          if (reused !== undefined) return reused;
        }
        try {
          return await openWorktree(packet, attemptId, input, common, signal);
        } catch (error: unknown) {
          if (signal.aborted) throw error;
          const failure = classifyWorktreeFailure(error);
          if (packet.risk === "high-risk") {
            throw isolationError("sandbox_insufficient", `high-risk writing task requires a worktree, but creating it failed (${failure.reason}): ${failure.detail}`);
          }
          fallback = { from: "worktree", reason: failure.reason, detail: failure.detail };
        }
      } else if (packet.isolation === "worktree" && top === undefined && !(await gitAvailable(git, deps.workspaceRoot))) {
        fallback = { from: "worktree", reason: "git-unavailable", detail: "git could not be started" };
        reason = "git is not available";
      }
      if (packet.risk === "high-risk") {
        throw isolationError("sandbox_insufficient", `high-risk writing task requires a worktree, but ${reason ?? "scoped-dir was requested"}`);
      }
      const slot = await acquireSlot(packet.task_id, signal);
      try {
        const skipDirs = isGitRoot
          ? (await gitIgnoredEntries(git, deps.workspaceRoot, signal))
              .filter((entry) => entry.endsWith("/"))
              .map((entry) => entry.replace(/\/+$/, ""))
              .filter((relative) => relative.length > 0 && !ownsInside(owned, relative, platform))
          : [];
        // Clean tracked files outside the owned paths are restored from the base commit (checkout
        // form, digest-verified) instead of copied; owned files always keep a copy.
        let restorableFromGit: ReadonlySet<string> = new Set();
        if (isGitRoot && head !== undefined) {
          const dirty = new Set(reason === undefined ? mainDirty : await gitDirtyPaths(git, deps.workspaceRoot, signal));
          restorableFromGit = new Set(
            (await gitTrackedPaths(git, deps.workspaceRoot, signal)).filter((relative) => !dirty.has(relative) && !matchesAny(relative, owned, platform)),
          );
        }
        const snapshot = await ScopedSnapshot.take({
          root: deps.workspaceRoot,
          directory: scopedDirectory(attemptId),
          owner: ownerOf(attemptId, "scoped-dir"),
          ownedPaths: owned,
          git: isGitRoot && head !== undefined ? { runner: git, head } : undefined,
          skipDirs,
          platform,
          restorableFromGit,
        });
        scopedSnapshots.set(attemptId, snapshot);
        return build(
          attemptId,
          packet,
          "scoped-dir",
          deps.workspaceRoot,
          head,
          snapshot,
          async () => {
            scopedSnapshots.delete(attemptId);
            await snapshot.destroy();
          },
          { ...common, ...(fallback === undefined ? {} : { fallback }) },
          slot,
        );
      } catch (error: unknown) {
        slot.release();
        await rm(scopedDirectory(attemptId), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
    async integrate(workspace, expectedArtifact, signal) {
      const orchestrated = workspace as Partial<OrchestratedWorkspace>;
      if (typeof orchestrated.changeSet !== "function" || orchestrated.ownedPaths === undefined || orchestrated.forbiddenPaths === undefined) {
        throw isolationError("internal", "integrate needs a workspace created by this provider");
      }
      const set = await orchestrated.changeSet(signal);
      if (set.artifactDigest !== expectedArtifact) {
        throw isolationError("verification_failed", `artifact changed since it was pinned: expected ${expectedArtifact}, found ${set.artifactDigest}`);
      }
      const violations = findScopeViolations(
        [...set.changes.map((change) => change.path), ...set.unsafe.filter((entry) => normalizeWorkspacePath(entry) === undefined)],
        { owned: orchestrated.ownedPaths, forbidden: orchestrated.forbiddenPaths },
        platform,
      );
      if (violations.length > 0) {
        throw isolationError("policy_denied", `artifact touches paths outside the owned scope: ${violations.map((v) => `${v.path} (${v.reason})`).join(", ")}`);
      }
      if (set.unsafe.length > 0) {
        const reasons = set.unsafe.filter((entry) => set.unsafeReasons?.has(entry));
        if (reasons.length > 0) {
          throw isolationError("policy_denied", `artifact contains paths that cannot be integrated: ${reasons.slice(0, 10).map((entry) => `${entry}: ${set.unsafeReasons?.get(entry) ?? ""}`).join("; ")}`);
        }
        throw isolationError("policy_denied", `artifact contains links or special files, which are never integrated: ${set.unsafe.slice(0, 10).join(", ")}`);
      }
      if (workspace.mode === "shared-read-only") {
        if (set.changes.length > 0) throw isolationError("policy_denied", "a read-only workspace has changes");
        return;
      }
      if (workspace.mode === "scoped-dir") {
        for (const change of set.changes) integrated.set(change.path, change.after);
        await scopedSnapshots.get(orchestrated.attemptId as AttemptId)?.markIntegrated();
        return;
      }
      const lease = leases.get(workspace as OrchestratedWorkspace);
      const canonicalRoot = await realpath(deps.workspaceRoot);
      const refused: string[] = [];
      for (const link of await exposedIgnoredLinks(set.changes, workspace.root, signal)) {
        const real = await realpath(path.join(deps.workspaceRoot, ...link.split("/"))).catch(() => undefined);
        const inside = real !== undefined && contains(canonicalRoot, real);
        if (!inside || !matchesAny(link, orchestrated.ownedPaths, platform)) refused.push(link);
      }
      if (refused.length > 0) {
        throw isolationError("policy_denied", `a .gitignore change would expose ignored links (${refused.slice(0, 5).join(", ")}); only an owned link inside the workspace may be un-ignored`);
      }
      const paths = set.changes.map((change) => change.path);
      const worktreeName = (relative: string): string => set.diskPaths?.get(relative) ?? relative;
      // Where each path lives in the main tree (an existing NFD-named file keeps its spelling).
      const mainName = new Map<string, string>();
      for (const relative of paths) mainName.set(relative, (await resolveOnDiskPath(deps.workspaceRoot, relative, platform)) ?? relative);
      // Resolve every target before writing any byte: a link anywhere refuses the whole artifact.
      for (const relative of paths) await resolveLinkSafeTarget(deps.workspaceRoot, mainName.get(relative) ?? relative, platform);

      // Base identities: the base commit's blob, or (for paths this provider integrated earlier) the main tree at create time.
      const seeded = lease?.seededMainIdentities ?? new Map<string, ContentIdentity | undefined>();
      const base = new Map<string, ContentIdentity | null>();
      const gitlinkBases: string[] = [];
      const fromTree = paths.filter((relative) => !seeded.has(worktreeName(relative)));
      const tree = workspace.baseCommit === undefined ? new Map<string, GitTreeEntry>() : await gitTreeEntries(git, workspace.root, workspace.baseCommit, fromTree.map(worktreeName), signal);
      for (const relative of paths) {
        if (seeded.has(worktreeName(relative))) {
          base.set(relative, seeded.get(worktreeName(relative)) ?? null);
          continue;
        }
        const entry = tree.get(worktreeName(relative));
        if (entry?.mode === "160000") gitlinkBases.push(relative);
        base.set(relative, entry === undefined ? null : { scheme: "git-blob", oid: entry.oid });
      }
      if (gitlinkBases.length > 0) {
        throw isolationError("policy_denied", `artifact replaces submodule entries, which are never integrated: ${gitlinkBases.slice(0, 5).join(", ")}`);
      }

      // Written content in the main tree's representation: clean in the worktree (blob), smudge for the main tree.
      const writes = set.changes.filter((change) => set.contents.get(change.path) !== null && set.contents.get(change.path) !== undefined);
      const writeNames = writes.map((change) => worktreeName(change.path));
      const ignoredInWorktree = await gitIgnoredSubset(git, workspace.root, writeNames, signal);
      const blobs = await gitHashObjects(git, workspace.root, writeNames.filter((name) => !ignoredInWorktree.has(name)), { write: true, signal });
      const ignoredInMain = await gitIgnoredSubset(git, deps.workspaceRoot, writes.map((change) => mainName.get(change.path) ?? change.path), signal);
      const finalBytes = new Map<string, Buffer>();
      const after = new Map<string, ContentIdentity | null>();
      for (const change of set.changes) {
        const raw = set.contents.get(change.path);
        if (raw === null || raw === undefined) {
          after.set(change.path, null);
          continue;
        }
        const target = mainName.get(change.path) ?? change.path;
        const oid = blobs.get(worktreeName(change.path));
        if (oid === undefined || ignoredInMain.has(target)) {
          finalBytes.set(change.path, raw);
          after.set(change.path, { scheme: "workspace", digest: workspaceDigest(raw) });
          continue;
        }
        let bytes = await gitSmudgeBlob(git, deps.workspaceRoot, oid, target, signal);
        const existing = await observe(deps.workspaceRoot, target);
        if (existing.kind === "file" && !existing.bytes.includes(0) && !bytes.includes(0)) {
          const mainStyle = eolStyle(existing.bytes);
          const newStyle = eolStyle(bytes);
          if ((mainStyle === "lf" || mainStyle === "crlf") && (newStyle === "lf" || newStyle === "crlf") && mainStyle !== newStyle) {
            // Keep the main file's line endings when git stores the very same blob either way.
            const candidate = withEol(bytes, mainStyle);
            if ((await gitHashBytes(git, deps.workspaceRoot, target, candidate, signal)) === oid) bytes = candidate;
          }
        }
        finalBytes.set(change.path, bytes);
        after.set(change.path, { scheme: "git-blob", oid });
      }

      const current = await contentIdentities(deps.workspaceRoot, paths, signal, { git, platform });
      const conflicts: string[] = [];
      for (const relative of paths) {
        const now = current.get(relative);
        const was = base.get(relative) ?? null;
        const next = after.get(relative) ?? null;
        const unchanged = now === undefined ? was === null : was !== null && sameContent(now, was);
        const alreadyApplied = now === undefined ? next === null : next !== null && sameContent(now, next);
        if (!unchanged && !alreadyApplied) conflicts.push(relative);
      }
      if (conflicts.length > 0) {
        throw isolationError("verification_failed", `integration conflict: the main workspace changed at ${conflicts.join(", ")}`);
      }
      for (const change of set.changes) {
        const target = mainName.get(change.path) ?? change.path;
        const bytes = finalBytes.get(change.path);
        if (bytes === undefined) await removeSafe(deps.workspaceRoot, target, platform);
        else await writeSafe(deps.workspaceRoot, target, bytes, platform);
        const digest = bytes === undefined ? null : workspaceDigest(bytes);
        integrated.set(change.path, digest);
        for (const slot of slots) slot.foreign.set(change.path, digest);
      }
    },
    async seed(workspace, artifactBytes) {
      if (workspace.mode === "shared-read-only") throw isolationError("policy_denied", "cannot seed a read-only workspace");
      const document = decodeArtifact(artifactBytes);
      for (const change of document.changes) await resolveLinkSafeTarget(workspace.root, change.path, platform);
      for (const change of document.changes) {
        if (change.content === null) await removeSafe(workspace.root, change.path, platform);
        else await writeSafe(workspace.root, change.path, Buffer.from(change.content, "base64"), platform);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Crash recovery (SEC-M3)
// ---------------------------------------------------------------------------------------------

export interface PruneOrphansOptions {
  readonly worktreesRoot: string;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly git?: GitRunner;
  readonly platform?: NodeJS.Platform;
  /** Whether the process that created an attempt workspace may still use it. */
  readonly isLive?: (owner: AttemptOwner) => boolean;
}

export interface PruneReport {
  /** Worktree directories removed (their attempt's process is gone), by attempt id. */
  readonly removedWorktrees: readonly string[];
  /** Crashed scoped-dir attempts: owned paths restored, other changes left in place, and paths no copy existed for. */
  readonly revertedScoped: readonly { readonly attemptId: string; readonly restored: readonly string[]; readonly leftInPlace: readonly string[]; readonly unrestorable: readonly string[] }[];
  /** Attempt workspaces whose owner process is still alive (or on another host). */
  readonly live: readonly string[];
  /** Directories without an owner record; left alone. */
  readonly unknown: readonly string[];
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The default liveness test: same host, and the owner process still runs (this process counts as live). */
export function isAttemptOwnerLive(owner: AttemptOwner): boolean {
  if (owner.host !== hostname()) return true;
  return owner.pid === process.pid || processAlive(owner.pid);
}

function parseOwner(value: unknown): AttemptOwner | undefined {
  const owner = value as Partial<AttemptOwner> | undefined;
  if (owner?.format !== ATTEMPT_OWNER_FORMAT || typeof owner.pid !== "number" || typeof owner.host !== "string" || typeof owner.attempt_id !== "string") return undefined;
  return owner as AttemptOwner;
}

/**
 * Removes attempt workspaces a crashed process left under the project's worktrees directory (the
 * hashed one, and the pre-ADR-19 `<worktrees>/<project-id>`): git worktrees are removed with their
 * dependency links unlinked first, and a scoped-dir attempt's partial writes inside its owned
 * paths are reverted from the persisted snapshot (changes elsewhere are reported, not reverted,
 * because the user may have edited those files since). Nothing whose owner is live is touched.
 * Integrated scoped-dir attempts are only cleaned up.
 */
export async function pruneOrphanedAttempts(options: PruneOrphansOptions): Promise<PruneReport> {
  const git = options.git ?? runGit;
  const platform = options.platform ?? process.platform;
  const isLive = options.isLive ?? isAttemptOwnerLive;
  const report = { removedWorktrees: [] as string[], revertedScoped: [] as PruneReport["revertedScoped"][number][], live: [] as string[], unknown: [] as string[] };
  const directories = [...new Set([projectWorkspacesDirectory(options.worktreesRoot, options.projectId), path.join(options.worktreesRoot, options.projectId)])];
  for (const directory of directories) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    const owned = new Set<string>();
    for (const name of names.filter((entry) => entry.endsWith(".owner.json"))) {
      const base = name.slice(0, -".owner.json".length);
      owned.add(base);
      const owner = parseOwner(await readJson(path.join(directory, name)));
      if (owner === undefined) {
        report.unknown.push(base);
        continue;
      }
      if (isLive(owner)) {
        report.live.push(owner.attempt_id);
        continue;
      }
      const target = path.join(directory, base);
      const links = [...(owner.dependency_links ?? []), ...DEPENDENCY_LINK_DIRECTORIES];
      for (const link of links) {
        const normalized = normalizeWorkspacePath(link);
        if (normalized !== undefined) await unlinkLink(path.join(target, ...normalized.split("/")));
      }
      // Node's rm never descends into a link; `git worktree remove` would empty a junction's target.
      await rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      await rm(path.join(directory, name), { force: true }).catch(() => undefined);
      report.removedWorktrees.push(owner.attempt_id);
    }
    for (const name of names.filter((entry) => entry.endsWith(".scoped"))) {
      const base = name.slice(0, -".scoped".length);
      const scoped = path.join(directory, name);
      const owner = parseOwner(await readJson(path.join(scoped, SCOPED_OWNER_FILE)));
      if (owner === undefined) {
        report.unknown.push(base);
        continue;
      }
      if (isLive(owner)) {
        report.live.push(owner.attempt_id);
        continue;
      }
      const state = ((await readJson(path.join(scoped, SCOPED_STATE_FILE))) as { state?: string } | undefined)?.state;
      const snapshot = await ScopedSnapshot.load(scoped, git, platform);
      if (snapshot !== undefined && state !== "integrated") {
        if (!(await samePath(snapshot.workspaceRoot, options.workspaceRoot, platform))) {
          report.unknown.push(owner.attempt_id);
          continue;
        }
        const changed = [...(await snapshot.candidates())].sort();
        const inside = changed.filter((relative) => matchesAny(relative, snapshot.ownedPaths, platform));
        const outcome = await restorePaths(options.workspaceRoot, snapshot, inside, platform);
        report.revertedScoped.push({
          attemptId: owner.attempt_id,
          restored: outcome.restored,
          leftInPlace: changed.filter((relative) => !inside.includes(relative)),
          unrestorable: outcome.unrestorable,
        });
      }
      await rm(scoped, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const name of names) {
      if (name.endsWith(".owner.json") || name.endsWith(".scoped") || owned.has(name)) continue;
      report.unknown.push(name);
    }
  }
  await git(["worktree", "prune"], options.workspaceRoot).catch(() => undefined);
  return report;
}
