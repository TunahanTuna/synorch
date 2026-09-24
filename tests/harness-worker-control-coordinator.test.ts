import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import type { SessionEvent } from "../src/harness/contracts/index.ts";
import { renderConsultPrompt, renderWorkerMessages } from "../src/harness/orchestration/index.ts";
import { createScriptedPlanner, createTempWorkspace, createTestRuntime, replayTransitions, testPlan, workerClaim, type ScriptContext, type TestRuntime } from "../src/harness/orchestration/testing.ts";

/**
 * K1.7 runtime side: while a worker attempt runs the user can see its assignment, message it
 * (delivered to that attempt's driver, recorded, passed on to the orchestrator), pause / resume it and
 * cancel it (handled like any cancelled attempt). Delegations are recorded for the main chat.
 */

function ofType<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

async function untilLive(runtime: TestRuntime, key: string): Promise<void> {
  for (let index = 0; index < 500; index += 1) {
    if (runtime.coordinator.workers.list().some((worker) => worker.key === key && worker.live)) return;
    await tick();
  }
  throw new Error(`${key} never became live`);
}

async function finish(context: ScriptContext): Promise<void> {
  await context.write("docs/a.md", "fixed\n");
  const call = await context.toolCall("exec", { exitCode: 0, text: "ok" });
  await context.reply(workerClaim(context, call));
}

test("message, pause and resume a running worker; its assignment is visible and a finished worker refuses messages", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: true });
  try {
    const seen: { assignment?: unknown; results: string[] } = { results: [] };
    let runtime: TestRuntime | undefined;
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "edit-a", owned_paths: ["docs/a.md"], read_paths: ["docs/a.md"], risk: "trivial", criteria: ["a.md says fixed"] }]));
    runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        const current = runtime;
        assert.ok(current !== undefined);
        await untilLive(current, "edit-a");
        const control = current.coordinator.workers;
        seen.assignment = current.coordinator.workers.assignment("edit-a");
        for (const result of [await control.message("edit-a", "keep the heading unchanged"), await control.pause("edit-a")]) seen.results.push(`${result.ok} ${result.message}`);
        assert.equal(current.coordinator.workers.list()[0]?.paused, true);
        seen.results.push(String((await control.resume("edit-a")).ok));
        await finish(context);
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);

    const assignment = seen.assignment as { objective: string; owned_paths: string[]; acceptance_criteria: string[]; steering: unknown[] };
    assert.equal(assignment.objective, "Do edit-a");
    assert.deepEqual(assignment.owned_paths, ["docs/a.md"]);
    assert.deepEqual(assignment.acceptance_criteria, ["AC-1: a.md says fixed"]);
    assert.match(seen.results[0] ?? "", /^true sent to edit-a/);
    assert.match(seen.results[1] ?? "", /^true edit-a pauses/);
    assert.equal(seen.results[2], "true");
    assert.deepEqual(runtime.driver.steers, ["keep the heading unchanged"], "the message reached the attempt's driver");

    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    const delegated = ofType(events, "task/delegated");
    assert.equal(delegated.length, 1);
    assert.equal(delegated[0]?.data.key, "edit-a");
    assert.equal(delegated[0]?.data.objective, "Do edit-a");
    assert.equal(ofType(events, "task/user_message")[0]?.data.text, "keep the heading unchanged");
    assert.deepEqual(ofType(events, "attempt/user_control").map((event) => event.data.action), ["pause", "resume"]);
    assert.equal(ofType(events, "task/user_message")[0]?.actor.kind, "user");

    const late = await runtime.coordinator.workers.message("edit-a", "too late");
    assert.equal(late.ok, false);
    assert.match(late.message, /not running/);
    assert.deepEqual(runtime.coordinator.workers.assignment("edit-a")?.steering, [{ from: "user", text: "keep the heading unchanged", atMs: runtime.coordinator.workers.assignment("edit-a")?.steering[0]?.atMs }]);
  } finally {
    await workspace.cleanup();
  }
});

test("cancelling a running worker aborts that attempt and the coordinator handles it like a cancelled attempt", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: true });
  try {
    let runtime: TestRuntime | undefined;
    let attempts = 0;
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "edit-a", owned_paths: ["docs/a.md"], read_paths: ["docs/a.md"], risk: "trivial" }]));
    runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        attempts += 1;
        const current = runtime;
        assert.ok(current !== undefined);
        if (attempts === 1) {
          await untilLive(current, "edit-a");
          const result = await current.coordinator.workers.cancel("edit-a");
          assert.equal(result.ok, true, result.message);
          assert.ok(context.signal.aborted, "the attempt's signal is aborted");
          return "cancelled";
        }
        await finish(context);
      },
    });
    const outcome = await runtime.run();
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.deepEqual(ofType(events, "attempt/user_control").map((event) => event.data.action), ["cancel"]);
    const states = ofType(events, "attempt/state_changed").map((event) => event.data.to);
    assert.equal(states[0], "cancelled");
    assert.equal(outcome.status, "succeeded", "the existing rules retried the task with a new attempt");
    assert.equal(ofType(events, "task/delegated").length, 2);
    assert.equal(ofType(events, "task/delegated")[1]?.data.attempt, 2);
  } finally {
    await workspace.cleanup();
  }
});

test("the orchestrator's next consultation lists what the user told workers directly", () => {
  assert.equal(renderWorkerMessages([]), "");
  const prompt = renderConsultPrompt({
    runId: "run_01K5W0A8Z4X9V2M6N7P0R1S2B2" as never,
    goal: "Edit a",
    planVersion: 1,
    steering: ["also b"],
    workerMessages: ["to edit-a: keep the heading unchanged"],
    tasks: [],
    route: undefined as never,
    policy: undefined as never,
    events: undefined as never,
    sessionId: undefined as never,
  });
  assert.match(prompt, /messaged running workers directly[\s\S]*to edit-a: keep the heading unchanged/);
});
