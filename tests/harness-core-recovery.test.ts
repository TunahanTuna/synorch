import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createId,
  deriveProjectId,
  digestText,
  StoreFailure,
  type EventStore,
  type SessionEvent,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionEventType,
  type SessionId,
} from "../src/harness/contracts/index.ts";
import { createAgentDriver, projectSession, recoverSession } from "../src/harness/core/index.ts";
import {
  createLogContextBuilder,
  lazy,
  newRunId,
  RecordingToolGateway,
  ScriptedModelAdapter,
  testCredential,
  testPolicy,
  testRegistry,
  testRoute,
  testRouter,
  textTurn,
  toolTurn,
} from "../src/harness/core/testing.ts";
import { createBlobStore, createSessionStore } from "../src/harness/store/index.ts";

const homes: string[] = [];
const open: EventStore[] = [];
const PROJECT = deriveProjectId("/workspace", "linux");
const RUN = createId("run");
const TURN = createId("turn");
const STEP = createId("step");
const REQUEST = createId("request");
const EXECUTING = createId("toolCall");
const PROPOSED = createId("toolCall");
const APPROVAL = createId("approval");
const TASK = createId("task");
const DIGEST = digestText("x");

after(async () => {
  await Promise.all(open.map((store) => store.close().catch(() => undefined)));
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

async function newHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "synorch-recovery-"));
  homes.push(home);
  return home;
}

function manifest(sessionId: SessionId) {
  return { session_id: sessionId, project_id: PROJECT, workspace_root: "/workspace", created_at: "2026-09-22T10:00:00.000Z" };
}

function event(type: string, data: unknown): SessionEventDraft {
  return { type, event_version: 1, actor: { kind: "system" }, run_id: RUN, data } as SessionEventDraft;
}

async function readEvents(store: { read(): AsyncIterable<import("../src/harness/contracts/index.ts").EventReadItem> }): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const item of store.read()) if (item.status === "ok") out.push(item.event);
  return out;
}

function ofType<T extends SessionEventType>(events: readonly SessionEvent[], type: T): SessionEventOf<T>[] {
  return events.filter((item): item is SessionEventOf<T> => item.type === type);
}

const CRASHED_LOG: SessionEventDraft[] = [
  event("session/opened", {
    writer: { name: "synorch", version: "0.4.0" },
    project_id: PROJECT,
    workspace_root: "/workspace",
    cwd: "/workspace",
    platform: "linux",
    git: null,
    policy_mode: "ask",
  }),
  event("run/created", { goal: "Fix it", policy_mode: "ask", headless: false, budget: {} }),
  event("run/state_changed", { from: "created", to: "running", reason: "start" }),
  event("task/created", { task_id: TASK, plan_id: createId("plan"), key: "fix", role: "implementer", depends_on: [], owned_paths: ["src/**"], risk: "standard" }),
  event("task/state_changed", { task_id: TASK, from: "draft", to: "ready", reason: "approved" }),
  event("task/state_changed", { task_id: TASK, from: "ready", to: "running", reason: "dispatched" }),
  event("turn/started", { turn_id: TURN, trigger: "user" }),
  event("step/started", { step_id: STEP, turn_id: TURN, request_id: REQUEST }),
  event("tool/call_proposed", { tool_call_id: EXECUTING, provider_call_id: "toolu_exec", tool_name: "exec", args_digest: DIGEST }),
  event("tool/execution_started", { tool_call_id: EXECUTING, sandbox_enforcement: "partial" }),
  event("tool/call_proposed", { tool_call_id: PROPOSED, provider_call_id: "toolu_next", tool_name: "read_file", args_digest: DIGEST }),
  event("approval/requested", {
    request: { approval_id: APPROVAL, run_id: RUN, subject_kind: "action", subject_digest: DIGEST, summary: "push", scope: "once", requested_at: "2026-09-22T10:00:00Z" },
  }),
];

