import assert from "node:assert/strict";
import { test } from "node:test";
import { createContextBuilder } from "../src/harness/context/index.ts";
import { createId, HarnessError, type SessionEvent, type Usage } from "../src/harness/contracts/index.ts";
import {
  createBudgetGateSlot,
  createBudgetTracker,
  isHumanBudgetGrant,
  requestBudgetIncrease,
  type BudgetExceeded,
  type BudgetLimits,
} from "../src/harness/orchestration/index.ts";
import {
  createFakePolicyEngine,
  createHeadlessBroker,
  createMemoryBlobStore,
  createMemorySessionStore,
  createScriptedBroker,
  createScriptedPlanner,
  createStaticToolRegistry,
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  testPlan,
  testRoute,
  workerClaim,
} from "../src/harness/orchestration/testing.ts";

const NONE: BudgetLimits = { maxCostUsd: undefined, maxWallTimeSeconds: undefined, maxSteps: undefined, maxToolCalls: undefined };
const usage = (cost: number): Usage => ({ cost_usd_estimate: cost, source: "provider-reported" });

test("AC-6 at the limit no new request is admitted and budget/exceeded says stop-new-requests", () => {
  const exceeded: BudgetExceeded[] = [];
  const tracker = createBudgetTracker({ scope: "run", limits: { ...NONE, maxSteps: 2 }, onExceeded: (event) => exceeded.push(event) });
  assert.equal(tracker.admit().ok, true);
  assert.equal(tracker.admit().ok, true);
  const third = tracker.admit();
  assert.equal(third.ok, false);
  assert.equal(tracker.usage().steps, 2, "a refused admission does not count a step");
  assert.deepEqual(exceeded.map((event) => [event.metric, event.action]), [["steps", "stop-new-requests"]]);
});

test("AC-6 cost at the limit stops new requests but only 120% cancels the active one", () => {
  const exceeded: BudgetExceeded[] = [];
  const cancelled: BudgetExceeded[] = [];
  const tracker = createBudgetTracker({ scope: "run", limits: { ...NONE, maxCostUsd: 1 }, onExceeded: (event) => exceeded.push(event) });
  tracker.onCancel((event) => cancelled.push(event));
  const session = createId("session");
  tracker.observe([{ sessionId: session, seq: 1, usage: usage(1.05) }]);
  assert.equal(tracker.admit().ok, false);
  assert.equal(cancelled.length, 0);
  tracker.observe([{ sessionId: session, seq: 1, usage: usage(1.05) }]);
  assert.equal(tracker.usage().costUsd, 1.05, "observations are de-duplicated by session and seq");
  tracker.observe([{ sessionId: session, seq: 2, usage: usage(0.2) }]);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]?.action, "cancel-active");
  assert.ok(exceeded.some((event) => event.action === "cancel-active" && event.metric === "cost_usd"));
});

test("AC-6 reaching the wall-time limit cancels the active request", () => {
  let clock = 0;
  const cancelled: BudgetExceeded[] = [];
  const tracker = createBudgetTracker({ scope: "run", limits: { ...NONE, maxWallTimeSeconds: 10 }, now: () => clock });
  tracker.onCancel((event) => cancelled.push(event));
  clock = 9_000;
  tracker.check();
  assert.equal(cancelled.length, 0);
  clock = 10_000;
  tracker.check();
  assert.deepEqual(cancelled.map((event) => [event.metric, event.action]), [["wall_time_seconds", "cancel-active"]]);
});

test("AC-6 a budget increase needs a human: orchestrator, broker and headless answers never raise it", async () => {
  const runId = createId("run");
  const raise: BudgetLimits = { ...NONE, maxCostUsd: 50 };
  const attempt = async (decide: Parameters<typeof createScriptedBroker>[0]) => {
    const tracker = createBudgetTracker({ scope: "run", limits: { ...NONE, maxCostUsd: 5 } });
    const outcome = await requestBudgetIncrease({ tracker, broker: createScriptedBroker(decide), runId, mode: "autonomous", limits: raise, now: () => new Date() }, new AbortController().signal);
    return { outcome, limit: tracker.limits().maxCostUsd };
  };
  const byOrchestrator = await attempt(() => ({ outcome: "allowed-once", decided_by: "orchestrator", mode: "autonomous" }));
  assert.equal(byOrchestrator.outcome.granted, false);
  assert.equal(byOrchestrator.limit, 5);
  const byConfig = await attempt(() => ({ outcome: "allowed-once", decided_by: "config", mode: "autonomous" }));
  assert.equal(byConfig.outcome.granted, false);
  const rejected = await attempt(() => ({ outcome: "rejected", decided_by: "user", mode: "autonomous" }));
  assert.equal(rejected.outcome.granted, false);
  const otherSubject = await attempt(() => ({ outcome: "allowed-once", decided_by: "user", mode: "autonomous", subject_digest: createId("run") as never }));
  assert.equal(otherSubject.outcome.granted, false);
  const tracker = createBudgetTracker({ scope: "run", limits: { ...NONE, maxCostUsd: 5 } });
  const headless = await requestBudgetIncrease({ tracker, broker: createHeadlessBroker(), runId, mode: "autonomous", limits: raise, now: () => new Date() }, new AbortController().signal);
  assert.equal(headless.granted, false);
  assert.equal(tracker.limits().maxCostUsd, 5);
  const byUser = await attempt(() => ({ outcome: "allowed-once", decided_by: "user", mode: "autonomous" }));
  assert.equal(byUser.outcome.granted, true);
  assert.equal(byUser.limit, 50);
  assert.equal(isHumanBudgetGrant({ ...byUser.outcome.decision!, decided_by: "orchestrator" }, byUser.outcome.request.subject_digest), false);
});

