import {
  modelStreamEventSchema,
  type ModelRequest,
  type ModelStreamEvent,
  type ProviderError,
  type SystemBlock,
} from "../contracts/index.ts";
import type { StreamAssembler } from "./assembler.ts";
import { classifyHttpError, isAbortError, providerError } from "./errors.ts";
import { readSse, type SseMessage } from "./sse.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SseMapper {
  readonly assembler: StreamAssembler;
  /** Maps one SSE message; a returned `done` or `error` ends the stream. */
  map(message: SseMessage): readonly ModelStreamEvent[];
}

export interface HttpStreamInput {
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
  readonly fetch: FetchLike;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly subscription: boolean;
  readonly mapper: SseMapper;
  readonly headerEvents?: (headers: Headers) => readonly ModelStreamEvent[];
  readonly requestIdHeaders?: readonly string[];
}

/**
 * The shared HTTP+SSE pipeline for direct adapters. It never throws: setup failures end in a single
 * `error` (no `start`), stream failures in `error` with the partial message, and every event is
 * checked against the stream schema before it leaves, so a provider quirk surfaces as
 * `protocol_mismatch` rather than as an invalid event.
 */
export async function* streamHttp(input: HttpStreamInput): AsyncGenerator<ModelStreamEvent> {
  const { signal, mapper } = input;
  if (signal.aborted) {
    yield { type: "error", error: providerError("cancelled", "request aborted before it was sent") };
    return;
  }
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal,
    });
  } catch (error: unknown) {
    yield {
      type: "error",
      error: isAbortError(error, signal)
        ? providerError("cancelled", "request aborted before a response arrived")
        : providerError("provider_internal", `request failed: ${errorText(error)}`),
    };
    return;
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }
    yield {
      type: "error",
      error: signal.aborted
        ? providerError("cancelled", "request aborted")
        : classifyHttpError({ status: response.status, headers: response.headers, bodyText, subscription: input.subscription }),
    };
    return;
  }

  const providerRequestId = (input.requestIdHeaders ?? ["x-request-id", "request-id"])
    .map((name) => response.headers.get(name))
    .find((value): value is string => value !== null && value !== "");
  yield {
    type: "start",
    request_id: input.request.request_id,
    route: input.request.route,
    ...(providerRequestId === undefined ? {} : { provider_request_id: providerRequestId.slice(0, 200) }),
  };
  for (const event of input.headerEvents?.(response.headers) ?? []) {
    const checked = validated(event, mapper);
    yield checked;
    if (isTerminal(checked)) return;
  }

  if (response.body === null) {
    yield failure(mapper, providerError("stream_interrupted", "provider returned no response body"));
    return;
  }

  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const message of readSse(chunks(reader))) {
      if (signal.aborted) break;
      for (const event of mapper.map(message)) {
        const checked = validated(event, mapper);
        yield checked;
        if (isTerminal(checked)) return;
      }
    }
    yield signal.aborted
      ? failure(mapper, providerError("cancelled", "request aborted by user"))
      : failure(mapper, providerError("stream_interrupted", "stream ended before the response completed"));
  } catch (error: unknown) {
    yield isAbortError(error, signal)
      ? failure(mapper, providerError("cancelled", "request aborted by user"))
      : failure(mapper, providerError("stream_interrupted", `stream failed: ${errorText(error)}`));
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
  }
}

async function* chunks(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Uint8Array> {
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value !== undefined) yield value;
  }
}

function isTerminal(event: ModelStreamEvent): boolean {
  return event.type === "done" || event.type === "error";
}

function validated(event: ModelStreamEvent, mapper: SseMapper): ModelStreamEvent {
  if (modelStreamEventSchema.safeParse(event).success) return event;
  return failure(mapper, providerError("protocol_mismatch", `adapter produced an invalid ${event.type} event`));
}

export function failure(mapper: { readonly assembler: StreamAssembler }, error: ProviderError): ModelStreamEvent {
  const partial = mapper.assembler.partial();
  return partial === undefined ? { type: "error", error } : { type: "error", error, partial };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Trusted system blocks become instructions; `untrusted` blocks (repository text, memory, tool
 * output) are delivered as clearly delimited user-side data and never gain instruction priority.
 */
export function splitSystemBlocks(system: readonly SystemBlock[]): { readonly instructions: string; readonly untrusted: string | undefined } {
  const trusted = system.filter((block) => block.trust !== "untrusted").map((block) => block.text);
  const untrusted = system
    .filter((block) => block.trust === "untrusted")
    .map((block) => `<untrusted-data source="${block.source}" id="${block.id}">\n${block.text}\n</untrusted-data>`);
  return { instructions: trusted.join("\n\n"), untrusted: untrusted.length === 0 ? undefined : untrusted.join("\n\n") };
}
