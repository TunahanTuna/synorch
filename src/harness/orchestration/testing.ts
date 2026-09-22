import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTROL_PLANE_WRITE_PREFIX,
  createId,
  digestOf,
  effectivePolicySchema,
  EVENT_VERSIONS,
  isReservedWritePattern,
  READ_ONLY_ROLES,
  sessionEventSchema,
  sha256,
  StoreFailure,
  validateTransition,
  type AgentDriver,
  type AgentRole,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type BlobRef,
  type BlobStore,
  type ContextBuilder,
  type ContextBuildResult,
  type Coordinator,
  type Digest,
  type RunOutcome,
  type RunRequest,
  type EffectivePolicy,
  type EventReadItem,
  type EventStore,
  type ModelRoute,
  type ModelRouter,
  type NormalizedAction,
  type PolicyDecision,
  type PolicyEngine,
  type ReadOnlyEventStore,
  type RouteDecision,
  type SandboxReport,
  type SessionEvent,
  type SessionEventDraft,
  type SessionId,
  type SessionManifest,
  type SessionStore,
  type ToolCallId,
  type ToolDescriptor,
  type ToolRegistry,
  type TurnInput,
  type TurnOutcome,
} from "../contracts/index.ts";
import { createBudgetGateSlot, type BudgetGateSlot } from "./budget.ts";
import { createCoordinator, type CoordinatorLimits } from "./coordinator.ts";
import { createWorkerFactory } from "./factories.ts";
import { runGit } from "./git.ts";
import { matchesAny } from "./paths.ts";
import type { Planner, PlannerInput } from "./planner.ts";
import type { OrchestrationWorkerManager } from "./worker-manager.ts";

/**
 * In-memory doubles for the seams I4 consumes (I1 store/driver, I2 router, I3 policy/broker).
 * They validate what they are given against the frozen contracts, so a test that passes here
 * exercises real event and policy shapes. They are test support only; nothing in the runtime
 * imports this file.
 */

export const TEST_SANDBOX: SandboxReport = {
  backend: "policy-only",
  platform: "other",
  enforcement: "partial",
  filesystem: "partial",
  network: "partial",
  process: "partial",
  notes: [],
};

export function createMemoryBlobStore(): BlobStore & { readonly size: () => number } {
  const blobs = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  return {
    size: () => blobs.size,
    async put(bytes, mediaType): Promise<BlobRef> {
      const digest = sha256(bytes);
      blobs.set(digest, { bytes: new Uint8Array(bytes), mediaType });
      return { digest, size_bytes: bytes.byteLength, media_type: mediaType };
    },
    async get(digest) {
      const blob = blobs.get(digest);
      if (blob === undefined) throw new StoreFailure("blob_missing", `no blob ${digest}`);
      if (sha256(blob.bytes) !== digest) throw new StoreFailure("blob_digest_mismatch", digest);
      return blob.bytes;
    },
    async has(digest) {
      return blobs.has(digest);
    },
  };
}

export interface MemoryEventStore extends EventStore {
  readonly events: readonly SessionEvent[];
  readonly closed: boolean;
}

export function createMemoryEventStore(sessionId: SessionId = createId("session"), seed: readonly SessionEvent[] = []): MemoryEventStore {
  const events: SessionEvent[] = [...seed];
  let closed = false;
  return {
    sessionId,
    get lastSeq() {
      return events.at(-1)?.seq ?? 0;
    },
    get events() {
      return events;
    },
    get closed() {
      return closed;
    },
    async append(draft: SessionEventDraft) {
      if (closed) throw new StoreFailure("write_failed", "store is closed");
      const event = sessionEventSchema.parse({
        ...draft,
        schema_version: 1,
        event_id: createId("event"),
        session_id: sessionId,
        seq: (events.at(-1)?.seq ?? 0) + 1,
        timestamp: new Date().toISOString(),
      });
      events.push(event);
      return event;
    },
    async *read(fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER): AsyncIterable<EventReadItem> {
      for (const event of [...events]) {
        if (event.seq >= fromSeq && event.seq <= toSeq) yield { status: "ok", event };
      }
    },
    async close() {
      closed = true;
    },
  };
}

