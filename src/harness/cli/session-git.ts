import { execFile } from "node:child_process";

/**
 * Git reads and the one human-confirmed mutation (`/commit`) of the conversation's slash commands.
 * These run as harness commands on the user's explicit request, never as agent tool calls: the
 * agent's own git mutations stay refused by policy (ADR-21 D3); `/commit` commits only after the
 * human confirms the shown diff summary and message (ADR-21 open question 2, K2).
 */

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export function git(cwd: string, args: readonly string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...(signal === undefined ? {} : { signal }), env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout, stderr) => resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

export interface ChangeSummary {
  readonly files: readonly { readonly status: string; readonly path: string }[];
  readonly stat: string;
}

/** `git status --porcelain` + `git diff HEAD --stat`; undefined outside a git repository. */
export async function uncommittedChanges(cwd: string, signal?: AbortSignal): Promise<ChangeSummary | undefined> {
  const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
  if (!status.ok) return undefined;
  const files = status.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => ({ status: line.slice(0, 2).trim() || "?", path: line.slice(3).replace(/^"|"$/g, "") }));
  const stat = await git(cwd, ["diff", "HEAD", "--stat", "--no-color"], signal);
  return { files, stat: stat.ok ? stat.stdout.trim() : "" };
}

/** The uncommitted diff (tracked changes against HEAD, plus untracked files as new-file diffs), bounded. */
export async function uncommittedDiff(cwd: string, limitBytes: number, signal?: AbortSignal): Promise<{ readonly text: string; readonly truncated: boolean } | undefined> {
  const tracked = await git(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff"], signal);
  if (!tracked.ok) {
    const noHead = await git(cwd, ["diff", "--no-color", "--no-ext-diff"], signal);
    if (!noHead.ok) return undefined;
  }
  let text = tracked.stdout;
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"], signal);
  for (const file of untracked.ok ? untracked.stdout.split(/\r?\n/).filter((line) => line !== "") : []) {
    if (Buffer.byteLength(text, "utf8") > limitBytes) break;
    const added = await git(cwd, ["diff", "--no-color", "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", file], signal);
    text += added.stdout;
  }
  const truncated = Buffer.byteLength(text, "utf8") > limitBytes;
  return { text: truncated ? `${Buffer.from(text, "utf8").subarray(0, limitBytes).toString("utf8")}\n… (diff truncated)` : text, truncated };
}

/** Commits every uncommitted change with `message` (the human confirmed both). */
export async function commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<GitResult> {
  const add = await git(cwd, ["add", "-A"], signal);
  if (!add.ok) return add;
  return git(cwd, ["commit", "-m", message], signal);
}

/** Commits made after `since` (ISO time), newest first, one line each. */
export async function commitsSince(cwd: string, since: string, signal?: AbortSignal): Promise<string[]> {
  const log = await git(cwd, ["log", `--since=${since}`, "--format=%h %s", "-n", "20"], signal);
  return log.ok ? log.stdout.split(/\r?\n/).filter((line) => line.trim() !== "") : [];
}
