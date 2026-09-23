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
  type QuotaSnapshot,
  type ResolvedCredential,
} from "../contracts/index.ts";
import { isProviderError, StreamAssembler, usageOf } from "./assembler.ts";
import { classifyStreamError, numberField, providerError, record, stringField } from "./errors.ts";
import { failure, splitSystemBlocks, streamHttp, type FetchLike, type SseMapper } from "./http-stream.ts";
import type { SseMessage } from "./sse.ts";

/** ChatGPT subscription inference base (research: openai-chatgpt-oauth §2, §7). */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const SYNORCH_ORIGINATOR = "synorch";

export interface ResponsesAdapterOptions {
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  /** Statically configured models; capability discovery never sends a paid request. */
  readonly models?: readonly ModelCapability[];
  readonly now?: () => Date;
}

interface Variant {
  readonly adapterId: "openai-chatgpt" | "openai-responses";
  readonly authMethod: "oauth-subscription" | "api-key";
  readonly defaultBaseUrl: string;
  readonly subscription: boolean;
}

const CHATGPT: Variant = {
  adapterId: "openai-chatgpt",
  authMethod: "oauth-subscription",
  defaultBaseUrl: CHATGPT_CODEX_BASE_URL,
  subscription: true,
};

const API: Variant = {
  adapterId: "openai-responses",
  authMethod: "api-key",
  defaultBaseUrl: OPENAI_API_BASE_URL,
  subscription: false,
};

/** `openai-chatgpt`: Responses over the ChatGPT backend, `store:false`, full history each request. */
export function createOpenAIChatGPTAdapter(options: ResponsesAdapterOptions = {}): ModelAdapter {
  return createResponsesAdapter(CHATGPT, options);
}

/** `openai-responses`: the public Responses API with an API key, sharing the stateless wire code. */
export function createOpenAIResponsesAdapter(options: ResponsesAdapterOptions = {}): ModelAdapter {
  return createResponsesAdapter(API, options);
}

function createResponsesAdapter(variant: Variant, options: ResponsesAdapterOptions): ModelAdapter {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = (options.baseUrl ?? variant.defaultBaseUrl).replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  const providerId = providerIdSchema.parse("openai");

  function capabilities(): ProviderCapabilities {
    return {
      schema_version: 1,
      provider_id: providerId,
      adapter_id: variant.adapterId,
      adapter_kind: "model",
      auth_method: variant.authMethod,
      auth_status: "unknown",
      billing: variant.subscription ? "subscription" : "metered",
      quota_visibility: variant.subscription ? "headers" : "none",
      loop_owner: "synorch",
      tool_channel: "native",
      policy_status: "permitted",
      models: [...(options.models ?? [])],
      probed_at: now().toISOString(),
      source: "static-config",
    };
  }

  const adapter: ModelAdapter = {
    kind: "model",
    adapterId: variant.adapterId,
    providerId,
    authMethod: variant.authMethod,
    async discoverCapabilities() {
      return capabilities();
    },
    prepare(request, caps) {
      return prepareResponses(variant, request, caps);
    },
    stream(request, credential, signal) {
      return streamResponses(variant, fetchImpl, baseUrl, request, credential, signal, capabilities());
    },
    async health(): Promise<ProviderHealth> {
      return { state: "unknown", checked_at: now().toISOString(), detail: "health is not probed without a request; no paid call is made" };
    },
  };
  return adapter;
}

interface PreparedBody {
  readonly body: Record<string, unknown>;
  readonly warnings: readonly string[];
}

function buildBody(variant: Variant, request: ModelRequest): PreparedBody | { readonly error: string } {
  const warnings: string[] = [];
  const { instructions, untrusted } = splitSystemBlocks(request.system);
  const input: Record<string, unknown>[] = [];
  if (untrusted !== undefined) {
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: untrusted }] });
  }
  for (const message of request.messages) {
    const userText: Record<string, unknown>[] = [];
    const flushUser = () => {
      if (userText.length > 0) input.push({ type: "message", role: "user", content: userText.splice(0) });
    };
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (message.role === "assistant") {
            input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: part.text }] });
          } else {
            userText.push({ type: "input_text", text: part.text });
          }
          break;
        case "thinking":
          if (part.opaque !== undefined) {
            flushUser();
            input.push({
              type: "reasoning",
              summary: part.text === "" ? [] : [{ type: "summary_text", text: part.text }],
              encrypted_content: part.opaque,
            });
          }
          break;
        case "tool_call":
          flushUser();
          input.push({ type: "function_call", call_id: part.provider_call_id, name: part.name, arguments: JSON.stringify(part.arguments) });
          break;
        case "tool_result":
          flushUser();
          if (part.blob !== undefined) warnings.push(`tool result ${part.provider_call_id} blob is sent as its inline text only`);
          input.push({ type: "function_call_output", call_id: part.provider_call_id, output: part.text });
          break;
        case "blob":
          return { error: "blob (image/file) input is not supported by this adapter" };
      }
    }
    flushUser();
  }

  const body: Record<string, unknown> = {
    model: request.route.model_id,
    instructions,
    input,
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: false,
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  // Prompt caching (ADR-20, F16): a key stable per session and role routes every step to the same cache.
  if (request.cache !== undefined) body.prompt_cache_key = request.cache.key;
  if (request.reasoning_effort !== undefined) body.reasoning = { effort: request.reasoning_effort, summary: "auto" };
  if (request.max_output_tokens !== undefined) {
    if (variant.subscription) warnings.push("max_output_tokens is not sent to the ChatGPT backend");
    else body.max_output_tokens = request.max_output_tokens;
  }
  return { body, warnings };
}

