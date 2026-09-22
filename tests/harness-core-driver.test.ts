import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  canonicalJson,
  createId,
  deriveProjectId,
  digestOf,
  StoreFailure,
  type EventReadItem,
  type EventStore,
  type ModelRequest,
  type ModelStreamEvent,
  type SessionEvent,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionEventType,
  type TurnInput,
} from "../src/harness/contracts/index.ts";
import { createAgentDriver, loadRecordedMessage, rebuildModelRequest, type AgentDriverOptions } from "../src/harness/core/index.ts";
import {
  createLogContextBuilder,
  lazy,
  newRunId,
  RecordingToolGateway,
  ScriptedBackendAdapter,
  ScriptedModelAdapter,
  testCredential,
  testPolicy,
  testRegistry,
  testRoute,
  testRouter,
  textTurn,
  toolTurn,
  type BackendScript,
  type ScriptStep,
  type ToolHandler,
} from "../src/harness/core/testing.ts";
import { createBlobStore, createSessionStore } from "../src/harness/store/index.ts";

const homes: string[] = [];
const stores: EventStore[] = [];

after(async () => {
  await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

interface Harness {
  readonly events: EventStore;
  readonly blobs: ReturnType<typeof createBlobStore>;
  readonly gateway: RecordingToolGateway;
  readonly driver: ReturnType<typeof createAgentDriver>;
  readonly input: (overrides?: Partial<TurnInput>) => TurnInput;
  readonly log: () => Promise<SessionEvent[]>;
}

async function harness(
  adapter: ScriptedModelAdapter | ScriptedBackendAdapter,
  options: { readonly handler?: ToolHandler; readonly wrap?: (store: EventStore) => EventStore; readonly driver?: AgentDriverOptions } = {},
): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "synorch-driver-"));
  homes.push(home);
  const store = await createSessionStore(home).create({
    session_id: createId("session"),
    project_id: deriveProjectId("/workspace", "linux"),
    workspace_root: "/workspace",
    created_at: "2026-09-22T10:00:00.000Z",
  });
  stores.push(store);
  const events = options.wrap?.(store) ?? store;
  const blobs = createBlobStore(home);
  const registry = testRegistry();
  const gateway = new RecordingToolGateway(events, options.handler);
  const driver = createAgentDriver({
    events,
    blobs,
    router: testRouter(adapter),
    context: createLogContextBuilder(events, blobs, registry),
    tools: registry,
    gateway,
    credentials: async () => testCredential(),
    ...options.driver,
  });
  const runId = newRunId();
  const route = testRoute(adapter.kind);
  return {
    events,
    blobs,
    gateway,
    driver,
    input: (overrides = {}) => ({
      sessionId: store.sessionId,
      runId,
      taskId: undefined,
      attemptId: undefined,
      role: "implementer",
      route,
      policy: testPolicy(runId),
      packet: undefined,
      userMessage: "Fix the failing test",
      trigger: "user",
      maxSteps: 8,
      ...overrides,
    }),
    log: async () => {
      const out: SessionEvent[] = [];
      for await (const item of store.read()) if (item.status === "ok") out.push(item.event);
      return out;
    },
  };
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => (event.type === "message/recorded" ? `message/${event.data.role}` : event.type));
}

function ofType<T extends SessionEventType>(events: readonly SessionEvent[], type: T): SessionEventOf<T>[] {
  return events.filter((event): event is SessionEventOf<T> => event.type === type);
}

test("a text-only turn records turn, step, request, message and settled events and completes", async () => {
  const adapter = new ScriptedModelAdapter([lazy((request) => textTurn(request, "Done."))]);
  const h = await harness(adapter);
  const outcome = await h.driver.runTurn(h.input(), new AbortController().signal);
  assert.equal(outcome.outcome, "completed");
  assert.equal(outcome.steps, 1);
  const events = await h.log();
  assert.deepEqual(types(events), [
    "turn/started",
    "message/user",
    "step/started",
    "model/request_prepared",
    "message/assistant",
    "model/response_settled",
    "provider/usage",
    "step/ended",
    "turn/ended",
  ]);
  assert.equal(ofType(events, "step/ended")[0]?.data.state, "settled");
  assert.equal(ofType(events, "turn/ended")[0]?.data.outcome, "completed");
  assert.equal(events[0]?.actor.kind, "worker");
  assert.ok(events.every((event) => event.run_id === h.input().runId));
});

