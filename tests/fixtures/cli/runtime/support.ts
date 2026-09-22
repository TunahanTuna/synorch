import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  jsonlFrameSchema,
  sessionIdSchema,
  splitJsonlLines,
  validateFrameSequence,
  type JsonlFrame,
  type ModelRequest,
  type ModelStreamEvent,
  type SandboxReport,
  type SessionEvent,
  type SessionId,
} from "../../../../src/harness/contracts/index.ts";
import type { HarnessProcessIO, RuntimeOverrides } from "../../../../src/harness/cli/index.ts";
import { createMemoryCredentialStore } from "../../../../src/harness/auth/index.ts";
import { projectSession } from "../../../../src/harness/core/index.ts";
import { createWorkspaceTrustStore } from "../../../../src/harness/policy/index.ts";
import { createSessionStore } from "../../../../src/harness/store/index.ts";
import type { ScriptStep } from "../../../../src/harness/providers/index.ts";

/**
 * Shared support for the I5 stage B end-to-end tests: temporary homes and workspaces, a captured
 * process IO, scripted model steps and readers for recorded sessions and JSONL frames. Everything
 * runs the real runtime (store, policy, tools, orchestration, context) with scripted adapters.
 */

export const TEST_SANDBOX: SandboxReport = {
  backend: "policy-only",
  platform: process.platform === "win32" || process.platform === "darwin" || process.platform === "linux" ? process.platform : "other",
  enforcement: "partial",
  filesystem: "partial",
  network: "unavailable",
  process: "partial",
  notes: ["test sandbox report"],
};

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  cleanup(): Promise<void>;
}

export async function createSandbox(files: Readonly<Record<string, string>>, options: { readonly git?: boolean } = {}): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-e2e-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "ws");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(workspace, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  if (options.git === true) {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "e2e@synorch.test");
    git("config", "user.name", "Synorch E2E");
    git("config", "core.autocrlf", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  }
  return {
    root,
    home,
    workspace,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

export interface RouteSpec {
  readonly tier: "orchestrator" | "complex_worker" | "fast_worker";
  readonly adapter: string;
  readonly model: string;
  readonly role?: string;
  readonly provider?: string;
}

/** Writes `<home>/config.yaml` with routes to (usually injected) scripted adapters. */
export async function writeConfig(home: string, routes: readonly RouteSpec[], extra = ""): Promise<void> {
  const lines = ["routes:"];
  for (const route of routes) {
    lines.push(
      `  - { tier: ${route.tier}, provider: ${route.provider ?? "scripted"}, model: ${route.model}, adapter: ${route.adapter}${route.role === undefined ? "" : `, role: ${route.role}`} }`,
    );
  }
  await writeFile(path.join(home, "config.yaml"), `${lines.join("\n")}\n${extra}`);
}

export class FakeInput extends EventEmitter {
  public readonly isTTY: boolean;

  public constructor(isTTY = false) {
    super();
    this.isTTY = isTTY;
  }

  public setRawMode(): this {
    return this;
  }

  public setEncoding(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public pause(): this {
    return this;
  }

  public send(text: string): void {
    this.emit("data", text);
  }

  public end(): void {
    this.emit("end");
  }
}

/** Piped input: delivers `text` once a reader attaches, then ends (like `printf ... | syn agent`). */
export class ScriptedInput extends FakeInput {
  private readonly text: string;
  private delivered = false;

  public constructor(text: string, isTTY = false) {
    super(isTTY);
    this.text = text;
  }

  public override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void);
    if (event === "data" && !this.delivered) {
      this.delivered = true;
      setImmediate(() => {
        this.emit("data", this.text);
        setImmediate(() => this.emit("end"));
      });
    }
    return this;
  }
}

export interface Captured {
  readonly io: HarnessProcessIO;
  readonly out: string[];
  readonly err: string[];
  stdout(): string;
  stderr(): string;
}

export function capture(options: { readonly cwd: string; readonly env?: Record<string, string | undefined>; readonly stdin?: FakeInput; readonly signal?: AbortSignal; readonly stdinIsTTY?: boolean }): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    io: {
      env: { NO_COLOR: "1", ...(options.env ?? {}) },
      cwd: options.cwd,
      stdinIsTTY: options.stdinIsTTY ?? false,
      stdout: { isTTY: false, write: (chunk: string) => (out.push(chunk), true) },
      stderr: { isTTY: false, write: (chunk: string) => (err.push(chunk), true) },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      platform: process.platform,
    },
  };
}

/** Overrides every e2e test uses: an isolated home, a fixed sandbox report and no keychain. */
/**
 * SEC-N1: the test sandbox is partial, so verification and build/test commands need a trusted
 * workspace. Tests that run them trust the workspace explicitly through the test home's user-scope
 * trust store, exactly as `syn trust` would; the policy itself is never loosened.
 */
export async function trustWorkspace(sandbox: Sandbox): Promise<void> {
  const state = await createWorkspaceTrustStore(sandbox.home).grant(sandbox.workspace, "command");
  if (!state.trusted) throw new Error(`the test workspace could not be trusted: ${state.reason ?? "unknown"}`);
}

export function overridesFor(sandbox: Sandbox, extra: RuntimeOverrides = {}): RuntimeOverrides {
  return { home: sandbox.home, sandbox: TEST_SANDBOX, credentialStore: () => createMemoryCredentialStore(), ...extra };
}

