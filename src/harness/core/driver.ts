import {
  createId,
  digestOf,
  EVENT_VERSIONS,
  INLINE_PAYLOAD_MAX_BYTES,
  modelRequestSchema,
  ProviderFailure,
  StoreFailure,
  type Actor,
  type AgentBackendAdapter,
  type AgentDriver,
  type AgentDriverDependencies,
  type ApprovalBridge,
  type AssistantMessage,
  type BackendSession,
  type BlobRef,
  type ContentPart,
  type EventStore,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelRoute,
  type ModelStreamEvent,
  type RequestId,
  type ResolvedCredential,
  type SessionEvent,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionEventType,
  type StepId,
  type ToolBridge,
  type ToolBridgeCall,
  type ToolBridgeResult,
  type ToolCallId,
  type ToolCallOutcome,
  type TurnId,
  type TurnInput,
  type TurnOutcome,
} from "../contracts/index.ts";
import { putCanonicalJson } from "./envelope.ts";
import { consumeStream, describe, providerError, type StreamOutcome } from "./stream.ts";

/** Prefix under which a backend-owned loop sees Synorch's tools (MCP server `synorch`). */
export const BRIDGE_TOOL_PREFIX = "mcp__synorch__";

export interface AgentDriverOptions {
  /** Environment handed to agent-backend children (the adapter strips `BRIDGE_STRIPPED_ENV`). */
  readonly backendEnv?: Readonly<Record<string, string>>;
}

/** Creates the fixed agent loop (ADR-02) over the given seams. */
export function createAgentDriver(deps: AgentDriverDependencies & AgentDriverOptions): AgentDriver {
  return new FixedAgentDriver(deps);
}

type StepResult = "continue" | "completed" | "cancelled" | "failed" | "budget_exceeded";

interface ToolCallRef {
  readonly toolCallId: ToolCallId;
  readonly providerCallId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface StepContext {
  readonly input: TurnInput;
  readonly log: TurnLog;
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly requestId: RequestId;
}

type Prepared = { readonly kind: "ok"; readonly request: ModelRequest } | { readonly kind: "cancelled" | "failed" | "budget_exceeded" };

/** A refused preparation ends the step without a model request: aborted when nothing was attempted, errored otherwise. */
function refusedStepState(kind: Exclude<Prepared["kind"], "ok">): "aborted" | "errored" {
  return kind === "failed" ? "errored" : "aborted";
}

class FixedAgentDriver implements AgentDriver {
  readonly #deps: AgentDriverDependencies & AgentDriverOptions;
  readonly #steers: string[] = [];
  readonly #backendSessions = new Map<string, string>();

  public constructor(deps: AgentDriverDependencies & AgentDriverOptions) {
    this.#deps = deps;
  }

  public steer(text: string): void {
    if (text.trim().length === 0) throw new RangeError("steer text must not be empty");
    this.#steers.push(text);
  }

  public async runTurn(input: TurnInput, signal: AbortSignal): Promise<TurnOutcome> {
    if (input.sessionId !== this.#deps.events.sessionId) {
      throw new RangeError(`turn targets ${input.sessionId} but the driver writes ${this.#deps.events.sessionId}`);
    }
    const log = new TurnLog(this.#deps.events, input);
    const turnId = createId("turn");
    await log.append("turn/started", { turn_id: turnId, trigger: input.trigger });
    let steps = 0;
    try {
      if (input.userMessage !== undefined) {
        await this.#recordMessage(log, { role: "user", content: [{ type: "text", text: input.userMessage }] }, undefined);
      }
      const adapter = this.#deps.router.adapterFor(input.route);
      let outcome: TurnOutcome["outcome"] = "max_steps";
      while (steps < input.maxSteps) {
        if (signal.aborted) {
          outcome = "cancelled";
          break;
        }
        await this.#drainSteers(log);
        steps += 1;
        const step: StepContext = { input, log, turnId, stepId: createId("step"), requestId: createId("request") };
        await log.append("step/started", { step_id: step.stepId, turn_id: turnId, request_id: step.requestId });
        const result = adapter.kind === "model" ? await this.#modelStep(adapter, step, signal) : await this.#backendStep(adapter, step, signal);
        if (result === "continue") continue;
        outcome = result;
        break;
      }
      await log.append("turn/ended", { turn_id: turnId, outcome });
      return { turnId, outcome, steps };
    } catch (error: unknown) {
      await log.append("turn/ended", { turn_id: turnId, outcome: "failed" }).catch(() => undefined);
      throw error;
    }
  }

  async #drainSteers(log: TurnLog): Promise<void> {
    while (this.#steers.length > 0) {
      const text = this.#steers[0] ?? "";
      await log.append("steer/queued", { text });
      this.#steers.shift();
    }
  }