export interface MemorySessionStore extends SessionStore {
  store(sessionId: SessionId): MemoryEventStore | undefined;
  manifests(): readonly SessionManifest[];
}

export function createMemorySessionStore(): MemorySessionStore {
  const stores = new Map<string, { manifest: SessionManifest; store: MemoryEventStore }>();
  const require = (sessionId: SessionId) => {
    const entry = stores.get(sessionId);
    if (entry === undefined) throw new StoreFailure("session_not_found", sessionId);
    return entry;
  };
  const reopen = (store: MemoryEventStore): MemoryEventStore => {
    const fresh = createMemoryEventStore(store.sessionId, store.events);
    return fresh;
  };
  return {
    store: (sessionId) => stores.get(sessionId)?.store,
    manifests: () => [...stores.values()].map((entry) => entry.manifest),
    async create(manifest) {
      const full: SessionManifest = { schema_version: 1, ...manifest };
      const store = createMemoryEventStore(manifest.session_id);
      stores.set(manifest.session_id, { manifest: full, store });
      return store;
    },
    async openForWrite(sessionId) {
      const entry = require(sessionId);
      if (entry.store.closed) {
        entry.store = reopen(entry.store);
      }
      return entry.store;
    },
    async openForRead(sessionId): Promise<ReadOnlyEventStore> {
      const entry = require(sessionId);
      return { sessionId, read: (fromSeq, toSeq) => entry.store.read(fromSeq, toSeq) };
    },
    async fork(sessionId, upToSeq) {
      const entry = require(sessionId);
      const forkId = createId("session");
      const store = createMemoryEventStore(forkId);
      stores.set(forkId, {
        manifest: { ...entry.manifest, session_id: forkId, parent: { session_id: sessionId, up_to_seq: upToSeq } },
        store,
      });
      return store;
    },
    async list(projectId) {
      return [...stores.values()]
        .filter((entry) => entry.manifest.project_id === projectId)
        .map((entry) => ({ manifest: entry.manifest, lastSeq: entry.store.lastSeq, lastEventAt: entry.store.events.at(-1)?.timestamp, locked: false }));
    },
  };
}

export interface FakePolicyOptions {
  /** Allow every action (used to prove that the orchestrator's own guard does not depend on the engine). */
  readonly lenient?: boolean;
}

/** A small, schema-valid stand-in for the I3 PolicyEngine: role matrix, write scope and reserved paths. */
export function createFakePolicyEngine(options: FakePolicyOptions = {}): PolicyEngine & { readonly computed: EffectivePolicy[] } {
  const computed: EffectivePolicy[] = [];
  return {
    computed,
    compute(inputs) {
      const readOnly = (READ_ONLY_ROLES as readonly AgentRole[]).includes(inputs.role);
      const owned = inputs.taskScope?.owned ?? [];
      const writeScope = readOnly
        ? []
        : inputs.role === "orchestrator"
          ? owned.filter((pattern) => pattern.startsWith(CONTROL_PLANE_WRITE_PREFIX))
          : owned;
      const ask = inputs.mode === "ask";
      const policy = effectivePolicySchema.parse({
        schema_version: 1,
        policy_version: 1,
        mode: inputs.mode,
        role: inputs.role,
        run_id: inputs.runId,
        ...(inputs.taskId === undefined ? {} : { task_id: inputs.taskId }),
        workspace_root: inputs.workspaceRoot,
        write_scope: writeScope,
        read_scope: inputs.taskScope !== undefined && inputs.taskScope.read.length + owned.length > 0 ? [...inputs.taskScope.read, ...owned] : ["**"],
        forbidden: inputs.taskScope?.forbidden ?? [],
        effects: {
          read: "allow",
          "workspace-write": readOnly || writeScope.length === 0 ? "deny" : ask ? "ask" : "allow",
          exec: inputs.role === "orchestrator" || inputs.role === "explorer" ? "deny" : ask ? "ask" : "allow",
          "external-write": "deny",
          control: inputs.role === "orchestrator" ? "allow" : "deny",
        },
        external_write_allowlist: [],
        network: { mode: "deny", hosts: [] },
        sandbox: { backend: inputs.sandbox.backend, enforcement: inputs.sandbox.enforcement },
        require_full_sandbox: false,
        layers: [{ layer: "role", source: inputs.role, digest: digestOf({ role: inputs.role }) }],
      });
      computed.push(policy);
      return policy;
    },
    evaluate(action: NormalizedAction, policy: EffectivePolicy): PolicyDecision {
      const base = { action_digest: digestOf(action), policy_digest: digestOf(policy) };
      if (options.lenient === true) return { ...base, decision: "allow", reasons: [{ code: "lenient", layer: "platform", message: "test engine allows everything" }] };
      for (const entry of action.paths.filter((candidate) => candidate.access === "write")) {
        if (isReservedWritePattern(entry.path)) {
          return { ...base, decision: "deny", rail: "reserved-path-write", reasons: [{ code: "reserved", layer: "platform", message: `${entry.path} is reserved` }] };
        }
        if (!matchesAny(entry.path, policy.write_scope) || matchesAny(entry.path, policy.forbidden)) {
          return { ...base, decision: "deny", rail: "write-outside-scope", reasons: [{ code: "outside-scope", layer: "task", message: `${entry.path} is outside the write scope` }] };
        }
      }
      const decision = policy.effects[action.effect];
      return { ...base, decision, reasons: [{ code: `effect-${decision}`, layer: "role", message: `${action.effect} is ${decision} for ${policy.role}` }] };
    },
  };
}

