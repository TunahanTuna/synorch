import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createId, type SessionEvent, type ToolExecutionContext } from "../src/harness/contracts/index.ts";
import { createDelegationSlot, delegationCallbacks, type DelegationResult, type Planner } from "../src/harness/orchestration/index.ts";
import {
  createScriptedBroker,
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  testPlan,
  workerClaim,
  type TestRuntime,
} from "../src/harness/orchestration/testing.ts";

/**
 * Orchestrator delegation and mid-run steering: `task_spawn`/`task_status` reach the active run's
 * DAG with ownership and budget checks, steering is applied at a safe boundary (before the next
 * dispatch), and the plan is re-versioned and re-approved under the run's policy mode.
 */

function ofType<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

function planTask(key: string, owned: string, dependsOn: readonly string[]): Record<string, unknown> {
  return {
    key,
    role: "implementer",
    objective: `Do ${key}`,
    depends_on: dependsOn,
    owned_paths: [owned],
    read_paths: [],
    risk: "trivial",
    model_tier: "complex_worker",
    acceptance_criteria: [{ id: "AC-1", statement: `${key} is done` }],
    verification: [],
  };
}

function toolContext(role: ToolExecutionContext["role"], runId = createId("run")): ToolExecutionContext {
  return { toolCallId: createId("toolCall"), runId, role } as unknown as ToolExecutionContext;
}

test("task_spawn and task_status refuse callers outside the active run's orchestrator", async () => {
  const slot = createDelegationSlot();
  const callbacks = delegationCallbacks(slot);
  const idle = await callbacks.taskStatus({}, toolContext("orchestrator"));
  assert.equal(idle.error?.code, "execution_failed", "no approved plan is active");
  const worker = await callbacks.taskSpawn({ packet: {} }, toolContext("implementer"));
  assert.equal(worker.error?.code, "policy_denied", "only the orchestrator delegates");
  const runId = createId("run");
  slot.set({ runId, spawn: () => ({ ok: true, text: "spawned" }), status: () => ({ ok: true, text: "status" }) });
  assert.equal((await callbacks.taskStatus({}, toolContext("orchestrator", createId("run")))).error?.code, "execution_failed", "another run's orchestrator is refused");
  assert.equal((await callbacks.taskSpawn({ packet: {} }, toolContext("orchestrator", runId))).text, "spawned");
});

function steeringRuntime(workspace: Awaited<ReturnType<typeof createTempWorkspace>>, options: { readonly mode?: "autonomous" | "ask"; readonly rejectRevision?: boolean } = {}) {
  const slot = createDelegationSlot();
  const spawnResults: DelegationResult[] = [];
  const statuses: string[] = [];
  let early: DelegationResult | undefined;
  let runtime: TestRuntime | undefined;
  const planner: Planner & { consulted: string[][] } = {
    consulted: [],
    async propose(input) {
      return testPlan(input, [
        { key: "a", owned_paths: ["docs/a.md"], risk: "trivial" },
        { key: "b", owned_paths: ["docs/b.md"], depends_on: ["a"], risk: "trivial" },
      ]);
    },
    async consult(input) {
      this.consulted.push([...input.steering]);
      const port = slot.current();
      assert.ok(port !== undefined);
      const caller = { runId: input.runId, role: "orchestrator" as const, toolCallId: "call_consult" };
      const status = port.status(undefined);
      statuses.push(status.ok ? status.text : status.message);
      spawnResults.push(port.spawn(planTask("c", "docs/a.md", []), caller));
      spawnResults.push(port.spawn(planTask("c", "docs/c.md", ["b"]), caller));
      spawnResults.push(port.spawn(planTask("c", "docs/d.md", ["b"]), caller));
      spawnResults.push(port.spawn({ key: "bad" }, caller));
    },
  };
  let approvals = 0;
  const broker = createScriptedBroker((request) => {
    approvals += 1;
    const reject = options.rejectRevision === true && request.subject_kind === "plan" && approvals > 1;
    return { outcome: reject ? "rejected" : "allowed-for-scope", decided_by: "user", mode: "ask" };
  });
  runtime = createTestRuntime({
    workspace,
    planner,
    delegation: slot,
    broker,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    script: async (context) => {
      const key = context.input.packet?.objective.replace("Do ", "") ?? "";
      if (key === "a") {
        early = slot.current()?.spawn(planTask("x", "docs/x.md", []), { runId: context.input.runId!, role: "orchestrator", toolCallId: "call_early" });
        runtime?.coordinator.steer("prefer tabs over spaces");
      }
      await context.write(`docs/${key}.md`, `${key} done\n`);
      const call = await context.toolCall("exec", { exitCode: 0 });
      await context.reply(workerClaim(context, call));
    },
  });
  return { runtime, planner, broker, spawnResults, statuses, early: () => early };
}

