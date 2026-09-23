import {
  createId,
  digestOf,
  digestText,
  EVENT_VERSIONS,
  modelRouteSchema,
  effectivePolicySchema,
  type AgentBackendAdapter,
  type AgentRole,
  type AnyModelAdapter,
  type BackendSession,
  type BlobStore,
  type ContextBuilder,
  type ContextBuildInput,
  type ContextBuildResult,
  type EffectivePolicy,
  type EventStore,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelRoute,
  type ModelRouter,
  type ModelStreamEvent,
  type ProviderId,
  type ResolvedCredential,
  type RunId,
  type SessionEventDraft,
  type Tool,
  type ToolBridge,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolGateway,
  type ToolInvocationScope,
  type ToolRegistry,
  type ToolResult,
} from "../contracts/index.ts";
import { loadRecordedMessage } from "./envelope.ts";

/**
 * In-memory doubles for the driver's seams, for I1's own tests and for other workstreams that need
 * a scripted loop. None of them is used by production code.
 */

export function testRoute(kind: "model" | "agent-backend" = "model"): ModelRoute {
  return modelRouteSchema.parse(
    kind === "model"
      ? { provider_id: "openai", model_id: "test-model", adapter_id: "scripted", adapter_kind: "model", auth_method: "api-key", profile: "default" }
      : { provider_id: "anthropic", model_id: "test-backend", adapter_id: "scripted-backend", adapter_kind: "agent-backend", auth_method: "cli-bridge", profile: "default" },
  );
}

export function testPolicy(runId: RunId, role: AgentRole = "implementer"): EffectivePolicy {
  return effectivePolicySchema.parse({
    schema_version: 1,
    policy_version: 1,
    mode: "autonomous",
    role,
    run_id: runId,
    workspace_root: "/workspace",
    write_scope: role === "implementer" ? ["src/**"] : [],
    read_scope: ["**"],
    forbidden: [],
    effects: { read: "allow", "workspace-write": role === "implementer" ? "allow" : "deny", exec: "allow", "external-write": "deny", control: "deny" },
    external_write_allowlist: [],
    network: { mode: "deny", hosts: [] },
    sandbox: { backend: "policy-only", enforcement: "partial" },
    require_full_sandbox: false,
    exec_confinement: "allowlist",
    verification_commands: [],
    layers: [{ layer: "role", source: role, digest: digestText(role) }],
  });
}

export function testCredential(): ResolvedCredential {
  return {
    providerId: "openai" as ProviderId,
    method: "api-key",
    profile: "default",
    expiresAt: undefined,
    applyTo: () => undefined,
    redactionValues: () => [],
    toJSON: () => "[redacted]",
  };
}

export type ScriptStep = readonly ModelStreamEvent[] | ((request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelStreamEvent>);

/** A `ModelAdapter` that replays one scripted stream per request and records what it was asked. */
export class ScriptedModelAdapter implements ModelAdapter {
  public readonly kind = "model" as const;
  public readonly adapterId = "scripted";
  public readonly providerId = "openai" as ProviderId;
  public readonly authMethod = "api-key" as const;
  public readonly requests: ModelRequest[] = [];
  readonly #script: ScriptStep[];

  public constructor(script: readonly ScriptStep[]) {
    this.#script = [...script];
  }

  public discoverCapabilities(): never {
    throw new Error("not used by the driver");
  }

  public prepare(): never {
    throw new Error("not used by the driver");
  }

  public stream(request: ModelRequest, _credential: ResolvedCredential, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const step = this.#script.shift();
    if (step === undefined) return replay([{ type: "error", error: { code: "invalid_request", message: "script exhausted", retryable: false } }]);
    return typeof step === "function" ? step(request, signal) : replay(step);
  }

  public async health(): Promise<never> {
    throw new Error("not used by the driver");
  }
}

async function* replay(events: readonly ModelStreamEvent[]): AsyncGenerator<ModelStreamEvent> {
  for (const event of events) yield event;
}

export function textTurn(request: ModelRequest, text: string): ModelStreamEvent[] {
  return [
    { type: "start", request_id: request.request_id, route: request.route },
    { type: "text_delta", index: 0, text },
    { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 10, output_tokens: 2, source: "provider-reported" } },
  ];
}

