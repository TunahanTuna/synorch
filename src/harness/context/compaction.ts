import {
  canonicalJson,
  EVENT_VERSIONS,
  type BlobStore,
  type EventStore,
  type SessionEvent,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionId,
} from "../contracts/index.ts";
import { lastCompaction, type HistoryMessage } from "./history.ts";
import { estimateTokens, messageTokens } from "./tokens.ts";

/**
 * Compaction `summary-v1` (ADR-11). The oldest part of the history is summarised into a structured
 * blob and a `context/compacted` event marks `first_kept_seq`; nothing is deleted, so the original
 * events stay the evidence and replay stays deterministic (`system + summary + events after the
 * boundary`). Two compactions within three steps without progress are a thrash and an error.
 */

export const SUMMARY_MEDIA_TYPE = "application/vnd.synorch.summary-v1+json";
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const THRASH_STEP_WINDOW = 3;

export interface SummaryContent {
  readonly summary: string;
  readonly open_work: readonly string[];
  readonly decisions: readonly string[];
  readonly files: readonly string[];
  readonly uncertainties: readonly string[];
  readonly model_id?: string;
}

export interface SummaryV1 extends SummaryContent {
  readonly method: "summary-v1";
  readonly from_seq: number;
  readonly to_seq: number;
  readonly first_kept_seq: number;
  readonly note: string;
}

export const SUMMARY_NOT_EVIDENCE = "This summary is orientation only; it is never evidence for an acceptance criterion.";

export interface SummarizeInput {
  readonly messages: readonly HistoryMessage[];
  readonly previous: SummaryV1 | undefined;
}

export type Summarizer = (input: SummarizeInput, signal: AbortSignal) => Promise<SummaryContent>;

