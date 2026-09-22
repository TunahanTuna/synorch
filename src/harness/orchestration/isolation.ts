import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  HarnessError,
  isReservedWritePattern,
  sha256,
  type AttemptId,
  type BlobStore,
  type Digest,
  type IsolatedWorkspace,
  type IsolationCreateOptions,
  type IsolationProvider,
  type ProjectId,
  type TaskContextPacket,
} from "../contracts/index.ts";
import { gitCheckIgnored, gitDirtyPaths, gitHead, gitIgnoredEntries, gitShowHead, gitTopLevel, runGit, type GitRunner } from "./git.ts";
import { findScopeViolations, matchesAny, normalizeWorkspacePath } from "./paths.ts";

/**
 * Per-attempt isolation (ADR-07).
 *
 * - `worktree`: a detached git worktree at `<home>/.synorch/worktrees/<project-id>/<attempt-id>`
 *   on `HEAD`; the main workspace is untouched until `integrate`.
 * - `scoped-dir`: writes happen in place, limited by policy to `owned_paths`. A snapshot of the
 *   whole tree (ignored files included, bounded by `SCOPED_SNAPSHOT_LIMITS`) is taken first and
 *   persisted under `<worktrees>/<project-id>/<attempt-id>.scoped`, so every change anywhere is
 *   seen (changed ⊆ owned), a failed attempt can be reverted, and crash recovery can revert a
 *   crashed attempt's partial writes (`pruneOrphanedAttempts`). Scoped-dir attempts of different
 *   tasks run one at a time: in a shared directory a change cannot be attributed to one of two
 *   concurrent writers, so a second one waits for the first to be disposed.
 * - `shared-read-only`: explorers and reviewers; nothing may change.
 *
 * Every workspace can pin its changes as an artifact: a canonical JSON document of
 * `{path, before, after, content}` entries whose sha256 is the artifact digest a review binds to.
 *
 * Link safety (SEC-H4): integrate, seed and revert resolve every target segment by segment and
 * refuse any path that traverses a symbolic link or junction, resolves elsewhere or is a
 * multiply linked file; they never follow a link out of the workspace. Integrate also refuses a
 * `.gitignore` change that would expose an ignored link unless the link is owned and stays inside.
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

/** Directory names never walked. `.git` is skipped except its `config` and `hooks/` at the root. */
const WALK_SKIP = new Set([".git", "node_modules"]);

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
  /** Changed paths that are links, special files or not expressible as workspace paths; integrate refuses them. */
  readonly unsafe: readonly string[];
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
}

function isolationError(code: "sandbox_insufficient" | "verification_failed" | "policy_denied" | "internal", message: string): HarnessError {
  return new HarnessError({ code, message: message.slice(0, 2000), workspace_effect: "none", retry_safe: code !== "policy_denied" });
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameFsPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
 * outside `root`.
 */
export async function resolveLinkSafeTarget(root: string, relative: string, platform: NodeJS.Platform, options: TargetOptions = {}): Promise<string> {
  const normalized = workspaceRelative(relative, options.allowReserved === true);
  const canonicalRoot = await realpath(root);
  const segments = normalized.split("/");
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
    await rename(temporary, target);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
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
      return sha256(observed.bytes);
    case "link":
      return sha256(`link:${observed.target}`);
    case "other":
      return sha256("other");
  }
}

