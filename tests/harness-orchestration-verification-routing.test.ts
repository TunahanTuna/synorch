import assert from "node:assert/strict";
import { test } from "node:test";
import { createId, type PlanTask, type SessionEvent } from "../src/harness/contracts/index.ts";
import { createDelegationSlot, type TriageDecision } from "../src/harness/orchestration/delegation.ts";
import {
  createBudgetTracker,
  isPlanCausedVerification,
  DEFAULT_STEP_FLOORS,
  perTaskStepLimit,
  reviewerStepLimit,
  runStepLimit,
  type BudgetLimits,
} from "../src/harness/orchestration/index.ts";
import type { Planner, TriageInput } from "../src/harness/orchestration/planner.ts";
import { renderTriagePrompt } from "../src/harness/orchestration/planner.ts";
import {
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  TEST_SANDBOX,
  testPlan,
  workerClaim,
} from "../src/harness/orchestration/testing.ts";
import { formatVerificationRefusal, preflightVerification } from "../src/harness/orchestration/verification-preflight.ts";
import type { VerificationRequest, VerificationResult } from "../src/harness/orchestration/worker-manager.ts";
import { createPolicyEngine } from "../src/harness/policy/index.ts";

/**
 * Live run 01M37V2J (2026-09-23): a plan-caused verification problem (a command the harness can
 * never run) was treated like a worker mistake (two evidence repairs), and the plan's step estimate
 * starved the reviewer. Plan-time dry run, cause-aware routing and guaranteed step floors.
 */

function task(overrides: Partial<PlanTask> & Pick<PlanTask, "key">): PlanTask {
  return {
    role: "implementer",
    objective: `Do ${overrides.key}`,
    depends_on: [],
    owned_paths: ["src-test.js"],
    read_paths: [],
    risk: "standard",
    model_tier: "fast_worker",
    acceptance_criteria: [{ id: "AC-1", statement: "done" }],
    verification: [],
    ...overrides,
  } as PlanTask;
}

function preflight(tasks: readonly PlanTask[], trusted = true, mode: "autonomous" | "ask" = "autonomous") {
  return preflightVerification(tasks, { policy: createPolicyEngine({ workspaceTrusted: () => trusted }), mode, runId: createId("run"), workspaceRoot: process.cwd(), sandbox: TEST_SANDBOX });
}