  async #modelStep(adapter: ModelAdapter, step: StepContext, signal: AbortSignal): Promise<StepResult> {
    const prepared = await this.#prepare(step, signal);
    if (prepared.kind !== "ok") return this.#endStep(step, refusedStepState(prepared.kind), prepared.kind);
    const outcome = await consumeStream(await this.#openModelStream(adapter, prepared.request, step.input.route, signal), signal);
    if (outcome.kind === "failed") return this.#recordFailure(step, outcome);

    const calls: ToolCallRef[] = [];
    const message = withToolCallIds(outcome.message, calls, () => createId("toolCall"));
    await this.#recordSettled(step, outcome, message);
    if (calls.length === 0) return this.#endStep(step, "settled", this.#steers.length > 0 ? "continue" : "completed");
    if (outcome.stopReason === "length") {
      for (const call of calls) {
        await this.#recordToolResult(step, call, { isError: true, text: "the model output was cut off by the length limit; this tool call was not executed", blob: undefined });
      }
      return this.#endStep(step, "settled", "continue");
    }
    for (const [index, call] of calls.entries()) {
      if (signal.aborted) {
        for (const skipped of calls.slice(index)) {
          await this.#recordToolResult(step, skipped, { isError: true, text: "cancelled before execution", blob: undefined });
        }
        return this.#endStep(step, "aborted", "cancelled");
      }
      const result = await this.#invokeRecorded(step, call, signal);
      await this.#recordToolResult(step, call, { isError: result.result.status === "error", text: result.result.text, blob: result.result.blob });
    }
    if (signal.aborted) return this.#endStep(step, "aborted", "cancelled");
    return this.#endStep(step, "settled", "continue");
  }

  async #backendStep(adapter: AgentBackendAdapter, step: StepContext, signal: AbortSignal): Promise<StepResult> {
    const prepared = await this.#prepare(step, signal);
    if (prepared.kind !== "ok") return this.#endStep(step, refusedStepState(prepared.kind), prepared.kind);
    const { input } = step;
    const stepController = new AbortController();
    const stepSignal = AbortSignal.any([signal, stepController.signal]);
    const bridgeIds = new Map<string, ToolCallId>();
    let storeError: unknown;
    let chain: Promise<unknown> = Promise.resolve();

    const runBridgeCall = async (call: ToolBridgeCall, callSignal: AbortSignal): Promise<ToolBridgeResult> => {
      if (storeError !== undefined) return { isError: true, text: "the session store is unavailable; the tool call was not executed" };
      const toolCallId = createId("toolCall");
      bridgeIds.set(call.providerCallId, toolCallId);
      const ref: ToolCallRef = { toolCallId, providerCallId: call.providerCallId, name: bridgeToolName(call.name), arguments: call.arguments };
      try {
        const outcome = await this.#invokeRecorded(step, ref, AbortSignal.any([stepSignal, callSignal]));
        await this.#recordToolResult(step, ref, { isError: outcome.result.status === "error", text: outcome.result.text, blob: outcome.result.blob });
        return { isError: outcome.result.status === "error", text: outcome.result.text };
      } catch (error: unknown) {
        storeError = error;
        stepController.abort();
        return { isError: true, text: "the session store is unavailable; the tool call was not executed" };
      }
    };
    const tools: ToolBridge = {
      serverName: "synorch",
      list: () => this.#deps.tools.visibleTo(input.role, input.policy),
      call: (call, callSignal) => {
        const run = chain.then(() => runBridgeCall(call, callSignal));
        chain = run.catch(() => undefined);
        return run;
      },
    };
    const approvals: ApprovalBridge = {
      decide: async (toolName) => {
        const known = toolName.startsWith(BRIDGE_TOOL_PREFIX) && this.#deps.tools.get(bridgeToolName(toolName)) !== undefined;
        return known
          ? { allow: true, reason: "Synorch bridge tool; policy is enforced by the tool gateway" }
          : { allow: false, reason: `${toolName} is not a Synorch bridge tool` };
      },
    };

