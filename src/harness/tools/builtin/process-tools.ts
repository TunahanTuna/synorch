import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AGENT_ROLES,
  matchesAnyPathPattern as matchesAny,
  READ_ONLY_ROLES,
  staticPrefix,
  type AgentRole,
  type ProcessResult,
  type Tool,
  type ToolExecutionContext,
  type ToolResult,
} from "../../contracts/index.ts";
import { childEnvironment, isBlockedEnvName } from "../environment.ts";
import { resolveWorkspacePath } from "../workspace-path.ts";
import { messageOf } from "./read-tools.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, NormalizedMemo, okResult, readableByPolicy, scopeViolationResult } from "./shared.ts";

export interface CommandScopeHint {
  readonly cwd: string;
  readonly writeScope: readonly string[];
  readonly forbidden: readonly string[];
}

/**
 * Optional classifier wired by the composition root (the policy module's `classifyCommand`), so
 * the recorded action already says `destructive`/`external-write`. The PolicyEngine re-classifies
 * every argv itself; this hint can only add to what it finds, never remove.
 */
export type CommandClassifierHint = (
  argv: readonly string[],
  scope: CommandScopeHint,
) => { readonly destructive: boolean; readonly effect: "exec" | "external-write" };

export interface ProcessToolOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly classifyCommand: CommandClassifierHint | undefined;
}

const STDIN_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "cmd", "powershell", "pwsh"]);

const execInput = z
  .strictObject({
    argv: z.array(z.string().max(32_768)).min(1).max(1024),
    cwd: z.string().min(1).max(1024).default("."),
    env: z
      .record(z.string().max(128), z.string().max(32_768))
      .default({})
      .refine((env) => Object.keys(env).every((name) => !isBlockedEnvName(name)), "env may not set loader, shell-hook, credential or path variables"),
    stdin: z.string().max(1024 * 1024).optional(),
    timeout_ms: z.int().min(100).max(600_000).optional(),
  })
  .superRefine((input, context) => {
    const program = programOf(input.argv[0] ?? "");
    if (program.length === 0) context.addIssue({ code: "custom", path: ["argv", 0], message: "argv[0] must name a program" });
    if (input.stdin !== undefined && STDIN_SHELLS.has(program)) {
      context.addIssue({ code: "custom", path: ["stdin"], message: "pass shell scripts inline (-c, /c, -Command) so policy can inspect them" });
    }
  });
type ExecInput = z.infer<typeof execInput>;

export function createExecTool(options: ProcessToolOptions): Tool<ExecInput> {
  const metadata = builtinMetadata({
    name: "exec",
    description: "Run a program with argv (no shell string), cwd, environment and timeout inside the sandbox.",
    effect: "exec",
    idempotent: false,
    network: "optional",
    output_limit_bytes: 1024 * 1024,
    timeout_ms: 600_000,
    cancellable: true,
    concurrency: "sequential",
    visible_to: ["implementer", "debugger", "reviewer"],
  });
  const memo = new NormalizedMemo<string>();
  return defineTool(metadata, execInput, {
    async normalize(input, context) {
      const cwd = await resolveWorkspacePath(context.workspaceRoot, input.cwd, "read");
      memo.remember(context.toolCallId, cwd.relative);
      const hint = options.classifyCommand?.(input.argv, {
        cwd: cwd.relative,
        writeScope: context.policy.write_scope,
        forbidden: context.policy.forbidden,
      });
      return actionOf(metadata, input, context, {
        paths: [{ path: cwd.relative, access: "read" }],
        command: { argv: input.argv, cwd: cwd.relative },
        destructive: hint?.destructive ?? false,
        effect: hint?.effect ?? "exec",
      });
    },
    async execute(input, context) {
      try {
        const approved = memo.take(context.toolCallId);
        const cwd = await resolveWorkspacePath(context.workspaceRoot, input.cwd, "read");
        if (approved === undefined || cwd.relative !== approved) {
          return errorResult("path_outside_scope", `${input.cwd} changed after the policy decision`);
        }
        if (!(await stat(cwd.absolute)).isDirectory()) return errorResult("invalid_arguments", `${cwd.relative} is not a directory`);
        const argv = input.argv as [string, ...string[]];
        const result = await context.sandbox.run(
          {
            argv,
            cwd: cwd.absolute,
            env: childEnvironment(options.environment, input.env),
            stdin: input.stdin,
            timeoutMs: Math.min(input.timeout_ms ?? metadata.timeout_ms, metadata.timeout_ms),
            outputLimitBytes: metadata.output_limit_bytes,
            writeRoots: writeRoots(context),
            network: context.policy.network.mode === "deny" ? "deny" : "allow",
          },
          context.signal,
        );
        return processOutcome(argv, result, context.signal);
      } catch (error: unknown) {
        return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
      }
    },
  });
}