test("tool calls run through the gateway in source order with runtime ids and feed the next step", async () => {
  const adapter = new ScriptedModelAdapter([
    lazy((request) =>
      toolTurn(request, [
        { id: "toolu_a", name: "read_file", arguments: { path: "src/a.ts" } },
        { id: "toolu_b", name: "exec", arguments: { argv: ["pnpm", "test"] } },
      ]),
    ),
    lazy((request) => textTurn(request, "All green.")),
  ]);
  const h = await harness(adapter);
  const outcome = await h.driver.runTurn(h.input(), new AbortController().signal);
  assert.equal(outcome.outcome, "completed");
  assert.equal(outcome.steps, 2);
  assert.deepEqual(h.gateway.invocations.map((call) => [call.provider_call_id, call.tool_name]), [
    ["toolu_a", "read_file"],
    ["toolu_b", "exec"],
  ]);

  const events = await h.log();
  const assistant = ofType(events, "message/recorded").find((event) => event.data.role === "assistant");
  const recordedIds = (assistant?.data.message?.content ?? []).flatMap((part) => (part.type === "tool_call" ? [part.tool_call_id] : []));
  assert.deepEqual(recordedIds, h.gateway.invocations.map((call) => call.tool_call_id));
  assert.ok(recordedIds.every((id) => id !== undefined && id.startsWith("call_")));
  assert.deepEqual(ofType(events, "tool/call_proposed").map((event) => event.data.tool_call_id), recordedIds);

  const second = adapter.requests[1] as ModelRequest;
  const results = second.messages.filter((message) => message.role === "tool").flatMap((message) => message.content);
  assert.deepEqual(results.map((part) => (part.type === "tool_result" ? [part.tool_call_id, part.provider_call_id, part.is_error] : [])), [
    [recordedIds[0], "toolu_a", false],
    [recordedIds[1], "toolu_b", false],
  ]);
});

test("AC-5 every model request envelope is rebuilt byte for byte from the log and blobs", async () => {
  const adapter = new ScriptedModelAdapter([
    lazy((request) => toolTurn(request, [{ id: "toolu_a", name: "read_file", arguments: { path: "src/a.ts" } }])),
    lazy((request) => textTurn(request, "Finished.")),
  ]);
  const h = await harness(adapter);
  await h.driver.runTurn(h.input(), new AbortController().signal);
  const events = await h.log();
  const prepared = ofType(events, "model/request_prepared");
  assert.equal(prepared.length, 2);
  for (const [index, event] of prepared.entries()) {
    const rebuilt = await rebuildModelRequest(event, h.blobs);
    assert.deepEqual(rebuilt, adapter.requests[index]);
    assert.equal(digestOf(rebuilt), event.data.envelope_digest);
    assert.deepEqual(await h.blobs.get(event.data.envelope_blob.digest), new TextEncoder().encode(canonicalJson(adapter.requests[index])));
    assert.equal(event.data.tool_set_digest, digestOf(rebuilt.tools));

    const prefix = prefixStore(h.events, event.seq - 1);
    const again = await createLogContextBuilder(prefix, h.blobs, testRegistry()).build(
      { ...h.input(), requestId: event.data.request_id, packet: undefined },
      new AbortController().signal,
    );
    assert.ok(again.ok);
    assert.equal(again.envelopeDigest, event.data.envelope_digest, "the same log prefix yields the same envelope");
  }
});

