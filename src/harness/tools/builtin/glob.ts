import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AGENT_ROLES, foldPathCase, matchesPathPattern, type Tool, type ToolExecutionContext } from "../../contracts/index.ts";
import { childEnvironment } from "../environment.ts";
import { resolveWorkspacePath } from "../workspace-path.ts";
import { messageOf } from "./read-tools.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, GRANT_MATCH, okResult, readableByPolicy, scopeViolationResult } from "./shared.ts";

/**
 * K4.2 `glob`: file paths matching a pattern, newest first. Inside a git repository the candidate
 * list is `git ls-files --cached --others --exclude-standard` (so `.gitignore` is honoured and
 * untracked files are included); elsewhere a walk that skips `.git`, `node_modules` and `.synorch`.
 * Paths outside the read scope or forbidden by policy are never listed.
 */

const WALK_SKIPPED = new Set([".git", "node_modules", ".synorch"].map((name) => foldPathCase(name)));
const WALK_FILE_LIMIT = 200_000;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

const globInput = z.strictObject({
  pattern: z.string().trim().min(1).max(500),
  path: z.string().min(1).max(1024).default("."),
  max_results: z.int().min(1).max(5_000).default(500),
});
type GlobInput = z.infer<typeof globInput>;

export function createGlobTool(options: { readonly environment: Readonly<Record<string, string | undefined>> }): Tool<GlobInput> {
  const metadata = builtinMetadata({
    name: "glob",
    description:
      "Find files by glob pattern (`**/*.ts`, `src/**/*.{ts,tsx}`, `*.md`), newest first. A pattern without `/` matches file names at any depth. Honours .gitignore in git repositories; `path` narrows the search to a folder.",
    effect: "read",
    idempotent: true,
    network: "none",
    output_limit_bytes: 256 * 1024,
    timeout_ms: 60_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: [...AGENT_ROLES],
  });
  return defineTool(metadata, globInput, {
    async normalize(input, context) {
      const base = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
      return actionOf(metadata, input, context, { paths: [{ path: base.relative, access: "read" }] });
    },
    async execute(input, context) {
      try {
        const base = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
        const info = await stat(base.absolute).catch(() => undefined);
        if (info === undefined || !info.isDirectory()) return errorResult("invalid_arguments", `${base.relative} is not a folder`);
        const patterns = expandBraces(input.pattern.replaceAll("\\", "/").replace(/^\.\//, "")).map((pattern) => (pattern.includes("/") ? pattern : `**/${pattern}`));
        const listed = (await gitFiles(base.absolute, context, options)) ?? (await walkFiles(base.absolute, context.signal));
        const prefix = base.relative === "." ? "" : `${base.relative}/`;
        const matches: { path: string; mtime: number }[] = [];
        const candidates = listed.files.filter((file) => patterns.some((pattern) => matchesPathPattern(file, pattern, GRANT_MATCH)));
        for (const file of candidates) {
          if (context.signal.aborted) return errorResult("cancelled", "glob was cancelled");
          const relative = `${prefix}${file}`;
          if (!readableByPolicy(relative, context)) continue;
          const entry = await stat(path.join(base.absolute, file)).catch(() => undefined);
          if (entry === undefined || !entry.isFile()) continue;
          matches.push({ path: relative, mtime: entry.mtimeMs });
        }
        matches.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
        const shown = matches.slice(0, input.max_results);
        const source = listed.source === "git" ? "git ls-files, .gitignore honoured" : `folder walk${listed.capped ? `, stopped after ${WALK_FILE_LIMIT} files` : ""}`;
        if (shown.length === 0) return okResult(`no files match ${input.pattern}${base.relative === "." ? "" : ` in ${base.relative}`} (${source})`);
        const header = `${matches.length} file${matches.length === 1 ? "" : "s"} match ${input.pattern}${matches.length > shown.length ? `; showing the newest ${shown.length}` : ""} (newest first; ${source})`;
        return okResult([header, ...shown.map((entry) => entry.path)].join("\n"), { truncated: matches.length > shown.length });
      } catch (error: unknown) {
        return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
      }
    },
  });
}

interface Listing {
  readonly files: string[];
  readonly source: "git" | "walk";
  readonly capped: boolean;
}

async function gitFiles(cwd: string, context: ToolExecutionContext, options: { readonly environment: Readonly<Record<string, string | undefined>> }): Promise<Listing | undefined> {
  try {
    const result = await context.sandbox.run(
      {
        argv: ["git", "--no-optional-locks", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
        cwd,
        env: childEnvironment(options.environment, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }),
        stdin: undefined,
        timeoutMs: 30_000,
        outputLimitBytes: GIT_OUTPUT_LIMIT,
        writeRoots: [],
        network: "deny",
        untrustedRoots: [context.workspaceRoot],
      },
      context.signal,
    );
    if (result.termination !== "exited" || result.exitCode !== 0 || result.truncated) return undefined;
    return { files: result.stdout.split("\0").filter((entry) => entry.length > 0), source: "git", capped: false };
  } catch {
    return undefined;
  }
}

async function walkFiles(root: string, signal: AbortSignal): Promise<Listing> {
  const files: string[] = [];
  const pending: string[] = [""];
  let capped = false;
  while (pending.length > 0) {
    if (signal.aborted) break;
    const directory = pending.pop() ?? "";
    const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!WALK_SKIPPED.has(foldPathCase(entry.name))) pending.push(relative);
      } else if (entry.isFile()) {
        files.push(relative);
        if (files.length >= WALK_FILE_LIMIT) {
          capped = true;
          return { files, source: "walk", capped };
        }
      }
    }
  }
  return { files, source: "walk", capped };
}

/** `src/**\/*.{ts,tsx}` → `src/**\/*.ts`, `src/**\/*.tsx` (nested braces expand too; at most 64 results). */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1;
    if (pattern[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return [pattern];
  const options: string[] = [];
  let current = "";
  depth = 0;
  for (const character of pattern.slice(open + 1, close)) {
    if (character === "," && depth === 0) {
      options.push(current);
      current = "";
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    current += character;
  }
  options.push(current);
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return options.flatMap((option) => expandBraces(`${head}${option}${tail}`)).slice(0, 64);
}
