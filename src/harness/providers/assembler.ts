import type { AssistantMessage, ContentPart, ModelStreamEvent, ProviderError, Usage } from "../contracts/index.ts";

type Slot =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "thinking"; text: string; opaque: string | undefined }
  | {
      readonly kind: "tool";
      readonly providerCallId: string;
      readonly name: string;
      fragments: string;
      arguments: Record<string, unknown> | undefined;
    };

/**
 * Accumulates one assistant message from provider deltas and emits the matching
 * `ModelStreamEvent`s. Parts are ordered by their stream index; `partial()` drops tool calls that
 * never completed so an aborted stream never hands the driver half-parsed arguments.
 */
export class StreamAssembler {
  private readonly slots = new Map<number, Slot>();

  public text(index: number, text: string): ModelStreamEvent {
    const slot = this.slots.get(index);
    if (slot?.kind === "text") slot.text += text;
    else this.slots.set(index, { kind: "text", text });
    return { type: "text_delta", index, text };
  }

  public thinking(index: number, text: string): ModelStreamEvent {
    const slot = this.slots.get(index);
    if (slot?.kind === "thinking") slot.text += text;
    else this.slots.set(index, { kind: "thinking", text, opaque: undefined });
    return { type: "thinking_delta", index, text };
  }

  /** Records the opaque continuation (encrypted reasoning, signature) of a thinking part. */
  public thinkingOpaque(index: number, opaque: string, text?: string): void {
    const slot = this.slots.get(index);
    if (slot?.kind === "thinking") {
      slot.opaque = opaque;
      if (text !== undefined && slot.text === "") slot.text = text;
    } else {
      this.slots.set(index, { kind: "thinking", text: text ?? "", opaque });
    }
  }

  public toolStart(index: number, providerCallId: string, name: string): ModelStreamEvent {
    this.slots.set(index, { kind: "tool", providerCallId, name, fragments: "", arguments: undefined });
    return { type: "tool_call_start", index, provider_call_id: providerCallId, name };
  }

  public toolDelta(index: number, fragment: string): ModelStreamEvent | undefined {
    const slot = this.slots.get(index);
    if (slot?.kind !== "tool" || slot.arguments !== undefined) return undefined;
    slot.fragments += fragment;
    return { type: "tool_call_delta", index, provider_call_id: slot.providerCallId, arguments_fragment: fragment };
  }

  public hasOpenTool(index: number): boolean {
    const slot = this.slots.get(index);
    return slot?.kind === "tool" && slot.arguments === undefined;
  }

  /**
   * Completes a tool call. `finalArguments` (the provider's complete argument string) wins over
   * the accumulated fragments. Returns an error instead of an event when the JSON is not an object.
   */
  public toolEnd(index: number, finalArguments?: string): ModelStreamEvent | ProviderError | undefined {
    const slot = this.slots.get(index);
    if (slot?.kind !== "tool" || slot.arguments !== undefined) return undefined;
    const raw = finalArguments ?? slot.fragments;
    const parsed = parseArguments(raw);
    if (parsed === undefined) {
      return {
        code: "protocol_mismatch",
        message: `tool call ${slot.name} returned arguments that are not a JSON object`,
        retryable: false,
      };
    }
    slot.arguments = parsed;
    return { type: "tool_call_end", index, provider_call_id: slot.providerCallId, name: slot.name, arguments: parsed };
  }

  public hasToolCalls(): boolean {
    return [...this.slots.values()].some((slot) => slot.kind === "tool");
  }

  public message(): AssistantMessage {
    return { role: "assistant", content: this.parts(true) };
  }

  public partial(): AssistantMessage | undefined {
    const content = this.parts(false);
    return content.length === 0 ? undefined : { role: "assistant", content };
  }

  private parts(includeIncompleteTools: boolean): ContentPart[] {
    const parts: ContentPart[] = [];
    for (const [, slot] of [...this.slots.entries()].sort(([left], [right]) => left - right)) {
      if (slot.kind === "text") {
        if (slot.text !== "") parts.push({ type: "text", text: slot.text });
      } else if (slot.kind === "thinking") {
        if (slot.text === "" && slot.opaque === undefined) continue;
        parts.push(
          slot.opaque === undefined
            ? { type: "thinking", text: slot.text }
            : { type: "thinking", text: slot.text, opaque: slot.opaque },
        );
      } else if (slot.arguments !== undefined || includeIncompleteTools) {
        parts.push({
          type: "tool_call",
          provider_call_id: slot.providerCallId,
          name: slot.name,
          arguments: slot.arguments ?? parseArguments(slot.fragments) ?? {},
        });
      }
    }
    return parts;
  }
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function isProviderError(value: ModelStreamEvent | ProviderError | undefined): value is ProviderError {
  return value !== undefined && "code" in value;
}

/** Drops undefined members so the result satisfies `usageSchema` under exact optional types. */
export function usageOf(
  fields: Readonly<Partial<Record<Exclude<keyof Usage, "source">, number | undefined>>>,
  source: Usage["source"] = "provider-reported",
): Usage {
  const usage: Record<string, unknown> = { source };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) usage[key] = value;
  }
  return usage as Usage;
}