export function toolTurn(request: ModelRequest, calls: readonly { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }[]): ModelStreamEvent[] {
  return [
    { type: "start", request_id: request.request_id, route: request.route },
    ...calls.map((call, index): ModelStreamEvent => ({ type: "tool_call_end", index, provider_call_id: call.id, name: call.name, arguments: call.arguments })),
    {
      type: "done",
      stop_reason: "tool_use",
      message: { role: "assistant", content: calls.map((call) => ({ type: "tool_call" as const, provider_call_id: call.id, name: call.name, arguments: call.arguments })) },
    },
  ];
}

/** Scripts each request lazily so the script can refer to the actual request id and route. */
export function lazy(build: (request: ModelRequest) => readonly ModelStreamEvent[]): ScriptStep {
  return (request) => replay(build(request));
}

export function testRouter(adapter: AnyModelAdapter): ModelRouter {
  return {
    resolve: async () => {
      throw new Error("not used by the driver");
    },
    adapterFor: () => adapter,
    reportFailure: () => undefined,
    proposeProviderChange: () => {
      throw new Error("not used by the driver");
    },
    applyProviderChange: () => undefined,
  };
}

/**
 * Rebuilds the model input from the log on every step: one system block plus every recorded
 * message (blobs resolved). Deterministic, so the same log always yields the same envelope.
 */
export function createLogContextBuilder(events: EventStore, blobs: BlobStore, tools: ToolRegistry): ContextBuilder {
  return {
    async build(input: ContextBuildInput): Promise<ContextBuildResult> {
      const messages: ModelMessage[] = [];
      for await (const item of events.read()) {
        if (item.status !== "ok") continue;
        if (item.event.type === "message/recorded") messages.push(await loadRecordedMessage(item.event, blobs));
        if (item.event.type === "steer/queued") messages.push({ role: "user", content: [{ type: "text", text: item.event.data.text }] });
      }
      const systemText = `You are the ${input.role}.`;
      const request: ModelRequest = {
        request_id: input.requestId as ModelRequest["request_id"],
        route: input.route,
        system: [{ id: "role", source: "role", trust: "harness", text: systemText, digest: digestText(systemText) }],
        messages,
        tools: [...tools.visibleTo(input.role, input.policy)],
      };
      return {
        ok: true,
        request,
        envelopeDigest: digestOf(request),
        blocks: [
          { blockId: "role", source: "role", trust: "harness", tokensEstimate: 8, truncated: false },
          { blockId: "history", source: "history", trust: "untrusted", tokensEstimate: messages.length * 10, truncated: false },
        ],
        memories: [],
      };
    },
  };
}

export function testRegistry(names: readonly string[] = ["read_file", "exec"]): ToolRegistry {
  return {
    register: () => undefined,
    get: (name) => (names.includes(name) ? ({ metadata: { name } } as unknown as Tool) : undefined),
    visibleTo: () => names.map((name) => ({ name, description: `${name} tool`, input_schema: { type: "object" } })),
  };
}

export type ToolHandler = (request: ToolCallRequest, signal: AbortSignal) => Promise<ToolResult>;

/**
 * Records `tool/call_proposed` -> `tool/execution_started` -> `tool/result_recorded` like the real
 * gateway and runs `handler` in between; `invocations` lists every call that reached execution.
 */
export interface RecordingGatewayOptions {
  /** Assign `[#n]` short refs (1, 2, …) like the real gateway (ADR-18). */
  readonly refs?: boolean;
  /** Names of terminal control tools: a succeeded call with `status: ok` returns `endsTurn` (ADR-20). */
  readonly terminalTools?: readonly string[];
}

export class RecordingToolGateway implements ToolGateway {
  public readonly invocations: ToolCallRequest[] = [];
  readonly #events: EventStore;
  readonly #handler: ToolHandler;
  readonly #options: RecordingGatewayOptions;
  #nextRef = 1;

