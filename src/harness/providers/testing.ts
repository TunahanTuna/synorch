import {
  createId,
  digestText,
  modelIdSchema,
  providerIdSchema,
  type ModelRequest,
  type ModelRoute,
  type ResolvedCredential,
} from "../contracts/index.ts";
import type { FetchLike } from "./http-stream.ts";

/**
 * Test doubles for the providers workstream: scripted HTTP responses (no network), a static
 * credential and request builders. Nothing here is used by production code paths.
 */

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

export type FakeHandler = (request: RecordedRequest, signal: AbortSignal | undefined) => Response | Promise<Response>;

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
}

/** A `fetch` replacement that records every request and answers from handlers in order (the last one repeats). */
export function fakeFetch(...handlers: FakeHandler[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  let cursor = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    const recorded: RecordedRequest = {
      url: input,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : init.body === undefined || init.body === null ? "" : String(init.body),
    };
    requests.push(recorded);
    const handler = handlers[Math.min(cursor, handlers.length - 1)];
    cursor += 1;
    if (handler === undefined) throw new Error("fakeFetch has no handler");
    return handler(recorded, signal);
  };
  return { fetch: fetchImpl, requests };
}

/** An SSE response whose body is delivered in `chunkSize`-byte pieces (to exercise split frames). */
export function sseResponse(text: string, options: { readonly chunkSize?: number; readonly headers?: Record<string, string>; readonly hold?: boolean } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const size = options.chunkSize ?? 64;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        if (options.hold === true) return new Promise<void>(() => undefined);
        controller.close();
        return undefined;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
      return undefined;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", ...options.headers } });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A credential that sets one header; `secret` is what redaction tests search for. */
export function staticCredential(provider: string, secret: string, header = "authorization"): ResolvedCredential {
  return {
    providerId: providerIdSchema.parse(provider),
    method: "api-key",
    profile: "default",
    expiresAt: undefined,
    applyTo(headers) {
      headers.set(header, header === "authorization" ? `Bearer ${secret}` : secret);
    },
    redactionValues() {
      return [secret];
    },
    toJSON() {
      return "[redacted]";
    },
  };
}

export function testRoute(fields: Partial<Omit<ModelRoute, "provider_id" | "model_id">> & { readonly provider_id: string; readonly model_id: string; readonly adapter_id: string }): ModelRoute {
  return {
    adapter_kind: "model",
    auth_method: "api-key",
    profile: "default",
    ...fields,
    provider_id: providerIdSchema.parse(fields.provider_id),
    model_id: modelIdSchema.parse(fields.model_id),
  };
}

export function testRequest(route: ModelRoute, overrides: Partial<Omit<ModelRequest, "route">> = {}): ModelRequest {
  const harness = "You are a careful engineering agent.";
  return {
    request_id: createId("request"),
    route,
    system: [{ id: "harness", source: "harness", trust: "harness", text: harness, digest: digestText(harness) }],
    messages: [{ role: "user", content: [{ type: "text", text: "Read src/a.ts" }] }],
    tools: [
      {
        name: "read_file",
        description: "Read a workspace file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    ...overrides,
  };
}