test("AC-4 a call that crashed after tool/execution_started becomes tool/interrupted{unknown} and every open entity is closed", async () => {
  const home = await newHome();
  const sessionId = createId("session");
  const crashed = await createSessionStore(home).create(manifest(sessionId));
  for (const draft of CRASHED_LOG) await crashed.append(draft);
  await crashed.close();

  const writer = await createSessionStore(home).openForWrite(sessionId);
  open.push(writer);
  const report = await recoverSession(writer, { clock: () => new Date("2026-09-22T11:00:00.000Z") });
  assert.equal(report.previousLastSeq, CRASHED_LOG.length);
  assert.equal(report.resumedSeq, CRASHED_LOG.length + 1);
  assert.deepEqual(report.interruptedToolCalls, [EXECUTING]);
  assert.deepEqual(report.cancelledToolCalls, [PROPOSED]);
  assert.deepEqual(
    report.recovered.map((entry) => [entry.machine, entry.from, entry.to]),
    [
      ["toolCall", "executing", "interrupted"],
      ["toolCall", "proposed", "cancelled"],
      ["approval", "pending", "cancelled"],
      ["step", "open", "aborted"],
      ["task", "running", "interrupted"],
      ["run", "running", "interrupted"],
    ],
  );

  const events = await readEvents(writer);
  const tail = events.slice(CRASHED_LOG.length);
  assert.equal(tail[0]?.type, "session/resumed");
  assert.ok(tail.slice(1).every((item) => item.causation_seq === report.resumedSeq));
  const interrupted = ofType(tail, "tool/interrupted");
  assert.deepEqual(interrupted.map((item) => item.data), [{ tool_call_id: EXECUTING, outcome: "unknown", idempotent: false }]);
  assert.equal(ofType(tail, "tool/result_recorded")[0]?.data.state, "cancelled");
  const decided = ofType(tail, "approval/decided")[0]?.data.decision;
  assert.deepEqual([decided?.outcome, decided?.decided_by, decided?.mode, decided?.decided_at], ["cancelled", "broker", "ask", "2026-09-22T11:00:00.000Z"]);
  assert.equal(ofType(tail, "turn/ended")[0]?.data.outcome, "failed");

  const projection = projectSession(events);
  assert.equal(projection.status, "ok", JSON.stringify(projection.issues));
  assert.equal(projection.toolCalls.get(EXECUTING)?.state, "interrupted");
  assert.equal(projection.approvals.get(APPROVAL)?.state, "cancelled");
  assert.equal(projection.runs.get(RUN)?.state, "interrupted");

  const again = await recoverSession(writer);
  assert.deepEqual(again.recovered, [], "a second recovery finds nothing left open");
});

test("AC-4 the idempotent flag comes from tool metadata and defaults to false", async () => {
  const home = await newHome();
  const sessionId = createId("session");
  const writer = await createSessionStore(home).create(manifest(sessionId));
  open.push(writer);
  for (const draft of CRASHED_LOG.slice(0, 10)) await writer.append(draft);
  await recoverSession(writer, { isIdempotent: (name) => name === "exec" });
  const interrupted = ofType(await readEvents(writer), "tool/interrupted");
  assert.equal(interrupted[0]?.data.idempotent, true);
});