const gitStatusInput = z.strictObject({});
type GitStatusInput = z.infer<typeof gitStatusInput>;

export function createGitStatusTool(options: ProcessToolOptions): Tool<GitStatusInput> {
  const metadata = builtinMetadata({
    name: "git_status",
    description: "Show the git status, separating changes inside the task's write scope from the user's or other tasks' changes.",
    effect: "read",
    idempotent: true,
    network: "none",
    output_limit_bytes: 256 * 1024,
    timeout_ms: 30_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: [...AGENT_ROLES],
  });
  return defineTool(metadata, gitStatusInput, {
    async normalize(input, context) {
      return actionOf(metadata, input, context, { paths: [{ path: ".", access: "read" }] });
    },
    async execute(_input, context) {
      const argv: [string, ...string[]] = ["git", "--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=all"];
      const result = await runGit(argv, context, options, metadata.output_limit_bytes).catch((error: unknown) => errorResult("execution_failed", messageOf(error)));
      if (result.status === "error") return result;
      const owned: string[] = [];
      const other: string[] = [];
      let branch = "";
      for (const line of result.text.split(/\r?\n/)) {
        if (line.startsWith("## ")) branch = line.slice(3);
        if (line.length < 4 || line.startsWith("## ")) continue;
        const target = (line.slice(3).split(" -> ").pop() ?? "").replace(/^"|"$/g, "");
        if (!readableByPolicy(target, context)) continue;
        (matchesAny(target, context.policy.write_scope, { caseInsensitive: false }) ? owned : other).push(line);
      }
      const sections = [
        `branch: ${branch || "(unknown)"}`,
        `task scope changes:\n${owned.join("\n") || "(none)"}`,
        `other changes (user or other tasks; do not modify):\n${other.join("\n") || "(none)"}`,
      ];
      return okResult(sections.join("\n\n"), { truncated: result.truncated });
    },
  });
}

const gitDiffInput = z.strictObject({
  staged: z.boolean().default(false),
  paths: z.array(z.string().min(1).max(1024)).max(100).default([]),
  context_lines: z.int().min(0).max(50).default(3),
});
type GitDiffInput = z.infer<typeof gitDiffInput>;

