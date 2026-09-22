import { modelStreamEventSchema, type ModelStreamEvent } from "../contracts/index.ts";

/**
 * Checks a complete adapter stream against the contract grammar:
 *
 *   start → backend_init? → (text_delta | thinking_delta | tool_call_start → tool_call_delta* →
 *   tool_call_end | usage | quota)* → done | error
 *
 * A setup failure may be a single `error` without `start`. Returns human-readable violations;
 * an empty list means the stream conforms.
 */
export function checkStreamGrammar(events: readonly ModelStreamEvent[]): string[] {
  const issues: string[] = [];
  if (events.length === 0) return ["stream is empty"];
  events.forEach((event, position) => {
    if (!modelStreamEventSchema.safeParse(event).success) issues.push(`#${position} ${event.type} does not match the schema`);
  });
  const first = events[0];
  if (first?.type === "error") {
    if (events.length > 1) issues.push("a setup error must be the only event");
    return issues;
  }
  if (first?.type !== "start") issues.push("stream must begin with start");
  const open = new Map<number, string>();
  const closed = new Set<string>();
  let terminal = -1;
  events.forEach((event, position) => {
    if (terminal !== -1) {
      issues.push(`#${position} ${event.type} after terminal event`);
      return;
    }
    switch (event.type) {
      case "start":
        if (position !== 0) issues.push(`#${position} duplicate start`);
        break;
      case "backend_init":
        if (position !== 1) issues.push(`#${position} backend_init must directly follow start`);
        break;
      case "tool_call_start":
        if (open.has(event.index)) issues.push(`#${position} tool call index ${event.index} restarted before it ended`);
        open.set(event.index, event.provider_call_id);
        break;
      case "tool_call_delta":
        if (open.get(event.index) !== event.provider_call_id) issues.push(`#${position} delta for a tool call that is not open`);
        break;
      case "tool_call_end":
        if (open.get(event.index) !== event.provider_call_id) issues.push(`#${position} end for a tool call that is not open`);
        if (closed.has(event.provider_call_id)) issues.push(`#${position} tool call ${event.provider_call_id} ended twice`);
        open.delete(event.index);
        closed.add(event.provider_call_id);
        break;
      case "done":
      case "error":
        terminal = position;
        break;
      default:
        break;
    }
  });
  if (terminal === -1) issues.push("stream has no terminal done or error");
  const last = events.at(-1);
  if (last?.type === "done" && last.stop_reason !== "length" && open.size > 0) {
    issues.push("done arrived while tool calls were still open");
  }
  return issues;
}

/** Drains an adapter stream into an array. Rejections are reported, never rethrown. */
export async function collectStream(stream: AsyncIterable<ModelStreamEvent>): Promise<{ readonly events: ModelStreamEvent[]; readonly threw: unknown }> {
  const events: ModelStreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events, threw: undefined };
  } catch (error: unknown) {
    return { events, threw: error ?? new Error("stream threw") };
  }
}
