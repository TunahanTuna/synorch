import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createId,
  digestText,
  parseSessionEvent,
  type SessionEvent,
  type SessionEventDraft,
} from "../src/harness/contracts/index.ts";
import { projectSession } from "../src/harness/core/index.ts";
import { testRoute } from "../src/harness/core/testing.ts";

const SESSION = createId("session");
const RUN = createId("run");
const PLAN = createId("plan");
const TASK = createId("task");
const ATTEMPT = createId("attempt");
const TURN = createId("turn");
const STEP = createId("step");
const REQUEST = createId("request");
const CALL = createId("toolCall");
const APPROVAL = createId("approval");
const DIGEST = digestText("subject");

function log(drafts: readonly SessionEventDraft[], firstSeq = 1): SessionEvent[] {
  return drafts.map((draft, index) => {
    const parsed = parseSessionEvent({
      schema_version: 1,
      event_id: createId("event"),
      session_id: SESSION,
      seq: firstSeq + index,
      timestamp: `2026-09-22T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
      ...draft,
    });
    assert.equal(parsed.status, "ok", JSON.stringify(parsed));
    return (parsed as { event: SessionEvent }).event;
  });
}

function event(type: string, data: unknown, extra: Record<string, unknown> = {}): SessionEventDraft {
  return { type, event_version: 1, actor: { kind: "system" }, run_id: RUN, ...extra, data } as SessionEventDraft;
}

const RUN_START = [
  event("run/created", { goal: "Fix the bug", policy_mode: "autonomous", headless: false, budget: {} }),
  event("run/state_changed", { from: "created", to: "running", reason: "planning" }),
];
const TASK_START = [
  event("task/created", { task_id: TASK, plan_id: PLAN, key: "fix", role: "implementer", depends_on: [], owned_paths: ["src/**"], risk: "standard" }),
  event("task/state_changed", { task_id: TASK, from: "draft", to: "ready", reason: "plan approved" }),
  event("task/state_changed", { task_id: TASK, from: "ready", to: "running", reason: "dispatched" }),
  event("attempt/started", {
    attempt_id: ATTEMPT,
    task_id: TASK,
    role: "implementer",
    route: testRoute(),
    packet_digest: DIGEST,
    isolation: { mode: "scoped-dir" },
  }),
];
const TOOL_ROUND = [
  event("turn/started", { turn_id: TURN, trigger: "dispatch" }),
  event("step/started", { step_id: STEP, turn_id: TURN, request_id: REQUEST }),
  event("message/recorded", {
    role: "assistant",
    request_id: REQUEST,
    message: { role: "assistant", content: [{ type: "tool_call", provider_call_id: "toolu_1", tool_call_id: CALL, name: "read_file", arguments: { path: "src/a.ts" } }] },
  }),
  event("tool/call_proposed", { tool_call_id: CALL, provider_call_id: "toolu_1", tool_name: "read_file", args_digest: DIGEST }),
  event("tool/execution_started", { tool_call_id: CALL, sandbox_enforcement: "partial" }),
];

test("projection replays legal transitions of every machine", () => {
  const projection = projectSession(
    log([
      ...RUN_START,
      ...TASK_START,
      ...TOOL_ROUND,
      event("tool/result_recorded", { tool_call_id: CALL, state: "succeeded", duration_ms: 3, result: { status: "ok", text: "file", truncated: false, redactions: 0 } }),
      event("step/ended", { step_id: STEP, state: "settled" }),
      event("turn/ended", { turn_id: TURN, outcome: "completed" }),
      event("attempt/state_changed", { attempt_id: ATTEMPT, from: "running", to: "succeeded", reason: "completion recorded" }),
      event("task/state_changed", { task_id: TASK, from: "running", to: "verifying", reason: "completed" }),
    ]),
  );
  assert.equal(projection.status, "ok");
  assert.equal(projection.writable, true);
  assert.deepEqual(projection.issues, []);
  assert.equal(projection.runs.get(RUN)?.state, "running");
  assert.equal(projection.runs.get(RUN)?.goal, "Fix the bug");
  assert.equal(projection.tasks.get(TASK)?.state, "verifying");
  assert.equal(projection.attempts.get(ATTEMPT)?.state, "succeeded");
  assert.equal(projection.toolCalls.get(CALL)?.state, "succeeded");
  assert.equal(projection.toolCalls.get(CALL)?.toolName, "read_file");
  assert.equal(projection.steps.get(STEP)?.state, "settled");
  assert.equal(projection.turns.get(TURN)?.open, false);
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.lastSeq, projection.appliedSeq);
});

test("an illegal transition (review skipped) is corrupt and the projection stops there", () => {
  const events = log([...RUN_START, ...TASK_START, event("task/state_changed", { task_id: TASK, from: "running", to: "completed", reason: "skip review" }), event("steer/queued", { text: "later" })]);
  const projection = projectSession(events);
  assert.equal(projection.status, "corrupt");
  assert.equal(projection.writable, false);
  assert.equal(projection.issues[0]?.code, "illegal-transition");
  assert.equal(projection.tasks.get(TASK)?.state, "running");
  assert.equal(projection.appliedSeq, events.length - 2);
  assert.equal(projection.lastSeq, events.length);
});

test("a transition whose from disagrees with the current state is corrupt", () => {
  const projection = projectSession(log([...RUN_START, event("run/state_changed", { from: "created", to: "running", reason: "again" })]));
  assert.equal(projection.status, "corrupt");
  assert.equal(projection.issues[0]?.code, "state-mismatch");
});

test("a tool result without execution_started is an illegal proposed -> succeeded transition", () => {
  const projection = projectSession(
    log([
      ...RUN_START,
      event("turn/started", { turn_id: TURN, trigger: "user" }),
      event("tool/call_proposed", { tool_call_id: CALL, provider_call_id: "toolu_1", tool_name: "exec", args_digest: DIGEST }),
      event("tool/result_recorded", { tool_call_id: CALL, state: "succeeded", duration_ms: 1, result: { status: "ok", text: "", truncated: false, redactions: 0 } }),
    ]),
  );
  assert.equal(projection.status, "corrupt");
  assert.equal(projection.issues[0]?.code, "illegal-transition");
});

test("events about unknown entities and duplicate creations are corrupt", () => {
  assert.equal(projectSession(log([event("step/ended", { step_id: STEP, state: "settled" })])).issues[0]?.code, "unknown-entity");
  assert.equal(projectSession(log([event("tool/interrupted", { tool_call_id: CALL, outcome: "unknown", idempotent: false })])).issues[0]?.code, "unknown-entity");
  assert.equal(projectSession(log([...RUN_START, RUN_START[0] as SessionEventDraft])).issues[0]?.code, "duplicate-entity");
  assert.equal(projectSession(log([event("step/started", { step_id: STEP, turn_id: TURN, request_id: REQUEST })])).issues[0]?.code, "unknown-entity");
});

test("a seq gap between events is corrupt", () => {
  const events = [...log([RUN_START[0] as SessionEventDraft]), ...log([RUN_START[1] as SessionEventDraft], 3)];
  const projection = projectSession(events);
  assert.equal(projection.status, "corrupt");
  assert.equal(projection.issues[0]?.code, "seq-gap");
  assert.match(projection.issues[0]?.message ?? "", /expected seq 2, found 3/);
});

test("an invalid read item is corrupt and a torn tail alone keeps the session writable", () => {
  const events = log(RUN_START);
  const invalid = projectSession([{ status: "ok", event: events[0] as SessionEvent }, { status: "invalid", issues: [{ path: ["data"], message: "broken" }] }]);
  assert.equal(invalid.status, "corrupt");
  assert.equal(invalid.issues[0]?.code, "invalid-event");
  const torn = projectSession([...events.map((item) => ({ status: "ok" as const, event: item })), { status: "torn-tail", segment: 1, bytes: 12 }]);
  assert.equal(torn.status, "ok");
  assert.equal(torn.writable, true);
  assert.deepEqual(torn.tornTail, { segment: 1, bytes: 12 });
});

test("policy ask moves a call to awaiting_approval and approval outcomes map onto the approval machine", () => {
  const action = {
    tool_name: "exec",
    tool_version: "1.0.0",
    effect: "exec",
    role: "implementer",
    args_digest: DIGEST,
    paths: [],
    command: { argv: ["pnpm", "test"], cwd: "." },
    network_hosts: [],
    destructive: false,
  };
  const projection = projectSession(
    log([
      ...RUN_START,
      event("tool/call_proposed", { tool_call_id: CALL, provider_call_id: "toolu_1", tool_name: "exec", args_digest: DIGEST }),
      event("tool/policy_decided", {
        tool_call_id: CALL,
        action,
        decision: { decision: "ask", action_digest: DIGEST, policy_digest: DIGEST, reasons: [{ code: "ask-mode", layer: "approval", message: "ask" }] },
      }),
      event("approval/requested", {
        request: { approval_id: APPROVAL, run_id: RUN, subject_kind: "action", subject_digest: DIGEST, summary: "run tests", scope: "once", requested_at: "2026-09-22T10:00:00Z" },
      }),
      event("approval/decided", {
        decision: { approval_id: APPROVAL, subject_kind: "action", subject_digest: DIGEST, outcome: "allowed-once", decided_by: "user", mode: "ask", decided_at: "2026-09-22T10:00:01Z" },
      }),
      event("tool/execution_started", { tool_call_id: CALL, sandbox_enforcement: "partial" }),
    ]),
  );
  assert.equal(projection.status, "ok", JSON.stringify(projection.issues));
  assert.equal(projection.approvals.get(APPROVAL)?.state, "allowed");
  assert.equal(projection.toolCalls.get(CALL)?.state, "executing");
});
