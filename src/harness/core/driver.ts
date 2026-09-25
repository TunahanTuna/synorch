import {
  createId,
  digestOf,
  EVENT_VERSIONS,
  INLINE_PAYLOAD_MAX_BYTES,
  modelRequestSchema,
  ProviderFailure,
  renderToolResultText,
  StoreFailure,
  type Actor,
  type AgentBackendAdapter,
  type AgentDriver,
  type AgentDriverDependencies,
  type ApprovalBridge,
  type AssistantMessage,
  type BackendApprovalDecision,
  type BackendSession,
  type BackendToolObservation,
  IMAGE_MAX_BYTES,
  IMAGE_MEDIA_TYPES,
  type BlobRef,
  type BlobStore,
  type ContentPart,
  type EventStore,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelRoute,
  type ModelStreamEvent,
  type ReasoningEffort,
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
  type ToolResult,
  type TurnId,
  type TurnInput,
  type TurnOutcome,
} from "../contracts/index.ts";
import { putCanonicalJson } from "./envelope.ts";
import { consumeStream, describe, providerError, type StreamOutcome } from "./stream.ts";

/**
 * Fills `data` (base64) on every `image` part from the blob store, right before the request goes to
 * the adapter. The recorded envelope keeps only the blob refs. A missing blob becomes a text note so
 * the step still runs.
 */
export async function withImageData(blobs: BlobStore, request: ModelRequest): Promise<ModelRequest> {
  if (!request.messages.some((message) => message.content.some((part) => part.type === "image" && part.data === undefined))) return request;
  const messages: ModelMessage[] = [];
  for (const message of request.messages) {
    const content: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== "image" || part.data !== undefined) {
        content.push(part);
        continue;
      }
      try {
        const bytes = await blobs.get(part.blob.digest);
        content.push({ ...part, data: Buffer.from(bytes).toString("base64") });
      } catch {
        content.push({ type: "text", text: `[image ${part.blob.digest.slice(7, 19)} is no longer available]` });
      }
    }
    messages.push({ ...message, content });
  }
  return { ...request, messages };
}

/** Adapters that turn `image` message parts into provider image input (K4.2 tool images). */
const IMAGE_INPUT_ADAPTERS: ReadonlySet<string> = new Set(["openai-chatgpt", "openai-responses", "anthropic-messages", "scripted"]);

function toolImage(blob: BlobRef | undefined): Extract<ContentPart, { type: "image" }>["blob"] | undefined {
  if (blob === undefined || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(blob.media_type) || blob.size_bytes > IMAGE_MAX_BYTES || blob.size_bytes < 1) return undefined;
  return blob as Extract<ContentPart, { type: "image" }>["blob"];
}

/** Prefix under which a backend-owned loop sees Synorch's tools (MCP server `synorch`). */
export const BRIDGE_TOOL_PREFIX = "mcp__synorch__";
/** Synorch tools a native backend replaces with its own built-ins (Claude Code WebSearch/WebFetch); never offered on its bridge. */
export const NATIVE_DUPLICATE_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/** What a backend permission handler knows about the turn, and how it audits into the turn's log. */
export interface BackendApprovalContext {
  readonly role: TurnInput["role"];
  readonly runId: TurnInput["runId"];
  readonly taskId: TurnInput["taskId"];
  readonly attemptId: TurnInput["attemptId"];
  readonly policy: TurnInput["policy"];
  /** Appends `approval/requested` / `approval/decided` with the turn's actor and correlation ids. */
  record<T extends "approval/requested" | "approval/decided">(type: T, data: SessionEventOf<T>["data"]): Promise<unknown>;
}

/**
 * Decides a backend built-in's permission prompt (Claude Code native mode): the composition root
 * routes it to the session's approval broker. Without a handler every built-in is denied.
 */
export type BackendApprovalHandler = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: BackendApprovalContext,
  signal: AbortSignal,
) => Promise<BackendApprovalDecision>;

