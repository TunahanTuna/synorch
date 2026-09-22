import {
  modelMessageSchema,
  type AgentRole,
  type BlobStore,
  type ContentPart,
  type ModelMessage,
  type SessionEvent,
  type SessionEventOf,
  type AttemptId,
  type TaskId,
} from "../contracts/index.ts";

/**
 * Rebuilds the model-visible history of one session from its event log: only events after the
 * last compaction boundary, only this role's own conversation, and every tool call paired with a
 * result (an unanswered call gets a synthetic "outcome unknown" error so no provider rejects it).
 */

export interface HistoryFilter {
  readonly role: AgentRole;
  readonly taskId: TaskId | undefined;
  /** When set, events correlated to a different attempt are foreign even for the same role and task. */
  readonly attemptId?: AttemptId | undefined;
}

export interface HistoryMessage {
  readonly seq: number;
  readonly message: ModelMessage;
}

export interface History {
  readonly messages: readonly HistoryMessage[];
  readonly lastCompaction: SessionEventOf<"context/compacted"> | undefined;
  readonly droppedForeign: number;
}

export function lastCompaction(events: readonly SessionEvent[]): SessionEventOf<"context/compacted"> | undefined {
  let found: SessionEventOf<"context/compacted"> | undefined;
  for (const event of events) if (event.type === "context/compacted") found = event;
  return found;
}

/**
 * A message belongs to this context only if it was not produced by another role or task. Input
 * addressed *to* the agent (user-role messages, steering) may come from the user or the
 * orchestrator; assistant and tool messages must be this role's own.
 */
export function belongsTo(event: SessionEvent, filter: HistoryFilter, messageRole: ModelMessage["role"]): boolean {
  if (event.task_id !== undefined && filter.taskId !== undefined && event.task_id !== filter.taskId) return false;
  if (event.attempt_id !== undefined && filter.attemptId !== undefined && event.attempt_id !== filter.attemptId) return false;
  if (messageRole === "user") return event.actor.kind !== "worker" || event.actor.role === filter.role;
  if (event.actor.role !== undefined && event.actor.role !== filter.role) return false;
  if (filter.role === "orchestrator" && event.actor.kind === "worker") return false;
  return true;
}

export async function loadMessage(event: SessionEventOf<"message/recorded">, blobs: BlobStore): Promise<ModelMessage | undefined> {
  if (event.data.message !== undefined) return event.data.message;
  if (event.data.blob === undefined) return undefined;
  const parsed = modelMessageSchema.safeParse(JSON.parse(Buffer.from(await blobs.get(event.data.blob.digest)).toString("utf8")));
  return parsed.success ? parsed.data : undefined;
}

function unanswered(calls: Map<string, Extract<ContentPart, { type: "tool_call" }>>): ModelMessage | undefined {
  if (calls.size === 0) return undefined;
  const content: ContentPart[] = [...calls.values()].flatMap((call) =>
    call.tool_call_id === undefined
      ? []
      : [
          {
            type: "tool_result" as const,
            tool_call_id: call.tool_call_id,
            provider_call_id: call.provider_call_id,
            is_error: true,
            text: "interrupted: the outcome of this call is unknown and it was not repeated",
          },
        ],
  );
  calls.clear();
  return content.length === 0 ? undefined : { role: "tool", content };
}

export async function reconstructHistory(events: readonly SessionEvent[], blobs: BlobStore, filter: HistoryFilter): Promise<History> {
  const compaction = lastCompaction(events);
  const boundary = compaction?.data.first_kept_seq ?? 0;
  const messages: HistoryMessage[] = [];
  const open = new Map<string, Extract<ContentPart, { type: "tool_call" }>>();
  let droppedForeign = 0;
  const flush = (seq: number): void => {
    const synthetic = unanswered(open);
    if (synthetic !== undefined) messages.push({ seq, message: synthetic });
  };
  for (const event of events) {
    if (event.seq < boundary) continue;
    if (event.type === "steer/queued") {
      if (!belongsTo(event, filter, "user")) continue;
      flush(event.seq);
      messages.push({ seq: event.seq, message: { role: "user", content: [{ type: "text", text: event.data.text }] } });
      continue;
    }
    if (event.type !== "message/recorded") continue;
    if (!belongsTo(event, filter, event.data.role)) {
      droppedForeign += 1;
      continue;
    }
    const message = await loadMessage(event, blobs);
    if (message === undefined) continue;
    if (message.role === "tool") {
      const content = message.content.filter((part) => {
        if (part.type !== "tool_result") return true;
        const known = open.has(part.provider_call_id);
        open.delete(part.provider_call_id);
        return known;
      });
      if (content.length > 0) messages.push({ seq: event.seq, message: { role: "tool", content } });
      continue;
    }
    flush(event.seq);
    messages.push({ seq: event.seq, message });
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "tool_call") open.set(part.provider_call_id, part);
    }
  }
  flush(events.at(-1)?.seq ?? 0);
  return { messages, lastCompaction: compaction, droppedForeign };
}
