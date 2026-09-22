import {
  modelMessageSchema,
  type BlobStore,
  type EventReadItem,
  type ModelMessage,
  type SessionEvent,
  type SessionId,
} from "../contracts/index.ts";

/**
 * A read model over one attempt session: which tool calls ran and how they ended, which events
 * exist (so `event` evidence can be resolved), which blobs are compaction summaries (never
 * evidence), and the final assistant message the claim is parsed from.
 */

export interface RecordedToolCall {
  readonly name: string | undefined;
  readonly state: "succeeded" | "failed" | "denied" | "cancelled" | "interrupted" | "proposed";
  readonly exitCode: number | undefined;
}

export interface AttemptLog {
  readonly sessionId: SessionId;
  readonly toolCalls: ReadonlyMap<string, RecordedToolCall>;
  readonly eventTypes: ReadonlyMap<number, string>;
  readonly compactionBlobs: ReadonlySet<string>;
  readonly finalAssistantText: string | undefined;
  readonly assistantTexts: readonly string[];
}

export interface EventSource {
  read(fromSeq?: number, toSeq?: number): AsyncIterable<EventReadItem>;
}

export async function readEvents(source: EventSource): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const item of source.read()) {
    if (item.status === "ok") events.push(item.event);
  }
  return events;
}

async function messageOf(event: Extract<SessionEvent, { type: "message/recorded" }>, blobs: BlobStore | undefined): Promise<ModelMessage | undefined> {
  if (event.data.message !== undefined) return event.data.message;
  if (event.data.blob === undefined || blobs === undefined) return undefined;
  try {
    const parsed = modelMessageSchema.safeParse(JSON.parse(Buffer.from(await blobs.get(event.data.blob.digest)).toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function textOf(message: ModelMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

export async function buildAttemptLog(sessionId: SessionId, events: readonly SessionEvent[], blobs: BlobStore | undefined): Promise<AttemptLog> {
  const toolCalls = new Map<string, RecordedToolCall>();
  const eventTypes = new Map<number, string>();
  const compactionBlobs = new Set<string>();
  const assistantTexts: string[] = [];
  for (const event of events) {
    eventTypes.set(event.seq, event.type);
    switch (event.type) {
      case "tool/call_proposed":
        toolCalls.set(event.data.tool_call_id, { name: event.data.tool_name, state: "proposed", exitCode: undefined });
        break;
      case "tool/result_recorded": {
        const previous = toolCalls.get(event.data.tool_call_id);
        toolCalls.set(event.data.tool_call_id, {
          name: previous?.name,
          state: event.data.state,
          exitCode: event.data.result.exit_code,
        });
        break;
      }
      case "tool/interrupted": {
        const previous = toolCalls.get(event.data.tool_call_id);
        toolCalls.set(event.data.tool_call_id, { name: previous?.name, state: "interrupted", exitCode: undefined });
        break;
      }
      case "context/compacted":
        compactionBlobs.add(event.data.summary_blob.digest);
        break;
      case "message/recorded": {
        if (event.data.role !== "assistant") break;
        const message = await messageOf(event, blobs);
        if (message !== undefined) assistantTexts.push(textOf(message));
        break;
      }
      default:
        break;
    }
  }
  return {
    sessionId,
    toolCalls,
    eventTypes,
    compactionBlobs,
    finalAssistantText: assistantTexts.at(-1),
    assistantTexts,
  };
}
