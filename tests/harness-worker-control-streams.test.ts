import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createId, deriveProjectId, type RenderEvent, type SessionEvent } from "../src/harness/contracts/index.ts";
import { createAgentDriver } from "../src/harness/core/index.ts";
import { createLogContextBuilder, lazy, newRunId, RecordingToolGateway, ScriptedModelAdapter, testCredential, testPolicy, testRegistry, testRoute, testRouter, textTurn, toolTurn } from "../src/harness/core/testing.ts";
import { OrchestrationTracker } from "../src/harness/cli/orchestration-view.ts";
import { WorkerStreamHub } from "../src/harness/orchestration/index.ts";
import { createBlobStore, createSessionStore } from "../src/harness/store/index.ts";

/** K1.7: the driver's per-worker pause and steer, and the worker stream hub (replay, live tail, retries). */

test("a paused driver finishes its step, starts no new one until resumed, and delivers a steer at the boundary", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "synorch-wc-"));
  const store = await createSessionStore(home).create({ session_id: createId("session"), project_id: deriveProjectId("/workspace", "linux"), workspace_root: "/workspace", created_at: "2026-09-24T10:00:00.000Z" });
  try {
    const blobs = createBlobStore(home);
    const registry = testRegistry();
    let driver: ReturnType<typeof createAgentDriver> | undefined;
    const adapter = new ScriptedModelAdapter([
      lazy((request) => {
        driver?.pause();
        driver?.steer("keep the heading unchanged");
        return toolTurn(request, [{ id: "toolu_a", name: "read_file", arguments: { path: "a.md" } }]);
      }),
      lazy((request) => textTurn(request, "Done.")),
    ]);
    driver = createAgentDriver({ events: store, blobs, router: testRouter(adapter), context: createLogContextBuilder(store, blobs, registry), tools: registry, gateway: new RecordingToolGateway(store), credentials: async () => testCredential() });
    const runId = newRunId();
    const turn = driver.runTurn(
      { sessionId: store.sessionId, runId, taskId: undefined, attemptId: undefined, role: "implementer", route: testRoute("model"), policy: testPolicy(runId), packet: undefined, userMessage: "Fix a", trigger: "dispatch", maxSteps: 5 },
      new AbortController().signal,
    );
    const events = async (): Promise<string[]> => {
      const out: string[] = [];
      for await (const item of store.read()) if (item.status === "ok") out.push(item.event.type);
      return out;
    };
    for (let index = 0; index < 2000 && !(await events()).includes("step/ended"); index += 1) await tick();
    await delay(150);
    assert.equal(adapter.requests.length, 1, "no second model step while paused");
    assert.equal(driver.paused, true);
    driver.resume();
    const outcome = await turn;
    assert.equal(outcome.outcome, "completed");
    assert.equal(adapter.requests.length, 2);
    const second = JSON.stringify(adapter.requests[1]?.messages);
    assert.ok(second.includes("keep the heading unchanged"), "the steer reached the next request");
  } finally {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

test("pause and resume toggle the driver's paused state", () => {
  const driver = createAgentDriver({} as never);
  driver.pause();
  assert.equal(driver.paused, true);
  driver.resume();
  assert.equal(driver.paused, false);
});

function event(sessionId: string, seq: number, type: string, data: Record<string, unknown>, ids: Record<string, string> = {}): RenderEvent {
  return { kind: "session-event", event: { schema_version: 1, event_id: createId("event"), session_id: sessionId, seq, event_version: 1, timestamp: new Date(seq * 1000).toISOString(), actor: { kind: "system" }, type, data, ...ids } as unknown as SessionEvent };
}

test("worker stream hub: assignment first, replays the current attempt, tails it live, re-sends the assignment on a steer, follows a retry", () => {
  const runLog = createId("session");
  const first = createId("session");
  const second = createId("session");
  const conversation = createId("session");
  const taskId = createId("task");
  const hub = new WorkerStreamHub((sessionId) => sessionId === conversation);
  let steering = 0;
  hub.assignments = (taskKey) => (taskKey === "edit-a" ? { taskKey, objective: "Do edit-a", owned_paths: [], acceptance_criteria: [], verification_commands: [], steering: Array.from({ length: steering }, () => ({ from: "user" as const, text: "hi" })) } : undefined);
  assert.deepEqual(hub.snapshot("unknown"), [], "an unknown key delivers nothing");
  hub.feed(event(runLog, 1, "task/created", { task_id: taskId, key: "edit-a" }, { task_id: taskId }));
  hub.feed(event(first, 1, "session/opened", {}));
  hub.feed(event(runLog, 2, "attempt/started", { task_id: taskId, attempt_id: createId("attempt"), session_id: first, role: "implementer" }, { task_id: taskId }));
  hub.feed(event(first, 2, "turn/started", { turn_id: createId("turn") }));
  hub.feed(event(conversation, 1, "turn/started", { turn_id: createId("turn") }));

  const seen: string[] = [];
  const stop = hub.subscribe("edit-a", (item) =>
    seen.push(
      item.kind === "assignment"
        ? `assignment:${item.assignment.steering.length}`
        : item.kind === "session-event"
          ? `${item.event.session_id === first ? "first" : item.event.session_id === second ? "second" : "run"}:${item.event.type}`
          : item.kind === "stream"
            ? `stream:${item.event.type}`
            : `notice:${item.message}`,
    ),
  );
  assert.deepEqual(seen, ["assignment:0", "first:session/opened", "first:turn/started"], "assignment, then history, synchronously");

  const requestId = createId("request");
  hub.feed(event(first, 3, "model/request_prepared", { request_id: requestId }));
  hub.feed({ kind: "stream", requestId, event: { type: "text_delta", text: "hi" } as never });
  steering = 1;
  hub.feed(event(runLog, 3, "task/user_message", { task_id: taskId, text: "hi" }, { task_id: taskId }));
  hub.feed(event(runLog, 4, "attempt/started", { task_id: taskId, attempt_id: createId("attempt"), session_id: second, role: "implementer" }, { task_id: taskId }));
  hub.feed(event(first, 4, "turn/ended", {}));
  hub.feed(event(second, 1, "turn/started", {}));
  stop();
  hub.feed(event(second, 2, "turn/ended", {}));
  assert.deepEqual(seen, [
    "assignment:0",
    "first:session/opened",
    "first:turn/started",
    "first:model/request_prepared",
    "stream:text_delta",
    "run:task/user_message",
    "assignment:1",
    "notice:edit-a: attempt 2 (implementer) started",
    "assignment:1",
    "second:turn/started",
  ]);
  assert.equal(hub.recent("edit-a", 10).length, 2, "recent events come from the current attempt only");
  assert.equal(hub.taskIdOf("edit-a"), taskId);
});

test("the board marks a paused worker until it is resumed", () => {
  const tracker = new OrchestrationTracker("goal", "why");
  const runSession = createId("session");
  const runId = createId("run");
  const taskId = createId("task");
  const attemptId = createId("attempt");
  let seq = 0;
  const recorded = (type: string, data: unknown): SessionEvent =>
    ({ type, data, session_id: runSession, run_id: runId, seq: (seq += 1), event_version: 1, actor: { kind: "user" }, timestamp: new Date().toISOString() }) as unknown as SessionEvent;
  tracker.observe(recorded("run/created", { goal: "goal", policy_mode: "autonomous", headless: true, budget: {} }));
  tracker.observe(recorded("task/created", { task_id: taskId, plan_id: "plan_x", key: "edit-a", role: "implementer", depends_on: [], owned_paths: ["a.md"], risk: "trivial" }));
  tracker.observe(recorded("attempt/started", { attempt_id: attemptId, task_id: taskId, role: "implementer", route: { model_id: "luna" }, session_id: createId("session") }));
  assert.equal(tracker.view().tasks[0]?.paused, undefined);
  assert.equal(tracker.observe(recorded("attempt/user_control", { attempt_id: attemptId, task_id: taskId, action: "pause" })), true);
  assert.equal(tracker.view().tasks[0]?.paused, true);
  tracker.observe(recorded("attempt/user_control", { attempt_id: attemptId, task_id: taskId, action: "resume" }));
  assert.equal(tracker.view().tasks[0]?.paused, undefined);
});