test("plan-time dry run: the live inline-code command, argv inline code, git writes and read-only mutations are refused with an alternative; a check script passes", () => {
  const live = "node --input-type=module -e \"import { multiply } from './src-test.js'; import assert from 'node:assert/strict'; assert.equal(multiply(2, 3), 6);\"";
  const result = preflight([
    task({ key: "implement-multiply", verification: ["node --check src-test.js", live, "node -e 1", "git commit -m x", "node check-multiply.mjs", "pnpm test"] }),
    task({ key: "review", role: "reviewer", owned_paths: [], depends_on: ["implement-multiply"], verification: ["pnpm build", "node -p 1"] }),
  ]);
  assert.deepEqual(
    result.refusals.map((refusal) => [refusal.taskKey, refusal.command, refusal.code]),
    [
      ["implement-multiply", live, "shell-syntax"],
      ["implement-multiply", "node -e 1", "exec-not-allowlisted"],
      ["implement-multiply", "git commit -m x", "exec-not-allowlisted"],
      ["review", "node -p 1", "read-only-role-mutation"],
    ],
    "a reviewer task's own exact command runs; its inline code does not",
  );
  assert.deepEqual(result.environment, []);
  const [shell, inline] = result.refusals.map(formatVerificationRefusal);
  assert.match(shell ?? "", /^tasks\[0\] implement-multiply: verification command "node --input-type=module -e .*" would not run \(shell-syntax: .*inline code/);
  assert.match(shell ?? "", /add check-implement-multiply\.mjs to its owned_paths.*`node check-implement-multiply\.mjs`/);
  assert.match(inline ?? "", /inline interpreter code .* is always refused/);
  assert.match(formatVerificationRefusal(result.refusals[2]!), /only the harness integrates changes/);
});

test("plan-time dry run: an untrusted workspace is an environment refusal (noticed, not a plan problem); in ask mode an asking command is left to the worker", () => {
  const untrusted = preflight([task({ key: "t", verification: ["node check.mjs"] })], false);
  assert.deepEqual(untrusted.refusals, []);
  assert.deepEqual(untrusted.environment.map((refusal) => refusal.code), ["workspace-untrusted"]);
  const ask = preflight([task({ key: "t", verification: ["node check.mjs", "node -e 1", "git commit -m x", "pnpm test && echo ok"] })], true, "ask");
  assert.deepEqual(ask.refusals.map((refusal) => refusal.command), ["git commit -m x", "pnpm test && echo ok"], "a hard refusal and shell syntax stay plan problems in ask mode");
});

test("step floors: the run's step budget is never below the guaranteed task and reviewer limits", () => {
  const plan = { budget: { max_wall_time_seconds: 180, max_steps: 10 }, tasks: [task({ key: "implement-multiply" }), task({ key: "review-multiply", role: "reviewer", owned_paths: [] })] };
  assert.equal(perTaskStepLimit(plan), 25);
  assert.equal(reviewerStepLimit(25), 25);
  assert.equal(runStepLimit(plan), 50, "live plan: 25 implementer + 25 reviewer, not the plan's 10");
  assert.equal(runStepLimit({ ...plan, tasks: [task({ key: "doc", risk: "trivial" })] }), 25, "a trivial task gets no reviewer allocation");
  assert.equal(runStepLimit({ ...plan, budget: { max_wall_time_seconds: 60, max_steps: 400 } }), 800, "the task and its reviewer each get the plan share");
  assert.equal(runStepLimit({ budget: { max_wall_time_seconds: 60, max_steps: 90 }, tasks: [task({ key: "doc", risk: "trivial" })] }), 90, "a larger plan estimate is kept");
  assert.equal(reviewerStepLimit(10, { ...DEFAULT_STEP_FLOORS, reviewer: 30 }), 30, "the reviewer floor is configurable");
  assert.equal(reviewerStepLimit(60), 60, "never below the implementation's own limit");
});

test("budget grace: a report-only request is admitted past an exhausted step budget, never past cost, and is not counted", () => {
  const none: BudgetLimits = { maxCostUsd: undefined, maxWallTimeSeconds: undefined, maxSteps: undefined, maxToolCalls: undefined };
  const tracker = createBudgetTracker({ scope: "run", limits: { ...none, maxSteps: 1 } });
  assert.equal(tracker.admit().ok, true);
  assert.equal(tracker.admit().ok, false);
  assert.equal(tracker.admit({ grace: true }).ok, true);
  assert.equal(tracker.usage().steps, 1, "the graced request is not a step");
  const costly = createBudgetTracker({ scope: "run", limits: { ...none, maxSteps: 1, maxCostUsd: 1 } });
  costly.observe([{ sessionId: createId("session"), seq: 1, usage: { cost_usd_estimate: 1, source: "provider-reported" } }]);
  assert.equal(costly.admit({ grace: true }).ok, false, "cost is never graced");
});

test("cause classification: refused, unrunnable and missing programs are plan-caused; a failed run, a cancelled attempt and an ask-mode command are not", () => {
  assert.equal(isPlanCausedVerification({ status: "not-run", reason: "the command uses shell syntax and cannot be run as a plain argv" }), true);
  assert.equal(isPlanCausedVerification({ status: "not-run", reason: "refused: it cannot run without a full sandbox: node is invoked with inline code" }), true);
  assert.equal(isPlanCausedVerification({ status: "failed", termination: "spawn-failed" }), true);
  assert.equal(isPlanCausedVerification({ status: "failed", termination: "exited" }), false);
  assert.equal(isPlanCausedVerification({ status: "not-run", reason: "the attempt was cancelled" }), false);
  assert.equal(isPlanCausedVerification({ status: "not-run", reason: "refused: a harness-initiated call never asks for approval: exec needs approval in ask mode" }), false);
});

type RunnerOutcome = "not-run" | "spawn-failed";

function unrunnable(outcome: RunnerOutcome): (request: VerificationRequest) => Promise<VerificationResult> {
  return async (request) => {
    if (request.command !== "node check.mjs") return { status: "passed", commandClass: "build-test", termination: "exited", exitCode: 0, output: "ok", durationMs: 1 };
    return outcome === "not-run"
      ? { status: "not-run", exitCode: null, output: "", durationMs: 0, reason: "refused: node check.mjs is not an exact verification command here" }
      : { status: "failed", termination: "spawn-failed", exitCode: null, output: "spawn node ENOENT", durationMs: 1 };
  };
}

function triagePlanner(slot: ReturnType<typeof createDelegationSlot>, decide: (input: TriageInput) => readonly TriageDecision[], seen: TriageInput[], answers: string[], plan: (input: Parameters<Planner["propose"]>[0]) => unknown): Planner {
  return {
    propose: async (input) => plan(input),
    async triage(input) {
      seen.push(input);
      const port = slot.current();
      assert.ok(port?.triage !== undefined);
      for (const decision of decide(input)) {
        const result = port.triage(decision, { runId: input.runId, role: "orchestrator", toolCallId: "call_triage" });
        answers.push(result.ok ? `ok: ${result.text}` : `${result.code}: ${result.message}`);
        if (result.ok) break;
      }
    },
  };
}

function ofType<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

for (const outcome of ["not-run", "spawn-failed"] as const) {
  test(`a plan-caused verification problem (${outcome}) never costs a worker repair: the orchestrator triages it and accept waives the command`, async () => {
    const workspace = await createTempWorkspace({ "src/a.js": "a\n" }, { git: false });
    try {
      const slot = createDelegationSlot();
      const seen: TriageInput[] = [];
      const answers: string[] = [];
      const planner = triagePlanner(slot, () => [{ task: "fix", decision: "accept", guidance: "the reviewer checks it by reading" }], seen, answers, (input) =>
        testPlan(input, [{ key: "fix", owned_paths: ["src/a.js"], risk: "trivial", verification: ["pnpm test", "node check.mjs"] }]),
      );
      const runtime = createTestRuntime({
        workspace,
        planner,
        delegation: slot,
        verification: unrunnable(outcome),
        script: async (context) => {
          await context.write("src/a.js", "fixed\n");
          const call = await context.toolCall("read_file");
          await context.reply(workerClaim(context, call, { commands_run: [] }));
        },
      });
      const result = await runtime.run();
      assert.equal(result.status, "succeeded", result.summary);
      const events = runtime.runEvents(result);
      assert.deepEqual(replayTransitions(events), []);
      assert.equal(ofType(events, "attempt/repair_requested").length, 0, "the worker is never asked to fix the plan");
      assert.equal(runtime.driver.turns.length, 1);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0]?.planCaused, ["node check.mjs"]);
      assert.equal(seen[0]?.verificationOnly, true);
      assert.match(seen[0]?.problems?.[0] ?? "", /could not run \(plan-caused/);
      const prompt = renderTriagePrompt(seen[0]!);
      assert.match(prompt, /Plan-caused .*\n- node check\.mjs/);
      assert.match(prompt, /- accept: the change goes to independent review without the commands that could not run/);
      assert.match(answers[0] ?? "", /^ok: decision for fix recorded: accept; the verification command\(s\) that could not run are waived \(node check\.mjs\)/);
    } finally {
      await workspace.cleanup();
    }
  });
}

