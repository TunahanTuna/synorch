import { SYNORCH_VERSION } from "../../domain/product.ts";
import {
  digestOf,
  providerIdSchema,
  type ModelAdapter,
  type ModelCapability,
  type ModelRequest,
  type ModelStreamEvent,
  type PrepareResult,
  type ProviderCapabilities,
  type ProviderHealth,
  type ResolvedCredential,
} from "../contracts/index.ts";
import { isProviderError, StreamAssembler, usageOf } from "./assembler.ts";
import { classifyStreamError, numberField, providerError, record, stringField } from "./errors.ts";
import { failure, splitSystemBlocks, streamHttp, type FetchLike, type SseMapper } from "./http-stream.ts";
import type { SseMessage } from "./sse.ts";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Messages requires `max_tokens`; used only when the request does not set one (reported as a warning). */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

const THINKING_BUDGETS = { low: 1024, medium: 4096, high: 16384 } as const;

export interface AnthropicMessagesOptions {
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly models?: readonly ModelCapability[];
  readonly now?: () => Date;
}

/** `anthropic-messages`: the Messages API with an API key (research: api-keys). */
export function createAnthropicMessagesAdapter(options: AnthropicMessagesOptions = {}): ModelAdapter {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = (options.baseUrl ?? ANTHROPIC_API_BASE_URL).replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  const providerId = providerIdSchema.parse("anthropic");

  function capabilities(): ProviderCapabilities {
    return {
      schema_version: 1,
      provider_id: providerId,
      adapter_id: "anthropic-messages",
      adapter_kind: "model",
      auth_method: "api-key",
      auth_status: "unknown",
      billing: "metered",
      quota_visibility: "none",
      loop_owner: "synorch",
      tool_channel: "native",
      policy_status: "permitted",
      models: [...(options.models ?? [])],
      probed_at: now().toISOString(),
      source: "static-config",
    };
  }

  return {
    kind: "model",
    adapterId: "anthropic-messages",
    providerId,
    authMethod: "api-key",
    async discoverCapabilities() {
      return capabilities();
    },
    prepare(request, caps) {
      return prepareMessages(request, caps);
    },
    stream(request, credential, signal) {
      return streamMessages(fetchImpl, baseUrl, request, credential, signal, capabilities());
    },
    async health(): Promise<ProviderHealth> {
      return { state: "unknown", checked_at: now().toISOString(), detail: "health is not probed without a request; no paid call is made" };
    },
  };
}

type Block = Record<string, unknown>;

interface Built {
  readonly body: Record<string, unknown>;
  readonly warnings: readonly string[];
}

/** Opaque thinking continuations are stored as `{"signature":…}` or `{"redacted":…}`. */
export function encodeThinkingOpaque(value: { readonly signature: string } | { readonly redacted: string }): string {
  return JSON.stringify(value);
}

function decodeThinkingOpaque(opaque: string): { signature?: string; redacted?: string } | undefined {
  try {
    const value = record(JSON.parse(opaque));
    const signature = stringField(value, "signature");
    const redacted = stringField(value, "redacted");
    if (signature !== undefined) return { signature };
    if (redacted !== undefined) return { redacted };
    return undefined;
  } catch {
    return undefined;
  }
}

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Trusted instructions as text blocks: the first `cache.stable_system_blocks` blocks (byte-stable
 * for the session) carry the `cache_control` breakpoint; the variable trusted blocks (packet)
 * follow uncached. Untrusted blocks never enter `system`; they go to the first user message.
 */
function cachedSystem(request: ModelRequest): Block[] {
  const stableCount = request.cache?.stable_system_blocks ?? 0;
  const trusted = (blocks: typeof request.system) => blocks.filter((block) => block.trust !== "untrusted").map((block) => block.text);
  const stable = trusted(request.system.slice(0, stableCount)).join("\n\n");
  const rest = trusted(request.system.slice(stableCount)).join("\n\n");
  const blocks: Block[] = [];
  if (stable !== "") blocks.push({ type: "text", text: stable, cache_control: EPHEMERAL });
  if (rest !== "") blocks.push({ type: "text", text: rest });
  return blocks;
}

