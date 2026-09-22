import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompactor,
  createContextBuilder,
  detectThrash,
  SUMMARY_NOT_EVIDENCE,
  type ContextBuilderDependencies,
  type Summarizer,
} from "../src/harness/context/index.ts";
import {
  createId,
  EVENT_VERSIONS,
  sha256,
  type Actor,
  type ContextBuildInput,
  type EventStore,
  type ModelMessage,
  type SessionEvent,
  type SessionEventDraft,
} from "../src/harness/contracts/index.ts";
import { resolveEvidence, type EvidenceIndex } from "../src/harness/orchestration/index.ts";
import { buildAttemptLog } from "../src/harness/orchestration/attempt-log.ts";
import {
  createFakePolicyEngine,
  createMemoryBlobStore,
  createMemorySessionStore,
  createStaticToolRegistry,
  TEST_SANDBOX,
  testRoute,
} from "../src/harness/orchestration/testing.ts";

async function record(store: EventStore, type: SessionEventDraft["type"], data: unknown, actor: Actor = { kind: "system" }): Promise<number> {
  return (await store.append({ type, data, event_version: EVENT_VERSIONS[type], actor } as SessionEventDraft)).seq;
}

function text(role: ModelMessage["role"], body: string): ModelMessage {
  return { role, content: [{ type: "text", text: body }] };
}

async function setup() {
  const sessions = createMemorySessionStore();
  const blobs = createMemoryBlobStore();
  const sessionId = createId("session");
  const store = await sessions.create({ session_id: sessionId, project_id: "proj-1234abcd" as never, workspace_root: "/w", created_at: new Date().toISOString() });
  const runId = createId("run");
  const policy = createFakePolicyEngine().compute({
    mode: "autonomous",
    role: "implementer",
    runId,
    taskId: undefined,
    workspaceRoot: "/w",
    taskScope: { owned: ["src/**"], read: [], forbidden: [] },
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: TEST_SANDBOX,
    grants: [],
  });
  const input = (packet: undefined): ContextBuildInput => ({
    sessionId,
    runId,
    taskId: undefined,
    role: "implementer",
    route: testRoute("openai", "gpt-test"),
    policy,
    packet,
    requestId: createId("request"),
  });
  const builder = (extra: Partial<ContextBuilderDependencies> = {}) =>
    createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(), ...extra });
  return { sessions, blobs, store, sessionId, input, builder };
}

const implementer: Actor = { kind: "worker", role: "implementer" };
const WINDOW = { contextWindow: () => 3_000, reserveTokens: 1_000, maxOutputTokens: 500 } as const;

async function longConversation(store: Awaited<ReturnType<typeof setup>>["store"], turns: number): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await record(store, "message/recorded", { role: "user", message: text("user", `question ${index} ${"q".repeat(1_600)}`) }, implementer);
    await record(store, "message/recorded", { role: "assistant", message: text("assistant", `answer ${index} ${"a".repeat(1_600)}`) }, implementer);
  }
}

test("AC-7 compaction appends a summary-v1 boundary and deletes nothing; the next request is summary + events after first_kept_seq", async () => {
  const { store, blobs, sessionId, sessions, input, builder } = await setup();
  await longConversation(store, 6);
  const before = [...(sessions.store(sessionId)?.events ?? [])];
  const compactor = createCompactor({ blobs, writerFor: (id) => (id === sessionId ? store : undefined), keepRecentTokens: 900 });
  const result = await builder({ ...WINDOW, compactor }).build(input(undefined), new AbortController().signal);
  assert.ok(result.ok, JSON.stringify(result));
  const after = sessions.store(sessionId)?.events ?? [];
  assert.equal(after.length, before.length + 1, "compaction only appends");
  assert.deepEqual(after.slice(0, before.length), before, "original events are untouched");
  const compacted = after.at(-1);
  assert.ok(compacted?.type === "context/compacted");
  assert.equal(compacted.data.method, "summary-v1");
  assert.equal(compacted.data.trigger, "threshold");
  assert.ok(compacted.data.tokens_after < compacted.data.tokens_before);
  const firstKept = compacted.data.first_kept_seq;
  const keptMessages = before.filter((event) => event.type === "message/recorded" && event.seq >= firstKept).length;
  assert.equal(result.request.messages.length, keptMessages);
  const summaryBlock = result.request.system.find((block) => block.source === "compaction");
  assert.equal(summaryBlock?.trust, "untrusted");
  assert.ok(summaryBlock?.text.includes(SUMMARY_NOT_EVIDENCE));

  const replay = await builder({ ...WINDOW, compactor }).build({ ...input(undefined), requestId: result.request.request_id }, new AbortController().signal);
  assert.ok(replay.ok);
  assert.equal(replay.envelopeDigest, result.envelopeDigest, "after compaction the envelope still replays byte for byte");
  assert.equal((sessions.store(sessionId)?.events ?? []).length, after.length, "no second compaction once under the limit");
});