test("AC-5 a tampered envelope blob is detected instead of rebuilt", async () => {
  const adapter = new ScriptedModelAdapter([lazy((request) => textTurn(request, "ok"))]);
  const h = await harness(adapter);
  await h.driver.runTurn(h.input(), new AbortController().signal);
  const prepared = ofType(await h.log(), "model/request_prepared")[0] as SessionEventOf<"model/request_prepared">;
  const forged = { ...prepared, data: { ...prepared.data, envelope_digest: digestOf({ other: true }) } };
  await assert.rejects(rebuildModelRequest(forged, h.blobs), (error: unknown) => error instanceof StoreFailure && error.code === "session_corrupt");
});

test("AC-6 a cancelled stream ends with step aborted and response_failed{cancelled}, never settled", async () => {
  const controller = new AbortController();
  const hanging: ScriptStep = async function* (request: ModelRequest) {
    yield { type: "start", request_id: request.request_id, route: request.route } satisfies ModelStreamEvent;
    yield { type: "text_delta", index: 0, text: "Let me" } satisfies ModelStreamEvent;
    controller.abort();
    await new Promise(() => undefined);
  };
  const h = await harness(new ScriptedModelAdapter([hanging]));
  const outcome = await h.driver.runTurn(h.input(), controller.signal);
  assert.equal(outcome.outcome, "cancelled");
  const events = await h.log();
  assert.deepEqual(types(events).slice(-3), ["model/response_failed", "step/ended", "turn/ended"]);
  const failed = ofType(events, "model/response_failed")[0];
  assert.equal(failed?.data.error.code, "cancelled");
  assert.equal(failed?.data.error.retryable, false);
  assert.ok(failed?.data.partial_blob !== undefined);
  const partial = JSON.parse(new TextDecoder().decode(await h.blobs.get(failed.data.partial_blob.digest))) as unknown;
  assert.deepEqual(partial, { role: "assistant", content: [{ type: "text", text: "Let me" }] });
  assert.equal(ofType(events, "step/ended")[0]?.data.state, "aborted");
  assert.equal(ofType(events, "turn/ended")[0]?.data.outcome, "cancelled");
  assert.equal(ofType(events, "model/response_settled").length, 0);
  assert.equal(ofType(events, "message/recorded").filter((event) => event.data.role === "assistant").length, 0);
});

test("AC-6 a stream that still reports done after the abort is recorded as cancelled", async () => {
  const controller = new AbortController();
  const late: ScriptStep = async function* (request: ModelRequest) {
    yield { type: "start", request_id: request.request_id, route: request.route } satisfies ModelStreamEvent;
    controller.abort();
    yield { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "too late" }] } } satisfies ModelStreamEvent;
  };
  const h = await harness(new ScriptedModelAdapter([late]));
  assert.equal((await h.driver.runTurn(h.input(), controller.signal)).outcome, "cancelled");
  const events = await h.log();
  assert.equal(ofType(events, "model/response_settled").length, 0);
  assert.equal(ofType(events, "model/response_failed")[0]?.data.error.code, "cancelled");
  assert.equal(ofType(events, "step/ended")[0]?.data.state, "aborted");
});

test("AC-6 cancelling during a tool batch skips the remaining calls and aborts the step", async () => {
  const controller = new AbortController();
  const adapter = new ScriptedModelAdapter([
    lazy((request) =>
      toolTurn(request, [
        { id: "toolu_a", name: "exec", arguments: { argv: ["sleep"] } },
        { id: "toolu_b", name: "exec", arguments: { argv: ["never"] } },
      ]),
    ),
  ]);
  const h = await harness(adapter, {
    handler: async () => {
      controller.abort();
      return { status: "error", text: "", truncated: false, redactions: 0, error: { code: "cancelled", message: "cancelled" } };
    },
  });
  const outcome = await h.driver.runTurn(h.input(), controller.signal);
  assert.equal(outcome.outcome, "cancelled");
  assert.deepEqual(h.gateway.invocations.map((call) => call.provider_call_id), ["toolu_a"]);
  const events = await h.log();
  const skipped = ofType(events, "message/recorded").at(-1)?.data.message?.content[0];
  assert.ok(skipped?.type === "tool_result" && skipped.provider_call_id === "toolu_b" && skipped.is_error);
  assert.equal(ofType(events, "step/ended")[0]?.data.state, "aborted");
  assert.equal(ofType(events, "turn/ended")[0]?.data.outcome, "cancelled");
});

