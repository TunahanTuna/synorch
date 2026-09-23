import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Plan, SessionEvent, TaskContextPacket } from "../src/harness/contracts/index.ts";
import { placeCrossTaskCriteria, scopeLimitedReview, validatePlan } from "../src/harness/orchestration/index.ts";
import {
  createScriptedPlanner,
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  reviewerClaim,
  testPlan,
  workerClaim,
  type PlanTaskInput,
  type ScriptContext,
} from "../src/harness/orchestration/testing.ts";

/**
 * Replay of live run 01M381W6 (K1.6-P2): add/subtract/divide in separate files, three parallel
 * implementers and a plan-level reviewer. The planner put a criterion about the other tasks' files
 * on an implementer; every per-task reviewer could read only its task's files, found those criteria
 * unverifiable, blocked, and nothing was integrated while the plan's reviewer waited forever.
 * Now: the cross-task criterion moves to the integration review, reviewers read the whole
 * workspace, a scope-limited verdict is re-dispatched once, a block is a revise round, and the
 * integration review runs over the combined, integrated result.
 */

const TASKS: readonly PlanTaskInput[] = [
  {
    key: "fix-add",
    owned_paths: ["src/add.mjs", "src/add.test.mjs"],
    criteria: ["add(a, b) returns the sum; src/add.test.mjs covers negatives", "src/subtract.mjs and src/divide.mjs keep their own separate tests"],
    verification: ["node --test src/add.test.mjs"],
  },
  { key: "implement-subtract", owned_paths: ["src/subtract.mjs", "src/subtract.test.mjs"], criteria: ["subtract(a, b) returns the difference"], verification: ["node --test src/subtract.test.mjs"] },
  { key: "implement-divide", owned_paths: ["src/divide.mjs", "src/divide.test.mjs"], criteria: ["divide(a, b) divides; division by zero gives Infinity"], verification: ["node --test src/divide.test.mjs"] },
  {
    key: "independent-review",
    role: "reviewer",
    depends_on: ["fix-add", "implement-subtract", "implement-divide"],
    criteria: ["the three functions and their tests are consistent and only the six files changed"],
  },
];

function ofType<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

const FILES: Readonly<Record<string, string>> = {
  "fix-add": "export function add(a, b) { return a + b; }\n",
  "implement-subtract": "export function subtract(a, b) { return a - b; }\n",
  "implement-divide": "export function divide(a, b) { return a / b; }\n",
};