function prepareResponses(variant: Variant, request: ModelRequest, caps: ProviderCapabilities): PrepareResult {
  if (caps.adapter_id !== variant.adapterId) {
    return { ok: false, error: providerError("invalid_request", `capabilities belong to ${caps.adapter_id}, not ${variant.adapterId}`) };
  }
  if (request.route.adapter_id !== variant.adapterId) {
    return { ok: false, error: providerError("invalid_request", `route targets ${request.route.adapter_id}, not ${variant.adapterId}`) };
  }
  const model = caps.models.find((candidate) => candidate.id === request.route.model_id);
  if (model !== undefined && request.tools.length > 0 && model.tool_calls === "unsupported") {
    return { ok: false, error: providerError("model_unavailable", `${model.id} does not support tool calls`) };
  }
  const prepared = buildBody(variant, request);
  if ("error" in prepared) return { ok: false, error: providerError("invalid_request", prepared.error) };
  return { ok: true, wireDigest: digestOf(prepared.body), warnings: prepared.warnings };
}

async function* streamResponses(
  variant: Variant,
  fetchImpl: FetchLike,
  baseUrl: string,
  request: ModelRequest,
  credential: ResolvedCredential,
  signal: AbortSignal,
  caps: ProviderCapabilities,
): AsyncGenerator<ModelStreamEvent> {
  const mapper = new ResponsesMapper();
  try {
    const prepared = prepareResponses(variant, request, caps);
    const built = buildBody(variant, request);
    if (!prepared.ok || "error" in built) {
      yield { type: "error", error: prepared.ok ? providerError("invalid_request", "request could not be prepared") : prepared.error };
      return;
    }
    const headers = new Headers({
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": `synorch/${SYNORCH_VERSION}`,
    });
    if (variant.subscription) {
      headers.set("originator", SYNORCH_ORIGINATOR);
      headers.set("OpenAI-Beta", "responses=experimental");
    }
    credential.applyTo(headers);
    yield* streamHttp({
      request,
      signal,
      fetch: fetchImpl,
      url: `${baseUrl}/responses`,
      headers,
      body: built.body,
      subscription: variant.subscription,
      mapper,
      ...(variant.subscription ? { headerEvents: quotaEvents } : {}),
    });
  } catch (error: unknown) {
    yield failure(mapper, providerError("provider_internal", error instanceof Error ? error.message : String(error)));
  }
}

const QUOTA_WINDOWS = ["primary", "secondary"] as const;

/** `x-codex-{primary,secondary}-*` usage headers → one `quota` event (never mixed with tokens). */
export function parseCodexQuota(headers: Headers): QuotaSnapshot | undefined {
  const windows: QuotaSnapshot["windows"][number][] = [];
  for (const name of QUOTA_WINDOWS) {
    const used = headers.get(`x-codex-${name}-used-percent`);
    if (used === null || used.trim() === "" || Number.isNaN(Number(used))) continue;
    const percent = Math.min(100, Math.max(0, Number(used)));
    const resetsAt = parseReset(headers.get(`x-codex-${name}-reset-at`));
    windows.push(resetsAt === undefined ? { name, used_percent: percent } : { name, used_percent: percent, resets_at: resetsAt });
  }
  return windows.length === 0 ? undefined : { source: "headers", windows };
}

function parseReset(value: string | null): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function quotaEvents(headers: Headers): readonly ModelStreamEvent[] {
  const quota = parseCodexQuota(headers);
  return quota === undefined ? [] : [{ type: "quota", quota }];
}