test("AC-7 when recording the assistant message is rejected, none of its tool calls start", async () => {
  const adapter = new ScriptedModelAdapter([lazy((request) => toolTurn(request, [{ id: "toolu_a", name: "exec", arguments: { argv: ["rm", "x"] } }]))]);
  const h = await harness(adapter, { wrap: (store) => rejectingStore(store, (draft) => draft.type === "message/recorded" && draft.data.role === "assistant") });
  await assert.rejects(h.driver.runTurn(h.input(), new AbortController().signal), (error: unknown) => error instanceof StoreFailure && error.code === "write_failed");
  assert.equal(h.gateway.invocations.length, 0);
  const events = await h.log();
  assert.equal(ofType(events, "tool/call_proposed").length, 0);
  assert.equal(ofType(events, "turn/ended")[0]?.data.outcome, "failed");
});

test("AC-7 when a tool result cannot be recorded, the next tool call does not start", async () => {
  const adapter = new ScriptedModelAdapter([
    lazy((request) =>
      toolTurn(request, [
        { id: "toolu_a", name: "exec", arguments: { argv: ["one"] } },
        { id: "toolu_b", name: "exec", arguments: { argv: ["two"] } },
      ]),
    ),
  ]);
  const h = await harness(adapter, { wrap: (store) => rejectingStore(store, (draft) => draft.type === "message/recorded" && draft.data.role === "tool") });
  await assert.rejects(h.driver.runTurn(h.input(), new AbortController().signal), StoreFailure);
  assert.deepEqual(h.gateway.invocations.map((call) => call.provider_call_id), ["toolu_a"]);
});

test("AC-7 a gateway that leaves no durable record stops the batch", async () => {
  const adapter = new ScriptedModelAdapter([
    lazy((request) =>
      toolTurn(request, [
        { id: "toolu_a", name: "exec", arguments: { argv: ["one"] } },
        { id: "toolu_b", name: "exec", arguments: { argv: ["two"] } },
      ]),
    ),
  ]);
  const h = await harness(adapter);
  const invoked: string[] = [];
  const silent = createAgentDriver({
    events: h.events,
    blobs: h.blobs,
    router: testRouter(adapter),
    context: createLogContextBuilder(h.events, h.blobs, testRegistry()),
    tools: testRegistry(),
    gateway: {
      invoke: async (request) => {
        invoked.push(request.provider_call_id);
        return { toolCallId: request.tool_call_id, state: "succeeded", result: { status: "ok", text: "", truncated: false, redactions: 0 }, decision: undefined, approval: undefined };
      },
    },
    credentials: async () => testCredential(),
  });
  await assert.rejects(silent.runTurn(h.input(), new AbortController().signal), /left no record/);
  assert.deepEqual(invoked, ["toolu_a"]);
});

test("tool calls in a length-truncated message get synthetic error results and are not executed", async () => {
  const adapter = new ScriptedModelAdapter([
    lazy((request) => [
      { type: "start", request_id: request.request_id, route: request.route },
      { type: "done", stop_reason: "length", message: { role: "assistant", content: [{ type: "tool_call", provider_call_id: "toolu_cut", name: "exec", arguments: {} }] } },
    ]),
    lazy((request) => textTurn(request, "Retrying with less output.")),
  ]);
  const h = await harness(adapter);
  assert.equal((await h.driver.runTurn(h.input(), new AbortController().signal)).outcome, "completed");
  assert.equal(h.gateway.invocations.length, 0);
  const result = (adapter.requests[1] as ModelRequest).messages.at(-1)?.content[0];
  assert.ok(result?.type === "tool_result" && result.is_error && /length limit/.test(result.text));
});