test("live run 01M381W6 replay: cross-task criteria go to the integration review, reviews revise instead of reject, and the integration review runs over the combined result", async () => {
  const workspace = await createTempWorkspace({ "src/add.mjs": "export function add(a, b) { return a - b; }\n", "README.md": "calc\n" }, { git: true });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, TASKS));
    const reviewPackets: TaskContextPacket[] = [];
    const integrationBriefs: string[] = [];
    const reviews = new Map<string, number>();
    const script = async (context: ScriptContext): Promise<void> => {
      const packet = context.input.packet;
      if (packet === undefined) return;
      const key = TASKS.find((task) => packet.objective.endsWith(`Do ${task.key}`))?.key ?? "";
      if (context.input.role !== "reviewer") {
        const base = key.replace(/^(fix|implement)-/, "");
        await context.write(`src/${base}.mjs`, FILES[key] ?? "");
        await context.write(`src/${base}.test.mjs`, `import "./${base}.mjs";\n`);
        const call = await context.toolCall("exec", { exitCode: 0, text: "tests passed" });
        await context.report("task_report", workerClaim(context, call));
        return;
      }
      const call = await context.toolCall("exec", { exitCode: 0, text: "reviewer checked" });
      if (key === "independent-review") {
        integrationBriefs.push(context.input.userMessage ?? "");
        await context.report("review_report", reviewerClaim(context, call, "accept"));
        return;
      }
      reviewPackets.push(packet);
      const round = (reviews.get(key) ?? 0) + 1;
      reviews.set(key, round);
      if (key === "fix-add" && round === 1) {
        // The live verdict: unverifiable because of the reviewer's read scope, decision block.
        await context.report("review_report", {
          criteria: packet.acceptance_criteria.map((criterion) => ({ criterion_id: criterion.id, verdict: "unverifiable", evidence: [], note: "the dispatch permits reading only add-related files" })),
          findings: [{ id: "F-1", severity: "major", summary: "AC-1 cannot be independently verified within this dispatch's read scope" }],
          decision: "block",
        });
        return;
      }
      if (key === "implement-divide" && round === 1) {
        await context.report("review_report", reviewerClaim(context, call, "block"));
        return;
      }
      await context.report("review_report", reviewerClaim(context, call, "accept"));
    };
    const runtime = createTestRuntime({ workspace, planner, script, limits: { budgets: { review_revisions: 1 } } });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);

    // (2) The cross-task criterion moved to the integration review, with a note in the plan.
    const plan = ofType(events, "plan/proposed")[0]?.data.plan as Plan;
    const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
    assert.deepEqual(byKey.get("fix-add")?.acceptance_criteria.map((criterion) => criterion.id), ["AC-1"]);
    assert.deepEqual(byKey.get("independent-review")?.acceptance_criteria.map((criterion) => criterion.id), ["AC-1", "AC-2"]);
    assert.match(byKey.get("independent-review")?.acceptance_criteria[1]?.statement ?? "", /^\(from fix-add\) src\/subtract\.mjs/);
    assert.ok(plan.assumptions.some((note) => /Moved fix-add AC-2 to the integration review independent-review as AC-2/.test(note)));

    // (1) Per-task reviewers read the whole workspace and never carry the integration criteria.
    assert.ok(reviewPackets.length > 0);
    for (const packet of reviewPackets) {
      assert.ok(packet.scope.read_paths.includes("**"), "workspace-wide read scope");
      assert.deepEqual(packet.scope.owned_paths, []);
      assert.ok(packet.scope.forbidden_paths.includes(".git/**"));
      assert.ok(packet.acceptance_criteria.every((criterion) => !criterion.statement.includes("reviewer task")), "no integration criterion in a per-task review");
    }

    // (3) The scope-limited verdict was re-dispatched once (a harness problem), then accepted.
    const addReviews = reviewPackets.filter((packet) => packet.objective.endsWith("Do fix-add"));
    assert.equal(addReviews.length, 2);
    assert.ok(addReviews[1]?.decisions.some((decision) => decision.startsWith("Harness: an earlier review")), "the re-dispatch carries the scope note");

    // (3) A block with harness checks passed is a revise round for the implementer, not a rejection.
    const taskIds = new Map(ofType(events, "task/created").map((event) => [event.data.key, event.data.task_id]));
    const divideStates = ofType(events, "task/state_changed").filter((event) => event.data.task_id === taskIds.get("implement-divide")).map((event) => event.data.to);
    assert.deepEqual(divideStates, ["ready", "running", "verifying", "reviewing", "changes_requested", "ready", "running", "verifying", "reviewing", "completed"]);

    // (4) The integration review ran after every dependency was integrated, over the combined workspace.
    const reviewerId = taskIds.get("independent-review");
    const integrationAttempt = ofType(events, "attempt/started").find((event) => event.data.task_id === reviewerId);
    assert.ok(integrationAttempt !== undefined, "the plan's reviewer task dispatched its own attempt");
    assert.equal(integrationAttempt.data.isolation.path, workspace.root, "it reads the main workspace with the integrated changes");
    const integrated = ofType(events, "task/integrated");
    assert.equal(integrated.length, 3);
    assert.ok(integrated.every((event) => event.seq < integrationAttempt.seq), "it starts only after all three were integrated");
    assert.equal(integrationBriefs.length, 1);
    for (const key of ["fix-add", "implement-subtract", "implement-divide"]) assert.match(integrationBriefs[0] ?? "", new RegExp(key));
    assert.match(integrationBriefs[0] ?? "", /\(from fix-add\) src\/subtract\.mjs/);
    const verdicts = ofType(events, "review/recorded").filter((event) => event.data.task_id === reviewerId);
    assert.deepEqual(verdicts.map((event) => event.data.decision), ["accept"]);
    for (const [key, content] of Object.entries(FILES)) {
      assert.equal(await readFile(path.join(workspace.root, "src", `${key.replace(/^(fix|implement)-/, "")}.mjs`), "utf8"), content);
    }
  } finally {
    await workspace.cleanup();
  }
});

test("plan validation: a cross-task criterion without an integration reviewer is rejected with what to change", () => {
  const input = { runId: "run_01K5T3Q8Z4X9V2M6N7P0R1S2T3", planId: "plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5", version: 1, goal: "calc", createdAt: "2026-09-24T10:00:00Z" } as const;
  const expected = { runId: input.runId as never, planId: input.planId as never, version: 1 };
  const validation = validatePlan(testPlan(input as never, TASKS.slice(0, 3)), expected);
  assert.equal(validation.ok, false);
  assert.ok(!validation.ok && validation.issues.some((issue) => /fix-add AC-2 names src\/subtract\.mjs.*integration reviewer task \(role reviewer, depends_on \[fix-add, implement-subtract/.test(issue)), JSON.stringify(validation));
  const valid = validatePlan(testPlan(input as never, TASKS), expected);
  assert.ok(valid.ok && valid.notes?.length === 1);
  assert.ok(valid.ok && placeCrossTaskCriteria(valid.plan).notes.length === 0, "placement is idempotent: the moved plan validates unchanged");
});

test("scopeLimitedReview: only unverifiable verdicts blamed on the read scope count", () => {
  const scoped = { criteria: [{ verdict: "met" }, { verdict: "unverifiable", note: "outside the dispatch's read scope" }], findings: [] };
  assert.equal(scopeLimitedReview(scoped), true);
  assert.equal(scopeLimitedReview({ ...scoped, criteria: [{ verdict: "not_met", note: "read scope" }] }), false, "a real not_met is a finding about the work");
  assert.equal(scopeLimitedReview({ criteria: [{ verdict: "unverifiable", note: "no test covers it" }], findings: [] }), false);
  assert.equal(scopeLimitedReview({ ...scoped, findings: [{ severity: "blocker", summary: "SQL injection" }] }), false);
});
