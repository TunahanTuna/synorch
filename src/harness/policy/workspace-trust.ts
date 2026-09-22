import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HarnessError, TRUST_GRANT_SOURCES, type TrustGrantSource, type WorkspaceTrustState } from "../contracts/index.ts";

/**
 * Workspace trust (SEC-N1). Without a full OS sandbox, a build or test command runs repository
 * code with the user's permissions. Such commands run only in a workspace the user trusted once.
 *
 * - The record lives only in the user scope: `<synorch home>/trust.json`. A home that lies inside
 *   the workspace is refused, so repository content can never supply or grant trust.
 * - A record is keyed by the canonical workspace root and a repository identity (the git
 *   directory's, or the root's, file id and creation time), so a different repository cloned to a
 *   trusted path later is not trusted.
 * - Reading fails closed: a missing, linked or unreadable file means untrusted.
 */

export const TRUST_FILE = "trust.json";

const trustRecordSchema = z.strictObject({
  root: z.string().min(1).max(4096),
  identity: z.string().regex(/^(git|dir):[0-9a-f]{64}$/),
  granted_at: z.string().min(1).max(64),
  granted_by: z.enum(TRUST_GRANT_SOURCES),
});
const trustFileSchema = z.strictObject({ schema_version: z.literal(1), workspaces: z.array(trustRecordSchema).max(10_000) });
type TrustFile = z.infer<typeof trustFileSchema>;

export interface WorkspaceIdentity {
  /** Canonical absolute root (links resolved, case-folded where the file system ignores case). */
  readonly root: string;
  readonly identity: string;
}

export interface WorkspaceTrustStore {
  /** `<home>/trust.json`. */
  readonly file: string;
  status(workspaceRoot: string): WorkspaceTrustState;
  grant(workspaceRoot: string, source: TrustGrantSource): Promise<WorkspaceTrustState>;
  /** Removes every record for the workspace root; `removed` is false when none existed. */
  revoke(workspaceRoot: string): Promise<{ readonly removed: boolean; readonly state: WorkspaceTrustState }>;
}

export interface WorkspaceTrustOptions {
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
}

function foldCase(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
}

function canonical(target: string, platform: NodeJS.Platform): string {
  let resolved = path.resolve(target);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // A missing path keeps its lexical form; it cannot match a record made for an existing one.
  }
  return foldCase(resolved, platform);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The git directory of a workspace (a `.git` directory, or the target of a `.git` file), if any. */
function gitDirectory(root: string): string | undefined {
  const dotGit = path.join(root, ".git");
  try {
    const entry = lstatSync(dotGit);
    if (entry.isDirectory()) return dotGit;
    if (entry.isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8").slice(0, 4096));
      if (match?.[1] !== undefined) return path.resolve(root, match[1]);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Canonical root and repository identity of a workspace. */
export function workspaceIdentity(workspaceRoot: string, platform: NodeJS.Platform = process.platform): WorkspaceIdentity {
  const root = canonical(workspaceRoot, platform);
  const git = gitDirectory(root);
  const kind = git === undefined ? "dir" : "git";
  const subject = git === undefined ? root : canonical(git, platform);
  let fileId = "missing";
  try {
    const stats = statSync(subject, { bigint: true });
    fileId = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
  } catch {
    // A missing root still gets a stable (never matching) identity.
  }
  const digest = createHash("sha256").update(JSON.stringify([kind, subject, fileId])).digest("hex");
  return { root, identity: `${kind}:${digest}` };
}

export function createWorkspaceTrustStore(home: string, options: WorkspaceTrustOptions = {}): WorkspaceTrustStore {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const file = path.join(path.resolve(home), TRUST_FILE);

  const homeInside = (root: string): boolean => isInside(root, canonical(home, platform));

  const read = (): { readonly data: TrustFile; readonly problem: string | undefined } => {
    const empty: TrustFile = { schema_version: 1, workspaces: [] };
    let entry;
    try {
      entry = lstatSync(file);
    } catch {
      return { data: empty, problem: undefined };
    }
    if (!entry.isFile()) return { data: empty, problem: `${file} is not a regular file` };
    try {
      const parsed = trustFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      return parsed.success ? { data: parsed.data, problem: undefined } : { data: empty, problem: `${file} is not a valid trust file` };
    } catch {
      return { data: empty, problem: `${file} is unreadable` };
    }
  };

  const status = (workspaceRoot: string): WorkspaceTrustState => {
    const { root, identity } = workspaceIdentity(workspaceRoot, platform);
    const untrusted = (reason: string): WorkspaceTrustState => ({ trusted: false, source: undefined, root, identity, reason });
    if (homeInside(root)) return untrusted("the Synorch home lies inside the workspace, so its trust file could come from the repository");
    const { data, problem } = read();
    if (problem !== undefined) return untrusted(problem);
    const records = data.workspaces.filter((record) => record.root === root);
    if (records.some((record) => record.identity === identity)) return { trusted: true, source: "store", root, identity, reason: undefined };
    return untrusted(records.length > 0 ? "the repository at this path changed since it was trusted" : "the workspace has not been trusted");
  };

  const persist = async (data: TrustFile): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const writable = (root: string): TrustFile => {
    if (homeInside(root)) {
      throw new HarnessError({
        code: "config_invalid",
        message: `the Synorch home ${home} lies inside the workspace ${root}; trust is stored only in the user scope, outside any repository`,
        workspace_effect: "none",
        retry_safe: false,
      });
    }
    const { data, problem } = read();
    if (problem !== undefined) {
      throw new HarnessError({ code: "config_invalid", message: `${problem}; fix or delete it first`, workspace_effect: "none", retry_safe: false });
    }
    return data;
  };

  return {
    file,
    status,
    async grant(workspaceRoot, source) {
      const { root, identity } = workspaceIdentity(workspaceRoot, platform);
      const data = writable(root);
      const workspaces = data.workspaces.filter((record) => record.root !== root);
      workspaces.push({ root, identity, granted_at: now().toISOString(), granted_by: source });
      await persist({ schema_version: 1, workspaces });
      return status(workspaceRoot);
    },
    async revoke(workspaceRoot) {
      const { root } = workspaceIdentity(workspaceRoot, platform);
      const data = writable(root);
      const workspaces = data.workspaces.filter((record) => record.root !== root);
      const removed = workspaces.length !== data.workspaces.length;
      if (removed) await persist({ schema_version: 1, workspaces });
      return { removed, state: status(workspaceRoot) };
    },
  };
}