/** Deterministic fallback that needs no model: it keeps the first line of every message. */
export const extractiveSummarizer: Summarizer = async (input) => {
  const lines: string[] = [];
  if (input.previous !== undefined) lines.push(`Earlier: ${input.previous.summary}`);
  const files = new Set<string>();
  for (const { message } of input.messages) {
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim() !== "") lines.push(`${message.role}: ${part.text.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
      if (part.type === "tool_call") {
        lines.push(`${message.role} called ${part.name}`);
        const target = part.arguments.path;
        if (typeof target === "string") files.add(target);
      }
    }
  }
  return {
    summary: lines.join("\n").slice(0, 8000),
    open_work: [],
    decisions: [],
    files: [...files].sort(),
    uncertainties: ["extractive summary: details may be missing; re-read sources before acting"],
  };
};

export interface CompactorDependencies {
  readonly blobs: BlobStore;
  /** The writer of the session being compacted; compaction is impossible without one. */
  readonly writerFor: (sessionId: SessionId) => EventStore | undefined;
  readonly summarize?: Summarizer;
  readonly keepRecentTokens?: number;
}

export interface CompactInput {
  readonly sessionId: SessionId;
  readonly events: readonly SessionEvent[];
  readonly messages: readonly HistoryMessage[];
  readonly trigger: "threshold" | "overflow" | "manual";
  readonly tokensBefore: number;
}

export type CompactionOutcome =
  | { readonly status: "compacted"; readonly event: SessionEvent; readonly summary: SummaryV1 }
  | { readonly status: "thrash" }
  | { readonly status: "nothing-to-compact" }
  | { readonly status: "unavailable" };

export interface Compactor {
  compact(input: CompactInput, signal: AbortSignal): Promise<CompactionOutcome>;
}

/** True when another compaction now would be the second within three steps without progress. */
export function detectThrash(events: readonly SessionEvent[]): boolean {
  const previous = lastCompaction(events);
  if (previous === undefined) return false;
  let steps = 0;
  let progress = false;
  for (const event of events) {
    if (event.seq <= previous.seq) continue;
    if (event.type === "step/started") steps += 1;
    if (event.type === "tool/result_recorded" && event.data.state === "succeeded") progress = true;
  }
  return steps < THRASH_STEP_WINDOW && !progress;
}

export async function readSummary(blobs: BlobStore, event: SessionEventOf<"context/compacted">): Promise<SummaryV1 | undefined> {
  try {
    const parsed = JSON.parse(Buffer.from(await blobs.get(event.data.summary_blob.digest)).toString("utf8")) as Partial<SummaryV1>;
    return parsed.method === "summary-v1" && typeof parsed.summary === "string" ? (parsed as SummaryV1) : undefined;
  } catch {
    return undefined;
  }
}

export function renderSummary(summary: SummaryV1): string {
  const list = (title: string, items: readonly string[]): string => (items.length === 0 ? "" : `\n${title}:\n${items.map((item) => `- ${item}`).join("\n")}`);
  return [
    `Summary of events ${summary.from_seq}-${summary.to_seq} (compacted, ${summary.method}). ${SUMMARY_NOT_EVIDENCE}`,
    summary.summary,
    list("Open work", summary.open_work),
    list("Decisions", summary.decisions),
    list("Files", summary.files),
    list("Uncertainties", summary.uncertainties),
  ].join("\n");
}

function chooseBoundary(messages: readonly HistoryMessage[], keepRecent: number): number | undefined {
  let kept = 0;
  let index = messages.length;
  while (index > 0) {
    const candidate = messages[index - 1];
    if (candidate === undefined) break;
    if (kept + messageTokens(candidate.message) > keepRecent && index < messages.length) break;
    kept += messageTokens(candidate.message);
    index -= 1;
  }
  while (index < messages.length && messages[index]?.message.role === "tool") index += 1;
  if (index <= 0 || index >= messages.length) return undefined;
  return index;
}

export function createCompactor(deps: CompactorDependencies): Compactor {
  const summarize = deps.summarize ?? extractiveSummarizer;
  const keepRecent = deps.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  return {
    async compact(input, signal) {
      if (detectThrash(input.events)) return { status: "thrash" };
      const writer = deps.writerFor(input.sessionId);
      if (writer === undefined) return { status: "unavailable" };
      const boundaryIndex = chooseBoundary(input.messages, keepRecent);
      if (boundaryIndex === undefined) return { status: "nothing-to-compact" };
      const summarized = input.messages.slice(0, boundaryIndex);
      const kept = input.messages.slice(boundaryIndex);
      const firstKept = kept[0];
      const firstSummarized = summarized[0];
      if (firstKept === undefined || firstSummarized === undefined) return { status: "nothing-to-compact" };
      const previousEvent = lastCompaction(input.events);
      const previous = previousEvent === undefined ? undefined : await readSummary(deps.blobs, previousEvent);
      const content = await summarize({ messages: summarized, previous }, signal);
      const summary: SummaryV1 = {
        method: "summary-v1",
        from_seq: previousEvent?.data.from_seq ?? firstSummarized.seq,
        to_seq: Math.max(firstSummarized.seq, firstKept.seq - 1),
        first_kept_seq: firstKept.seq,
        note: SUMMARY_NOT_EVIDENCE,
        ...content,
      };
      const blob = await deps.blobs.put(Buffer.from(canonicalJson(summary), "utf8"), SUMMARY_MEDIA_TYPE);
      const tokensAfter = estimateTokens(renderSummary(summary)) + kept.reduce((sum, entry) => sum + messageTokens(entry.message), 0);
      const draft = {
        type: "context/compacted",
        event_version: EVENT_VERSIONS["context/compacted"],
        actor: { kind: "system" },
        data: {
          from_seq: summary.from_seq,
          to_seq: summary.to_seq,
          first_kept_seq: summary.first_kept_seq,
          method: "summary-v1",
          ...(content.model_id === undefined ? {} : { model_id: content.model_id }),
          tokens_before: input.tokensBefore,
          tokens_after: tokensAfter,
          summary_blob: blob,
          trigger: input.trigger,
        },
      } as SessionEventDraft;
      const event = await writer.append(draft);
      return { status: "compacted", event, summary };
    },
  };
}