    const sessionKey = `${input.route.adapter_id}:${input.route.model_id}`;
    let outcome: StreamOutcome | undefined;
    let session: BackendSession | undefined;
    try {
      session = await adapter.startSession(
        {
          cwd: input.policy.workspace_root,
          modelId: input.route.model_id,
          systemPrompt: prepared.request.system.map((block) => block.text).join("\n\n"),
          maxTurns: input.maxSteps,
          resumeBackendSessionId: this.#backendSessions.get(sessionKey),
          env: this.#deps.backendEnv ?? currentEnvironment(),
        },
        stepSignal,
      );
    } catch (error: unknown) {
      outcome = failedOutcome(signal.aborted ? providerError("cancelled", "request cancelled") : error instanceof ProviderFailure ? error.error : providerError("bridge_unavailable", describe(error)));
    }
    if (session !== undefined) {
      const active = session;
      try {
        const stream = active.runTurn({ requestId: step.requestId, route: input.route, messages: prepared.request.messages }, { tools, approvals }, stepSignal);
        outcome = await consumeStream(stream, stepSignal, rejectForeignBackendTools);
        if (outcome.kind === "failed") await active.interrupt().catch(() => undefined);
        await chain;
      } finally {
        this.#backendSessions.set(sessionKey, active.backendSessionId);
        await active.close().catch(() => undefined);
      }
    }
    if (storeError !== undefined) throw storeError;
    outcome ??= failedOutcome(providerError("bridge_unavailable", "backend session did not start"));
    if (outcome.kind === "failed") return this.#recordFailure(step, outcome);
    const message = withToolCallIds(outcome.message, [], (providerCallId) => bridgeIds.get(providerCallId) ?? createId("toolCall"));
    await this.#recordSettled(step, outcome, message);
    return this.#endStep(step, "settled", this.#steers.length > 0 ? "continue" : "completed");
  }

