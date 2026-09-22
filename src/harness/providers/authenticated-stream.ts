import {
  ProviderFailure,
  type AuthProvider,
  type ModelAdapter,
  type ModelRequest,
  type ModelStreamEvent,
  type ResolvedCredential,
} from "../contracts/index.ts";
import { providerError } from "./errors.ts";

/**
 * Resolves a credential and streams one request. For a refreshable (`oauth-subscription`) identity,
 * a 401 before any output triggers exactly one `resolve({ forceRefresh: true })` and one resend of
 * the same request; a second 401 ends in `auth_expired`. No other method, profile or provider is
 * ever tried.
 */
export async function* streamAuthenticated(
  adapter: ModelAdapter,
  auth: AuthProvider,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  let credential: ResolvedCredential;
  try {
    credential = await auth.resolve(signal);
  } catch (error: unknown) {
    yield { type: "error", error: failureOf(error, signal) };
    return;
  }

  const first = adapter.stream(request, credential, signal)[Symbol.asyncIterator]();
  let head: IteratorResult<ModelStreamEvent>;
  try {
    head = await first.next();
  } catch (error: unknown) {
    yield { type: "error", error: failureOf(error, signal) };
    return;
  }
  const rejected = !head.done && head.value.type === "error" && head.value.error.http_status === 401;
  if (!rejected || auth.method !== "oauth-subscription") {
    if (head.done) return;
    yield head.value;
    yield* drain(first, signal);
    return;
  }

  try {
    credential = await auth.resolve(signal, { forceRefresh: true });
  } catch (error: unknown) {
    const failure = failureOf(error, signal);
    yield { type: "error", error: failure.code === "cancelled" ? failure : providerError("auth_expired", `${failure.message}; run \`syn login ${auth.providerId}\``) };
    return;
  }
  for await (const event of drainIterable(adapter.stream(request, credential, signal), signal)) {
    if (event.type === "error" && event.error.http_status === 401) {
      yield {
        type: "error",
        error: providerError("auth_expired", `the provider rejected the refreshed credential; run \`syn login ${auth.providerId}\``, {
          httpStatus: 401,
        }),
      };
      return;
    }
    yield event;
  }
}

async function* drain(iterator: AsyncIterator<ModelStreamEvent>, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
  while (true) {
    let next: IteratorResult<ModelStreamEvent>;
    try {
      next = await iterator.next();
    } catch (error: unknown) {
      yield { type: "error", error: failureOf(error, signal) };
      return;
    }
    if (next.done) return;
    yield next.value;
  }
}

function drainIterable(stream: AsyncIterable<ModelStreamEvent>, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
  return drain(stream[Symbol.asyncIterator](), signal);
}

function failureOf(error: unknown, signal: AbortSignal) {
  if (error instanceof ProviderFailure) return error.error;
  if (signal.aborted) return providerError("cancelled", "request aborted by user");
  return providerError("provider_internal", error instanceof Error ? error.message : String(error));
}
