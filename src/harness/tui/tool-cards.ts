import type { ModelStreamEvent, SessionEvent } from "../contracts/index.ts";
import { sanitizeInline } from "./sanitize.ts";

/**
 * View model of tool cards. A card is born from the model stream (`tool_call_start`, arguments
 * still arriving) and continues under the runtime `ToolCallId` once the gateway records the call,
 * linked by the provider call id, so one card follows a call from proposal to result.
 */

export type ToolCardStatus = "streaming" | "proposed" | "denied" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface ToolCard {
  readonly key: string;
  readonly name: string;
  readonly status: ToolCardStatus;
  readonly args: string;
  readonly detail: string | undefined;
  readonly durationMs: number | undefined;
}

const ARGUMENT_PREVIEW_LIMIT = 200;

export class ToolCardTracker {
  private readonly cards = new Map<string, ToolCard>();
  private readonly byProviderCall = new Map<string, string>();
  private readonly byToolCall = new Map<string, string>();
  private sequence = 0;

  public list(): readonly ToolCard[] {
    return [...this.cards.values()];
  }

  public get(key: string): ToolCard | undefined {
    return this.cards.get(key);
  }

  /** Returns the card that changed, if any. */
  public applyStream(event: ModelStreamEvent): ToolCard | undefined {
    switch (event.type) {
      case "tool_call_start": {
        const key = this.byProviderCall.get(event.provider_call_id) ?? `card-${(this.sequence += 1)}`;
        this.byProviderCall.set(event.provider_call_id, key);
        return this.put({ key, name: sanitizeInline(event.name, 64), status: "streaming", args: "", detail: undefined, durationMs: undefined });
      }
      case "tool_call_delta": {
        const card = this.cardForProvider(event.provider_call_id);
        return card === undefined ? undefined : this.put({ ...card, args: preview(card.args + event.arguments_fragment) });
      }
      case "tool_call_end": {
        const card = this.cardForProvider(event.provider_call_id);
        const args = preview(JSON.stringify(event.arguments));
        if (card !== undefined) return this.put({ ...card, args, status: card.status === "streaming" ? "proposed" : card.status });
        const key = `card-${(this.sequence += 1)}`;
        this.byProviderCall.set(event.provider_call_id, key);
        return this.put({ key, name: sanitizeInline(event.name, 64), status: "proposed", args, detail: undefined, durationMs: undefined });
      }
      case "error":
        return this.failStreaming("the model stream ended with an error");
      default:
        return undefined;
    }
  }

  public applyEvent(event: SessionEvent): ToolCard | undefined {
    switch (event.type) {
      case "tool/call_proposed": {
        const key = this.byProviderCall.get(event.data.provider_call_id) ?? `card-${(this.sequence += 1)}`;
        this.byProviderCall.set(event.data.provider_call_id, key);
        this.byToolCall.set(event.data.tool_call_id, key);
        const existing = this.cards.get(key);
        return this.put({
          key,
          name: sanitizeInline(event.data.tool_name, 64),
          status: "proposed",
          args: existing?.args ?? "",
          detail: undefined,
          durationMs: undefined,
        });
      }
      case "tool/policy_decided": {
        const card = this.cardForTool(event.data.tool_call_id);
        if (card === undefined || event.data.decision.decision !== "deny") return undefined;
        return this.put({ ...card, status: "denied", detail: sanitizeInline(event.data.decision.reasons[0]?.message ?? "denied by policy", 300) });
      }
      case "tool/execution_started": {
        const card = this.cardForTool(event.data.tool_call_id);
        return card === undefined ? undefined : this.put({ ...card, status: "running", detail: `sandbox ${event.data.sandbox_enforcement}` });
      }
      case "tool/result_recorded": {
        const card = this.cardForTool(event.data.tool_call_id);
        if (card === undefined) return undefined;
        const status: ToolCardStatus = event.data.state === "denied" ? "denied" : event.data.state;
        const summary = event.data.result.error?.message ?? firstLine(event.data.result.text);
        return this.put({ ...card, status, detail: summary === "" ? undefined : sanitizeInline(summary, 300), durationMs: event.data.duration_ms });
      }
      case "tool/interrupted": {
        const card = this.cardForTool(event.data.tool_call_id);
        return card === undefined ? undefined : this.put({ ...card, status: "interrupted", detail: "interrupted; outcome unknown" });
      }
      default:
        return undefined;
    }
  }

  /** Marks cards still streaming as cancelled, e.g. after an aborted request. */
  public failStreaming(reason: string): ToolCard | undefined {
    let changed: ToolCard | undefined;
    for (const card of this.cards.values()) {
      if (card.status === "streaming") changed = this.put({ ...card, status: "cancelled", detail: reason });
    }
    return changed;
  }

  private cardForProvider(providerCallId: string): ToolCard | undefined {
    const key = this.byProviderCall.get(providerCallId);
    return key === undefined ? undefined : this.cards.get(key);
  }

  private cardForTool(toolCallId: string): ToolCard | undefined {
    const key = this.byToolCall.get(toolCallId);
    return key === undefined ? undefined : this.cards.get(key);
  }

  private put(card: ToolCard): ToolCard {
    this.cards.set(card.key, card);
    return card;
  }
}

function preview(text: string): string {
  const flat = sanitizeInline(text, ARGUMENT_PREVIEW_LIMIT + 1);
  return flat.length > ARGUMENT_PREVIEW_LIMIT ? `${flat.slice(0, ARGUMENT_PREVIEW_LIMIT - 1)}…` : flat;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

export const TOOL_STATUS_LABEL: { readonly [S in ToolCardStatus]: string } = {
  streaming: "preparing",
  proposed: "proposed",
  denied: "denied",
  running: "running",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};
