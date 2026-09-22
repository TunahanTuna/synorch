import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  approvalDecisionSchema,
  createId,
  HarnessError,
  sha256,
  type ApprovalRequest,
  type EffectivePolicy,
  type SessionEvent,
} from "../src/harness/contracts/index.ts";
import { approvePlan, createControlPlaneWriter, decisionAnswers, isControlPlanePath } from "../src/harness/orchestration/index.ts";
import {
  createFakePolicyEngine,
  createHeadlessBroker,
  createScriptedBroker,
  createScriptedPlanner,
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  TEST_SANDBOX,
  testPlan,
  workerClaim,
} from "../src/harness/orchestration/testing.ts";

function orchestratorPolicy(root: string, engine = createFakePolicyEngine()): EffectivePolicy {
  return engine.compute({
    mode: "autonomous",
    role: "orchestrator",
    runId: createId("run"),
    taskId: undefined,
    workspaceRoot: root,
    taskScope: { owned: [".ai/tasks/**"], read: ["**"], forbidden: [] },
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: TEST_SANDBOX,
    grants: [],
  });
}

const isPolicyDenied = (error: unknown) => error instanceof HarnessError && error.info.code === "policy_denied" && error.exitCode === 6;

test("AC-8 the orchestrator's product-file write is denied by policy and nothing is written", async () => {
  const workspace = await createTempWorkspace({ "src/index.ts": "original\n" }, { git: false });
  try {
    const engine = createFakePolicyEngine();
    const writer = createControlPlaneWriter({ workspaceRoot: workspace.root, policy: orchestratorPolicy(workspace.root, engine), engine });
    await assert.rejects(writer.write("src/index.ts", "hijacked\n"), isPolicyDenied);
    await assert.rejects(writer.write("docs/new.md", "x\n"), isPolicyDenied);
    await assert.rejects(writer.write(".git/config", "x\n"), isPolicyDenied);
    assert.equal(await readFile(path.join(workspace.root, "src", "index.ts"), "utf8"), "original\n");
    await assert.rejects(stat(path.join(workspace.root, "docs", "new.md")));
    const decision = await writer.write(".ai/tasks/run-1/plan.md", "# plan\n");
    assert.equal(decision.decision, "allow");
    assert.equal(await readFile(path.join(workspace.root, ".ai", "tasks", "run-1", "plan.md"), "utf8"), "# plan\n");
  } finally {
    await workspace.cleanup();
  }
});

test("AC-8 the local guard denies product writes even when the policy engine would allow them", async () => {
  const workspace = await createTempWorkspace({ "src/index.ts": "original\n" }, { git: false });
  try {
    const lenient = createFakePolicyEngine({ lenient: true });
    const writer = createControlPlaneWriter({ workspaceRoot: workspace.root, policy: orchestratorPolicy(workspace.root), engine: lenient });
    await assert.rejects(writer.write("src/index.ts", "hijacked\n"), isPolicyDenied);
    await assert.rejects(writer.write(".ai/tasks/../../src/index.ts", "x\n"), isPolicyDenied);
    await assert.rejects(writer.write(".ai/tasks", "x\n"), isPolicyDenied);
    await assert.rejects(writer.write(".ai/other/x.md", "x\n"), isPolicyDenied);
    assert.equal(await readFile(path.join(workspace.root, "src", "index.ts"), "utf8"), "original\n");
    assert.equal(isControlPlanePath(".ai/tasks/a/b.json"), true);
    assert.equal(isControlPlanePath(".ai/tasks/.git/x"), false);
  } finally {
    await workspace.cleanup();
  }
});

