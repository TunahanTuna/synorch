import {
  modelStreamEventSchema,
  PROVIDER_ERROR_RETRYABLE,
  type AssistantMessage,
  type ModelStreamEvent,
  type ProviderError,
  type ProviderErrorCode,
  type QuotaSnapshot,
  type Usage,
} from "../contracts/index.ts";

export type StreamOutcome =
  | {
      readonly kind: "done";
      readonly stopReason: "stop" | "length" | "tool_use";
      readonly message: AssistantMessage;
      readonly usage: Usage | undefined;
      readonly quota: QuotaSnapshot | undefined;
    }
  | {
      readonly kind: "failed";
      readonly error: ProviderError;
      readonly partial: AssistantMessage | undefined;
      readonly usage: Usage | undefined;
      readonly quota: QuotaSnapshot | undefined;
    };

const ABORTED: unique symbol = Symbol("aborted");

export function providerError(code: ProviderErrorCode, message: string): ProviderError {
  return { code, message: message.slice(0, 2000) || code, retryable: PROVIDER_ERROR_RETRYABLE[code] };
}

/**
 * Consumes one adapter stream into a single outcome. Abort always wins: a stream cancelled by the
 * signal is `failed{cancelled}` even if the adapter ignores the signal or still reports `done`.
 * Adapters must not throw, but a throwing or malformed stream is contained here as well.
 */
export async function consumeStream(
  source: AsyncIterable<ModelStreamEvent>,
  signal: AbortSignal,
  inspect: (event: ModelStreamEvent) => ProviderError | undefined = () => undefined,
): Promise<StreamOutcome> {
  const texts = new Map<number, string>();
  let usage: Usage | undefined;
  let quota: QuotaSnapshot | undefined;
  const partial = (): AssistantMessage | undefined =>
    texts.size === 0
      ? undefined
      : { role: "assistant", content: [...texts.entries()].sort(([left], [right]) => left - right).map(([, text]) => ({ type: "text" as const, text })) };
  const failed = (error: ProviderError, reported?: AssistantMessage): StreamOutcome => ({ kind: "failed", error, partial: reported ?? partial(), usage, quota });
  const cancelled = (reported?: AssistantMessage, error?: ProviderError): StreamOutcome =>
    failed(error?.code === "cancelled" ? error : providerError("cancelled", "request cancelled"), reported);

  let iterator: AsyncIterator<ModelStreamEvent>;
  try {
    iterator = source[Symbol.asyncIterator]();
  } catch (error: unknown) {
    return signal.aborted ? cancelled() : failed(providerError("stream_interrupted", describe(error)));
  }
  try {
    for (;;) {
      if (signal.aborted) {
        closeQuietly(iterator);
        return cancelled();
      }
      const next = await nextOrAbort(iterator, signal);
      if (next === ABORTED) {
        closeQuietly(iterator);
        return cancelled();
      }
      if (next.done === true) {
        return signal.aborted ? cancelled() : failed(providerError("protocol_mismatch", "stream ended without done or error"));
      }
      const parsed = modelStreamEventSchema.safeParse(next.value);
      if (!parsed.success) {
        closeQuietly(iterator);
        return failed(providerError("protocol_mismatch", `adapter emitted an invalid stream event: ${parsed.error.issues[0]?.message ?? "unknown"}`));
      }
      const event = parsed.data;
      const rejection = inspect(event);
      if (rejection !== undefined) {
        closeQuietly(iterator);
        return failed(rejection);
      }
      switch (event.type) {
        case "text_delta":
          texts.set(event.index, (texts.get(event.index) ?? "") + event.text);
          break;
        case "usage":
          usage = event.usage;
          break;
        case "quota":
          quota = event.quota;
          break;
        case "done":
          closeQuietly(iterator);
          if (signal.aborted) return cancelled(event.message);
          return { kind: "done", stopReason: event.stop_reason, message: event.message, usage: event.usage ?? usage, quota };
        case "error":
          closeQuietly(iterator);
          if (signal.aborted || event.error.code === "cancelled") return cancelled(event.partial, event.error);
          return failed(event.error, event.partial);
        default:
          break;
      }
    }
  } catch (error: unknown) {
    return signal.aborted ? cancelled() : failed(providerError("stream_interrupted", describe(error)));
  }
}

function nextOrAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T> | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function closeQuietly<T>(iterator: AsyncIterator<T>): void {
  void Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => undefined);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