export function testRoute(provider: string, model: string, tier?: ModelRoute["tier"]): ModelRoute {
  return {
    provider_id: provider as ModelRoute["provider_id"],
    model_id: model as ModelRoute["model_id"],
    adapter_id: `${provider}-test`,
    adapter_kind: "model",
    auth_method: "api-key",
    profile: "default",
    ...(tier === undefined ? {} : { tier }),
  };
}

export interface ScriptedRouterOptions {
  readonly worker?: ModelRoute;
  readonly reviewer?: ModelRoute;
  readonly orchestrator?: ModelRoute;
}

export function createScriptedRouter(options: ScriptedRouterOptions = {}): ModelRouter & { readonly resolved: RouteDecision[] } {
  const resolved: RouteDecision[] = [];
  return {
    resolved,
    async resolve(request) {
      const route =
        request.role === "reviewer"
          ? options.reviewer ?? testRoute("anthropic", "claude-test")
          : request.role === "orchestrator"
            ? options.orchestrator ?? testRoute("openai", "gpt-orchestrator")
            : options.worker ?? testRoute("openai", "gpt-worker");
      const decision: RouteDecision = {
        tier: request.tier,
        ...(request.role === undefined ? {} : { role: request.role }),
        route: { ...route, tier: request.tier },
        source: "provider-default",
        reason: "scripted test route",
        fallback: { used: false },
      };
      resolved.push(decision);
      return decision;
    },
    adapterFor() {
      throw new Error("the scripted router has no adapters; use a scripted driver");
    },
    reportFailure() {
      return undefined;
    },
    proposeProviderChange() {
      throw new Error("the scripted router never blocks a route");
    },
    applyProviderChange() {
      return undefined;
    },
  };
}

export function createScriptedBroker(
  decide: (request: ApprovalRequest) => Omit<ApprovalDecision, "approval_id" | "subject_kind" | "subject_digest" | "decided_at"> & Partial<ApprovalDecision>,
  availability: ApprovalBroker["availability"] = "interactive",
): ApprovalBroker & { readonly requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    availability,
    requests,
    async request(request) {
      requests.push(request);
      return {
        approval_id: request.approval_id,
        subject_kind: request.subject_kind,
        subject_digest: request.subject_digest,
        decided_at: new Date().toISOString(),
        ...decide(request),
      } as ApprovalDecision;
    },
  };
}

export function createHeadlessBroker(): ApprovalBroker & { readonly requests: ApprovalRequest[] } {
  return createScriptedBroker((request) => ({ outcome: "unavailable", decided_by: "broker", mode: request.subject_kind === "plan" ? "ask" : "ask", reason: "headless" }), "headless");
}