test("a plan-caused verification problem: triage retry with replacement verification revises the plan and a new attempt continues from the change", async () => {
  const workspace = await createTempWorkspace({ "src/a.js": "a\n" }, { git: false });
  try {
    const slot = createDelegationSlot();
    const seen: TriageInput[] = [];
    const answers: string[] = [];
    const planner = triagePlanner(
      slot,
      () => [
        { task: "fix", decision: "accept", verification: ["pnpm test"] },
        { task: "fix", decision: "retry", verification: ["pnpm test && echo ok"] },
        { task: "fix", decision: "retry", verification: ["pnpm test"], guidance: "the test suite covers it" },
      ],
      seen,
      answers,
      (input) => testPlan(input, [{ key: "fix", owned_paths: ["src/a.js"], risk: "trivial", verification: ["node check.mjs"] }]),
    );
    const runtime = createTestRuntime({
      workspace,
      planner,
      delegation: slot,
      verification: unrunnable("not-run"),
      script: async (context) => {
        await context.write("src/a.js", "fixed\n");
        const call = await context.toolCall("read_file");
        await context.reply(workerClaim(context, call, { commands_run: [] }));
      },
    });
    const result = await runtime.run();
    assert.equal(result.status, "succeeded", result.summary);
    const events = runtime.runEvents(result);
    assert.deepEqual(replayTransitions(events), []);
    assert.match(answers[0] ?? "", /^invalid_arguments: verification \(replacement commands\) goes with decision retry/);
    assert.match(answers[1] ?? "", /^invalid_arguments: replacement verification rejected:\n- tasks\[0\] fix: verification command "pnpm test && echo ok" would not run \(shell-syntax/);
    assert.match(answers[2] ?? "", /^ok: decision for fix recorded: retry with the revised verification \(pnpm test\)/);
    const plans = ofType(events, "plan/proposed");
    assert.deepEqual(plans.map((event) => [event.data.plan.version, event.data.plan.tasks[0]?.verification]), [[1, ["node check.mjs"]], [2, ["pnpm test"]]]);
    assert.ok(ofType(events, "plan/state_changed").some((event) => event.data.to === "superseded"));
    assert.equal(ofType(events, "attempt/repair_requested").length, 0);
    assert.equal(runtime.driver.turns.length, 2);
    assert.deepEqual(runtime.driver.turns[1]?.input.packet?.verification.commands, ["pnpm test"]);
    assert.match(runtime.driver.turns[1]?.input.userMessage ?? "", /replaced this task's verification .* with: pnpm test\..*previous change is already in your workspace/s);
    assert.deepEqual(ofType(events, "attempt/verification_ran").map((event) => [event.data.command, event.data.status]), [["node check.mjs", "not-run"], ["pnpm test", "passed"]]);
  } finally {
    await workspace.cleanup();
  }
});

test("a worker-caused verification failure is still repaired in the same session (the routing is by cause)", async () => {
  const workspace = await createTempWorkspace({ "src/a.js": "a\n" }, { git: false });
  try {
    let runs = 0;
    const runtime = createTestRuntime({
      workspace,
      planner: { propose: async (input) => testPlan(input, [{ key: "fix", owned_paths: ["src/a.js"], risk: "trivial", verification: ["pnpm test"] }]) },
      verification: async () => {
        runs += 1;
        return runs === 1 ? { status: "failed", termination: "exited", exitCode: 1, output: "1 failed", durationMs: 1 } : { status: "passed", commandClass: "build-test", termination: "exited", exitCode: 0, output: "ok", durationMs: 1 };
      },
      script: async (context) => {
        await context.write("src/a.js", "fixed\n");
        const call = await context.toolCall("read_file");
        await context.reply(workerClaim(context, call, { commands_run: [] }));
      },
    });
    const result = await runtime.run();
    assert.equal(result.status, "succeeded", result.summary);
    assert.deepEqual(ofType(runtime.runEvents(result), "attempt/repair_requested").map((event) => event.data.kind), ["verification-repair"]);
  } finally {
    await workspace.cleanup();
  }
});