  async #prepare(step: StepContext, signal: AbortSignal): Promise<Prepared> {
    const { input } = step;
    let built: Awaited<ReturnType<AgentDriverDependencies["context"]["build"]>>;
    try {
      built = await this.#deps.context.build(
        {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: input.taskId,
          attemptId: input.attemptId,
          role: input.role,
          route: input.route,
          policy: input.policy,
          packet: input.packet,
          requestId: step.requestId,
        },
        signal,
      );
    } catch (error: unknown) {
      if (error instanceof StoreFailure) throw error;
      return { kind: signal.aborted ? "cancelled" : "failed" };
    }
    if (signal.aborted) return { kind: "cancelled" };
    if (!built.ok) return { kind: built.reason === "budget-exceeded" ? "budget_exceeded" : "failed" };
    const request = modelRequestSchema.safeParse(built.request);
    if (
      !request.success ||
      request.data.request_id !== step.requestId ||
      digestOf(request.data.route) !== digestOf(input.route) ||
      digestOf(request.data) !== built.envelopeDigest
    ) {
      return { kind: "failed" };
    }
    const envelope = await putCanonicalJson(this.#deps.blobs, request.data);
    await step.log.append("model/request_prepared", {
      request_id: step.requestId,
      step_id: step.stepId,
      route: request.data.route,
      envelope_digest: built.envelopeDigest,
      envelope_blob: envelope,
      tool_set_digest: digestOf(request.data.tools),
      context: built.blocks.map((block) => ({
        block_id: block.blockId,
        source: block.source,
        trust: block.trust,
        tokens_estimate: block.tokensEstimate,
        truncated: block.truncated,
      })),
    });
    return { kind: "ok", request: request.data };
  }

  async #openModelStream(adapter: ModelAdapter, request: ModelRequest, route: ModelRoute, signal: AbortSignal): Promise<AsyncIterable<ModelStreamEvent>> {
    const failWith = (error: ReturnType<typeof providerError>): AsyncIterable<ModelStreamEvent> => singleEvent({ type: "error", error });
    const open = async (forceRefresh: boolean): Promise<AsyncIterable<ModelStreamEvent>> => {
      let credential: ResolvedCredential;
      try {
        credential = await this.#deps.credentials(route, signal, forceRefresh ? { forceRefresh: true } : undefined);
      } catch (error: unknown) {
        if (signal.aborted) return failWith(providerError("cancelled", "request cancelled"));
        return failWith(error instanceof ProviderFailure ? error.error : providerError("unauthenticated", describe(error)));
      }
      try {
        return adapter.stream(request, credential, signal);
      } catch (error: unknown) {
        return failWith(error instanceof ProviderFailure ? error.error : providerError("provider_internal", describe(error)));
      }
    };
    const first = await open(false);
    if (route.auth_method !== "oauth-subscription") return first;
    return retryOnceAfterRejection(first, () => open(true));
  }

  /** Every call goes through the gateway, which must leave a durable record before anything else runs. */
  async #invokeRecorded(step: StepContext, call: ToolCallRef, signal: AbortSignal): Promise<ToolCallOutcome> {
    const { input } = step;
    const before = this.#deps.events.lastSeq;
    const outcome = await this.#deps.gateway.invoke(
      { tool_call_id: call.toolCallId, provider_call_id: call.providerCallId, tool_name: call.name, arguments: { ...call.arguments } },
      { runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, role: input.role, policy: input.policy },
      signal,
    );
    if (this.#deps.events.lastSeq <= before) {
      throw new StoreFailure("write_failed", `tool gateway left no record for ${call.toolCallId}; no further tool call is started`);
    }
    return outcome;
  }

  async #recordSettled(step: StepContext, outcome: Extract<StreamOutcome, { kind: "done" }>, message: AssistantMessage): Promise<void> {
    await this.#recordMessage(step.log, message, step.requestId);
    await step.log.append("model/response_settled", {
      request_id: step.requestId,
      stop_reason: outcome.stopReason,
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    });
    await this.#recordUsage(step, outcome);
  }

  async #recordFailure(step: StepContext, outcome: Extract<StreamOutcome, { kind: "failed" }>): Promise<StepResult> {
    const partialBlob = outcome.partial === undefined ? undefined : await putCanonicalJson(this.#deps.blobs, outcome.partial);
    await step.log.append("model/response_failed", {
      request_id: step.requestId,
      error: outcome.error,
      ...(partialBlob === undefined ? {} : { partial_blob: partialBlob }),
    });
    await this.#recordUsage(step, outcome);
    const cancelled = outcome.error.code === "cancelled";
    return this.#endStep(step, cancelled ? "aborted" : "errored", cancelled ? "cancelled" : "failed");
  }

  async #recordUsage(step: StepContext, outcome: StreamOutcome): Promise<void> {
    if (outcome.usage === undefined) return;
    await step.log.append("provider/usage", {
      request_id: step.requestId,
      usage: outcome.usage,
      ...(outcome.quota === undefined ? {} : { quota: outcome.quota }),
    });
  }

  async #recordToolResult(step: StepContext, call: ToolCallRef, result: { readonly isError: boolean; readonly text: string; readonly blob: BlobRef | undefined }): Promise<void> {
    const part: ContentPart = {
      type: "tool_result",
      tool_call_id: call.toolCallId,
      provider_call_id: call.providerCallId,
      is_error: result.isError,
      text: result.text,
      ...(result.blob === undefined ? {} : { blob: result.blob }),
    };
    await this.#recordMessage(step.log, { role: "tool", content: [part] }, step.requestId);
  }

  async #recordMessage(log: TurnLog, message: ModelMessage, requestId: RequestId | undefined): Promise<void> {
    const correlation = requestId === undefined ? {} : { request_id: requestId };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") <= INLINE_PAYLOAD_MAX_BYTES) {
      await log.append("message/recorded", { role: message.role, ...correlation, message });
      return;
    }
    const blob = await putCanonicalJson(this.#deps.blobs, message);
    await log.append("message/recorded", { role: message.role, ...correlation, blob });
  }

  async #endStep(step: StepContext, state: "settled" | "aborted" | "errored", result: StepResult): Promise<StepResult> {
    await step.log.append("step/ended", { step_id: step.stepId, state });
    return result;
  }
}