test("a steer queued mid-turn is recorded at the next step boundary and keeps the turn going", async () => {
  let h: Harness | undefined;
  const adapter = new ScriptedModelAdapter([
    lazy((request) => {
      h?.driver.steer("Also update the changelog");
      return textTurn(request, "Fixed.");
    }),
    lazy((request) => textTurn(request, "Changelog updated.")),
  ]);
  h = await harness(adapter);
  const outcome = await h.driver.runTurn(h.input(), new AbortController().signal);
  assert.equal(outcome.outcome, "completed");
  assert.equal(outcome.steps, 2);
  const events = await h.log();
  assert.deepEqual(ofType(events, "steer/queued").map((event) => event.data.text), ["Also update the changelog"]);
  const secondRequest = adapter.requests[1] as ModelRequest;
  assert.ok(secondRequest.messages.some((message) => message.content.some((part) => part.type === "text" && part.text === "Also update the changelog")));
  assert.throws(() => h?.driver.steer("   "), RangeError);
});

test("the turn stops with max_steps when the model keeps calling tools", async () => {
  const loop = lazy((request) => toolTurn(request, [{ id: `toolu_${request.request_id}`, name: "read_file", arguments: { path: "a" } }]));
  const h = await harness(new ScriptedModelAdapter([loop, loop, loop]));
  const outcome = await h.driver.runTurn(h.input({ maxSteps: 2 }), new AbortController().signal);
  assert.equal(outcome.outcome, "max_steps");
  assert.equal(outcome.steps, 2);
  assert.equal(h.gateway.invocations.length, 2);
});

test("a provider error is recorded with usage, the step errors and the turn fails", async () => {
  const adapter = new ScriptedModelAdapter([
    lazy((request) => [
      { type: "start", request_id: request.request_id, route: request.route },
      { type: "usage", usage: { input_tokens: 100, source: "provider-reported" } },
      { type: "error", error: { code: "rate_limited", message: "429", retryable: true, retry_after_ms: 1000 } },
    ]),
  ]);
  const h = await harness(adapter);
  assert.equal((await h.driver.runTurn(h.input(), new AbortController().signal)).outcome, "failed");
  const events = await h.log();
  assert.equal(ofType(events, "model/response_failed")[0]?.data.error.code, "rate_limited");
  assert.equal(ofType(events, "provider/usage")[0]?.data.usage.input_tokens, 100);
  assert.equal(ofType(events, "step/ended")[0]?.data.state, "errored");
});

test("a malformed stream or a missing credential resolver fails the step without throwing", async () => {
  const malformed = new ScriptedModelAdapter([lazy(() => [{ type: "text_delta", index: -1, text: "x" } as unknown as ModelStreamEvent])]);
  const h1 = await harness(malformed);
  assert.equal((await h1.driver.runTurn(h1.input(), new AbortController().signal)).outcome, "failed");
  assert.equal(ofType(await h1.log(), "model/response_failed")[0]?.data.error.code, "protocol_mismatch");

  const unauthenticated = new ScriptedModelAdapter([lazy((request) => textTurn(request, "unreachable"))]);
  const h2 = await harness(unauthenticated);
  const plain = createAgentDriver({
    events: h2.events,
    blobs: h2.blobs,
    router: testRouter(unauthenticated),
    context: createLogContextBuilder(h2.events, h2.blobs, testRegistry()),
    tools: testRegistry(),
    gateway: h2.gateway,
  });
  assert.equal((await plain.runTurn(h2.input(), new AbortController().signal)).outcome, "failed");
  assert.equal(ofType(await h2.log(), "model/response_failed")[0]?.data.error.code, "unauthenticated");
  assert.equal(unauthenticated.requests.length, 0);
});

test("a user message above the inline limit is stored as a blob and resolved back", async () => {
  const h = await harness(new ScriptedModelAdapter([lazy((request) => textTurn(request, "Read it."))]));
  const long = "x".repeat(20_000);
  await h.driver.runTurn(h.input({ userMessage: long }), new AbortController().signal);
  const user = ofType(await h.log(), "message/recorded")[0] as SessionEventOf<"message/recorded">;
  assert.equal(user.data.message, undefined);
  assert.ok(user.data.blob !== undefined);
  assert.deepEqual(await loadRecordedMessage(user, h.blobs), { role: "user", content: [{ type: "text", text: long }] });
});