async function readFileBytes(root: string, relative: string): Promise<Buffer | null> {
  const observed = await observe(root, relative);
  return observed.kind === "file" ? observed.bytes : null;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
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

interface Baseline {
  beforeDigest(relative: string): Promise<Digest | null>;
  /** Pre-attempt bytes; `null` when the path did not exist, `undefined` when no copy is available. */
  beforeContent(relative: string): Promise<Buffer | null | undefined>;
  candidates(signal: AbortSignal): Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------------------------
// Scoped-dir snapshot (SEC-M1, SEC-M3)
// ---------------------------------------------------------------------------------------------

interface TreeEntry {
  readonly relative: string;
  readonly kind: "file" | "link";
}

async function walkTree(root: string, limit: number, skip: ReadonlySet<string> = WALK_SKIP, excluded?: string): Promise<TreeEntry[]> {
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
        // Synorch's own attempt data never counts as a workspace change, even when it lives inside the tree.
        if (excluded !== undefined && sameFsPath(path.resolve(directory, child.name), path.resolve(excluded), process.platform)) continue;
        if (skip.has(child.name)) {
          // The repository's own hooks and config execute or configure code: watch them.
          if (relative === "" && child.name === ".git") await visit(childRelative, (name) => name === "config" || name === "hooks");
          continue;
        }
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
      const digest = sha256(bytes);
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
  public readonly ownedPaths: readonly string[];

  private constructor(
    root: string,
    directory: string,
    records: ReadonlyMap<string, SnapshotRecord>,
    git: { readonly runner: GitRunner; readonly head: string } | undefined,
    ownedPaths: readonly string[],
  ) {
    this.root = root;
    this.directory = directory;
    this.records = records;
    this.git = git;
    this.ownedPaths = ownedPaths;
  }

  public static async take(options: {
    readonly root: string;
    readonly directory: string;
    readonly owner: AttemptOwner;
    readonly ownedPaths: readonly string[];
    readonly git: { readonly runner: GitRunner; readonly head: string } | undefined;
  }): Promise<ScopedSnapshot> {
    const entries = await walkTree(options.root, SCOPED_SNAPSHOT_LIMITS.maxEntries, WALK_SKIP, path.dirname(options.directory));
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
      if (signed.bytes !== undefined && keptBytes + signed.bytes.byteLength <= SCOPED_SNAPSHOT_LIMITS.keepTotalBytes) {
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
      entries: Object.fromEntries([...records].map(([relative, record]) => [relative, [record.method, record.signature, record.digest, record.kept] as const])),
    };
    await writeJsonAtomic(path.join(options.directory, SCOPED_MANIFEST_FILE), manifest);
    return new ScopedSnapshot(options.root, options.directory, records, options.git, options.ownedPaths);
  }

  /** Reloads a persisted snapshot (crash recovery); undefined when it is missing or unreadable. */
  public static async load(directory: string, git: GitRunner): Promise<ScopedSnapshot | undefined> {
    const manifest = (await readJson(path.join(directory, SCOPED_MANIFEST_FILE))) as Partial<ScopedManifest> | undefined;
    if (manifest?.format !== SCOPED_BASELINE_FORMAT || typeof manifest.workspace_root !== "string" || manifest.entries === undefined) return undefined;
    const records = new Map<string, SnapshotRecord>();
    for (const [relative, value] of Object.entries(manifest.entries)) {
      const [method, signature, digest, kept] = value;
      records.set(relative, { method, signature, digest: digest as Digest, kept });
    }
    const head = typeof manifest.git_head === "string" ? { runner: git, head: manifest.git_head } : undefined;
    return new ScopedSnapshot(manifest.workspace_root, directory, records, head, manifest.owned_paths ?? []);
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
      if (bytes !== undefined && sha256(bytes) === record.digest) return bytes;
    }
    if (this.git !== undefined && record.method === "h") {
      const bytes = await gitShowHead(this.git.runner, this.root, relative);
      if (bytes !== undefined && sha256(bytes) === record.digest) return bytes;
    }
    return undefined;
  }

  public async candidates(): Promise<readonly string[]> {
    const now = await walkTree(this.root, SCOPED_SNAPSHOT_LIMITS.maxEntries, WALK_SKIP, path.dirname(this.directory));
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
    return changed;
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

/** Restores `paths` from `baseline`, link-safely; a path that cannot be restored is reported, never forced. */
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
// Provider
// ---------------------------------------------------------------------------------------------

interface ScopedSlot {
  readonly taskId: string;
  readonly released: Promise<void>;
  release(): void;
  /** Paths another workspace of this provider integrated into the main tree while this one was active. */
  readonly foreign: Map<string, Digest | null>;
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
  /** After-digests of paths this provider integrated; such dirty paths are ours, not the user's. */
  const integrated = new Map<string, Digest | null>();

  const worktreesRoot = deps.worktreesRoot ?? path.join(home, ".synorch", "worktrees");
  const worktreePath = (attemptId: AttemptId): string => path.join(worktreesRoot, deps.projectId, attemptId);
  const ownerFile = (attemptId: AttemptId): string => `${worktreePath(attemptId)}.owner.json`;
  const scopedDirectory = (attemptId: AttemptId): string => `${worktreePath(attemptId)}.scoped`;
  const ownerOf = (attemptId: AttemptId, mode: AttemptOwner["mode"]): AttemptOwner => ({
    format: ATTEMPT_OWNER_FORMAT,
    attempt_id: attemptId,
    mode,
    pid: process.pid,
    host: hostname(),
    workspace_root: deps.workspaceRoot,
    created_at: new Date().toISOString(),
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
    if (baseline !== undefined) {
      const foreign = slotOf.get(workspace.self())?.foreign;
      const candidates = [...new Set(await baseline.candidates(signal))].sort();
      for (const relative of candidates) {
        const normalized = normalizeWorkspacePath(relative);
        if (normalized === undefined) {
          // Not expressible as a workspace path: never silently dropped from changed ⊆ owned.
          unsafe.push(relative);
          continue;
        }
        const before = await baseline.beforeDigest(normalized);
        const observed = await observe(workspace.root, normalized);
        const after = observedDigest(observed);
        if (before === after) continue;
        if (foreign !== undefined && foreign.has(normalized) && foreign.get(normalized) === after) continue;
        if (observed.kind === "link" || observed.kind === "other") unsafe.push(normalized);
        changes.push({ path: normalized, before, after });
        contents.set(normalized, observed.kind === "file" ? observed.bytes : null);
      }
    }
    const artifactBytes = encodeArtifact(workspace.mode, workspace.baseCommit, changes, contents);
    const artifactDigest = sha256(artifactBytes);
    if (deps.blobs !== undefined) await deps.blobs.put(artifactBytes, ARTIFACT_MEDIA_TYPE);
    return { artifactDigest, artifactBytes, changes, contents, unsafe };
  };

  const build = (
    attemptId: AttemptId,
    packet: TaskContextPacket,
    mode: IsolatedWorkspace["mode"],
    root: string,
    baseCommit: string | undefined,
    baseline: Baseline | undefined,
    cleanup: () => Promise<void>,
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
        const inputs = [...packet.scope.read_paths, ...sources];
        const paths = set.changes
          .map((change) => change.path)
          .filter((relative) => matchesAny(relative, packet.scope.owned_paths, platform) || !matchesAny(relative, inputs, platform));
        const outcome = await restorePaths(root, baseline, paths, platform);
        return outcome.restored;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        slotOf.delete(workspace);
        try {
          await cleanup();
        } finally {
          slot?.release();
        }
      },
    };
    if (slot !== undefined) slotOf.set(workspace, slot);
    return workspace;
  };

  const gitBaseline = async (root: string, signal: AbortSignal, snapshotDirty: boolean): Promise<Baseline> => {
    const dirty = new Map<string, Buffer | null>();
    if (snapshotDirty) {
      for (const relative of await gitDirtyPaths(git, root, signal)) {
        dirty.set(relative, await readFileBytes(root, relative));
      }
    }
    const content = async (relative: string): Promise<Buffer | null> => {
      if (dirty.has(relative)) return dirty.get(relative) ?? null;
      return (await gitShowHead(git, root, relative)) ?? null;
    };
    return {
      beforeContent: content,
      beforeDigest: async (relative) => {
        const bytes = await content(relative);
        return bytes === null ? null : sha256(bytes);
      },
      async candidates(inner) {
        return [...(await gitDirtyPaths(git, root, inner)), ...dirty.keys()];
      },
    };
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
        for (const child of await walkTree(path.join(deps.workspaceRoot, ...relative.split("/")), 10_000, new Set()).catch(() => [{ relative: "", kind: "link" as const }])) {
          if (child.kind === "link") links.push(child.relative === "" ? relative : `${relative}/${child.relative}`);
        }
      }
      exposed.push(...links);
    }
    return exposed;
  };

  return {
    worktreePath,
    async create(packet, attemptId, signal, options) {
      if (packet.write_mode !== "owned-paths" || packet.scope.owned_paths.length === 0) {
        const root = options?.readRoot ?? deps.workspaceRoot;
        return build(attemptId, packet, "shared-read-only", root, undefined, undefined, async () => {});
      }
      const top = await gitTopLevel(git, deps.workspaceRoot);
      const isGitRoot = top !== undefined && (await samePath(top, deps.workspaceRoot, platform));
      const head = isGitRoot ? await gitHead(git, deps.workspaceRoot) : undefined;
      let reason = isGitRoot ? (head === undefined ? "the repository has no commit" : undefined) : "the workspace is not a git repository";
      const ours: string[] = [];
      if (reason === undefined) {
        const dirty = await gitDirtyPaths(git, deps.workspaceRoot, signal);
        for (const relative of dirty) {
          const current = observedDigest(await observe(deps.workspaceRoot, relative));
          if (integrated.has(relative) && integrated.get(relative) === current) ours.push(relative);
        }
        const overlap = dirty.filter((relative) => !ours.includes(relative) && matchesAny(relative, packet.scope.owned_paths, platform));
        if (overlap.length > 0) reason = `uncommitted changes overlap owned paths (${overlap.slice(0, 5).join(", ")})`;
      }
      if (packet.isolation === "worktree" && reason === undefined && head !== undefined) {
        const target = worktreePath(attemptId);
        await mkdir(path.dirname(target), { recursive: true });
        await writeJsonAtomic(ownerFile(attemptId), ownerOf(attemptId, "worktree"));
        await git(["worktree", "add", "--detach", target, head], deps.workspaceRoot, signal);
        for (const relative of ours) {
          const bytes = await readFileBytes(deps.workspaceRoot, relative);
          if (bytes === null) await removeSafe(target, relative, platform);
          else await writeSafe(target, relative, bytes, platform);
        }
        const baseline = await gitBaseline(target, signal, ours.length > 0);
        return build(attemptId, packet, "worktree", target, head, baseline, async () => {
          try {
            await git(["worktree", "remove", "--force", target], deps.workspaceRoot);
          } catch {
            await rm(target, { recursive: true, force: true });
            await git(["worktree", "prune"], deps.workspaceRoot).catch(() => undefined);
          }
          await rm(ownerFile(attemptId), { force: true }).catch(() => undefined);
        });
      }
      if (packet.risk === "high-risk") {
        throw isolationError("sandbox_insufficient", `high-risk writing task requires a worktree, but ${reason ?? "scoped-dir was requested"}`);
      }
      const slot = await acquireSlot(packet.task_id, signal);
      try {
        const snapshot = await ScopedSnapshot.take({
          root: deps.workspaceRoot,
          directory: scopedDirectory(attemptId),
          owner: ownerOf(attemptId, "scoped-dir"),
          ownedPaths: packet.scope.owned_paths,
          git: isGitRoot && head !== undefined ? { runner: git, head } : undefined,
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
      // Resolve every target before writing any byte: a link anywhere refuses the whole artifact.
      const conflicts: string[] = [];
      for (const change of set.changes) {
        await resolveLinkSafeTarget(deps.workspaceRoot, change.path, platform);
        const current = observedDigest(await observe(deps.workspaceRoot, change.path));
        if (current !== change.before) conflicts.push(change.path);
      }
      if (conflicts.length > 0) {
        throw isolationError("verification_failed", `integration conflict: the main workspace changed at ${conflicts.join(", ")}`);
      }
      for (const change of set.changes) {
        const content = set.contents.get(change.path);
        if (content === null || content === undefined) await removeSafe(deps.workspaceRoot, change.path, platform);
        else await writeSafe(deps.workspaceRoot, change.path, content, platform);
        integrated.set(change.path, change.after);
        for (const slot of slots) slot.foreign.set(change.path, change.after);
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
  /** Worktree directories removed (their attempt's process is gone). */
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
 * Removes attempt workspaces a crashed process left under `<worktrees>/<project-id>`: git
 * worktrees are removed, and a scoped-dir attempt's partial writes inside its owned paths are
 * reverted from the persisted snapshot (changes elsewhere are reported, not reverted, because the
 * user may have edited those files since). Nothing whose owner is live is touched. Integrated
 * scoped-dir attempts are only cleaned up.
 */
export async function pruneOrphanedAttempts(options: PruneOrphansOptions): Promise<PruneReport> {
  const git = options.git ?? runGit;
  const platform = options.platform ?? process.platform;
  const isLive = options.isLive ?? isAttemptOwnerLive;
  const directory = path.join(options.worktreesRoot, options.projectId);
  const report = { removedWorktrees: [] as string[], revertedScoped: [] as PruneReport["revertedScoped"][number][], live: [] as string[], unknown: [] as string[] };
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return report;
  }
  const owned = new Set<string>();
  for (const name of names.filter((entry) => entry.endsWith(".owner.json"))) {
    const attemptId = name.slice(0, -".owner.json".length);
    owned.add(attemptId);
    const owner = parseOwner(await readJson(path.join(directory, name)));
    if (owner === undefined) {
      report.unknown.push(attemptId);
      continue;
    }
    if (isLive(owner)) {
      report.live.push(attemptId);
      continue;
    }
    const target = path.join(directory, attemptId);
    try {
      await git(["worktree", "remove", "--force", target], options.workspaceRoot);
    } catch {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(path.join(directory, name), { force: true }).catch(() => undefined);
    report.removedWorktrees.push(attemptId);
  }
  for (const name of names.filter((entry) => entry.endsWith(".scoped"))) {
    const attemptId = name.slice(0, -".scoped".length);
    const scoped = path.join(directory, name);
    const owner = parseOwner(await readJson(path.join(scoped, SCOPED_OWNER_FILE)));
    if (owner === undefined) {
      report.unknown.push(attemptId);
      continue;
    }
    if (isLive(owner)) {
      report.live.push(attemptId);
      continue;
    }
    const state = ((await readJson(path.join(scoped, SCOPED_STATE_FILE))) as { state?: string } | undefined)?.state;
    const snapshot = await ScopedSnapshot.load(scoped, git);
    if (snapshot !== undefined && state !== "integrated") {
      if (!(await samePath(snapshot.workspaceRoot, options.workspaceRoot, platform))) {
        report.unknown.push(attemptId);
        continue;
      }
      const changed = [...(await snapshot.candidates())].sort();
      const inside = changed.filter((relative) => matchesAny(relative, snapshot.ownedPaths, platform));
      const outcome = await restorePaths(options.workspaceRoot, snapshot, inside, platform);
      report.revertedScoped.push({
        attemptId,
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
  await git(["worktree", "prune"], options.workspaceRoot).catch(() => undefined);
  return report;
}