/** Responses SSE → stream grammar (research: openai-chatgpt-oauth §7, api-keys). */
class ResponsesMapper implements SseMapper {
  public readonly assembler = new StreamAssembler();

  public map(message: SseMessage): readonly ModelStreamEvent[] {
    let payload: Record<string, unknown> | undefined;
    try {
      payload = record(JSON.parse(message.data));
    } catch {
      payload = undefined;
    }
    if (payload === undefined) {
      if (message.data.trim() === "[DONE]") return [];
      return [failure(this, providerError("protocol_mismatch", "stream carried a non-JSON event"))];
    }
    const type = stringField(payload, "type") ?? message.event ?? "";
    const index = numberField(payload, "output_index") ?? 0;
    const item = record(payload.item);
    switch (type) {
      case "response.output_item.added":
        if (stringField(item, "type") === "function_call") {
          const callId = stringField(item, "call_id") ?? stringField(item, "id") ?? `call_${index}`;
          return [this.assembler.toolStart(index, callId, stringField(item, "name") ?? "unknown")];
        }
        return [];
      case "response.output_text.delta":
        return [this.assembler.text(index, stringField(payload, "delta") ?? "")];
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return [this.assembler.thinking(index, stringField(payload, "delta") ?? "")];
      case "response.function_call_arguments.delta": {
        const event = this.assembler.toolDelta(index, stringField(payload, "delta") ?? "");
        return event === undefined ? [] : [event];
      }
      case "response.function_call_arguments.done":
        return this.endTool(index, stringField(payload, "arguments"));
      case "response.output_item.done":
        return this.itemDone(index, item);
      case "response.completed":
        return this.completed(record(payload.response), "stop");
      case "response.incomplete": {
        const response = record(payload.response);
        const reason = stringField(record(response?.incomplete_details), "reason");
        if (reason === "max_output_tokens") return this.completed(response, "length");
        return [failure(this, providerError("invalid_request", `response incomplete: ${reason ?? "unknown reason"}`, reason === undefined ? {} : { providerCode: reason }))];
      }
      case "response.failed": {
        const error = record(record(payload.response)?.error);
        return [failure(this, classifyStreamError(stringField(error, "type"), stringField(error, "code"), stringField(error, "message")))];
      }
      case "error": {
        const error = record(payload.error) ?? payload;
        return [failure(this, classifyStreamError(stringField(error, "type"), stringField(error, "code"), stringField(error, "message")))];
      }
      default:
        return [];
    }
  }

  private endTool(index: number, finalArguments: string | undefined): readonly ModelStreamEvent[] {
    const result = this.assembler.toolEnd(index, finalArguments);
    if (result === undefined) return [];
    return isProviderError(result) ? [failure(this, result)] : [result];
  }

  private itemDone(index: number, item: Record<string, unknown> | undefined): readonly ModelStreamEvent[] {
    switch (stringField(item, "type")) {
      case "function_call":
        return this.assembler.hasOpenTool(index) ? this.endTool(index, stringField(item, "arguments")) : [];
      case "reasoning": {
        const encrypted = stringField(item, "encrypted_content");
        const summary = Array.isArray(item?.summary)
          ? item.summary.map((part) => stringField(record(part), "text") ?? "").join("")
          : undefined;
        if (encrypted !== undefined) this.assembler.thinkingOpaque(index, encrypted, summary);
        return [];
      }
      case "message": {
        const partial = this.assembler.partial();
        const hasText = partial?.content.some((part) => part.type === "text") ?? false;
        if (hasText || !Array.isArray(item?.content)) return [];
        const text = item.content.map((part) => stringField(record(part), "text") ?? "").join("");
        return text === "" ? [] : [this.assembler.text(index, text)];
      }
      default:
        return [];
    }
  }

  private completed(response: Record<string, unknown> | undefined, stop: "stop" | "length"): readonly ModelStreamEvent[] {
    const raw = record(response?.usage);
    const usage = usageOf({
      input_tokens: numberField(raw, "input_tokens"),
      output_tokens: numberField(raw, "output_tokens"),
      cache_read_tokens: numberField(record(raw?.input_tokens_details), "cached_tokens"),
      reasoning_tokens: numberField(record(raw?.output_tokens_details), "reasoning_tokens"),
    }, raw === undefined ? "unknown" : "provider-reported");
    const stopReason = stop === "length" ? "length" : this.assembler.hasToolCalls() ? "tool_use" : "stop";
    const events: ModelStreamEvent[] = [];
    if (raw !== undefined) events.push({ type: "usage", usage });
    events.push({ type: "done", stop_reason: stopReason, message: this.assembler.message(), usage });
    return events;
  }
}