test("a turn aimed at another session is refused before anything is written", async () => {
  const h = await harness(new ScriptedModelAdapter([]));
  await assert.rejects(h.driver.runTurn(h.input({ sessionId: createId("session") }), new AbortController().signal), RangeError);
  assert.equal((await h.log()).length, 0);
});

test("agent-backend turns record the same events and bridge tool calls go through the gateway", async () => {
  const script: BackendScript = async function* (tools, request) {
    yield { type: "backend_init", backend_session_id: "backend-session", model_id: "test-backend" as never, auth_source: "subscription", tools: ["mcp__synorch__read_file"] };
    const result = await tools.call({ providerCallId: "toolu_bridge", name: "mcp__synorch__read_file", arguments: { path: "src/a.ts" } }, new AbortController().signal);
    yield { type: "text_delta", index: 0, text: result.text };
    yield {
      type: "done",
      stop_reason: "stop",
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", provider_call_id: "toolu_bridge", name: "read_file", arguments: { path: "src/a.ts" } },
          { type: "text", text: `read for ${request.requestId}` },
        ],
      },
    };
  };
  const adapter = new ScriptedBackendAdapter(script);
  const h = await harness(adapter);
  assert.equal((await h.driver.runTurn(h.input(), new AbortController().signal)).outcome, "completed");
  assert.deepEqual(h.gateway.invocations.map((call) => [call.provider_call_id, call.tool_name]), [["toolu_bridge", "read_file"]]);
  const events = await h.log();
  assert.equal(ofType(events, "model/request_prepared").length, 1);
  assert.equal(ofType(events, "model/response_settled").length, 1);
  const assistant = ofType(events, "message/recorded").find((event) => event.data.role === "assistant");
  const part = assistant?.data.message?.content[0];
  assert.ok(part?.type === "tool_call");
  assert.equal(part.tool_call_id, h.gateway.invocations[0]?.tool_call_id);
  assert.equal(adapter.sessions[0]?.closed, true);

  await h.driver.runTurn(h.input({ userMessage: "again" }), new AbortController().signal);
  assert.equal(adapter.sessions[1]?.resumed, "backend-1", "the next turn resumes the backend session");
});

test("a backend exposing its own tools is a protocol_mismatch and is interrupted", async () => {
  const adapter = new ScriptedBackendAdapter(async function* () {
    yield { type: "backend_init", backend_session_id: "b", model_id: "test-backend" as never, auth_source: "subscription", tools: ["mcp__synorch__read_file", "Bash"] };
    yield { type: "done", stop_reason: "stop", message: { role: "assistant", content: [] } };
  });
  const h = await harness(adapter);
  assert.equal((await h.driver.runTurn(h.input(), new AbortController().signal)).outcome, "failed");
  assert.equal(ofType(await h.log(), "model/response_failed")[0]?.data.error.code, "protocol_mismatch");
  assert.equal(adapter.sessions[0]?.interrupted, true);
  assert.equal(h.gateway.invocations.length, 0);
});

function rejectingStore(store: EventStore, reject: (draft: SessionEventDraft) => boolean): EventStore {
  return {
    sessionId: store.sessionId,
    get lastSeq() {
      return store.lastSeq;
    },
    append: (draft) => (reject(draft) ? Promise.reject(new StoreFailure("write_failed", `injected failure for ${draft.type}`)) : store.append(draft)),
    read: (fromSeq, toSeq) => store.read(fromSeq, toSeq),
    close: () => store.close(),
  };
}

function prefixStore(store: EventStore, lastSeq: number): EventStore {
  return {
    sessionId: store.sessionId,
    lastSeq,
    append: () => Promise.reject(new Error("read-only")),
    read: (fromSeq = 1, toSeq = Number.POSITIVE_INFINITY): AsyncIterable<EventReadItem> => store.read(fromSeq, Math.min(toSeq, lastSeq)),
    close: async () => undefined,
  };
}
