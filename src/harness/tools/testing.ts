import {
  createId,
  isTerminalState,
  sessionEventSchema,
  sha256,
  StoreFailure,
  validateTransition,
  type ApprovalBroker,
  type BlobRef,
  type BlobStore,
  type Digest,
  type EffectivePolicy,
  type EventReadItem,
  type EventStore,
  type PolicyEngine,
  type SandboxReport,
  type SessionEvent,
  type SessionEventDraft,
  type ToolCallOutcome,
  type ToolCallState,
  type ToolGateway,
  type ToolRegistry,
} from "../contracts/index.ts";
import { createToolGateway } from "./gateway.ts";
import { createSandboxRunner } from "./sandbox.ts";

/**
 * In-memory doubles of the store seams for tests of this module (the real stores belong to I1).
 * The event store validates every envelope against the contract schema, so a malformed draft
 * fails the test instead of passing silently.
 */

export interface MemoryEventStore extends EventStore {
  readonly events: readonly SessionEvent[];
  /** When it returns true for a draft, `append` rejects like a failed durable write. */
  failWhen: ((draft: SessionEventDraft) => boolean) | undefined;
}

export function createMemoryEventStore(): MemoryEventStore {
  const events: SessionEvent[] = [];
  const sessionId = createId("session");
  const store: MemoryEventStore = {
    sessionId,
    events,
    failWhen: undefined,
    get lastSeq() {
      return events.length;
    },
    async append(draft: SessionEventDraft): Promise<SessionEvent> {
      if (store.failWhen?.(draft) === true) throw new StoreFailure("write_failed", `append refused for ${draft.type}`);
      const event = sessionEventSchema.parse({
        ...draft,
        schema_version: 1,
        event_id: createId("event"),
        session_id: sessionId,
        seq: events.length + 1,
        timestamp: new Date().toISOString(),
      });
      events.push(event);
      return event;
    },
    async *read(fromSeq = 1, toSeq = Number.POSITIVE_INFINITY): AsyncIterable<EventReadItem> {
      for (const event of events) {
        if (event.seq >= fromSeq && event.seq <= toSeq) yield { status: "ok", event };
      }
    },
    async close(): Promise<void> {
      return undefined;
    },
  };
  return store;
}

/**
 * Replays `tool/*` events through the contract `toolCall` state machine the way the session
 * projection does and returns every illegal transition or non-terminal call it finds.
 */
export function replayToolCallTransitions(events: readonly SessionEvent[]): string[] {
  const states = new Map<string, string>();
  const issues: string[] = [];
  const advance = (id: string, to: string, seq: number): void => {
    const from = states.get(id);
    if (from === undefined) {
      issues.push(`seq ${seq}: ${id} -> ${to} before tool/call_proposed`);
      return;
    }
    const verdict = validateTransition("toolCall", from, to);
    if (!verdict.ok) issues.push(`seq ${seq}: ${verdict.message}`);
    states.set(id, to);
  };
  for (const event of events) {
    switch (event.type) {
      case "tool/call_proposed":
        if (states.has(event.data.tool_call_id)) issues.push(`seq ${event.seq}: duplicate ${event.data.tool_call_id}`);
        states.set(event.data.tool_call_id, "proposed");
        break;
      case "tool/policy_decided":
        if (event.data.decision.decision === "ask") advance(event.data.tool_call_id, "awaiting_approval", event.seq);
        else if (!states.has(event.data.tool_call_id)) issues.push(`seq ${event.seq}: decision for unknown call`);
        break;
      case "tool/execution_started":
        advance(event.data.tool_call_id, "executing", event.seq);
        break;
      case "tool/result_recorded":
        advance(event.data.tool_call_id, event.data.state, event.seq);
        break;
      case "tool/interrupted":
        advance(event.data.tool_call_id, "interrupted", event.seq);
        break;
      default:
        break;
    }
  }
  for (const [id, state] of states) {
    if (!isTerminalState("toolCall", state as ToolCallState)) issues.push(`${id} ended non-terminal in ${state}`);
  }
  return issues;
}

export interface MemoryBlobStore extends BlobStore {
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  text(digest: Digest): string;
}

export function createMemoryBlobStore(): MemoryBlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
      const digest = sha256(bytes);
      blobs.set(digest, new Uint8Array(bytes));
      return { digest, size_bytes: bytes.length, media_type: mediaType };
    },
    async get(digest: Digest): Promise<Uint8Array> {
      const bytes = blobs.get(digest);
      if (bytes === undefined) throw new StoreFailure("blob_missing", `no blob ${digest}`);
      if (sha256(bytes) !== digest) throw new StoreFailure("blob_digest_mismatch", `blob ${digest} is corrupt`);
      return bytes;
    },
    async has(digest: Digest): Promise<boolean> {
      return blobs.has(digest);
    },
    text(digest: Digest): string {
      return Buffer.from(blobs.get(digest) ?? new Uint8Array()).toString("utf8");
    },
  };
}

export interface GatewayHarnessOptions {
  readonly engine: PolicyEngine;
  readonly policy: EffectivePolicy;
  readonly approvals: ApprovalBroker;
  readonly sandboxReport: SandboxReport;
  readonly registry: ToolRegistry;
  readonly redactionValues?: readonly string[];
}

export interface GatewayHarness {
  readonly events: MemoryEventStore;
  readonly blobs: MemoryBlobStore;
  readonly gateway: ToolGateway;
  call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal, policy?: EffectivePolicy): Promise<ToolCallOutcome>;
  ofType<T extends SessionEvent["type"]>(type: T): Extract<SessionEvent, { type: T }>[];
}

/** A gateway over in-memory stores, a real sandbox runner for the given report and the given policy. */
export function createGatewayHarness(options: GatewayHarnessOptions): GatewayHarness {
  const events = createMemoryEventStore();
  const blobs = createMemoryBlobStore();
  const values = options.redactionValues ?? [];
  const gateway = createToolGateway({
    events,
    blobs,
    registry: options.registry,
    policy: options.engine,
    approvals: options.approvals,
    sandbox: createSandboxRunner(options.sandboxReport),
    redactionValues: () => values,
  });
  let counter = 0;
  return {
    events,
    blobs,
    gateway,
    call(toolName, args, signal = new AbortController().signal, policy = options.policy) {
      counter += 1;
      return gateway.invoke(
        { tool_call_id: createId("toolCall"), provider_call_id: `provider-${counter}`, tool_name: toolName, arguments: args },
        { runId: policy.run_id, taskId: policy.task_id, attemptId: undefined, role: policy.role, policy },
        signal,
      );
    },
    ofType<T extends SessionEvent["type"]>(type: T): Extract<SessionEvent, { type: T }>[] {
      return events.events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
    },
  };
}
