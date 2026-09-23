import { execFile } from "node:child_process";

/**
 * The narrow git surface isolation needs. It runs git with an argv array (never a shell), no
 * terminal prompts and a bounded buffer; a failure rejects with the command's stderr. Every
 * command runs with `core.longpaths=true` (ADR-19): a worktree under `<home>/.synorch/worktrees`
 * adds to every path's length, and Git for Windows otherwise fails on paths past MAX_PATH.
 */

export interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

export interface GitRunOptions {
  /** Written to the command's standard input (batch commands such as `hash-object --stdin-paths`). */
  readonly input?: Buffer | string;
}

export type GitRunner = (args: readonly string[], cwd: string, signal?: AbortSignal, options?: GitRunOptions) => Promise<GitResult>;

export class GitCommandError extends Error {
  public readonly args: readonly string[];
  public readonly exitCode: number | undefined;
  /** The spawn error code (`ENOENT` when git is not installed), when git never ran. */
  public readonly spawnCode: string | undefined;

  public constructor(args: readonly string[], exitCode: number | undefined, stderr: string, spawnCode?: string) {
    super(`git ${args.join(" ")} failed${exitCode === undefined ? "" : ` (${exitCode})`}: ${stderr.trim()}`);
    this.name = "GitCommandError";
    this.args = args;
    this.exitCode = exitCode;
    this.spawnCode = spawnCode;
  }
}

/** Options every git invocation carries. */
export const GIT_BASE_OPTIONS = ["-c", "core.longpaths=true"] as const;

export const runGit: GitRunner = (args, cwd, signal, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...GIT_BASE_OPTIONS, ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr);
        if (error !== null) {
          const rawCode = (error as { code?: unknown }).code;
          const code = typeof rawCode === "number" ? rawCode : undefined;
          reject(new GitCommandError(args, code, stderrText || error.message, typeof rawCode === "string" ? rawCode : undefined));
          return;
        }
        resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)), stderr: stderrText });
      },
    );
    if (options?.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });

export async function gitText(git: GitRunner, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return (await git(args, cwd, signal)).stdout.toString("utf8").trim();
}

/** True when a git executable can be started at all. */
export async function gitAvailable(git: GitRunner, cwd: string): Promise<boolean> {
  try {
    await git(["--version"], cwd);
    return true;
  } catch (error: unknown) {
    return !(error instanceof GitCommandError && error.spawnCode !== undefined);
  }
}

/** The repository top level, or undefined when `cwd` is not inside a git work tree. */
export async function gitTopLevel(git: GitRunner, cwd: string): Promise<string | undefined> {
  try {
    const inside = await gitText(git, ["rev-parse", "--is-inside-work-tree"], cwd);
    if (inside !== "true") return undefined;
    return await gitText(git, ["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return undefined;
  }
}

export async function gitHead(git: GitRunner, cwd: string): Promise<string | undefined> {
  try {
    return await gitText(git, ["rev-parse", "--verify", "HEAD"], cwd);
  } catch {
    return undefined;
  }
}

/** Paths git considers changed or untracked (ignored files excluded), POSIX separators, as named on disk. */
export async function gitDirtyPaths(git: GitRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const output = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], cwd, signal)).stdout.toString("utf8");
  const paths: string[] = [];
  for (const entry of output.split("\0")) {
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
  }
  return paths;
}

/** Raw blob bytes at `HEAD`, or undefined when the path does not exist there. */
export async function gitShowHead(git: GitRunner, cwd: string, relative: string): Promise<Buffer | undefined> {
  try {
    return (await git(["cat-file", "blob", `HEAD:${relative}`], cwd)).stdout;
  } catch {
    return undefined;
  }
}

/**
 * The bytes a checkout of `<rev>:<relative>` writes in the work tree at `cwd`: the blob through
 * that tree's smudge filter and EOL conversion (`cat-file --filters`). Undefined when absent.
 */
export async function gitShowFiltered(git: GitRunner, cwd: string, rev: string, relative: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  try {
    return (await git(["cat-file", "--filters", `${rev}:${relative}`], cwd, signal)).stdout;
  } catch {
    return undefined;
  }
}

/** The work-tree bytes of blob `oid` checked out at `relative` in the tree at `cwd` (smudge + EOL). */
export async function gitSmudgeBlob(git: GitRunner, cwd: string, oid: string, relative: string, signal?: AbortSignal): Promise<Buffer> {
  return (await git(["cat-file", "--filters", `--path=${relative}`, oid], cwd, signal)).stdout;
}

export interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

const PATHSPEC_CHUNK = 100;

