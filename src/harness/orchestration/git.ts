import { execFile } from "node:child_process";

/**
 * The narrow git surface isolation needs. It runs git with an argv array (never a shell), no
 * terminal prompts and a bounded buffer; a failure rejects with the command's stderr.
 */

export interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<GitResult>;

export class GitCommandError extends Error {
  public readonly args: readonly string[];
  public readonly exitCode: number | undefined;

  public constructor(args: readonly string[], exitCode: number | undefined, stderr: string) {
    super(`git ${args.join(" ")} failed${exitCode === undefined ? "" : ` (${exitCode})`}: ${stderr.trim()}`);
    this.name = "GitCommandError";
    this.args = args;
    this.exitCode = exitCode;
  }
}

export const runGit: GitRunner = (args, cwd, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
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
          const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : undefined;
          reject(new GitCommandError(args, code, stderrText || error.message));
          return;
        }
        resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)), stderr: stderrText });
      },
    );
  });

export async function gitText(git: GitRunner, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return (await git(args, cwd, signal)).stdout.toString("utf8").trim();
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

/** Paths git considers changed or untracked (ignored files excluded), POSIX separators. */
export async function gitDirtyPaths(git: GitRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const output = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], cwd, signal)).stdout.toString("utf8");
  const paths: string[] = [];
  for (const entry of output.split("\0")) {
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
  }
  return paths;
}

/** File bytes at `HEAD`, or undefined when the path does not exist there. */
export async function gitShowHead(git: GitRunner, cwd: string, relative: string): Promise<Buffer | undefined> {
  try {
    return (await git(["cat-file", "blob", `HEAD:${relative}`], cwd)).stdout;
  } catch {
    return undefined;
  }
}