export function createStaticToolRegistry(descriptors: readonly ToolDescriptor[] = []): ToolRegistry {
  return {
    register() {
      throw new Error("static registry");
    },
    get: () => undefined,
    visibleTo: () => descriptors,
  };
}

export interface ScriptContext {
  readonly input: TurnInput;
  readonly events: EventStore;
  readonly signal: AbortSignal;
  /** The isolated workspace root the attempt's policy points at. */
  readonly root: string;
  readonly context: ContextBuildResult | undefined;
  write(relativePath: string, content: string): Promise<void>;
  toolCall(name: string, result?: { readonly ok?: boolean; readonly exitCode?: number; readonly text?: string }): Promise<ToolCallId>;
  say(text: string): Promise<void>;
  reply(json: unknown): Promise<void>;
  /** Records a report tool call (assistant tool_call part + gateway events) as the real loop would. */
  report(name: string, args: Record<string, unknown>, result?: { readonly ok?: boolean }): Promise<ToolCallId>;
}

export type TurnScript = (context: ScriptContext) => Promise<TurnOutcome["outcome"] | void>;

export interface ScriptedDriverFactory {
  (events: EventStore): AgentDriver;
  readonly turns: { readonly input: TurnInput; readonly context: ContextBuildResult | undefined }[];
}

/**
 * A stand-in for the I1 AgentDriver: it records the user message, optionally builds the context
 * with a real ContextBuilder, then runs a script that writes files and records tool calls and the
 * final assistant message exactly as the real loop would.
 */