/** Tree entries of `rev` for exactly `paths` (literal pathspecs); a path absent from `rev` is missing from the map. */
export async function gitTreeEntries(git: GitRunner, cwd: string, rev: string, paths: readonly string[], signal?: AbortSignal): Promise<Map<string, GitTreeEntry>> {
  const entries = new Map<string, GitTreeEntry>();
  for (let index = 0; index < paths.length; index += PATHSPEC_CHUNK) {
    const chunk = paths.slice(index, index + PATHSPEC_CHUNK);
    const output = (await git(["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", rev, "--", ...chunk], cwd, signal)).stdout.toString("utf8");
    for (const record of output.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab === -1) continue;
      const [mode = "", type = "", oid = ""] = record.slice(0, tab).split(" ");
      entries.set(record.slice(tab + 1), { mode, type, oid });
    }
  }
  return entries;
}

/** Paths recorded in the index, POSIX separators. */
export async function gitTrackedPaths(git: GitRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const output = (await git(["ls-files", "-z"], cwd, signal)).stdout.toString("utf8");
  return output.split("\0").filter((entry) => entry.length > 0);
}

/** Gitlink (submodule, mode 160000) paths recorded in the index. */
export async function gitSubmodulePaths(git: GitRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const output = (await git(["ls-files", "--stage", "-z"], cwd, signal)).stdout.toString("utf8");
  const paths: string[] = [];
  for (const record of output.split("\0")) {
    if (!record.startsWith("160000 ")) continue;
    const tab = record.indexOf("\t");
    if (tab !== -1) paths.push(record.slice(tab + 1));
  }
  return paths;
}

/**
 * Blob ids git would store for the files at `paths` in the tree at `cwd` (clean filter and EOL
 * conversion of that tree). With `write`, the blobs are also written to the object database.
 */
export async function gitHashObjects(git: GitRunner, cwd: string, paths: readonly string[], options: { readonly write?: boolean; readonly signal?: AbortSignal } = {}): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const write = options.write === true ? ["-w"] : [];
  const batch = paths.filter((relative) => !relative.includes("\n") && !relative.includes("\r"));
  if (batch.length > 0) {
    const output = (await git(["hash-object", ...write, "--stdin-paths"], cwd, options.signal, { input: `${batch.join("\n")}\n` })).stdout.toString("utf8");
    const oids = output.split("\n").filter((line) => line.length > 0);
    batch.forEach((relative, index) => {
      const oid = oids[index];
      if (oid !== undefined) result.set(relative, oid.trim());
    });
  }
  for (const relative of paths.filter((candidate) => !batch.includes(candidate))) {
    result.set(relative, (await gitText(git, ["hash-object", ...write, `--path=${relative}`, "--", relative], cwd, options.signal)));
  }
  return result;
}

/** The blob id of `bytes` as if stored at `relative` in the tree at `cwd` (never written). */
export async function gitHashBytes(git: GitRunner, cwd: string, relative: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
  return (await git(["hash-object", "--stdin", `--path=${relative}`], cwd, signal, { input: bytes })).stdout.toString("utf8").trim();
}

/**
 * The subset of `paths` git ignores in the tree at `cwd`, honouring the index: a tracked file is
 * never ignored. The paths need not exist.
 */
export async function gitIgnoredSubset(git: GitRunner, cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  try {
    const output = (await git(["check-ignore", "--stdin", "-z"], cwd, signal, { input: `${paths.join("\0")}\0` })).stdout.toString("utf8");
    return new Set(output.split("\0").filter((entry) => entry.length > 0));
  } catch (error: unknown) {
    if (error instanceof GitCommandError && error.exitCode === 1) return new Set();
    throw error;
  }
}

/**
 * Ignored, untracked entries (files, or whole directories collapsed with a trailing `/`), POSIX
 * separators. Used to see which ignored paths a changed `.gitignore` would expose, which ignored
 * directories a scoped snapshot skips and which dependency directories a worktree links.
 */
export async function gitIgnoredEntries(git: GitRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const output = (await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], cwd, signal)).stdout.toString("utf8");
  return output.split("\0").filter((entry) => entry.length > 0);
}

/** The subset of `paths` the ignore rules under `cwd` match (`--no-index`: the paths need not be tracked or exist). */
export async function gitCheckIgnored(git: GitRunner, cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  try {
    const output = (await git(["check-ignore", "--no-index", "--stdin", "-z"], cwd, signal, { input: `${paths.join("\0")}\0` })).stdout.toString("utf8");
    return new Set(output.split("\0").filter((entry) => entry.length > 0));
  } catch (error: unknown) {
    // Exit code 1 means that none of the paths is ignored.
    if (error instanceof GitCommandError && error.exitCode === 1) return new Set();
    throw error;
  }
}
