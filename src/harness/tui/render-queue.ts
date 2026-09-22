import type { RenderEvent } from "../contracts/index.ts";

/**
 * The renderer side of the non-blocking subscription (ADR-04): `push` never waits. Consecutive text
 * or thinking deltas of the same request are coalesced; when the queue is full only deltas are
 * dropped, never session events, status or notices. Consumers reconcile dropped text from the
 * final `done` message. A paused queue (a slow pipe) keeps accepting under the same rule.
 */

export const DEFAULT_RENDER_QUEUE_CAPACITY = 2048;

const DELTA_TYPES = new Set(["text_delta", "thinking_delta", "tool_call_delta"]);

export function isDeltaEvent(event: RenderEvent): boolean {
  return event.kind === "stream" && DELTA_TYPES.has(event.event.type);
}

function coalesce(previous: RenderEvent | undefined, next: RenderEvent): RenderEvent | undefined {
  if (previous?.kind !== "stream" || next.kind !== "stream" || previous.requestId !== next.requestId) return undefined;
  const before = previous.event;
  const after = next.event;
  if ((before.type === "text_delta" && after.type === "text_delta") || (before.type === "thinking_delta" && after.type === "thinking_delta")) {
    if (before.index !== after.index) return undefined;
    return { kind: "stream", requestId: next.requestId, event: { type: after.type, index: after.index, text: before.text + after.text } };
  }
  return undefined;
}

export interface RenderQueueOptions {
  readonly capacity?: number;
  readonly coalesceDeltas?: boolean;
  readonly schedule?: (flush: () => void) => void;
}

export class RenderQueue {
  private readonly items: RenderEvent[] = [];
  private readonly consume: (event: RenderEvent) => void;
  private readonly capacity: number;
  private readonly coalesceDeltas: boolean;
  private readonly schedule: (flush: () => void) => void;
  private scheduled = false;
  private paused = false;
  private droppedDeltas = 0;

  public constructor(consume: (event: RenderEvent) => void, options: RenderQueueOptions = {}) {
    this.consume = consume;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_RENDER_QUEUE_CAPACITY);
    this.coalesceDeltas = options.coalesceDeltas ?? true;
    this.schedule = options.schedule ?? ((flush) => setImmediate(flush));
  }

  public get size(): number {
    return this.items.length;
  }

  public get dropped(): number {
    return this.droppedDeltas;
  }

  public push(event: RenderEvent): void {
    if (this.coalesceDeltas) {
      const merged = coalesce(this.items.at(-1), event);
      if (merged !== undefined) {
        this.items[this.items.length - 1] = merged;
        this.request();
        return;
      }
    }
    if (this.items.length >= this.capacity) {
      if (isDeltaEvent(event)) {
        this.droppedDeltas += 1;
        return;
      }
      const oldestDelta = this.items.findIndex(isDeltaEvent);
      if (oldestDelta !== -1) {
        this.items.splice(oldestDelta, 1);
        this.droppedDeltas += 1;
      }
    }
    this.items.push(event);
    this.request();
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
    this.request();
  }

  /** Drains synchronously until empty or paused. */
  public flush(): void {
    this.scheduled = false;
    while (!this.paused) {
      const next = this.items.shift();
      if (next === undefined) return;
      this.consume(next);
    }
  }

  private request(): void {
    if (this.scheduled || this.paused) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }
}