export interface AgentDriverOptions {
  /** Environment handed to agent-backend children (the adapter strips `BRIDGE_STRIPPED_ENV`). */
  readonly backendEnv?: Readonly<Record<string, string>>;
  /** Native-mode permission prompts for backend built-ins; absent means they are denied. */
  readonly backendApprovals?: BackendApprovalHandler;
  /** Redacts backend tool observations before they are logged (credential values, secret shapes). */
  readonly backendRedact?: (text: string) => string;
  /** K6: the reasoning effort of a turn's next step (role/tier settings, clamped to the route model); undefined = provider default. */
  readonly reasoningEffort?: (input: TurnInput) => ReasoningEffort | undefined;
}

/** Creates the fixed agent loop (ADR-02) over the given seams. */
export function createAgentDriver(deps: AgentDriverDependencies & AgentDriverOptions): PausableAgentDriver {
  return new FixedAgentDriver(deps);
}

/** K1.7: a driver whose next model step can be held (per-worker pause) and released. */
export interface PausableAgentDriver extends AgentDriver {
  readonly paused: boolean;
  pause(): void;
  resume(): void;
}

export function isPausableDriver(driver: AgentDriver): driver is PausableAgentDriver {
  const candidate = driver as Partial<PausableAgentDriver>;
  return typeof candidate.pause === "function" && typeof candidate.resume === "function";
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
  readonly effort?: ReasoningEffort;
}

type Prepared = { readonly kind: "ok"; readonly request: ModelRequest } | { readonly kind: "cancelled" | "failed" | "budget_exceeded" };

/** A refused preparation ends the step without a model request: aborted when nothing was attempted, errored otherwise. */
function refusedStepState(kind: Exclude<Prepared["kind"], "ok">): "aborted" | "errored" {
  return kind === "failed" ? "errored" : "aborted";
}

class FixedAgentDriver implements PausableAgentDriver {
  readonly #deps: AgentDriverDependencies & AgentDriverOptions;
  readonly #steers: string[] = [];
  readonly #wakers: (() => void)[] = [];
  #paused = false;
  readonly #backendSessions = new Map<string, string>();

  public constructor(deps: AgentDriverDependencies & AgentDriverOptions) {
    this.#deps = deps;
  }

  public steer(text: string): void {
    if (text.trim().length === 0) throw new RangeError("steer text must not be empty");
    this.#steers.push(text);
  }

  public drainSteers(): readonly string[] {
    return this.#steers.splice(0);
  }

  public get paused(): boolean {
    return this.#paused;
  }

  public pause(): void {
    this.#paused = true;
  }

