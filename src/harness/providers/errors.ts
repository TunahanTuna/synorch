import { PROVIDER_ERROR_RETRYABLE, type ProviderError, type ProviderErrorCode } from "../contracts/index.ts";

const MAX_MESSAGE = 2000;

/** Builds a schema-valid provider error: `retryable` always follows the contract table. */
export function providerError(
  code: ProviderErrorCode,
  message: string,
  extra: { readonly httpStatus?: number; readonly providerCode?: string; readonly retryAfterMs?: number } = {},
): ProviderError {
  const error: { -readonly [K in keyof ProviderError]: ProviderError[K] } = {
    code,
    message: truncate(message.trim() === "" ? code : message),
    retryable: PROVIDER_ERROR_RETRYABLE[code],
  };
  if (extra.httpStatus !== undefined && extra.httpStatus >= 100 && extra.httpStatus <= 599) error.http_status = extra.httpStatus;
  if (extra.providerCode !== undefined && extra.providerCode !== "") error.provider_code = extra.providerCode.slice(0, 200);
  if (extra.retryAfterMs !== undefined && Number.isFinite(extra.retryAfterMs)) {
    error.retry_after_ms = Math.max(0, Math.round(extra.retryAfterMs));
  }
  return error;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/** `retry-after-ms`, then `retry-after` as delta-seconds or an HTTP date. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null && /^\d+(\.\d+)?$/.test(milliseconds.trim())) return Number(milliseconds.trim());
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface ErrorBody {
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly message: string | undefined;
  readonly resetsAt: number | undefined;
}

/** Reads the `{error: {type, code, message}}` envelope both OpenAI and Anthropic use. */
export function parseErrorBody(text: string): ErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { type: undefined, code: undefined, message: undefined, resetsAt: undefined };
  }
  const root = record(parsed);
  const error = record(root?.error) ?? root;
  return {
    type: stringField(error, "type"),
    code: stringField(error, "code") ?? (typeof root?.error === "string" ? root.error : undefined),
    message: stringField(error, "message") ?? stringField(root, "error_description"),
    resetsAt: numberField(error, "resets_at") ?? numberField(error, "resets_in_seconds"),
  };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

export function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export interface HttpErrorContext {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
  /** Subscription credentials report 401 as an expired login; API keys as unauthenticated. */
  readonly subscription: boolean;
  readonly now?: number;
}

/** Maps a non-2xx provider response to the harness taxonomy (research: openai-chatgpt-oauth §8, api-keys). */
export function classifyHttpError(context: HttpErrorContext): ProviderError {
  const { status, headers } = context;
  const body = parseErrorBody(context.bodyText);
  const now = context.now ?? Date.now();
  const markers = [body.type, body.code].filter((value): value is string => value !== undefined);
  const providerCode = body.code ?? body.type;
  const detail = body.message ?? `HTTP ${status}`;
  const extra = { httpStatus: status, ...(providerCode === undefined ? {} : { providerCode }) };
  const has = (marker: string) => markers.includes(marker);

  if (has("missing_codex_entitlement") || has("usage_not_included")) {
    return providerError("entitlement_missing", `${detail} (the plan does not include this usage)`, extra);
  }
  if (has("usage_limit_reached") || has("insufficient_quota")) {
    const resetMs = body.resetsAt === undefined ? retryAfterMs(headers, now) : resetDelay(body.resetsAt, now);
    return providerError("quota_exhausted", detail, { ...extra, ...(resetMs === undefined ? {} : { retryAfterMs: resetMs }) });
  }
  if (has("context_length_exceeded") || /prompt is too long|context window/i.test(detail)) {
    return providerError("context_overflow", detail, extra);
  }
  if (status === 401) return providerError(context.subscription ? "auth_expired" : "unauthenticated", detail, extra);
  if (status === 403) return providerError("forbidden", detail, extra);
  if (status === 404) return providerError("model_unavailable", detail, extra);
  if (status === 408 || status === 504) return providerError("timeout", detail, extra);
  if (status === 429) {
    const after = retryAfterMs(headers, now);
    return providerError("rate_limited", detail, { ...extra, ...(after === undefined ? {} : { retryAfterMs: after }) });
  }
  if (status >= 500) return providerError("provider_internal", detail, extra);
  return providerError("invalid_request", detail, extra);
}

function resetDelay(resetsAt: number, now: number): number {
  const epochMs = resetsAt > 1e12 ? resetsAt : resetsAt > 1e9 ? resetsAt * 1000 : now + resetsAt * 1000;
  return Math.max(0, epochMs - now);
}

/** Maps an in-stream error payload (`response.failed`, Anthropic `error` event) to the taxonomy. */
export function classifyStreamError(type: string | undefined, code: string | undefined, message: string | undefined): ProviderError {
  const marker = code ?? type ?? "";
  const text = message ?? marker;
  const extra = marker === "" ? {} : { providerCode: marker };
  switch (marker) {
    case "context_length_exceeded":
      return providerError("context_overflow", text, extra);
    case "rate_limit_exceeded":
    case "rate_limit_error":
      return providerError("rate_limited", text, extra);
    case "usage_limit_reached":
    case "insufficient_quota":
      return providerError("quota_exhausted", text, extra);
    case "authentication_error":
      return providerError("unauthenticated", text, extra);
    case "permission_error":
      return providerError("forbidden", text, extra);
    case "not_found_error":
    case "model_not_found":
      return providerError("model_unavailable", text, extra);
    case "invalid_request_error":
    case "invalid_prompt":
      return providerError(/prompt is too long/i.test(text) ? "context_overflow" : "invalid_request", text, extra);
    case "overloaded_error":
    case "api_error":
    case "server_error":
    case "server_is_overloaded":
      return providerError("provider_internal", text, extra);
    default:
      return providerError("provider_internal", text === "" ? "provider reported a failure" : text, extra);
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