  public constructor(
    events: EventStore,
    handler: ToolHandler = async (request) => ({ status: "ok", text: `ran ${request.tool_name}`, truncated: false, redactions: 0 }),
    options: RecordingGatewayOptions = {},
  ) {
    this.#events = events;
    this.#handler = handler;
    this.#options = options;
  }

  public async invoke(request: ToolCallRequest, scope: ToolInvocationScope, signal: AbortSignal): Promise<ToolCallOutcome> {
    const correlation = { run_id: scope.runId, ...(scope.taskId === undefined ? {} : { task_id: scope.taskId }) };
    const actor = { kind: "system" as const };
    const ref = this.#options.refs === true ? this.#nextRef++ : undefined;
    await this.#events.append({
      type: "tool/call_proposed",
      event_version: EVENT_VERSIONS["tool/call_proposed"],
      actor,
      ...correlation,
      data: {
        tool_call_id: request.tool_call_id,
        provider_call_id: request.provider_call_id,
        tool_name: request.tool_name,
        args_digest: digestOf(request.arguments),
        ...(ref === undefined ? {} : { ref }),
      },
    } as SessionEventDraft);
    await this.#events.append({
      type: "tool/execution_started",
      event_version: EVENT_VERSIONS["tool/execution_started"],
      actor,
      ...correlation,
      data: { tool_call_id: request.tool_call_id, sandbox_enforcement: "partial" },
    } as SessionEventDraft);
    this.invocations.push(request);
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await this.#handler(request, signal);
    } catch (error: unknown) {
      result = { status: "error", text: "", truncated: false, redactions: 0, error: { code: "execution_failed", message: error instanceof Error ? error.message : String(error) } };
    }
    const state = signal.aborted ? "cancelled" : result.status === "ok" ? "succeeded" : "failed";
    await this.#events.append({
      type: "tool/result_recorded",
      event_version: EVENT_VERSIONS["tool/result_recorded"],
      actor,
      ...correlation,
      data: { tool_call_id: request.tool_call_id, state, result, duration_ms: Date.now() - started },
    } as SessionEventDraft);
    const endsTurn = state === "succeeded" && result.status === "ok" && (this.#options.terminalTools ?? []).includes(request.tool_name);
    return {
      toolCallId: request.tool_call_id,
      state,
      result,
      decision: undefined,
      approval: undefined,
      ...(ref === undefined ? {} : { ref }),
      ...(endsTurn ? { endsTurn } : {}),
    };
  }
}

export type BackendScript = (tools: ToolBridge, request: { readonly requestId: string }) => AsyncIterable<ModelStreamEvent>;

/** An `AgentBackendAdapter` whose single session runs `script`, calling Synorch tools through the bridge. */
export class ScriptedBackendAdapter implements AgentBackendAdapter {
  public readonly kind = "agent-backend" as const;
  public readonly adapterId = "scripted-backend";
  public readonly providerId = "anthropic" as ProviderId;
  public readonly authMethod = "cli-bridge" as const;
  public readonly sessions: { readonly resumed: string | undefined; closed: boolean; interrupted: boolean }[] = [];
  readonly #script: BackendScript;

  public constructor(script: BackendScript) {
    this.#script = script;
  }

  public async probe(): Promise<never> {
    throw new Error("not used by the driver");
  }

  public async discoverCapabilities(): Promise<never> {
    throw new Error("not used by the driver");
  }

  public async startSession(options: { readonly resumeBackendSessionId: string | undefined }): Promise<BackendSession> {
    const record = { resumed: options.resumeBackendSessionId, closed: false, interrupted: false };
    this.sessions.push(record);
    const script = this.#script;
    return {
      backendSessionId: `backend-${this.sessions.length}`,
      runTurn: (input, bridges) => script(bridges.tools, { requestId: input.requestId }),
      interrupt: async () => {
        record.interrupted = true;
      },
      close: async () => {
        record.closed = true;
      },
    };
  }

  public async health(): Promise<never> {
    throw new Error("not used by the driver");
  }
}

export function newRunId(): RunId {
  return createId("run");
}