  public resume(): void {
    this.#paused = false;
    for (const wake of this.#wakers.splice(0)) wake();
  }

  /** K1.7: a paused driver starts no new step; the step in flight finishes first. Abort ends the wait. */
  async #whilePaused(signal: AbortSignal): Promise<void> {
    while (this.#paused && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal.removeEventListener("abort", wake);
          resolve();
        };
        this.#wakers.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
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
        const images = (input.userImages ?? []).map((blob): ContentPart => ({ type: "image", blob: blob as Extract<ContentPart, { type: "image" }>["blob"] }));
        await this.#recordMessage(log, { role: "user", content: [{ type: "text", text: input.userMessage }, ...images] }, undefined);
      }
      const adapter = this.#deps.router.adapterFor(input.route);
      let outcome: TurnOutcome["outcome"] = "max_steps";
      while (steps < input.maxSteps) {
        await this.#whilePaused(signal);
        if (signal.aborted) {
          outcome = "cancelled";
          break;
        }
        await this.#drainSteers(log);
        steps += 1;
        // K6: read per step, so an /effort change applies to the next model request.
        const effort = this.#deps.reasoningEffort?.(input);
        const step: StepContext = { input, log, turnId, stepId: createId("step"), requestId: createId("request"), ...(effort === undefined ? {} : { effort }) };
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
    const outcome = await consumeStream(await this.#openModelStream(adapter, await withImageData(this.#deps.blobs, prepared.request), step.input.route, signal), signal);
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
    // K4.2: images read by tools (read_file on a png) reach the model as a user image part after the batch's results.
    const images: { readonly call: ToolCallRef; readonly image: Extract<ContentPart, { type: "image" }>["blob"] }[] = [];
    const flushImages = async (): Promise<void> => {
      if (images.length === 0) return;
      const content: ContentPart[] = images.flatMap(({ call, image }): ContentPart[] => [
        { type: "text", text: `[image returned by ${call.name}]` },
        { type: "image", blob: image },
      ]);
      images.length = 0;
      await this.#recordMessage(step.log, { role: "user", content }, step.requestId);
    };
    for (const [index, call] of calls.entries()) {
      if (signal.aborted) {
        for (const skipped of calls.slice(index)) {
          await this.#recordToolResult(step, skipped, { isError: true, text: "cancelled before execution", blob: undefined });
        }
        return this.#endStep(step, "aborted", "cancelled");
      }
      if (step.input.reportOnly !== undefined && call.name !== step.input.reportOnly) {
        // A report-only turn offers one tool; any other call is answered without running it.
        await this.#recordToolResult(step, call, { isError: true, text: `not executed: this is a report-only turn; call ${step.input.reportOnly} now`, blob: undefined });
        continue;
      }
      const result = await this.#invokeRecorded(step, call, signal);
      const image = toolImage(result.result.blob);
      const imageNote = image === undefined ? "" : IMAGE_INPUT_ADAPTERS.has(step.input.route.adapter_id) ? "" : `\n(the ${step.input.route.adapter_id} route does not take image input; the image was not shown to you)`;
      if (image !== undefined && imageNote === "") images.push({ call, image });
      await this.#recordToolResult(step, call, { isError: result.result.status === "error", text: `${renderToolResultText(result.ref, result.result)}${imageNote}`, blob: result.result.blob });
      if (result.endsTurn === true) {
        // A terminal control tool succeeded (ADR-20): the rest of the batch is not run and no further request is sent.
        for (const skipped of calls.slice(index + 1)) {
          await this.#recordToolResult(step, skipped, { isError: true, text: `not executed: turn ended by ${call.name}`, blob: undefined });
        }
        return this.#endStep(step, "settled", "completed");
      }
    }
    await flushImages();
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
      if (input.reportOnly !== undefined && ref.name !== input.reportOnly) return { isError: true, text: `not executed: this is a report-only turn; call ${input.reportOnly} now` };
      try {
        const outcome = await this.#invokeRecorded(step, ref, AbortSignal.any([stepSignal, callSignal]));
        const text = renderToolResultText(outcome.ref, outcome.result);
        await this.#recordToolResult(step, ref, { isError: outcome.result.status === "error", text, blob: outcome.result.blob });
        return { isError: outcome.result.status === "error", text };
      } catch (error: unknown) {
        storeError = error;
        stepController.abort();
        return { isError: true, text: "the session store is unavailable; the tool call was not executed" };
      }
    };
    const native = adapter.nativeTools === true;
    // Native backends (Claude Code native mode) bring their own WebSearch/WebFetch: Synorch's web tools stay off the bridge.
    const hidden = (name: string): boolean => native && NATIVE_DUPLICATE_TOOLS.has(name);
    const tools: ToolBridge = {
      serverName: "synorch",
      list: () => this.#deps.tools.visibleTo(input.role, input.policy).filter((tool) => !hidden(tool.name) && (input.reportOnly === undefined || tool.name === input.reportOnly)),
      call: (call, callSignal) => {
        if (hidden(bridgeToolName(call.name))) return Promise.resolve({ isError: true, text: `${call.name} is not offered here; use Claude Code's built-in WebSearch/WebFetch` });
        const run = chain.then(() => runBridgeCall(call, callSignal));
        chain = run.catch(() => undefined);
        return run;
      },
    };
    const approvals: ApprovalBridge = {
      decide: async (toolName, toolInput, decideSignal) => {
        if (toolName.startsWith(BRIDGE_TOOL_PREFIX)) {
          return this.#deps.tools.get(bridgeToolName(toolName)) !== undefined
            ? { allow: true, reason: "Synorch bridge tool; policy is enforced by the tool gateway" }
            : { allow: false, reason: `${toolName} is not a Synorch bridge tool` };
        }
        const handler = this.#deps.backendApprovals;
        if (!native || handler === undefined) return { allow: false, reason: `${toolName} is not a Synorch bridge tool` };
        try {
          return await handler(
            toolName,
            toolInput,
            {
              role: input.role,
              runId: input.runId,
              taskId: input.taskId,
              attemptId: input.attemptId,
              policy: input.policy,
              record: (type, data) => step.log.append(type, data as never),
            },
            AbortSignal.any([stepSignal, decideSignal]),
          );
        } catch (error: unknown) {
          return { allow: false, reason: `the permission check failed: ${describe(error)}`.slice(0, 1000) };
        }
      },
    };
    // Native built-in tool use is audit and display only: one event per phase, never a Synorch tool call or history.
    let observed: Promise<unknown> = Promise.resolve();
    const redact = this.#deps.backendRedact ?? ((text: string) => text);
    const observe = (observation: BackendToolObservation): void => {
      observed = observed
        .then(() =>
          step.log.append("backend/tool_observed", {
            source: "claude-code-native",
            phase: observation.phase,
            tool_use_id: observation.toolUseId.slice(0, 200),
            tool_name: observation.toolName.slice(0, 200),
            input_summary: redact(observation.inputSummary).slice(0, 2000),
            ...(observation.isError === undefined ? {} : { is_error: observation.isError }),
            ...(observation.resultSummary === undefined ? {} : { result_summary: redact(observation.resultSummary).slice(0, 4000) }),
            ...(observation.linesAdded === undefined ? {} : { lines_added: observation.linesAdded }),
            ...(observation.linesRemoved === undefined ? {} : { lines_removed: observation.linesRemoved }),
          }),
        )
        .catch((error: unknown) => {
          storeError ??= error;
          stepController.abort();
        });
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
          ...(step.effort === undefined ? {} : { reasoningEffort: step.effort }),
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
        const messages = (await withImageData(this.#deps.blobs, prepared.request)).messages;
        const stream = active.runTurn({ requestId: step.requestId, route: input.route, messages }, native ? { tools, approvals, observe } : { tools, approvals }, stepSignal);
        outcome = await consumeStream(stream, stepSignal, native ? undefined : rejectForeignBackendTools);
        if (outcome.kind === "failed") await active.interrupt().catch(() => undefined);
        await chain;
        await observed;
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
          ...(input.sources === undefined ? {} : { sources: input.sources }),
          ...(input.reportOnly === undefined ? {} : { reportOnly: input.reportOnly }),
          ...(step.effort === undefined ? {} : { reasoningEffort: step.effort }),
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
    // Quota headers without a usage report (e.g. a 429) still reach the footer.
    if (outcome.usage === undefined && outcome.quota === undefined) return;
    await step.log.append("provider/usage", {
      request_id: step.requestId,
      usage: outcome.usage ?? { source: "unknown" },
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
        : input.role === "session"
          ? { kind: "agent", role: input.role }
          : { kind: "worker", role: input.role, ...(input.attemptId === undefined ? {} : { attempt_id: input.attemptId }) };
    this.#correlation = {
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
      ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
      ...(input.attemptId === undefined ? {} : { attempt_id: input.attemptId }),
    };
  }

  public append<T extends SessionEventType>(type: T, data: SessionEventOf<T>["data"]): Promise<SessionEvent> {
    return this.#events.append({ type, event_version: EVENT_VERSIONS[type], actor: this.#actor, ...this.#correlation, data } as SessionEventDraft);
  }
}

/**
 * The tool result text the model sees, without a short ref: `renderToolResultText` (ADR-18). An
 * error's code and (already redacted) message are appended: without them a denial or a structured
 * rejection (e.g. `plan_propose` with the reasons to fix) reached the model as an empty error it
 * could not act on. The driver itself renders with the call's `[#n]` ref.
 */
export function modelVisibleText(result: Pick<ToolResult, "text" | "error">): string {
  return renderToolResultText(undefined, result);
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