function buildMessagesBody(request: ModelRequest): Built | { readonly error: string } {
  const warnings: string[] = [];
  const { instructions, untrusted } = splitSystemBlocks(request.system);
  const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", block: Block) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  if (untrusted !== undefined) push("user", { type: "text", text: untrusted });

  for (const message of request.messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          push(role, { type: "text", text: part.text });
          break;
        case "thinking": {
          const opaque = part.opaque === undefined ? undefined : decodeThinkingOpaque(part.opaque);
          if (opaque?.signature !== undefined) push(role, { type: "thinking", thinking: part.text, signature: opaque.signature });
          else if (opaque?.redacted !== undefined) push(role, { type: "redacted_thinking", data: opaque.redacted });
          else warnings.push("unsigned thinking is not replayed");
          break;
        }
        case "tool_call":
          push("assistant", { type: "tool_use", id: part.provider_call_id, name: part.name, input: part.arguments });
          break;
        case "tool_result":
          if (part.blob !== undefined) warnings.push(`tool result ${part.provider_call_id} blob is sent as its inline text only`);
          push("user", { type: "tool_result", tool_use_id: part.provider_call_id, content: part.text, is_error: part.is_error });
          break;
        case "blob":
          return { error: "blob (image/file) input is not supported by this adapter" };
      }
    }
  }

  let maxTokens = request.max_output_tokens;
  if (maxTokens === undefined) {
    maxTokens = ANTHROPIC_DEFAULT_MAX_TOKENS;
    warnings.push(`max_output_tokens not set; using ${ANTHROPIC_DEFAULT_MAX_TOKENS}`);
  }
  const body: Record<string, unknown> = {
    model: request.route.model_id,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };
  const tools = request.tools.map((tool): Block => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
  if (request.cache === undefined) {
    if (instructions !== "") body.system = instructions;
  } else {
    // Prompt caching (ADR-20): breakpoints after the tool list, after the last session-stable system
    // block and after the newest history block, so each step reads the previous step's prefix.
    const system = cachedSystem(request);
    if (system.length > 0) body.system = system;
    const lastTool = tools.at(-1);
    if (lastTool !== undefined) lastTool.cache_control = EPHEMERAL;
    const lastBlock = messages.at(-1)?.content.at(-1);
    if (lastBlock !== undefined && lastBlock.type !== "thinking" && lastBlock.type !== "redacted_thinking") lastBlock.cache_control = EPHEMERAL;
  }
  if (tools.length > 0) body.tools = tools;
  if (request.reasoning_effort !== undefined) {
    const budget = THINKING_BUDGETS[request.reasoning_effort];
    if (budget < maxTokens) body.thinking = { type: "enabled", budget_tokens: budget };
    else warnings.push(`reasoning_effort ${request.reasoning_effort} needs max_output_tokens above ${budget}; thinking disabled`);
  }
  return { body, warnings };
}

function prepareMessages(request: ModelRequest, caps: ProviderCapabilities): PrepareResult {
  if (caps.adapter_id !== "anthropic-messages" || request.route.adapter_id !== "anthropic-messages") {
    return { ok: false, error: providerError("invalid_request", "request or capabilities do not target anthropic-messages") };
  }
  const model = caps.models.find((candidate) => candidate.id === request.route.model_id);
  if (model !== undefined && request.tools.length > 0 && model.tool_calls === "unsupported") {
    return { ok: false, error: providerError("model_unavailable", `${model.id} does not support tool calls`) };
  }
  const built = buildMessagesBody(request);
  if ("error" in built) return { ok: false, error: providerError("invalid_request", built.error) };
  return { ok: true, wireDigest: digestOf(built.body), warnings: built.warnings };
}

async function* streamMessages(
  fetchImpl: FetchLike,
  baseUrl: string,
  request: ModelRequest,
  credential: ResolvedCredential,
  signal: AbortSignal,
  caps: ProviderCapabilities,
): AsyncGenerator<ModelStreamEvent> {
  const mapper = new MessagesMapper();
  try {
    const prepared = prepareMessages(request, caps);
    const built = buildMessagesBody(request);
    if (!prepared.ok || "error" in built) {
      yield { type: "error", error: prepared.ok ? providerError("invalid_request", "request could not be prepared") : prepared.error };
      return;
    }
    const headers = new Headers({
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": ANTHROPIC_VERSION,
      "user-agent": `synorch/${SYNORCH_VERSION}`,
    });
    credential.applyTo(headers);
    yield* streamHttp({
      request,
      signal,
      fetch: fetchImpl,
      url: `${baseUrl}/messages`,
      headers,
      body: built.body,
      subscription: false,
      mapper,
      requestIdHeaders: ["request-id", "x-request-id"],
    });
  } catch (error: unknown) {
    yield failure(mapper, providerError("provider_internal", error instanceof Error ? error.message : String(error)));
  }
}

/** Anthropic Messages SSE → stream grammar. Reused by the Claude Code bridge for `stream_event`s. */
export class MessagesMapper implements SseMapper {
  public readonly assembler: StreamAssembler;
  private inputUsage: Record<string, unknown> | undefined;
  private outputTokens: number | undefined;
  private stopReason: string | undefined;
  private readonly indexOffset: () => number;

