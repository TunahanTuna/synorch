import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createId } from "../src/harness/contracts/index.ts";
import { createDagScheduler, findDependencyCycle, SchedulerError, validatePlan } from "../src/harness/orchestration/index.ts";
import {
  createScriptedPlanner,
  createTempWorkspace,
  createTestRuntime,
  testPlan,
  workerClaim,
  type PlanTaskInput,
} from "../src/harness/orchestration/testing.ts";
import type { PlannerInput } from "../src/harness/orchestration/planner.ts";

function plannerInput(): PlannerInput {
  return {
    runId: createId("run"),
    planId: createId("plan"),
    version: 1,
    goal: "g",
    workspaceRoot: "/w",
    mode: "autonomous",
    createdAt: "2026-09-22T10:00:00Z",
    feedback: [],
  } as unknown as PlannerInput;
}

const task = (key: string, owned: string[], extra: Partial<PlanTaskInput> = {}): PlanTaskInput => ({ key, owned_paths: owned, risk: "trivial", ...extra });

test("AC-1 a plan with two unordered writers on overlapping paths is rejected", () => {
  const input = plannerInput();
  const result = validatePlan(testPlan(input, [task("a", ["src/auth/**"]), task("b", ["src/Auth/token.ts"])]), input);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.issues.some((issue) => issue.includes("both own")));
});

test("AC-1 the same writers ordered by a dependency form a valid plan", () => {
  const input = plannerInput();
  const result = validatePlan(testPlan(input, [task("a", ["src/auth/**"]), task("b", ["src/auth/token.ts"], { depends_on: ["a"] })]), input);
  assert.equal(result.ok, true);
});

test("AC-1 a plan for another run or plan id is rejected", () => {
  const input = plannerInput();
  const other = { ...input, runId: createId("run") };
  const result = validatePlan(testPlan(other, [task("a", ["docs/a.md"])]), input);
  assert.equal(result.ok, false);
});

test("AC-1 the scheduler never starts overlapping owners together, even if the plan check was bypassed", () => {
  const scheduler = createDagScheduler(
    [
      { key: "a", dependsOn: [], ownedPaths: ["src/auth/**"], provider: "p", workspace: "w" },
      { key: "b", dependsOn: [], ownedPaths: ["src/AUTH/x.ts"], provider: "p", workspace: "w" },
      { key: "c", dependsOn: [], ownedPaths: ["docs/**"], provider: "p", workspace: "w" },
    ],
    { global: 4, perProvider: 4, perWorkspace: 4 },
  );
  assert.deepEqual(scheduler.startable(), ["a", "c"]);
  scheduler.start("a");
  assert.throws(() => scheduler.start("b"), SchedulerError);
  scheduler.start("c");
  assert.deepEqual(scheduler.startable(), []);
  scheduler.finish("a", "completed");
  assert.deepEqual(scheduler.startable(), ["b"]);
});

test("AC-1 the scheduler honours global, provider and workspace limits", () => {
  const tasks = ["a", "b", "c", "d"].map((key, index) => ({
    key,
    dependsOn: [],
    ownedPaths: [`docs/${key}.md`],
    provider: index < 3 ? "openai" : "anthropic",
    workspace: index === 3 ? "w2" : "w1",
  }));
  assert.deepEqual(createDagScheduler(tasks, { global: 2, perProvider: 4, perWorkspace: 4 }).startable(), ["a", "b"]);
  assert.deepEqual(createDagScheduler(tasks, { global: 4, perProvider: 1, perWorkspace: 4 }).startable(), ["a", "d"]);
  assert.deepEqual(createDagScheduler(tasks, { global: 4, perProvider: 4, perWorkspace: 2 }).startable(), ["a", "b", "d"]);
});

test("AC-1 the scheduler rejects cycles and unknown dependencies and skips dependents of a failure", () => {
  assert.deepEqual(findDependencyCycle([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }]), ["a", "b", "a"]);
  assert.throws(() => createDagScheduler([{ key: "a", dependsOn: ["a"], ownedPaths: [], provider: undefined, workspace: "w" }]), /cycle/);
  assert.throws(() => createDagScheduler([{ key: "a", dependsOn: ["x"], ownedPaths: [], provider: undefined, workspace: "w" }]), /unknown/);
  const scheduler = createDagScheduler([
    { key: "a", dependsOn: [], ownedPaths: [], provider: undefined, workspace: "w" },
    { key: "b", dependsOn: ["a"], ownedPaths: [], provider: undefined, workspace: "w" },
  ]);
  scheduler.start("a");
  scheduler.finish("a", "failed");
  assert.equal(scheduler.state("b"), "skipped");
  assert.equal(scheduler.done(), true);
});

test("AC-1 the coordinator rejects an overlapping plan and dispatches no worker", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [task("a", ["docs/**"]), task("b", ["docs/a.md"])]));
    const runtime = createTestRuntime({ workspace, planner, script: async () => "completed" });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.exitCode, 5);
    assert.equal(planner.calls.length, 2);
    assert.ok((planner.calls[1]?.feedback ?? []).some((line) => line.includes("both own")));
    assert.equal(runtime.driver.turns.length, 0);
    assert.ok(!runtime.runEvents(outcome).some((event) => event.type === "task/created"));
  } finally {
    await workspace.cleanup();
  }
});

test("AC-1 two dependent writers on the same path run strictly one after the other (Faz 2 gate)", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "start\n" }, { git: true });
  try {
    const timeline: { key: string; phase: "start" | "end" }[] = [];
    let markOtherStarted: () => void = () => undefined;
    const otherStarted = new Promise<void>((resolve) => {
      markOtherStarted = resolve;
    });
    const planner = createScriptedPlanner((input) =>
      testPlan(input, [task("first", ["docs/**"]), task("second", ["docs/**"], { depends_on: ["first"] }), task("other", ["src/**"])]),
    );
    const runtime = createTestRuntime({
      workspace,
      planner,
      limits: { concurrency: { global: 4, perProvider: 4, perWorkspace: 4 } },
      script: async (context) => {
        const key = context.input.packet?.objective.replace("Do ", "") ?? "?";
        timeline.push({ key, phase: "start" });
        if (key === "other") markOtherStarted();
        if (key === "first") {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([otherStarted, new Promise<void>((resolve) => (timer = setTimeout(resolve, 10_000)))]);
          clearTimeout(timer);
        }
        const target = key === "other" ? "src/other.ts" : "docs/a.md";
        const previous = await readFile(path.join(context.root, ...target.split("/")), "utf8").catch(() => "");
        await context.write(target, `${previous}${key}\n`);
        const call = await context.toolCall("exec", { exitCode: 0 });
        timeline.push({ key, phase: "end" });
        await context.reply(workerClaim(context, call));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const firstEnd = timeline.findIndex((entry) => entry.key === "first" && entry.phase === "end");
    const secondStart = timeline.findIndex((entry) => entry.key === "second" && entry.phase === "start");
    assert.ok(firstEnd >= 0 && secondStart > firstEnd, JSON.stringify(timeline));
    const otherStart = timeline.findIndex((entry) => entry.key === "other" && entry.phase === "start");
    assert.ok(otherStart < firstEnd, "an independent, non-overlapping task runs in parallel");
    assert.equal(await readFile(path.join(workspace.root, "docs", "a.md"), "utf8"), "start\nfirst\nsecond\n");
    const started = runtime.runEvents(outcome).filter((event) => event.type === "attempt/started");
    assert.ok(started.every((event) => event.type === "attempt/started" && event.data.isolation.mode === "worktree"));
  } finally {
    await workspace.cleanup();
  }
});