export function toolResultIds(request: ModelRequest): string[] {
  return request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "tool_result" ? [part.tool_call_id] : [])));
}

export function text(value: string): ScriptStep {
  return [
    { type: "text_delta", index: 0, text: value },
    { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: value }] }, usage: { input_tokens: 40, output_tokens: 5, source: "provider-reported" } },
  ];
}

export function calls(build: (request: ModelRequest, ids: readonly string[]) => readonly { readonly name: string; readonly arguments: Record<string, unknown> }[]): ScriptStep {
  return (request) => {
    const planned = build(request, toolResultIds(request));
    const resolved = planned.map((call, index) => ({ ...call, id: `pc_${request.request_id.slice(-6)}_${index}` }));
    const events: ModelStreamEvent[] = [
      ...resolved.map((call, index): ModelStreamEvent => ({ type: "tool_call_start", index, provider_call_id: call.id, name: call.name })),
      ...resolved.map((call, index): ModelStreamEvent => ({ type: "tool_call_end", index, provider_call_id: call.id, name: call.name, arguments: call.arguments as never })),
      {
        type: "done",
        stop_reason: "tool_use",
        message: { role: "assistant", content: resolved.map((call) => ({ type: "tool_call" as const, provider_call_id: call.id, name: call.name, arguments: call.arguments as never })) },
        usage: { input_tokens: 60, output_tokens: 20, source: "provider-reported" },
      },
    ];
    return events;
  };
}

export function call(name: string, args: (ids: readonly string[]) => Record<string, unknown>): ScriptStep {
  return calls((_request, ids) => [{ name, arguments: args(ids) }]);
}

export interface PlanTaskSpec {
  readonly key: string;
  readonly role?: "explorer" | "implementer" | "debugger" | "reviewer";
  readonly risk?: "trivial" | "standard" | "high-risk";
  readonly owned?: readonly string[];
  readonly read?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly verification?: readonly string[];
  readonly tier?: "complex_worker" | "fast_worker";
  readonly criteria?: readonly string[];
}

export function planArguments(goal: string, tasks: readonly PlanTaskSpec[]): Record<string, unknown> {
  const risks = tasks.map((task) => task.risk ?? "standard");
  return {
    goal,
    risk: risks.includes("high-risk") ? "high-risk" : risks.includes("standard") ? "standard" : "trivial",
    scope: [...new Set(tasks.flatMap((task) => [...(task.owned ?? []), ...(task.read ?? [])]))].concat(["README.md"]).slice(0, 20),
    tasks: tasks.map((task) => ({
      key: task.key,
      role: task.role ?? "implementer",
      objective: `Do ${task.key}.`,
      depends_on: task.dependsOn ?? [],
      owned_paths: task.owned ?? [],
      read_paths: task.read ?? [],
      risk: task.risk ?? "standard",
      model_tier: task.tier ?? "complex_worker",
      acceptance_criteria: (task.criteria ?? [`${task.key} is done`]).map((statement, index) => ({ id: `AC-${index + 1}`, statement })),
      verification: task.verification ?? [],
    })),
    expected_external_effects: [],
    verification: [],
    budget: { max_wall_time_seconds: 600, max_steps: 60 },
    assumptions: [],
  };
}

export function taskReport(evidence: (ids: readonly string[]) => readonly { readonly criterion: string; readonly ref: string; readonly kind?: string }[], extra: Record<string, unknown> = {}): ScriptStep {
  return call("task_report", (ids) => ({
    status: "completed",
    summary: "done as asked",
    acceptance_evidence: evidence(ids).map((entry) => ({ criterion_id: entry.criterion, evidence: [{ kind: entry.kind ?? "tool-call", ref: entry.ref, produced_by: "worker" }] })),
    ...extra,
  }));
}

export function parseFrames(stdout: string): { readonly frames: JsonlFrame[]; readonly problems: readonly string[] } {
  const { lines, rest } = splitJsonlLines(stdout);
  const frames = lines.map((line) => jsonlFrameSchema.parse(JSON.parse(line)));
  const problems = [...validateFrameSequence(frames), ...(rest === "" ? [] : ["stdout does not end with LF"])];
  if (/\r|\x1b/.test(stdout)) return { frames, problems: [...problems, "stdout contains CR or an escape sequence"] };
  return { frames, problems };
}

export async function readSession(home: string, sessionId: string): Promise<SessionEvent[]> {
  const reader = await createSessionStore(home).openForRead(sessionIdSchema.parse(sessionId) as SessionId);
  const events: SessionEvent[] = [];
  for await (const item of reader.read()) if (item.status === "ok") events.push(item.event);
  return events;
}

export function eventsOf<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

export function frameEvents(frames: readonly JsonlFrame[]): SessionEvent[] {
  return frames.flatMap((frame) => (frame.type === "event" ? [frame.data] : []));
}

/** Issues the I1 projection (the replay recovery uses) finds in a recorded session; empty when it replays cleanly. */
export function projectionIssues(events: readonly SessionEvent[]): readonly string[] {
  const projection = projectSession(events);
  return projection.status === "ok" ? [] : projection.issues.map((issue) => `${issue.code} at ${issue.seq ?? "?"}: ${issue.message}`);
}