test("AC-4 a driver crash mid-tool is recovered on resume and the call is never re-executed", async () => {
  const home = await newHome();
  const sessionId = createId("session");
  let now = Date.parse("2026-09-22T10:00:00.000Z");
  const clock = (): Date => new Date(now);
  const runId = newRunId();
  const registry = testRegistry();

  const first = await createSessionStore(home, { clock }).create(manifest(sessionId));
  open.push(first);
  const blobs = createBlobStore(home);
  let entered: () => void = () => undefined;
  const reachedTool = new Promise<void>((resolve) => (entered = resolve));
  const crashingGateway = new RecordingToolGateway(first, () => {
    entered();
    return new Promise(() => undefined);
  });
  const crashingDriver = createAgentDriver({
    events: first,
    blobs,
    router: testRouter(new ScriptedModelAdapter([lazy((request) => toolTurn(request, [{ id: "toolu_push", name: "exec", arguments: { argv: ["git", "push"] } }]))])),
    context: createLogContextBuilder(first, blobs, registry),
    tools: registry,
    gateway: crashingGateway,
    credentials: async () => testCredential(),
  });
  const input = {
    sessionId,
    runId,
    taskId: undefined,
    attemptId: undefined,
    role: "implementer" as const,
    route: testRoute(),
    policy: testPolicy(runId),
    packet: undefined,
    userMessage: "Push the branch",
    trigger: "user" as const,
    maxSteps: 4,
  };
  void crashingDriver.runTurn(input, new AbortController().signal);
  await reachedTool;
  assert.equal(crashingGateway.invocations.length, 1);

  now += 31_000;
  const resumed = await createSessionStore(home, { clock }).openForWrite(sessionId);
  open.push(resumed);
  const report = await recoverSession(resumed);
  const pushCall = crashingGateway.invocations[0]?.tool_call_id;
  assert.deepEqual(report.interruptedToolCalls, [pushCall]);
  assert.ok(report.recovered.some((entry) => entry.machine === "step" && entry.to === "aborted"));

  const adapter = new ScriptedModelAdapter([lazy((request) => textTurn(request, "The push outcome is unknown; please check the remote."))]);
  const resumedGateway = new RecordingToolGateway(resumed);
  const driver = createAgentDriver({
    events: resumed,
    blobs,
    router: testRouter(adapter),
    context: createLogContextBuilder(resumed, blobs, registry),
    tools: registry,
    gateway: resumedGateway,
    credentials: async () => testCredential(),
  });
  const outcome = await driver.runTurn({ ...input, userMessage: "Continue" }, new AbortController().signal);
  assert.equal(outcome.outcome, "completed");
  assert.equal(resumedGateway.invocations.length, 0, "the interrupted call is not repeated");
  assert.equal(crashingGateway.invocations.length, 1);
  const events = await readEvents(resumed);
  assert.equal(ofType(events, "tool/call_proposed").length, 1);
  assert.equal(projectSession(events).status, "ok");
});

test("AC-4 recovery reports the torn tail the writer quarantined", async () => {
  const home = await newHome();
  const sessionId = createId("session");
  const crashed = await createSessionStore(home).create(manifest(sessionId));
  for (const draft of CRASHED_LOG.slice(0, 3)) await crashed.append(draft);
  await crashed.close();
  const segmentsDir = path.join(home, "sessions", PROJECT, sessionId, "segments");
  const torn = '{"schema_version":1,"event_id":"evt_';
  await appendFile(path.join(segmentsDir, "000001.jsonl"), torn);

  const writer = await createSessionStore(home).openForWrite(sessionId);
  open.push(writer);
  const report = await recoverSession(writer);
  assert.equal(report.tornTail?.segment, 1);
  assert.equal(report.tornTail?.bytes, Buffer.byteLength(torn));
  assert.ok((await readdir(segmentsDir)).includes("000001.jsonl.torn-1"));
  let resumed: SessionEvent | undefined;
  for await (const item of writer.read()) if (item.status === "ok" && item.event.type === "session/resumed") resumed = item.event;
  assert.equal(resumed?.event_version, 2);
  assert.deepEqual(resumed?.type === "session/resumed" ? resumed.data.torn_tail : undefined, { segment: 1, bytes: Buffer.byteLength(torn) });
});

test("recovery refuses a corrupt or newer-version log instead of guessing", async () => {
  const home = await newHome();
  const sessionId = createId("session");
  const writer = await createSessionStore(home).create(manifest(sessionId));
  open.push(writer);
  await writer.append(event("run/created", { goal: "g", policy_mode: "ask", headless: false, budget: {} }));
  await writer.append(event("run/state_changed", { from: "created", to: "completed", reason: "illegal" }));
  await assert.rejects(recoverSession(writer), (error: unknown) => error instanceof StoreFailure && error.code === "session_corrupt");
  assert.equal(writer.lastSeq, 2, "nothing was appended");

  const unsupported: EventStore = {
    sessionId,
    lastSeq: 1,
    append: () => Promise.reject(new Error("must not append")),
    read: async function* () {
      yield { status: "unsupported" as const, type: "worker/heartbeat", event_version: 1 };
    },
    close: async () => undefined,
  };
  await assert.rejects(recoverSession(unsupported), (error: unknown) => error instanceof StoreFailure && error.code === "unsupported_version");
});
