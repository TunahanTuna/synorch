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

/** `/review` with nothing uncommitted: the last commit's diff (subject line first), bounded; undefined without one. */
export async function lastCommitDiff(cwd: string, limitBytes: number, signal?: AbortSignal): Promise<{ readonly text: string; readonly subject: string } | undefined> {
  const shown = await git(cwd, ["show", "HEAD", "--no-color", "--no-ext-diff", "--format=%h %s"], signal);
  if (!shown.ok || shown.stdout.trim() === "") return undefined;
  const subject = shown.stdout.split(/\r?\n/, 1)[0] ?? "HEAD";
  const truncated = Buffer.byteLength(shown.stdout, "utf8") > limitBytes;
  return { text: truncated ? `${Buffer.from(shown.stdout, "utf8").subarray(0, limitBytes).toString("utf8")}\n… (diff truncated)` : shown.stdout, subject };
}

/** Commits every uncommitted change with `message` (the human confirmed both). */
export async function commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<GitResult> {
  const add = await git(cwd, ["add", "-A"], signal);
  if (!add.ok) return add;
  return git(cwd, ["commit", "-m", message], signal);
}

/** Pathspecs of one `git status --porcelain` entry: both sides of a rename or copy (`old -> new`). */
export function changePathspecs(entry: { readonly path: string }): string[] {
  return entry.path.split(" -> ").map((part) => part.replace(/^"|"$/g, "")).filter((part) => part !== "");
}

/**
 * `/commit` with a selection: stages the chosen entries only and commits exactly those paths (a
 * pathspec commit), so other staged or unstaged changes stay out of the commit.
 */
export async function commitSelected(cwd: string, message: string, entries: readonly { readonly path: string }[], signal?: AbortSignal): Promise<GitResult> {
  const paths = [...new Set(entries.flatMap(changePathspecs))];
  if (paths.length === 0) return { ok: false, stdout: "", stderr: "no files selected" };
  const add = await git(cwd, ["add", "-A", "--", ...paths], signal);
  if (!add.ok) return add;
  return git(cwd, ["commit", "-m", message, "--", ...paths], signal);
}

/** Commits made after `since` (ISO time), newest first, one line each. */
export async function commitsSince(cwd: string, since: string, signal?: AbortSignal): Promise<string[]> {
  const log = await git(cwd, ["log", `--since=${since}`, "--format=%h %s", "-n", "20"], signal);
  return log.ok ? log.stdout.split(/\r?\n/).filter((line) => line.trim() !== "") : [];
}

/** What `/review` pins: the full diff of one target (generated files left out), its files, and the target with commits resolved. */
export interface ReviewDiff {
  readonly text: string;
  readonly files: readonly string[];
  readonly excluded: readonly string[];
  readonly label: string;
  /** The target with its commits resolved to ids, so recomputing the digest reads the same content. */
  readonly resolved: ReviewDiffTarget;
}

export type ReviewDiffTarget =
  | { readonly kind: "workspace"; readonly paths?: readonly string[] }
  | { readonly kind: "staged" }
  | { readonly kind: "commit"; readonly rev: string }
  | { readonly kind: "range"; readonly from: string; readonly to: string; readonly symmetric: boolean };

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--relative"] as const;

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function excludePathspecs(paths: readonly string[]): string[] {
  return paths.map((entry) => `:(exclude,literal)${entry}`);
}

async function revParse(cwd: string, rev: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], signal);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

/**
 * The full diff of a `/review` target, workspace-relative, with generated files (`isGenerated`)
 * listed but left out. A string result is why it cannot be read (not a repository, an unknown
 * commit). The workspace target includes untracked files as new-file diffs.
 */
export async function reviewDiff(cwd: string, target: ReviewDiffTarget, isGenerated: (path: string) => boolean, signal?: AbortSignal): Promise<ReviewDiff | string> {
  const split = (names: readonly string[]) => ({ files: names.filter((name) => !isGenerated(name)), excluded: names.filter((name) => isGenerated(name)) });
  switch (target.kind) {
    case "workspace": {
      const scope = target.paths === undefined || target.paths.length === 0 ? ["."] : [...target.paths];
      let head = ["HEAD"];
      let names = await git(cwd, ["diff", ...head, "--name-only", "--relative", "--", ...scope], signal);
      if (!names.ok) {
        head = [];
        names = await git(cwd, ["diff", "--name-only", "--relative", "--", ...scope], signal);
        if (!names.ok) return "not a git repository";
      }
      const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...scope], signal);
      const tracked = split(nonEmptyLines(names.stdout));
      const fresh = split(untracked.ok ? nonEmptyLines(untracked.stdout) : []);
      let text = tracked.files.length === 0 ? "" : (await git(cwd, ["diff", ...head, ...DIFF_FLAGS, "--", ...scope, ...excludePathspecs(tracked.excluded)], signal)).stdout;
      for (const file of fresh.files) text += (await git(cwd, ["diff", "--no-color", "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", file], signal)).stdout;
      return { text, files: [...tracked.files, ...fresh.files], excluded: [...tracked.excluded, ...fresh.excluded], label: target.paths === undefined ? "uncommitted changes" : "worker run changes", resolved: target };
    }
    case "staged": {
      const names = await git(cwd, ["diff", "--cached", "--name-only", "--relative"], signal);
      if (!names.ok) return "not a git repository";
      const { files, excluded } = split(nonEmptyLines(names.stdout));
      const text = files.length === 0 ? "" : (await git(cwd, ["diff", "--cached", ...DIFF_FLAGS, "--", ".", ...excludePathspecs(excluded)], signal)).stdout;
      return { text, files, excluded, label: "staged changes", resolved: target };
    }
    case "commit": {
      const sha = await revParse(cwd, target.rev, signal);
      if (sha === undefined) return `unknown commit ${target.rev}`;
      const subject = await git(cwd, ["log", "-1", "--format=%h %s", sha], signal);
      const names = await git(cwd, ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "--relative", sha], signal);
      const { files, excluded } = split(nonEmptyLines(names.stdout));
      const text = files.length === 0 ? "" : (await git(cwd, ["diff-tree", "-r", "-p", "--root", "--no-commit-id", ...DIFF_FLAGS, sha, "--", ".", ...excludePathspecs(excluded)], signal)).stdout;
      return { text, files, excluded, label: `commit ${subject.ok ? subject.stdout.trim().slice(0, 80) : sha.slice(0, 7)}`, resolved: { kind: "commit", rev: sha } };
    }
    case "range": {
      const from = await revParse(cwd, target.from, signal);
      const to = await revParse(cwd, target.to, signal);
      if (from === undefined || to === undefined) return `unknown commit ${from === undefined ? target.from : target.to}`;
      const spec = target.symmetric ? [`${from}...${to}`] : [from, to];
      const names = await git(cwd, ["diff", "--name-only", "--relative", ...spec], signal);
      if (!names.ok) return names.stderr.trim() || "git diff failed";
      const { files, excluded } = split(nonEmptyLines(names.stdout));
      const text = files.length === 0 ? "" : (await git(cwd, ["diff", ...DIFF_FLAGS, ...spec, "--", ".", ...excludePathspecs(excluded)], signal)).stdout;
      return { text, files, excluded, label: `${target.from}${target.symmetric ? "..." : ".."}${target.to}`, resolved: { kind: "range", from, to, symmetric: target.symmetric } };
    }
  }
}