  public constructor(indexOffset: () => number = () => 0, assembler: StreamAssembler = new StreamAssembler()) {
    this.indexOffset = indexOffset;
    this.assembler = assembler;
  }

  public map(message: SseMessage): readonly ModelStreamEvent[] {
    let payload: Record<string, unknown> | undefined;
    try {
      payload = record(JSON.parse(message.data));
    } catch {
      payload = undefined;
    }
    if (payload === undefined) return [failure(this, providerError("protocol_mismatch", "stream carried a non-JSON event"))];
    return this.mapEvent(payload, message.event);
  }

  /** Maps one already-parsed Messages stream event. `done` is produced on `message_stop`. */
  public mapEvent(payload: Record<string, unknown>, eventName?: string): readonly ModelStreamEvent[] {
    const type = stringField(payload, "type") ?? eventName ?? "";
    const index = (numberField(payload, "index") ?? 0) + this.indexOffset();
    switch (type) {
      case "message_start":
        this.inputUsage = record(record(payload.message)?.usage);
        return [];
      case "content_block_start":
        return this.blockStart(index, record(payload.content_block));
      case "content_block_delta":
        return this.blockDelta(index, record(payload.delta));
      case "content_block_stop": {
        if (!this.assembler.hasOpenTool(index)) return [];
        const result = this.assembler.toolEnd(index);
        if (result === undefined) return [];
        return isProviderError(result) ? [failure(this, result)] : [result];
      }
      case "message_delta":
        this.stopReason = stringField(record(payload.delta), "stop_reason") ?? this.stopReason;
        this.outputTokens = numberField(record(payload.usage), "output_tokens") ?? this.outputTokens;
        return [];
      case "message_stop":
        return this.finish();
      case "error": {
        const error = record(payload.error);
        return [failure(this, classifyStreamError(stringField(error, "type"), undefined, stringField(error, "message")))];
      }
      default:
        return [];
    }
  }

  public usage() {
    const input = this.inputUsage;
    return usageOf({
      input_tokens: numberField(input, "input_tokens"),
      output_tokens: this.outputTokens ?? numberField(input, "output_tokens"),
      cache_read_tokens: numberField(input, "cache_read_input_tokens"),
      cache_write_tokens: numberField(input, "cache_creation_input_tokens"),
    }, input === undefined && this.outputTokens === undefined ? "unknown" : "provider-reported");
  }

  public stopReasonOf(): "stop" | "length" | "tool_use" {
    if (this.stopReason === "max_tokens") return "length";
    if (this.stopReason === "tool_use" || (this.stopReason === undefined && this.assembler.hasToolCalls())) return "tool_use";
    return "stop";
  }

  private finish(): readonly ModelStreamEvent[] {
    const usage = this.usage();
    const events: ModelStreamEvent[] = [];
    if (usage.source !== "unknown") events.push({ type: "usage", usage });
    events.push({ type: "done", stop_reason: this.stopReasonOf(), message: this.assembler.message(), usage });
    return events;
  }

  private blockStart(index: number, block: Record<string, unknown> | undefined): readonly ModelStreamEvent[] {
    switch (stringField(block, "type")) {
      case "text": {
        const text = stringField(block, "text") ?? "";
        return text === "" ? [] : [this.assembler.text(index, text)];
      }
      case "thinking": {
        const text = stringField(block, "thinking") ?? "";
        return text === "" ? [] : [this.assembler.thinking(index, text)];
      }
      case "redacted_thinking": {
        const data = stringField(block, "data");
        if (data !== undefined) this.assembler.thinkingOpaque(index, encodeThinkingOpaque({ redacted: data }));
        return [];
      }
      case "tool_use":
        return [this.assembler.toolStart(index, stringField(block, "id") ?? `toolu_${index}`, stringField(block, "name") ?? "unknown")];
      default:
        return [];
    }
  }

  private blockDelta(index: number, delta: Record<string, unknown> | undefined): readonly ModelStreamEvent[] {
    switch (stringField(delta, "type")) {
      case "text_delta":
        return [this.assembler.text(index, stringField(delta, "text") ?? "")];
      case "thinking_delta":
        return [this.assembler.thinking(index, stringField(delta, "thinking") ?? "")];
      case "signature_delta": {
        const signature = stringField(delta, "signature");
        if (signature !== undefined) this.assembler.thinkingOpaque(index, encodeThinkingOpaque({ signature }));
        return [];
      }
      case "input_json_delta": {
        const event = this.assembler.toolDelta(index, stringField(delta, "partial_json") ?? "");
        return event === undefined ? [] : [event];
      }
      default:
        return [];
    }
  }
}