test("AC-8 a symlink under .ai/tasks cannot redirect an orchestrator write into the product tree", async (context) => {
  const workspace = await createTempWorkspace({ "src/index.ts": "original\n" }, { git: false });
  try {
    await mkdir(path.join(workspace.root, ".ai", "tasks"), { recursive: true });
    try {
      await symlink(path.join(workspace.root, "src"), path.join(workspace.root, ".ai", "tasks", "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip("symlinks/junctions unavailable");
      return;
    }
    const lenient = createFakePolicyEngine({ lenient: true });
    const writer = createControlPlaneWriter({ workspaceRoot: workspace.root, policy: orchestratorPolicy(workspace.root), engine: lenient });
    await assert.rejects(writer.write(".ai/tasks/escape/index.ts", "hijacked\n"), isPolicyDenied);
    assert.equal(await readFile(path.join(workspace.root, "src", "index.ts"), "utf8"), "original\n");
  } finally {
    await workspace.cleanup();
  }
});

test("AC-8 the writer is bound to an orchestrator policy, and a run's orchestrator policy owns only .ai/tasks/**", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const engine = createFakePolicyEngine();
    const implementer = engine.compute({
      mode: "autonomous",
      role: "implementer",
      runId: createId("run"),
      taskId: createId("task"),
      workspaceRoot: workspace.root,
      taskScope: { owned: ["docs/**"], read: [], forbidden: [] },
      userConfig: undefined,
      workspaceConfig: undefined,
      sandbox: TEST_SANDBOX,
      grants: [],
    });
    assert.throws(() => createControlPlaneWriter({ workspaceRoot: workspace.root, policy: implementer, engine }), /orchestrator/);

    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/a.md"], risk: "trivial" }]));
    const runtime = createTestRuntime({
      workspace,
      planner,
      policy: engine,
      ledger: true,
      script: async (script) => {
        await script.write("docs/a.md", "b\n");
        const call = await script.toolCall("exec", { exitCode: 0 });
        await script.reply(workerClaim(script, call));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const orchestrator = engine.computed.find((policy) => policy.role === "orchestrator" && policy.run_id === outcome.runId);
    assert.deepEqual(orchestrator?.write_scope, [".ai/tasks/**"]);
    assert.ok(await stat(path.join(workspace.root, ".ai", "tasks", outcome.runId, "plan.json")));
    assert.match(await readFile(path.join(workspace.root, ".ai", "tasks", outcome.runId, "report.md"), "utf8"), /doc \(implementer\): completed/);
  } finally {
    await workspace.cleanup();
  }
});

function planApprovalFixture() {
  const runId = createId("run");
  const plan = {
    schema_version: 1 as const,
    plan_id: createId("plan"),
    run_id: runId,
    version: 1,
    goal: "g",
    risk: "trivial" as const,
    scope: ["docs/**"],
    tasks: [],
    expected_external_effects: [],
    verification: [],
    budget: { max_wall_time_seconds: 60, max_steps: 10 },
    assumptions: [],
    created_at: "2026-09-22T10:00:00Z",
  };
  return { plan: plan as never, digest: sha256("plan") };
}

test("autonomous mode: the orchestrator approves its own plan, audited, without asking anyone", async () => {
  const { plan, digest } = planApprovalFixture();
  const broker = createScriptedBroker(() => ({ outcome: "rejected", decided_by: "user", mode: "autonomous" }));
  const outcome = await approvePlan({ plan, digest, mode: "autonomous", broker, now: () => new Date() }, new AbortController().signal);
  assert.equal(outcome.approved, true);
  assert.equal(outcome.decision.decided_by, "orchestrator");
  assert.equal(outcome.decision.mode, "autonomous");
  assert.equal(outcome.decision.subject_digest, digest);
  assert.equal(broker.requests.length, 0);
});

test("ask mode: the user decides; a headless broker leaves the plan unapproved", async () => {
  const { plan, digest } = planApprovalFixture();
  const allow = createScriptedBroker(() => ({ outcome: "allowed-for-scope", decided_by: "user", mode: "ask" }));
  assert.equal((await approvePlan({ plan, digest, mode: "ask", broker: allow, now: () => new Date() }, new AbortController().signal)).approved, true);
  assert.equal(allow.requests[0]?.subject_kind, "plan");
  const headless = await approvePlan({ plan, digest, mode: "ask", broker: createHeadlessBroker(), now: () => new Date() }, new AbortController().signal);
  assert.equal(headless.approved, false);
  assert.equal(headless.decision.outcome, "unavailable");
  const selfApproved = await approvePlan(
    { plan, digest, mode: "ask", broker: createScriptedBroker(() => ({ outcome: "allowed-once", decided_by: "orchestrator", mode: "ask" })), now: () => new Date() },
    new AbortController().signal,
  );
  assert.equal(selfApproved.approved, false, "the orchestrator cannot approve in ask mode");
});

test("provider changes and budget increases are never orchestrator-approvable", () => {
  const request: ApprovalRequest = {
    approval_id: createId("approval"),
    run_id: createId("run"),
    subject_kind: "provider-change",
    subject_digest: sha256("route"),
    summary: "switch provider",
    scope: "once",
    requested_at: "2026-09-22T10:00:00Z",
  };
  const decision = {
    approval_id: request.approval_id,
    subject_kind: request.subject_kind,
    subject_digest: request.subject_digest,
    outcome: "allowed-once" as const,
    decided_by: "orchestrator" as const,
    mode: "autonomous" as const,
    decided_at: "2026-09-22T10:00:00Z",
  };
  assert.equal(approvalDecisionSchema.safeParse(decision).success, false);
  assert.equal(decisionAnswers(request, decision, "autonomous"), false);
  assert.equal(decisionAnswers({ ...request, subject_kind: "budget" }, { ...decision, subject_kind: "budget" }, "autonomous"), false);
  assert.equal(decisionAnswers(request, { ...decision, decided_by: "user" }, "autonomous"), true);
});

const types = (events: readonly SessionEvent[]) => events.map((event) => event.type);

test("the coordinator records the autonomous plan approval and ask-mode rejection ends the run with exit 3", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/a.md"], risk: "trivial" }]));
    const script = async (context: Parameters<Parameters<typeof createTestRuntime>[0]["script"]>[0]) => {
      await context.write("docs/a.md", "b\n");
      const call = await context.toolCall("exec", { exitCode: 0 });
      await context.reply(workerClaim(context, call));
    };
    const autonomous = createTestRuntime({ workspace, planner, script });
    const done = await autonomous.run();
    const events = autonomous.runEvents(done);
    assert.deepEqual(replayTransitions(events), []);
    const decided = events.find((event) => event.type === "approval/decided");
    assert.ok(decided?.type === "approval/decided" && decided.data.decision.decided_by === "orchestrator" && decided.actor.kind === "orchestrator");
    assert.ok(types(events).indexOf("approval/decided") < types(events).indexOf("task/created"));

    const rejecting = createTestRuntime({ workspace, planner, script, mode: "ask", broker: createScriptedBroker(() => ({ outcome: "rejected", decided_by: "user", mode: "ask" })) });
    const rejected = await rejecting.run();
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.exitCode, 3);
    const rejectedEvents = rejecting.runEvents(rejected);
    assert.deepEqual(replayTransitions(rejectedEvents), []);
    assert.ok(!types(rejectedEvents).includes("task/created"));
    assert.equal(rejecting.driver.turns.length, 0);

    const headless = createTestRuntime({ workspace, planner, script, mode: "ask", headless: true, broker: createHeadlessBroker() });
    const unavailable = await headless.run();
    assert.equal(unavailable.exitCode, 3);
    assert.equal(headless.driver.turns.length, 0);
  } finally {
    await workspace.cleanup();
  }
});