export function createGitDiffTool(options: ProcessToolOptions): Tool<GitDiffInput> {
  const metadata = builtinMetadata({
    name: "git_diff",
    description: "Show the working tree (or staged) diff for paths inside the read scope; forbidden paths are excluded.",
    effect: "read",
    idempotent: true,
    network: "none",
    output_limit_bytes: 1024 * 1024,
    timeout_ms: 60_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: [...AGENT_ROLES],
  });
  return defineTool(metadata, gitDiffInput, {
    async normalize(input, context) {
      const resolved = await Promise.all(input.paths.map((candidate) => resolveWorkspacePath(context.workspaceRoot, candidate, "read")));
      const paths = resolved.length === 0 ? [{ path: ".", access: "read" as const }] : resolved.map((entry) => ({ path: entry.relative, access: "read" as const }));
      return actionOf(metadata, input, context, { paths });
    },
    async execute(input, context) {
      try {
        const resolved = await Promise.all(input.paths.map((candidate) => resolveWorkspacePath(context.workspaceRoot, candidate, "read")));
        const pathspecs = resolved.length === 0 ? ["."] : resolved.map((entry) => entry.relative);
        const excludes = context.policy.forbidden.map((pattern) => `:(exclude,glob)${pattern}`);
        const argv: [string, ...string[]] = [
          "git",
          "--no-optional-locks",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.staged ? ["--cached"] : []),
          `-U${input.context_lines}`,
          "--",
          ...pathspecs,
          ...excludes,
        ];
        const result = await runGit(argv, context, options, metadata.output_limit_bytes);
        if (result.status === "error") return result;
        return okResult(result.text || "(no changes)", { truncated: result.truncated });
      } catch (error: unknown) {
        return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
      }
    },
  });
}

async function runGit(argv: [string, ...string[]], context: ToolExecutionContext, options: ProcessToolOptions, limit: number): Promise<ToolResult> {
  const root = await resolveWorkspacePath(context.workspaceRoot, ".", "read");
  const result = await context.sandbox.run(
    {
      argv,
      cwd: root.absolute,
      env: childEnvironment(options.environment, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" }),
      stdin: undefined,
      timeoutMs: 60_000,
      outputLimitBytes: limit,
      writeRoots: [],
      network: "deny",
    },
    context.signal,
  );
  if (result.termination === "cancelled" || context.signal.aborted) return errorResult("cancelled", "git was cancelled");
  if (result.termination === "timeout") return errorResult("timeout", "git timed out");
  if (result.termination === "spawn-failed") return errorResult("execution_failed", result.stderr || `failed to start git: ${result.spawnError ?? "unknown error"}`);
  if (result.exitCode !== 0) return errorResult("execution_failed", `git exited with ${result.exitCode ?? result.signal ?? "no status"}: ${result.stderr.trim()}`);
  return okResult(result.stdout, { truncated: result.truncated });
}

function processOutcome(argv: readonly string[], result: ProcessResult, signal: AbortSignal): ToolResult {
  const text = formatProcess(argv, result);
  const exit = result.exitCode === null ? {} : { exit_code: result.exitCode };
  if (result.termination === "cancelled" || signal.aborted) return errorResult("cancelled", "the command was cancelled and its process tree terminated", { text, truncated: result.truncated, ...exit });
  if (result.termination === "timeout") return errorResult("timeout", "the command timed out and its process tree was terminated", { text, truncated: result.truncated, ...exit });
  if (result.termination === "spawn-failed") return errorResult("execution_failed", result.stderr || `failed to start ${argv[0] ?? ""}`, { text });
  return okResult(text, { truncated: result.truncated, ...exit });
}

function formatProcess(argv: readonly string[], result: ProcessResult): string {
  const status = result.exitCode !== null ? `exit code ${result.exitCode}` : `terminated${result.signal === null ? "" : ` by ${result.signal}`}`;
  const parts = [`$ ${argv.join(" ")}`, `${status}${result.termination === "timeout" ? " (timed out)" : ""}${result.truncated ? " (output truncated)" : ""}`];
  if (result.stdout.length > 0) parts.push(`--- stdout ---\n${result.stdout}`);
  if (result.stderr.length > 0) parts.push(`--- stderr ---\n${result.stderr}`);
  return parts.join("\n");
}

function writeRoots(context: ToolExecutionContext): string[] {
  if ((READ_ONLY_ROLES as readonly AgentRole[]).includes(context.role)) return [];
  return context.policy.write_scope.map((pattern) => path.join(context.workspaceRoot, ...staticPrefix(pattern)));
}

function programOf(token: string): string {
  const base = token.replaceAll("\\", "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}
