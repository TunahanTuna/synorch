import {
  digestOf,
  providerIdSchema,
  type AuthMethodKind,
  type ModelAdapter,
  type ModelRequest,
  type ModelStreamEvent,
  type ProviderCapabilities,
} from "../contracts/index.ts";
import { StreamAssembler } from "./assembler.ts";
import { providerError } from "./errors.ts";

/** One scripted model response: the events after `start` (added automatically), or a function of the request. */
export type ScriptStep = readonly ModelStreamEvent[] | ((request: ModelRequest) => readonly ModelStreamEvent[]);

export interface ScriptedAdapterOptions {
  readonly adapterId?: string;
  readonly providerId?: string;
  readonly authMethod?: Exclude<AuthMethodKind, "cli-bridge">;
  /** Yields to the event loop between events so tests can abort mid-stream. */
  readonly yieldBetweenEvents?: boolean;
}

export interface ScriptedModelAdapter extends ModelAdapter {
  /** Every request the adapter received, in order. */
  readonly requests: readonly ModelRequest[];
  /** Marks a test adapter: it never needs a credential, whatever provider id it reports. */
  readonly scripted: true;
}

/**
 * A deterministic `ModelAdapter` for tests and end-to-end scenarios: it replays scripted responses
 * in order, never touches the network and honors the same never-throw and cancellation rules.
 */
export function createScriptedAdapter(script: readonly ScriptStep[], options: ScriptedAdapterOptions = {}): ScriptedModelAdapter {
  const adapterId = options.adapterId ?? "scripted";
  const providerId = providerIdSchema.parse(options.providerId ?? "scripted");
  const authMethod = options.authMethod ?? "api-key";
  const requests: ModelRequest[] = [];
  let cursor = 0;

  const capabilities = (): ProviderCapabilities => ({
    schema_version: 1,
    provider_id: providerId,
    adapter_id: adapterId,
    adapter_kind: "model",
    auth_method: authMethod,
    auth_status: "connected",
    billing: "unknown",
    quota_visibility: "none",
    loop_owner: "synorch",
    tool_channel: "native",
    policy_status: "permitted",
    models: [],
    probed_at: new Date(0).toISOString(),
    source: "static-config",
  });

  async function* stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    requests.push(request);
    const step = script[cursor];
    cursor += 1;
    if (step === undefined) {
      yield { type: "error", error: providerError("invalid_request", `script exhausted after ${script.length} response(s)`) };
      return;
    }
    let scripted: readonly ModelStreamEvent[];
    try {
      scripted = typeof step === "function" ? step(request) : step;
    } catch (error: unknown) {
      yield { type: "error", error: providerError("provider_internal", error instanceof Error ? error.message : String(error)) };
      return;
    }
    const first = scripted[0];
    const events: ModelStreamEvent[] =
      first?.type === "error"
        ? [...scripted]
        : [
            { type: "start", request_id: request.request_id, route: request.route },
            ...scripted.filter((event) => event.type !== "start"),
          ];
    const assembler = new StreamAssembler();
    for (const event of events) {
      if (options.yieldBetweenEvents === true) await new Promise((resolve) => setImmediate(resolve));
      if (signal.aborted) {
        const partial = assembler.partial();
        const error = providerError("cancelled", "request aborted by user");
        yield partial === undefined ? { type: "error", error } : { type: "error", error, partial };
        return;
      }
      replay(assembler, event);
      yield event;
      if (event.type === "done" || event.type === "error") return;
    }
  }

  return {
    kind: "model",
    adapterId,
    providerId,
    authMethod,
    requests,
    scripted: true,
    async discoverCapabilities() {
      return capabilities();
    },
    prepare(request) {
      return { ok: true, wireDigest: digestOf(request), warnings: [] };
    },
    stream(request, _credential, signal) {
      return stream(request, signal);
    },
    async health() {
      return { state: "ok", checked_at: new Date(0).toISOString(), detail: "scripted" };
    },
  };
}

function replay(assembler: StreamAssembler, event: ModelStreamEvent): void {
  switch (event.type) {
    case "text_delta":
      assembler.text(event.index, event.text);
      break;
    case "thinking_delta":
      assembler.thinking(event.index, event.text);
      break;
    case "tool_call_start":
      assembler.toolStart(event.index, event.provider_call_id, event.name);
      break;
    case "tool_call_delta":
      assembler.toolDelta(event.index, event.arguments_fragment);
      break;
    case "tool_call_end":
      assembler.toolEnd(event.index, JSON.stringify(event.arguments));
      break;
    default:
      break;
  }
}