test("steering during a task is applied at the next safe boundary through an approved plan revision", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n", "docs/b.md": "b\n" }, { git: false });
  try {
    const { runtime, planner, spawnResults, statuses, early } = steeringRuntime(workspace);
    const outcome = await runtime.run();
    assert.equal(outcome.exitCode, 0, outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);

    assert.equal(early()?.ok, false, "task_spawn outside a consultation is refused");
    assert.deepEqual(planner.consulted, [["prefer tabs over spaces"]], "the orchestrator is consulted once with the queued steering");
    assert.match(statuses[0] ?? "", /^plan plan_\S+ v1\n.*a task_\S+ .*: completed/s);
    assert.deepEqual(
      spawnResults.map((result) => (result.ok ? "ok" : result.code)),
      ["invalid_arguments", "ok", "invalid_arguments", "invalid_arguments"],
      "an overlapping owner, a duplicate key and a malformed task are refused; the ordered follow-up is accepted",
    );
    assert.match(spawnResults[0]?.ok === false ? spawnResults[0].message : "", /both own docs\/a\.md/);

    const plans = ofType(events, "plan/proposed").map((event) => event.data.plan);
    assert.deepEqual(plans.map((plan) => plan.version), [1, 2]);
    assert.notEqual(plans[0]?.plan_id, plans[1]?.plan_id, "each revision is its own plan record");
    assert.ok(plans[1]?.assumptions.includes("User steering: prefer tabs over spaces"));
    assert.deepEqual(plans[1]?.tasks.map((task) => task.key), ["a", "b", "c"]);
    const changes = ofType(events, "plan/state_changed").map((event) => `${event.data.plan_id === plans[0]?.plan_id ? "v1" : "v2"}:${event.data.from}->${event.data.to}`);
    assert.deepEqual(changes, ["v1:proposed->approved", "v1:approved->superseded", "v2:proposed->approved"]);
    assert.equal(ofType(events, "steer/queued")[0]?.data.text, "prefer tabs over spaces");

    const packets = runtime.driver.turns.map((turn) => turn.input.packet).filter((packet) => packet !== undefined);
    const packetA = packets.find((packet) => packet.objective === "Do a");
    const packetB = packets.find((packet) => packet.objective === "Do b");
    assert.ok(!packetA?.decisions.some((decision) => decision.includes("prefer tabs")), "the running task is not changed mid-attempt");
    assert.ok(packetB?.decisions.includes("Assumption: User steering: prefer tabs over spaces"), "the next dispatch carries the steering");
    assert.equal(packetB?.plan_version, 2);
    const created = ofType(events, "task/created").find((event) => event.data.key === "c");
    assert.equal(created?.data.plan_id, plans[1]?.plan_id);
    assert.equal(await readFile(path.join(workspace.root, "docs", "c.md"), "utf8"), "c done\n", "the spawned follow-up ran after approval");
  } finally {
    await workspace.cleanup();
  }
});

test("in ask mode a plan revision needs the user's approval; a rejected revision leaves the running plan in force", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n", "docs/b.md": "b\n" }, { git: false });
  try {
    const approved = steeringRuntime(workspace, { mode: "ask" });
    const first = await approved.runtime.run();
    assert.equal(first.exitCode, 0, first.summary);
    assert.deepEqual(approved.broker.requests.filter((request) => request.subject_kind === "plan").map((request) => request.summary.slice(0, 8)), ["Plan v1:", "Plan v2:"]);
    const runStates = ofType(approved.runtime.runEvents(first), "run/state_changed").map((event) => event.data.to);
    assert.equal(runStates.filter((state) => state === "waiting_for_approval").length, 2);
    assert.deepEqual(replayTransitions(approved.runtime.runEvents(first)), []);
  } finally {
    await workspace.cleanup();
  }
  const second = await createTempWorkspace({ "docs/a.md": "a\n", "docs/b.md": "b\n" }, { git: false });
  try {
    const rejected = steeringRuntime(second, { mode: "ask", rejectRevision: true });
    const outcome = await rejected.runtime.run();
    assert.equal(outcome.exitCode, 0, outcome.summary);
    const events = rejected.runtime.runEvents(outcome);
    const changes = ofType(events, "plan/state_changed").map((event) => `${event.data.from}->${event.data.to}`);
    assert.deepEqual(changes, ["proposed->approved", "proposed->rejected"]);
    assert.equal(ofType(events, "task/created").length, 2, "the rejected revision's follow-up task is never created");
    const packetB = rejected.runtime.driver.turns.map((turn) => turn.input.packet).find((packet) => packet?.objective === "Do b");
    assert.equal(packetB?.plan_version, 1);
    assert.deepEqual(replayTransitions(events), []);
  } finally {
    await second.cleanup();
  }
});
