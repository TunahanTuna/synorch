import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId, deriveProjectId, sha256, taskContextPacketSchema, type TaskContextPacket } from "../../../src/harness/contracts/index.ts";
import { createIsolationProvider, type IsolationProviderDependencies } from "../../../src/harness/orchestration/isolation.ts";

/**
 * Throwaway git repositories for the workspace-fidelity fixtures (Denetim B, ADR-19). Every repo
 * sets its own `core.autocrlf` (the machine-wide value, `true` on Git for Windows, never leaks in)
 * and lives in a temp directory next to its worktrees root.
 */

export interface FixtureRepo {
  readonly base: string;
  readonly root: string;
  readonly worktreesRoot: string;
  git(...args: string[]): string;
  gitBytes(args: readonly string[], input?: Buffer | string): Buffer;
  write(relative: string, content: string | Buffer): Promise<void>;
  commitAll(message?: string): void;
  provider(overrides?: Partial<IsolationProviderDependencies>): ReturnType<typeof createIsolationProvider>;
  cleanup(): Promise<void>;
}

export function gitIn(cwd: string, args: readonly string[], input?: Buffer | string): Buffer {
  return execFileSync("git", [...args], { cwd, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

export async function createFixtureRepo(config: Readonly<Record<string, string>> = {}, options: { readonly baseName?: string } = {}): Promise<FixtureRepo> {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), options.baseName ?? "syn-wf-")));
  const root = path.join(base, "repo");
  const worktreesRoot = path.join(base, "wt");
  await mkdir(root, { recursive: true });
  const git = (...args: string[]): string => gitIn(root, args).toString("utf8");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "wf@synorch.test");
  git("config", "user.name", "Synorch WF");
  git("config", "core.autocrlf", "false");
  git("config", "core.safecrlf", "false");
  for (const [key, value] of Object.entries(config)) git("config", key, value);
  return {
    base,
    root,
    worktreesRoot,
    git,
    gitBytes: (args, input) => gitIn(root, args, input),
    async write(relative, content) {
      const target = path.join(root, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    commitAll(message = "c") {
      git("add", "-A");
      git("commit", "-q", "--no-verify", "-m", message);
    },
    provider(overrides = {}) {
      return createIsolationProvider({ workspaceRoot: root, projectId: deriveProjectId(root, process.platform), worktreesRoot, ...overrides });
    },
    async cleanup() {
      try {
        gitIn(root, ["worktree", "prune"]);
      } catch {
        // already gone
      }
      await rm(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export function packet(owned: readonly string[], overrides: Partial<TaskContextPacket> = {}, read: readonly string[] = []): TaskContextPacket {
  return taskContextPacketSchema.parse({
    schema_version: 2,
    kind: "full",
    task_id: createId("task"),
    run_id: createId("run"),
    plan_id: createId("plan"),
    plan_version: 1,
    plan_digest: sha256("plan"),
    role: "implementer",
    model_tier: "complex_worker",
    risk: "standard",
    write_mode: "owned-paths",
    isolation: "worktree",
    objective: "o",
    why: { user_goal: "g" },
    scope: { owned_paths: owned, read_paths: read, forbidden_paths: [] },
    known_facts: [],
    decisions: [],
    relevant_symbols: [],
    acceptance_criteria: [{ id: "AC-1", statement: "s" }],
    verification: { commands: [] },
    non_goals: [],
    open_questions: [],
    stop_conditions: [],
    limits: { max_steps: 5, max_wall_time_seconds: 60 },
    context: { created_at: "2026-09-23T10:00:00Z", sources: [] },
    expected_report: ["summary"],
    ...overrides,
  });
}

export const signal = (): AbortSignal => new AbortController().signal;

export function lfsAvailable(): boolean {
  const result = spawnSync("git", ["lfs", "version"], { stdio: "ignore" });
  return result.status === 0;
}

export function crlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}