/** Appends drafts with the turn's actor and correlation ids. */
class TurnLog {
  readonly #events: EventStore;
  readonly #actor: Actor;
  readonly #correlation: Pick<SessionEventDraft, "run_id" | "task_id" | "attempt_id">;

  public constructor(events: EventStore, input: TurnInput) {
    this.#events = events;
    this.#actor =
      input.role === "orchestrator"
        ? { kind: "orchestrator", role: input.role }
        : { kind: "worker", role: input.role, ...(input.attemptId === undefined ? {} : { attempt_id: input.attemptId }) };
    this.#correlation = {
      run_id: input.runId,
      ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
      ...(input.attemptId === undefined ? {} : { attempt_id: input.attemptId }),
    };
  }

  public append<T extends SessionEventType>(type: T, data: SessionEventOf<T>["data"]): Promise<SessionEvent> {
    return this.#events.append({ type, event_version: EVENT_VERSIONS[type], actor: this.#actor, ...this.#correlation, data } as SessionEventDraft);
  }
}

/** Gives every tool_call part its runtime `ToolCallId` (the provider id is kept alongside, never reused). */
function withToolCallIds(message: AssistantMessage, calls: ToolCallRef[], idFor: (providerCallId: string) => ToolCallId): AssistantMessage {
  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type !== "tool_call") return part;
      const toolCallId = idFor(part.provider_call_id);
      calls.push({ toolCallId, providerCallId: part.provider_call_id, name: part.name, arguments: part.arguments });
      return { ...part, tool_call_id: toolCallId };
    }),
  };
}

function rejectForeignBackendTools(event: ModelStreamEvent): ReturnType<typeof providerError> | undefined {
  if (event.type !== "backend_init") return undefined;
  const foreign = event.tools.filter((tool) => !tool.startsWith(BRIDGE_TOOL_PREFIX));
  return foreign.length === 0 ? undefined : providerError("protocol_mismatch", `backend exposes non-Synorch tools: ${foreign.join(", ")}`);
}

function bridgeToolName(name: string): string {
  return name.startsWith(BRIDGE_TOOL_PREFIX) ? name.slice(BRIDGE_TOOL_PREFIX.length) : name;
}

function failedOutcome(error: ReturnType<typeof providerError>): StreamOutcome {
  return { kind: "failed", error, partial: undefined, usage: undefined, quota: undefined };
}

async function* singleEvent(event: ModelStreamEvent): AsyncGenerator<ModelStreamEvent> {
  yield event;
}

/**
 * A refreshable credential the provider rejects (HTTP 401) before any output gets exactly one
 * forced refresh and one resend of the same request; a second rejection is final.
 */
async function* retryOnceAfterRejection(
  first: AsyncIterable<ModelStreamEvent>,
  reopen: () => Promise<AsyncIterable<ModelStreamEvent>>,
): AsyncGenerator<ModelStreamEvent> {
  const iterator = first[Symbol.asyncIterator]();
  const head = await iterator.next();
  if (head.done) return;
  if (head.value.type === "error" && head.value.error.http_status === 401) {
    await iterator.return?.();
    yield* await reopen();
    return;
  }
  yield head.value;
  while (true) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

function currentEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