test("AC-6 the context builder refuses to prepare a request once the budget is exhausted", async () => {
  const sessions = createMemorySessionStore();
  const blobs = createMemoryBlobStore();
  const sessionId = createId("session");
  const store = await sessions.create({ session_id: sessionId, project_id: "p-12345678" as never, workspace_root: "/w", created_at: new Date().toISOString() });
  const requestId = createId("request");
  await store.append({ type: "provider/usage", event_version: 1, actor: { kind: "provider" }, data: { request_id: requestId, usage: usage(2) } } as never);
  const gate = createBudgetGateSlot();
  gate.set(createBudgetTracker({ scope: "run", limits: { ...NONE, maxCostUsd: 1 } }));
  const builder = createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(), budget: gate });
  const policy = createFakePolicyEngine().compute({
    mode: "autonomous",
    role: "explorer",
    runId: createId("run"),
    taskId: undefined,
    workspaceRoot: "/w",
    taskScope: undefined,
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: { backend: "b", platform: "other", enforcement: "full", filesystem: "full", network: "full", process: "full", notes: [] },
    grants: [],
  });
  await assert.rejects(
    builder.build({ sessionId, runId: policy.run_id, taskId: undefined, role: "explorer", route: testRoute("openai", "m"), policy, packet: undefined, requestId: createId("request") }, new AbortController().signal),
    (error: unknown) => error instanceof HarnessError && error.info.code === "budget_exceeded" && error.exitCode === 9,
  );
});

test("AC-6 crossing 120% of the cost budget cancels the running attempt", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/a.md"], risk: "trivial" }]));
    let abortedDuringTurn = false;
    const runtime = createTestRuntime({
      workspace,
      planner,
      limits: { maxRetries: 0 },
      script: async (context) => {
        runtime.budgetGate.current()?.observe([{ sessionId: context.input.sessionId, seq: 1, usage: usage(1.3) }]);
        abortedDuringTurn = context.signal.aborted;
        return "cancelled";
      },
    });
    const outcome = await runtime.run("g", { maxWallTimeSeconds: undefined, maxCostUsd: 1 });
    assert.equal(abortedDuringTurn, true);
    assert.equal(outcome.exitCode, 9, outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.ok(events.some((event) => event.type === "budget/exceeded" && event.data.action === "cancel-active"));
    assert.ok(events.some((event) => event.type === "attempt/state_changed" && event.data.to === "cancelled"));
  } finally {
    await workspace.cleanup();
  }
});

test("AC-6 an exhausted run budget stops new work: remaining tasks are cancelled and the run exits 9", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n", "docs/b.md": "b\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) =>
      testPlan(
        input,
        [
          { key: "first", owned_paths: ["docs/a.md"], risk: "trivial" },
          { key: "second", owned_paths: ["docs/b.md"], risk: "trivial", depends_on: ["first"] },
        ],
        { budget: { max_wall_time_seconds: 600, max_steps: 1 } },
      ),
    );
    const runtime = createTestRuntime({
      workspace,
      planner,
      context: ({ sessions, blobs, budgetGate }) => createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(), budget: budgetGate }),
      script: async (context) => {
        await context.write(context.input.packet?.scope.owned_paths[0] ?? "docs/x.md", "changed\n");
        const call = await context.toolCall("exec", { exitCode: 0 });
        await context.reply(workerClaim(context, call));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.exitCode, 9, outcome.summary);
    const events: readonly SessionEvent[] = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.ok(events.some((event) => event.type === "budget/exceeded" && event.data.action === "stop-new-requests"));
    assert.equal(runtime.driver.turns.length, 1, "no worker turn starts after the budget is exhausted");
    const second = events.filter((event) => event.type === "task/state_changed" && event.data.to === "cancelled");
    assert.equal(second.length, 1);
  } finally {
    await workspace.cleanup();
  }
});