test("AC-7 two compactions within three steps without progress are a compaction-thrash error", async () => {
  const { store, blobs, sessionId, input, builder } = await setup();
  await longConversation(store, 6);
  const compactor = createCompactor({ blobs, writerFor: () => store, keepRecentTokens: 900 });
  const first = await builder({ ...WINDOW, compactor }).build(input(undefined), new AbortController().signal);
  assert.ok(first.ok);
  await record(store, "step/started", { step_id: createId("step"), turn_id: createId("turn"), request_id: createId("request") });
  await longConversation(store, 3);
  const thrash = await builder({ ...WINDOW, compactor }).build(input(undefined), new AbortController().signal);
  assert.deepEqual(thrash, { ok: false, reason: "compaction-thrash", stale: [] });
});

test("AC-7 thrash detection counts steps and successful tool results since the last compaction", () => {
  const sessionId = createId("session");
  let seq = 0;
  const event = (type: string, data: unknown): SessionEvent =>
    ({ schema_version: 1, event_id: createId("event"), session_id: sessionId, seq: ++seq, event_version: 1, timestamp: "2026-09-22T10:00:00Z", actor: { kind: "system" }, type, data }) as SessionEvent;
  const compaction = event("context/compacted", {
    from_seq: 1,
    to_seq: 1,
    first_kept_seq: 1,
    method: "summary-v1",
    tokens_before: 10,
    tokens_after: 5,
    summary_blob: { digest: sha256("s"), size_bytes: 1, media_type: "x" },
    trigger: "threshold",
  });
  const step = () => event("step/started", { step_id: createId("step"), turn_id: createId("turn"), request_id: createId("request") });
  assert.equal(detectThrash([]), false);
  assert.equal(detectThrash([compaction, step()]), true);
  assert.equal(detectThrash([compaction, step(), step(), step()]), false);
  const progress = event("tool/result_recorded", {
    tool_call_id: createId("toolCall"),
    state: "succeeded",
    result: { status: "ok", text: "ok", truncated: false, redactions: 0 },
    duration_ms: 1,
  });
  assert.equal(detectThrash([compaction, step(), progress]), false);
});

test("AC-7 a provider context_overflow triggers an overflow compaction even under the threshold", async () => {
  const { store, blobs, input, builder } = await setup();
  await longConversation(store, 3);
  const requestId = createId("request");
  await record(store, "model/response_failed", { request_id: requestId, error: { code: "context_overflow", message: "too long", retryable: false } }, { kind: "provider" });
  const seen: number[] = [];
  const summarize: Summarizer = async (summaryInput) => {
    seen.push(summaryInput.messages.length);
    return { summary: "earlier turns", open_work: ["finish"], decisions: [], files: [], uncertainties: [], model_id: "summary-model" };
  };
  const compactor = createCompactor({ blobs, writerFor: () => store, keepRecentTokens: 500, summarize });
  const result = await builder({ compactor }).build(input(undefined), new AbortController().signal);
  assert.ok(result.ok);
  const events = [];
  for await (const item of store.read()) if (item.status === "ok") events.push(item.event);
  const compacted = events.find((event) => event.type === "context/compacted");
  assert.ok(compacted?.type === "context/compacted" && compacted.data.trigger === "overflow" && compacted.data.model_id === "summary-model");
  assert.ok((seen[0] ?? 0) > 0);
});

test("AC-7 a compaction summary is never accepted as evidence", async () => {
  const { store, blobs, sessionId, input, builder } = await setup();
  await longConversation(store, 6);
  const compactor = createCompactor({ blobs, writerFor: () => store, keepRecentTokens: 900 });
  assert.ok((await builder({ ...WINDOW, compactor }).build(input(undefined), new AbortController().signal)).ok);
  const events = [];
  for await (const item of store.read()) if (item.status === "ok") events.push(item.event);
  const compacted = events.find((event) => event.type === "context/compacted");
  assert.ok(compacted?.type === "context/compacted");
  const index: EvidenceIndex = {
    log: await buildAttemptLog(sessionId, events, blobs),
    artifactDigest: undefined,
    changedPaths: [],
    fileDigest: async () => undefined,
  };
  assert.match((await resolveEvidence({ kind: "event", ref: `${sessionId}#${compacted.seq}`, produced_by: "worker" }, index)) ?? "", /never evidence/);
  assert.match((await resolveEvidence({ kind: "artifact", ref: compacted.data.summary_blob.digest, produced_by: "worker" }, index)) ?? "", /never evidence/);
  assert.match((await resolveEvidence({ kind: "file", ref: "x.md", digest: compacted.data.summary_blob.digest, produced_by: "worker" }, index)) ?? "", /never evidence/);
  assert.equal(await resolveEvidence({ kind: "event", ref: `${sessionId}#1`, produced_by: "worker" }, index), undefined, "an original event is still evidence");
});

test("AC-7 without a writer compaction is unavailable and an oversized context is reported, not silently cut", async () => {
  const { store, blobs, input, builder } = await setup();
  await longConversation(store, 6);
  const compactor = createCompactor({ blobs, writerFor: () => undefined });
  const result = await builder({ ...WINDOW, compactor }).build(input(undefined), new AbortController().signal);
  assert.deepEqual(result, { ok: false, reason: "context-overflow", stale: [] });
});
