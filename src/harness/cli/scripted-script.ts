import { readFile } from "node:fs/promises";
import { z } from "zod";
import { formatZodIssues } from "../../domain/zod-issues.ts";
import {
  HarnessError,
  modelStreamEventSchema,
  PROVIDER_ERROR_CODES,
  type ModelRequest,
  type ModelStreamEvent,
} from "../contracts/index.ts";
import { providerError, type ScriptStep } from "../providers/index.ts";

/**
 * Script files for the `scripted` adapter (tests, end-to-end scenarios, smoke runs; never a real
 * model). A file is a JSON array; each entry answers one model request, in order:
 *
 *   [ ...ModelStreamEvent ]                       raw events (`start` is added by the adapter)
 *   { "text": "..." }                             one assistant text message
 *   { "tool_calls": [{ "name", "arguments" }] }   tool calls (optional "text" before them)
 *   { "error": { "code", "message", "retry_after_ms"? } }
 *
 * Inside tool arguments the string `$last_tool_call_id` becomes the harness id of the most recent
 * tool result in the request and `$tool_call_id[N]` the N-th one, so a report can cite evidence.
 */

const shorthandSchema = z.union([
  z.array(z.unknown()),
  z.strictObject({ text: z.string() }),
  z.strictObject({
    text: z.string().optional(),
    tool_calls: z.array(z.strictObject({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) })).min(1),
  }),
  z.strictObject({
    error: z.strictObject({ code: z.enum(PROVIDER_ERROR_CODES), message: z.string().min(1), retry_after_ms: z.int().min(0).optional() }),
  }),
]);
const scriptFileSchema = z.array(shorthandSchema);

function toolResultIds(request: ModelRequest): string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    for (const part of message.content) if (part.type === "tool_result") ids.push(part.tool_call_id);
  }
  return ids;
}

function substitute(value: unknown, ids: readonly string[]): unknown {
  if (typeof value === "string") {
    return value.replaceAll("$last_tool_call_id", ids.at(-1) ?? "").replace(/\$tool_call_id\[(\d+)\]/g, (_match, index: string) => ids[Number(index)] ?? "");
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, ids));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, ids)]));
  }
  return value;
}

/** Converts one parsed script entry to a step of the scripted adapter. */
export function scriptStep(entry: z.infer<typeof shorthandSchema>, file = "script"): ScriptStep {
  if (Array.isArray(entry)) {
    return entry.map((event, index) => {
      const parsed = modelStreamEventSchema.safeParse(event);
      if (!parsed.success) throw scriptError(`${file}: event ${index}: ${formatZodIssues(parsed.error)}`);
      return parsed.data;
    });
  }
  if ("error" in entry) {
    const { code, message, retry_after_ms: retryAfterMs } = entry.error;
    return [{ type: "error", error: providerError(code, message, retryAfterMs === undefined ? {} : { retryAfterMs }) }];
  }
  if (!("tool_calls" in entry)) {
    const text = entry.text;
    return [
      { type: "text_delta", index: 0, text },
      { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 0, output_tokens: 0, source: "unknown" } },
    ];
  }
  const calls = entry.tool_calls;
  const text = entry.text;
  return (request: ModelRequest): readonly ModelStreamEvent[] => {
    const ids = toolResultIds(request);
    const offset = text === undefined ? 0 : 1;
    const resolved = calls.map((call, index) => ({
      id: `call_${request.request_id.slice(-8)}_${index}`,
      name: call.name,
      arguments: substitute(call.arguments, ids) as Record<string, unknown>,
      index: index + offset,
    }));
    const content = [
      ...(text === undefined ? [] : [{ type: "text" as const, text }]),
      ...resolved.map((call) => ({ type: "tool_call" as const, provider_call_id: call.id, name: call.name, arguments: call.arguments })),
    ];
    return [
      ...(text === undefined ? [] : [{ type: "text_delta" as const, index: 0, text }]),
      ...resolved.map((call): ModelStreamEvent => ({ type: "tool_call_start", index: call.index, provider_call_id: call.id, name: call.name })),
      ...resolved.map((call): ModelStreamEvent => ({ type: "tool_call_end", index: call.index, provider_call_id: call.id, name: call.name, arguments: call.arguments as never })),
      { type: "done", stop_reason: "tool_use", message: { role: "assistant", content: content as never }, usage: { input_tokens: 0, output_tokens: 0, source: "unknown" } },
    ];
  };
}

function scriptError(message: string): HarnessError {
  return new HarnessError({ code: "config_invalid", message: message.slice(0, 2000), workspace_effect: "none", retry_safe: false });
}

export async function loadScript(file: string): Promise<readonly ScriptStep[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw scriptError(`${file}: cannot load the scripted responses: ${(error as Error).message}`);
  }
  const parsed = scriptFileSchema.safeParse(raw);
  if (!parsed.success) throw scriptError(`${file}: ${formatZodIssues(parsed.error)}`);
  return parsed.data.map((entry) => scriptStep(entry, file));
}
