import { lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import { gitDirtyPaths, gitHead, gitShowHead, gitTopLevel, runGit, type GitRunner } from "./git.ts";
import { findScopeViolations, matchesAny, normalizeWorkspacePath } from "./paths.ts";

/**
 * Per-attempt isolation (ADR-07).
 *
 * - `worktree`: a detached git worktree at `<home>/.synorch/worktrees/<project-id>/<attempt-id>`
 *   on `HEAD`; the main workspace is untouched until `integrate`.
 * - `scoped-dir`: writes happen in place, limited by policy to `owned_paths`; the pre-attempt
 *   content of every path is kept so the attempt can be reverted. Used when the workspace is not
 *   a git repository or the user's uncommitted changes overlap the owned paths.
 * - `shared-read-only`: explorers and reviewers; nothing may change.
 *
 * Every workspace can pin its changes as an artifact: a canonical JSON document of
 * `{path, before, after, content}` entries whose sha256 is the artifact digest a review binds to.
 */

export const ARTIFACT_FORMAT = "synorch.artifact/v1";
export const ARTIFACT_MEDIA_TYPE = "application/vnd.synorch.artifact+json";

const WALK_SKIP = new Set([".git", ".synorch", "node_modules"]);

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

function isolationError(code: "sandbox_insufficient" | "verification_failed" | "policy_denied" | "internal", message: string): HarnessError {
  return new HarnessError({ code, message, workspace_effect: "none", retry_safe: code !== "policy_denied" });
}

function digestBytes(bytes: Buffer | null | undefined): Digest | null {
  return bytes === null || bytes === undefined ? null : sha256(bytes);
}

async function readBytes(file: string): Promise<Buffer | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

function resolveInside(root: string, relative: string): string {
  const normalized = normalizeWorkspacePath(relative);
  if (normalized === undefined || normalized === "." || isReservedWritePattern(normalized)) {
    throw isolationError("policy_denied", `refusing to touch ${relative}`);
  }
  return path.join(root, ...normalized.split("/"));
}

async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.synorch-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function walk(root: string, relative = ""): Promise<string[]> {
  const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (WALK_SKIP.has(entry.name)) continue;
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function samePath(left: string, right: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const a = await realpath(left);
    const b = await realpath(right);
    return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
  /** Pre-attempt bytes; `undefined` when no copy was kept (never for owned paths). */
  beforeContent(relative: string): Promise<Buffer | null | undefined>;
  candidates(signal: AbortSignal): Promise<readonly string[]>;
}

export function createIsolationProvider(deps: IsolationProviderDependencies): OrchestrationIsolationProvider {
  const git = deps.git ?? runGit;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const activeScoped = new Set<OrchestratedWorkspace>();
  /** After-digests of paths this provider integrated; such dirty paths are ours, not the user's. */
  const integrated = new Map<string, Digest | null>();

  const worktreePath = (attemptId: AttemptId): string => path.join(home, ".synorch", "worktrees", deps.projectId, attemptId);

  const pinned = async (
    workspace: { readonly mode: IsolatedWorkspace["mode"]; readonly root: string; readonly baseCommit: string | undefined; readonly self: () => OrchestratedWorkspace },
    baseline: Baseline | undefined,
    signal: AbortSignal,
  ): Promise<ChangeSet> => {
    const changes: ArtifactChange[] = [];
    const contents = new Map<string, Buffer | null>();
    if (baseline !== undefined) {
      const others = [...activeScoped].filter((other) => other !== workspace.self());
      const candidates = [...new Set(await baseline.candidates(signal))].sort();
      for (const relative of candidates) {
        const normalized = normalizeWorkspacePath(relative);
        if (normalized === undefined) continue;
        if (workspace.mode === "scoped-dir" && others.some((other) => matchesAny(normalized, other.ownedPaths, platform))) continue;
        const before = await baseline.beforeDigest(normalized);
        const current = await readBytes(path.join(workspace.root, ...normalized.split("/")));
        const after = digestBytes(current);
        if (before === after) continue;
        changes.push({ path: normalized, before, after });
        contents.set(normalized, current);
      }
    }
    const artifactBytes = encodeArtifact(workspace.mode, workspace.baseCommit, changes, contents);
    const artifactDigest = sha256(artifactBytes);
    if (deps.blobs !== undefined) await deps.blobs.put(artifactBytes, ARTIFACT_MEDIA_TYPE);
    return { artifactDigest, artifactBytes, changes, contents };
  };

  const build = (
    attemptId: AttemptId,
    packet: TaskContextPacket,
    mode: IsolatedWorkspace["mode"],
    root: string,
    baseCommit: string | undefined,
    baseline: Baseline | undefined,
    cleanup: () => Promise<void>,
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
        const restored: string[] = [];
        for (const change of set.changes) {
          const target = resolveInside(root, change.path);
          const original = await baseline.beforeContent(change.path);
          if (original === undefined) continue;
          if (original === null) await removeFile(target);
          else await writeAtomic(target, original);
          restored.push(change.path);
        }
        return restored;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        activeScoped.delete(workspace);
        await cleanup();
      },
    };
    if (mode === "scoped-dir") activeScoped.add(workspace);
    return workspace;
  };

  const gitBaseline = async (root: string, signal: AbortSignal, snapshotDirty: boolean): Promise<Baseline> => {
    const dirty = new Map<string, Buffer | null>();
    if (snapshotDirty) {
      for (const relative of await gitDirtyPaths(git, root, signal)) {
        dirty.set(relative, await readBytes(path.join(root, ...relative.split("/"))));
      }
    }
    const content = async (relative: string): Promise<Buffer | null> => {
      if (dirty.has(relative)) return dirty.get(relative) ?? null;
      return (await gitShowHead(git, root, relative)) ?? null;
    };
    return {
      beforeContent: content,
      beforeDigest: async (relative) => digestBytes(await content(relative)),
      async candidates(inner) {
        return [...(await gitDirtyPaths(git, root, inner)), ...dirty.keys()];
      },
    };
  };

  const manifestBaseline = async (root: string, owned: readonly string[]): Promise<Baseline> => {
    const digests = new Map<string, Digest>();
    const kept = new Map<string, Buffer>();
    for (const relative of await walk(root)) {
      const bytes = await readBytes(path.join(root, ...relative.split("/")));
      if (bytes === null) continue;
      digests.set(relative, sha256(bytes));
      if (matchesAny(relative, owned, platform)) kept.set(relative, bytes);
    }
    return {
      async beforeContent(relative) {
        const bytes = kept.get(relative);
        if (bytes !== undefined) return bytes;
        return digests.has(relative) ? undefined : null;
      },
      async beforeDigest(relative) {
        return digests.get(relative) ?? null;
      },
      async candidates() {
        const now = await walk(root);
        const changed = new Set<string>();
        for (const relative of now) {
          const bytes = await readBytes(path.join(root, ...relative.split("/")));
          if (bytes === null) continue;
          if (digests.get(relative) !== sha256(bytes)) changed.add(relative);
        }
        for (const relative of digests.keys()) if (!now.includes(relative)) changed.add(relative);
        return [...changed];
      },
    };
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
          const current = digestBytes(await readBytes(path.join(deps.workspaceRoot, ...relative.split("/"))));
          if (integrated.has(relative) && integrated.get(relative) === current) ours.push(relative);
        }
        const overlap = dirty.filter((relative) => !ours.includes(relative) && matchesAny(relative, packet.scope.owned_paths, platform));
        if (overlap.length > 0) reason = `uncommitted changes overlap owned paths (${overlap.slice(0, 5).join(", ")})`;
      }
      if (packet.isolation === "worktree" && reason === undefined && head !== undefined) {
        const target = worktreePath(attemptId);
        await mkdir(path.dirname(target), { recursive: true });
        await git(["worktree", "add", "--detach", target, head], deps.workspaceRoot, signal);
        for (const relative of ours) {
          const bytes = await readBytes(path.join(deps.workspaceRoot, ...relative.split("/")));
          const destination = resolveInside(target, relative);
          if (bytes === null) await removeFile(destination);
          else await writeAtomic(destination, bytes);
        }
        const baseline = await gitBaseline(target, signal, ours.length > 0);
        return build(attemptId, packet, "worktree", target, head, baseline, async () => {
          try {
            await git(["worktree", "remove", "--force", target], deps.workspaceRoot);
          } catch {
            await rm(target, { recursive: true, force: true });
            await git(["worktree", "prune"], deps.workspaceRoot).catch(() => undefined);
          }
        });
      }
      if (packet.risk === "high-risk") {
        throw isolationError("sandbox_insufficient", `high-risk writing task requires a worktree, but ${reason ?? "scoped-dir was requested"}`);
      }
      const baseline =
        isGitRoot && head !== undefined
          ? await gitBaseline(deps.workspaceRoot, signal, true)
          : await manifestBaseline(deps.workspaceRoot, packet.scope.owned_paths);
      return build(attemptId, packet, "scoped-dir", deps.workspaceRoot, head, baseline, async () => {});
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
        set.changes.map((change) => change.path),
        { owned: orchestrated.ownedPaths, forbidden: orchestrated.forbiddenPaths },
        platform,
      );
      if (violations.length > 0) {
        throw isolationError("policy_denied", `artifact touches paths outside the owned scope: ${violations.map((v) => `${v.path} (${v.reason})`).join(", ")}`);
      }
      if (workspace.mode === "shared-read-only") {
        if (set.changes.length > 0) throw isolationError("policy_denied", "a read-only workspace has changes");
        return;
      }
      if (workspace.mode === "scoped-dir") {
        for (const change of set.changes) integrated.set(change.path, change.after);
        return;
      }
      const conflicts: string[] = [];
      for (const change of set.changes) {
        const current = digestBytes(await readBytes(resolveInside(deps.workspaceRoot, change.path)));
        if (current !== change.before) conflicts.push(change.path);
      }
      if (conflicts.length > 0) {
        throw isolationError("verification_failed", `integration conflict: the main workspace changed at ${conflicts.join(", ")}`);
      }
      for (const change of set.changes) {
        const target = resolveInside(deps.workspaceRoot, change.path);
        const content = set.contents.get(change.path);
        if (content === null || content === undefined) await removeFile(target);
        else await writeAtomic(target, content);
        integrated.set(change.path, change.after);
      }
    },
    async seed(workspace, artifactBytes) {
      if (workspace.mode === "shared-read-only") throw isolationError("policy_denied", "cannot seed a read-only workspace");
      const document = decodeArtifact(artifactBytes);
      for (const change of document.changes) {
        const target = resolveInside(workspace.root, change.path);
        if (change.content === null) await removeFile(target);
        else await writeAtomic(target, Buffer.from(change.content, "base64"));
      }
    },
  };
}
