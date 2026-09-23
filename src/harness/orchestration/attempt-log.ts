import {
  modelMessageSchema,
  REPORT_TOOL_NAMES,
  type ReportToolName,
  type BlobStore,
  type EventReadItem,
  type ModelMessage,
  type SessionEvent,
  type SessionId,
} from "../contracts/index.ts";

/**
 * A read model over one attempt session: which tool calls ran, with what arguments and how they
 * ended, which events exist (so `event` evidence can be resolved), which blobs are compaction
 * summaries (never evidence), and the final assistant message the claim is parsed from.
 */

export interface RecordedToolCall {
  readonly name: string | undefined;
  readonly state: "succeeded" | "failed" | "denied" | "cancelled" | "interrupted" | "proposed";
  readonly exitCode: number | undefined;
  /**
   * The call's short ref ordinal (`[#n]`, ADR-18): `tool/call_proposed.ref` when the gateway
   * recorded one, otherwise its 1-based position among the session's `tool/call_proposed` events
   * (the same numbering the gateway assigns).
   */
  readonly ordinal?: number;
  readonly providerCallId?: string;
  /** The arguments the model sent, from the recorded assistant message (absent when not recorded). */
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** Paths the tool reported as changed (`write_file`, `apply_patch`). */
  readonly changedPaths?: readonly string[];
  /** The start of the recorded result text (bounded), for correction messages. */
  readonly excerpt?: string;
}

/** A report tool call as the model made it; its arguments come from the recorded assistant message. */
export interface RecordedReportCall {
  readonly toolCallId: string;
  readonly name: ReportToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface AttemptLog {
  readonly sessionId: SessionId;
  readonly toolCalls: ReadonlyMap<string, RecordedToolCall>;
  readonly eventTypes: ReadonlyMap<number, string>;
  readonly compactionBlobs: ReadonlySet<string>;
  readonly finalAssistantText: string | undefined;
  readonly assistantTexts: readonly string[];
  /** Report tool calls in log order (`task_report`, `review_report`, `plan_propose`). */
  readonly reports: readonly RecordedReportCall[];
  /** `#n` ordinal → tool call id (absent in hand-built logs). */
  readonly ordinals?: ReadonlyMap<number, string>;
}

const REPORT_TOOLS: ReadonlySet<string> = new Set(Object.values(REPORT_TOOL_NAMES));
const EXCERPT_LIMIT = 400;

/** Arguments of the last report call of `name` that the gateway validated and recorded as succeeded. */
export function latestReport(log: AttemptLog, name: ReportToolName): Readonly<Record<string, unknown>> | undefined {
  for (let index = log.reports.length - 1; index >= 0; index -= 1) {
    const report = log.reports[index];
    if (report?.name === name && log.toolCalls.get(report.toolCallId)?.state === "succeeded") return report.arguments;
  }
  return undefined;
}

/** How many calls of `name` the harness refused with `invalid_arguments` (report correction rounds). */
export function rejectedReports(log: AttemptLog, name: ReportToolName): number {
  return log.reports.filter((report) => report.name === name && log.toolCalls.get(report.toolCallId)?.state === "failed").length;
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
  const reports: RecordedReportCall[] = [];
  const argumentsOf = new Map<string, Readonly<Record<string, unknown>>>();
  const ordinals = new Map<number, string>();
  let proposed = 0;
  for (const event of events) {
    eventTypes.set(event.seq, event.type);
    switch (event.type) {
      case "tool/call_proposed": {
        proposed += 1;
        const recorded = (event.data as { readonly ref?: number }).ref;
        const ordinal = recorded ?? proposed;
        if (!ordinals.has(ordinal)) ordinals.set(ordinal, event.data.tool_call_id);
        const args = argumentsOf.get(event.data.tool_call_id);
        toolCalls.set(event.data.tool_call_id, {
          name: event.data.tool_name,
          state: "proposed",
          exitCode: undefined,
          ordinal,
          providerCallId: event.data.provider_call_id,
          ...(args === undefined ? {} : { arguments: args }),
        });
        break;
      }
      case "tool/result_recorded": {
        const previous = toolCalls.get(event.data.tool_call_id);
        const result = event.data.result;
        toolCalls.set(event.data.tool_call_id, {
          ...previous,
          name: previous?.name,
          state: event.data.state,
          exitCode: result.exit_code,
          ...(result.changed_paths === undefined ? {} : { changedPaths: result.changed_paths }),
          excerpt: (result.error === undefined ? result.text : `${result.text} ${result.error.message}`).trim().slice(0, EXCERPT_LIMIT),
        });
        break;
      }
      case "tool/interrupted": {
        const previous = toolCalls.get(event.data.tool_call_id);
        toolCalls.set(event.data.tool_call_id, { ...previous, name: previous?.name, state: "interrupted", exitCode: undefined });
        break;
      }
      case "context/compacted":
        compactionBlobs.add(event.data.summary_blob.digest);
        break;
      case "message/recorded": {
        if (event.data.role !== "assistant") break;
        const message = await messageOf(event, blobs);
        if (message === undefined) break;
        assistantTexts.push(textOf(message));
        for (const part of message.content) {
          if (part.type !== "tool_call" || part.tool_call_id === undefined) continue;
          argumentsOf.set(part.tool_call_id, part.arguments);
          const known = toolCalls.get(part.tool_call_id);
          if (known !== undefined) toolCalls.set(part.tool_call_id, { ...known, arguments: part.arguments });
          if (REPORT_TOOLS.has(part.name)) {
            reports.push({ toolCallId: part.tool_call_id, name: part.name as ReportToolName, arguments: part.arguments });
          }
        }
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
    reports,
    ordinals,
  };
}