export function createScriptedDriverFactory(script: TurnScript, options: { readonly context?: ContextBuilder } = {}): ScriptedDriverFactory {
  const turns: { input: TurnInput; context: ContextBuildResult | undefined }[] = [];
  const factory = ((events: EventStore): AgentDriver => ({
    steer() {},
    async runTurn(input, signal) {
      const actor =
        input.role === "orchestrator"
          ? ({ kind: "orchestrator", role: "orchestrator" } as const)
          : ({ kind: "worker", role: input.role, ...(input.attemptId === undefined ? {} : { attempt_id: input.attemptId }) } as const);
      const ids = {
        run_id: input.runId,
        ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
        ...(input.attemptId === undefined ? {} : { attempt_id: input.attemptId }),
      };
      const append = (type: SessionEventDraft["type"], data: unknown, who: SessionEventDraft["actor"] = actor) =>
        events.append({ type, data, event_version: EVENT_VERSIONS[type], actor: who, ...ids } as SessionEventDraft);
      const turnId = createId("turn");
      await append("turn/started", { turn_id: turnId, trigger: input.trigger });
      if (input.userMessage !== undefined) {
        await append("message/recorded", { role: "user", message: { role: "user", content: [{ type: "text", text: input.userMessage }] } });
      }
      const requestId = createId("request");
      const context = options.context === undefined ? undefined : await options.context.build(
        { sessionId: input.sessionId, runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, role: input.role, route: input.route, policy: input.policy, packet: input.packet, requestId },
        signal,
      );
      turns.push({ input, context });
      const stepId = createId("step");
      await append("step/started", { step_id: stepId, turn_id: turnId, request_id: requestId });
      const root = input.policy.workspace_root;
      const outcome = await script({
        input,
        events,
        signal,
        root,
        context,
        async write(relativePath, content) {
          const target = path.join(root, ...relativePath.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
        },
        async toolCall(name, result = {}) {
          const toolCallId = createId("toolCall");
          await append("tool/call_proposed", { tool_call_id: toolCallId, provider_call_id: `p-${toolCallId}`, tool_name: name, args_digest: digestOf({ name }) }, { kind: "system" });
          const ok = result.ok ?? true;
          await append(
            "tool/result_recorded",
            {
              tool_call_id: toolCallId,
              state: ok ? "succeeded" : "failed",
              result: {
                status: ok ? "ok" : "error",
                text: result.text ?? (ok ? "ok" : "failed"),
                truncated: false,
                redactions: 0,
                ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
                ...(ok ? {} : { error: { code: "execution_failed", message: "failed" } }),
              },
              duration_ms: 1,
            },
            { kind: "system" },
          );
          return toolCallId;
        },
        async say(text) {
          await append("message/recorded", { role: "assistant", request_id: requestId, message: { role: "assistant", content: [{ type: "text", text }] } });
        },
        async reply(json) {
          await append("message/recorded", {
            role: "assistant",
            request_id: requestId,
            message: { role: "assistant", content: [{ type: "text", text: `Done.\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` }] },
          });
        },
        async report(name, args, result = {}) {
          const toolCallId = createId("toolCall");
          const providerCallId = `p-${toolCallId}`;
          await append("message/recorded", {
            role: "assistant",
            request_id: requestId,
            message: { role: "assistant", content: [{ type: "tool_call", provider_call_id: providerCallId, tool_call_id: toolCallId, name, arguments: args }] },
          });
          await append("tool/call_proposed", { tool_call_id: toolCallId, request_id: requestId, provider_call_id: providerCallId, tool_name: name, args_digest: digestOf(args) });
          const ok = result.ok ?? true;
          await append("tool/result_recorded", {
            tool_call_id: toolCallId,
            state: ok ? "succeeded" : "denied",
            result: ok
              ? { status: "ok", text: "report recorded", truncated: false, redactions: 0 }
              : { status: "error", text: "", truncated: false, redactions: 0, error: { code: "invalid_arguments", message: "invalid report" } },
            duration_ms: 1,
          });
          return toolCallId;
        },
      });
      const final = signal.aborted ? "cancelled" : (outcome ?? "completed");
      await append("step/ended", { step_id: stepId, state: final === "cancelled" ? "aborted" : "settled" }, { kind: "system" });
      await append("turn/ended", { turn_id: turnId, outcome: final });
      return { turnId, outcome: final, steps: 1 };
    },
  })) as ScriptedDriverFactory;
  Object.defineProperty(factory, "turns", { value: turns });
  return factory;
}

export function createScriptedPlanner(propose: (input: PlannerInput, call: number) => unknown): Planner & { readonly calls: PlannerInput[] } {
  const calls: PlannerInput[] = [];
  return {
    calls,
    async propose(input) {
      calls.push(input);
      return propose(input, calls.length);
    },
  };
}

export interface TempWorkspace {
  readonly root: string;
  readonly home: string;
  cleanup(): Promise<void>;
}

/** A temporary workspace (optionally a git repository with an initial commit) and a fake home. */
export async function createTempWorkspace(files: Readonly<Record<string, string>>, options: { readonly git: boolean }): Promise<TempWorkspace> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "synorch-i4-")));
  const root = path.join(base, "workspace");
  const home = path.join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  if (options.git) {
    await runGit(["init", "-q"], root);
    await runGit(["config", "user.email", "i4@synorch.test"], root);
    await runGit(["config", "user.name", "Synorch I4"], root);
    await runGit(["config", "core.autocrlf", "false"], root);
    await runGit(["add", "-A"], root);
    await runGit(["commit", "-q", "-m", "initial"], root);
  }
  return {
    root,
    home,
    async cleanup() {
      if (options.git) await runGit(["worktree", "prune"], root).catch(() => undefined);
      await rm(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/**
 * Replays the lifecycle events of a log through the contract state machines the way I1's
 * projection does: `run/created` starts a run in `created`, `plan/proposed` a plan in `draft`,
 * `task/created` a task in `draft` and `attempt/started` an attempt in `running`. Every
 * `*_state_changed` must start from the projected state and be a legal transition.
 */
export function replayTransitions(events: readonly SessionEvent[]): readonly string[] {
  const problems: string[] = [];
  const states = new Map<string, string>();
  const step = (machine: "run" | "plan" | "task" | "attempt", id: string, from: string, to: string, seq: number): void => {
    const key = `${machine}:${id}`;
    const current = states.get(key);
    if (current === undefined) problems.push(`#${seq} ${machine} ${id} changes state before it exists`);
    else if (current !== from) problems.push(`#${seq} ${machine} ${id} claims ${from} but is ${current}`);
    const check = validateTransition(machine, from, to);
    if (!check.ok) problems.push(`#${seq} ${check.message}`);
    states.set(key, to);
  };
  for (const event of events) {
    switch (event.type) {
      case "run/created":
        states.set(`run:${event.run_id ?? ""}`, "created");
        break;
      case "run/state_changed":
        step("run", event.run_id ?? "", event.data.from, event.data.to, event.seq);
        break;
      case "plan/proposed":
        states.set(`plan:${event.data.plan.plan_id}`, "proposed");
        break;
      case "plan/state_changed":
        step("plan", event.data.plan_id, event.data.from, event.data.to, event.seq);
        break;
      case "task/created":
        states.set(`task:${event.data.task_id}`, "draft");
        break;
      case "task/state_changed":
        step("task", event.data.task_id, event.data.from, event.data.to, event.seq);
        break;
      case "attempt/started":
        if (states.has(`attempt:${event.data.attempt_id}`)) problems.push(`#${event.seq} attempt ${event.data.attempt_id} started twice`);
        states.set(`attempt:${event.data.attempt_id}`, "running");
        break;
      case "attempt/state_changed":
        step("attempt", event.data.attempt_id, event.data.from, event.data.to, event.seq);
        break;
      default:
        break;
    }
  }
  for (const [key, state] of states) {
    if (key.startsWith("attempt:") && state === "running") problems.push(`${key} never reached a terminal state`);
  }
  return problems;
}

export function digestFor(text: string): Digest {
  return sha256(text);
}

export interface PlanTaskInput {
  readonly key: string;
  readonly role?: "explorer" | "implementer" | "debugger" | "reviewer";
  readonly depends_on?: readonly string[];
  readonly owned_paths?: readonly string[];
  readonly read_paths?: readonly string[];
  readonly risk?: "trivial" | "standard" | "high-risk";
  readonly criteria?: readonly string[];
  readonly verification?: readonly string[];
}

/** A plan candidate for the given planner input with sensible defaults per task. */
export function testPlan(input: PlannerInput, tasks: readonly PlanTaskInput[], overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const risks = tasks.map((task) => task.risk ?? "standard");
  return {
    schema_version: 1,
    plan_id: input.planId,
    run_id: input.runId,
    version: input.version,
    goal: input.goal,
    risk: risks.includes("high-risk") ? "high-risk" : risks.includes("standard") ? "standard" : "trivial",
    scope: ["docs/**", "src/**"],
    tasks: tasks.map((task) => ({
      key: task.key,
      role: task.role ?? "implementer",
      objective: `Do ${task.key}`,
      depends_on: task.depends_on ?? [],
      owned_paths: task.owned_paths ?? [],
      read_paths: task.read_paths ?? [],
      risk: task.risk ?? "standard",
      model_tier: "complex_worker",
      acceptance_criteria: (task.criteria ?? [`${task.key} is done`]).map((statement, index) => ({ id: `AC-${index + 1}`, statement })),
      verification: task.verification ?? [],
    })),
    expected_external_effects: [],
    verification: [],
    budget: { max_wall_time_seconds: 600, max_steps: 100 },
    assumptions: [],
    created_at: input.createdAt,
    ...overrides,
  };
}

/** A well-formed worker claim citing `callId` for every criterion and verification command. */
export function workerClaim(context: ScriptContext, callId: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const packet = context.input.packet;
  return {
    status: "completed",
    summary: `completed ${packet?.objective ?? "task"}`,
    acceptance_evidence: (packet?.acceptance_criteria ?? []).map((criterion) => ({
      criterion_id: criterion.id,
      evidence: [{ kind: "test-run", ref: callId, produced_by: "worker" }],
    })),
    commands_run: (packet?.verification.commands ?? []).map((command) => ({
      command,
      exit_code: 0,
      evidence: { kind: "tool-call", ref: callId, produced_by: "worker" },
    })),
    decisions_made: [],
    skipped_checks: [],
    unresolved_risks: [],
    recommended_context_updates: [],
    ...(packet?.role === "debugger" && packet.write_mode === "rca-only" ? { root_cause: "found" } : {}),
    ...overrides,
  };
}

/** A reviewer claim whose `met` verdicts are backed by the reviewer's own `callId`. */
export function reviewerClaim(context: ScriptContext, callId: string, decision: "accept" | "revise" | "block" = "accept"): Record<string, unknown> {
  return {
    criteria: (context.input.packet?.acceptance_criteria ?? []).map((criterion) => ({
      criterion_id: criterion.id,
      verdict: decision === "accept" ? "met" : "not_met",
      evidence: decision === "accept" ? [{ kind: "test-run", ref: callId, produced_by: "reviewer" }] : [],
    })),
    findings: decision === "accept" ? [] : [{ id: "F-1", severity: decision === "block" ? "blocker" : "major", summary: "needs work" }],
    decision,
  };
}

export interface TestRuntimeOptions {
  readonly workspace: TempWorkspace;
  readonly script: TurnScript;
  readonly planner: Planner;
  readonly mode?: "autonomous" | "ask";
  readonly broker?: ApprovalBroker;
  readonly router?: ModelRouter & { readonly resolved: RouteDecision[] };
  readonly policy?: PolicyEngine & { readonly computed: EffectivePolicy[] };
  /** Builds a real ContextBuilder over the runtime's stores for the scripted driver to call. */
  readonly context?: (stores: { readonly sessions: MemorySessionStore; readonly blobs: BlobStore; readonly budgetGate: BudgetGateSlot }) => ContextBuilder;
  readonly limits?: Partial<CoordinatorLimits>;
  readonly preferWorktree?: boolean;
  readonly ledger?: boolean;
  readonly headless?: boolean;
}

export interface TestRuntime {
  readonly coordinator: Coordinator;
  readonly sessions: MemorySessionStore;
  readonly blobs: BlobStore & { readonly size: () => number };
  readonly driver: ScriptedDriverFactory;
  readonly router: ModelRouter & { readonly resolved: RouteDecision[] };
  readonly policy: PolicyEngine & { readonly computed: EffectivePolicy[] };
  readonly broker: ApprovalBroker & { readonly requests?: ApprovalRequest[] };
  readonly budgetGate: BudgetGateSlot;
  readonly workers: OrchestrationWorkerManager[];
  run(goal?: string, budget?: RunRequest["budget"]): Promise<RunOutcome>;
  runEvents(outcome: RunOutcome): readonly SessionEvent[];
}

/** Wires a real coordinator, worker manager and isolation provider over in-memory seams. */
export function createTestRuntime(options: TestRuntimeOptions): TestRuntime {
  const sessions = createMemorySessionStore();
  const blobs = createMemoryBlobStore();
  const budgetGate = createBudgetGateSlot();
  const context = options.context?.({ sessions, blobs, budgetGate });
  const driver = createScriptedDriverFactory(options.script, context === undefined ? {} : { context });
  const router = options.router ?? createScriptedRouter();
  const policy = options.policy ?? createFakePolicyEngine();
  const broker = options.broker ?? createScriptedBroker(() => ({ outcome: "allowed-for-scope", decided_by: "user", mode: "ask" }));
  const workers: OrchestrationWorkerManager[] = [];
  const factory = createWorkerFactory({
    sessions,
    blobs,
    router,
    policy,
    createDriver: driver,
    sandbox: TEST_SANDBOX,
    home: options.workspace.home,
  });
  const coordinator = createCoordinator({
    sessions,
    blobs,
    router,
    policy,
    approvals: broker,
    planner: options.planner,
    sandbox: TEST_SANDBOX,
    createWorkers: (scope, budget) => {
      const manager = factory(scope, budget);
      workers.push(manager);
      return manager;
    },
    budgetGate,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.preferWorktree === undefined ? {} : { preferWorktree: options.preferWorktree }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
  });
  return {
    coordinator,
    sessions,
    blobs,
    driver,
    router,
    policy,
    broker,
    budgetGate,
    workers,
    run: (goal = "Test goal", budget = { maxWallTimeSeconds: undefined, maxCostUsd: undefined }) =>
      coordinator.run(
        {
          goal,
          workspaceRoot: options.workspace.root,
          policyMode: options.mode ?? "autonomous",
          headless: options.headless ?? false,
          resumeSessionId: undefined,
          budget,
        },
        new AbortController().signal,
      ),
    runEvents: (outcome) => sessions.store(outcome.sessionId)?.events ?? [],
  };
}
