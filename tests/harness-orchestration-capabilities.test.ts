import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createId,
  ROLE_CAPABILITIES,
  WORKER_ROLES,
  type CompletionPacket,
  type PlanId,
  type RunId,
  type TaskContextPacket,
} from "../src/harness/contracts/index.ts";
import { loadCanonicalStructure } from "../src/harness/cli/index.ts";
import { harnessInstructions } from "../src/harness/context/index.ts";
import { modelVisibleText } from "../src/harness/core/driver.ts";
import { commandMentioned, createDelegationSlot, retryNotes, validatePlan, type Planner } from "../src/harness/orchestration/index.ts";
import { createTempWorkspace, createTestRuntime, replayTransitions, testPlan, workerClaim } from "../src/harness/orchestration/testing.ts";
import { ROLE_EFFECT_CEILINGS } from "../src/harness/policy/index.ts";
import { createToolRegistry } from "../src/harness/tools/index.ts";
import { createStructureFiles } from "../src/templates/structure-templates.ts";

/**
 * Findings of the first live run, below the end-to-end level: plans are checked against what each
 * role can do, the role capability table agrees with the policy engine, worker reports that are not
 * `completed` are triaged or retried with the previous report (never identically), and repository
 * guidance reaches every role through context.
 */

const RUN = createId("run") as RunId;
const PLAN = createId("plan") as PlanId;

function candidate(tasks: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema_version: 1,
    plan_id: PLAN,
    run_id: RUN,
    version: 1,
    goal: "fix add",
    risk: "standard",
    scope: ["src/**"],
    tasks: tasks.map((task) => ({
      objective: "do it",
      depends_on: [],
      owned_paths: [],
      read_paths: [],
      risk: "standard",
      model_tier: "complex_worker",
      acceptance_criteria: [{ id: "AC-1", statement: "done" }],
      verification: [],
      ...task,
    })),
    expected_external_effects: [],
    verification: [],
    budget: { max_wall_time_seconds: 60, max_steps: 20 },
    assumptions: [],
    created_at: new Date().toISOString(),
  };
}

const EXPECTED = { runId: RUN, planId: PLAN, version: 1 };

test("plan validation rejects commands on an explorer and names the task that can run them", () => {
  const result = validatePlan(
    candidate([
      {
        key: "explore",
        role: "explorer",
        verification: ["node check.mjs"],
        acceptance_criteria: [
          { id: "AC-1", statement: "the bug is located" },
          { id: "AC-2", statement: "Başlangıç durumu node check.mjs çalıştırılarak kaydedilir" },
          { id: "AC-3", statement: "`pnpm test` passes before any change" },
        ],
      },
      { key: "fix", role: "implementer", depends_on: ["explore"], owned_paths: ["src/add.js"], verification: ["node check.mjs"] },
    ]),
    EXPECTED,
  );
  assert.equal(result.ok, false);
  const issues = result.ok ? [] : result.issues;
  assert.equal(issues.length, 3, issues.join("\n"));
  assert.match(issues[0] ?? "", /tasks\[0\] explore \(explorer\): the explorer role cannot run commands .*verification \[node check\.mjs\].*move it to fix/);
  assert.match(issues[1] ?? "", /AC-2: it requires running "node check\.mjs"/);
  assert.match(issues[2] ?? "", /AC-3: it requires running "pnpm test"/);
});

test("reviewer plan tasks must depend on standard/high-risk work; a sound plan passes", () => {
  const lone = validatePlan(candidate([{ key: "review", role: "reviewer" }]), EXPECTED);
  assert.ok(!lone.ok && lone.issues.some((issue) => /add depends_on/.test(issue)));
  const trivial = validatePlan(
    candidate([
      { key: "fix", role: "implementer", owned_paths: ["src/a.js"], risk: "trivial" },
      { key: "review", role: "reviewer", depends_on: ["fix"] },
    ]),
    EXPECTED,
  );
  assert.ok(!trivial.ok && trivial.issues.some((issue) => /depends on fix, which is trivial/.test(issue)));
  const sound = validatePlan(
    candidate([
      { key: "explore", role: "explorer", acceptance_criteria: [{ id: "AC-1", statement: "the node module that computes add is found" }] },
      { key: "fix", role: "implementer", depends_on: ["explore"], owned_paths: ["src/a.js"], verification: ["node check.mjs"] },
      { key: "review", role: "reviewer", depends_on: ["fix"], verification: ["node check.mjs"] },
      { key: "rca", role: "debugger", verification: ["node check.mjs"] },
    ]),
    EXPECTED,
  );
  assert.ok(sound.ok, sound.ok ? "" : sound.issues.join("\n"));
});

test("commandMentioned flags command lines, not prose", () => {
  for (const statement of ["run node check.mjs", "`npm test` is green", "go test ./... passes", "pnpm run check exits 0", "python -m pytest tests/"]) {
    assert.ok(commandMentioned(statement, []) !== undefined, statement);
  }
  for (const statement of ["the node module is found", "go to the add function", "tests are listed", "npm packages are named in the report"]) {
    assert.equal(commandMentioned(statement, []), undefined, statement);
  }
  assert.equal(commandMentioned("the smoke script passes", ["the smoke script"]), "the smoke script");
});

test("the role capability table agrees with the policy engine and the exec tool", () => {
  const exec = createToolRegistry().get("exec");
  for (const role of WORKER_ROLES) {
    const runs = ROLE_CAPABILITIES[role].commands !== "none";
    assert.equal(ROLE_EFFECT_CEILINGS[role].exec !== "deny", runs, `${role}: exec ceiling`);
    assert.equal(exec?.metadata.visible_to.includes(role) ?? false, runs, `${role}: exec visibility`);
    assert.equal(ROLE_EFFECT_CEILINGS[role]["workspace-write"] !== "deny", ROLE_CAPABILITIES[role].writes !== "never", `${role}: write ceiling`);
  }
});

test("the orchestrator is told how approvals work in each mode, with harness priority", () => {
  const autonomous = harnessInstructions("orchestrator", { mode: "autonomous" });
  assert.match(autonomous, /this run is autonomous/);
  assert.match(autonomous, /Do not ask the user for plan, profile or execution approval in text/);
  assert.match(autonomous, /satisfied by this runtime policy/);
  assert.match(autonomous, /Worker role capabilities/);
  const ask = harnessInstructions("orchestrator", { mode: "ask" });
  assert.match(ask, /collects the approval in its own interface/);
  assert.doesNotMatch(ask, /this run is autonomous/);
  const explorer = harnessInstructions("explorer", { mode: "autonomous" });
  assert.match(explorer, /do not read \.ai\/\*\*, AGENTS\.md or CLAUDE\.md with tools/);
  assert.match(explorer, /call load_skill/);
  assert.doesNotMatch(explorer, /Worker role capabilities/);
});

test("tool errors reach the model with their code and message", () => {
  assert.equal(modelVisibleText({ text: "", error: { code: "invalid_arguments", message: "plan rejected" } }), "Error [invalid_arguments]: plan rejected");
  assert.equal(modelVisibleText({ text: "partial", error: { code: "timeout", message: "slow" } }), "partial\nError [timeout]: slow");
  assert.equal(modelVisibleText({ text: "ok", error: undefined }), "ok");
});

test("retry notes carry the previous report, never an identical retry", () => {
  const completion = {
    attempt_id: createId("attempt"),
    status: "partial",
    summary: "found the bug; could not run the check",
    acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "tool-call", ref: "call_x", produced_by: "worker" }] }],
    skipped_checks: [{ check: "node check.mjs", reason: "no exec tool" }],
    unresolved_risks: ["the output is unverified"],
  } as unknown as CompletionPacket;
  const notes = retryNotes(completion, [{ id: "AC-1" }, { id: "AC-2" }], "read check.mjs instead");
  assert.match(notes[0] ?? "", /reported partial: found the bug/);
  assert.ok(notes.includes("Orchestrator guidance: read check.mjs instead"));
  assert.ok(notes.includes("Previous attempt did not evidence AC-2"));
  assert.ok(notes.includes("Previous attempt skipped node check.mjs: no exec tool"));
  assert.ok(notes.includes("Previous attempt left unresolved: the output is unverified"));
});

function partialExplorer(packet: TaskContextPacket | undefined): boolean {
  return packet?.role === "explorer";
}

test("without a triage-capable planner, a partial report is retried once with the report in the delta packet", async () => {
  const workspace = await createTempWorkspace({ "src/a.js": "a\n" }, { git: false });
  try {
    const planner: Planner = { propose: async (input) => testPlan(input, [{ key: "explore", role: "explorer", risk: "trivial" }]) };
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        const call = await context.toolCall("read_file", { text: "a" });
        await context.reply(workerClaim(context, call, { status: "partial", summary: "half done", skipped_checks: [{ check: "AC-9", reason: "impossible here" }] }));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.exitCode, 5);
    const turns = runtime.driver.turns.filter((turn) => partialExplorer(turn.input.packet));
    assert.equal(turns.length, 2, "one retry, then the task fails");
    // F19: the delta's notes reach the next attempt in its task message, not as copies in packet decisions.
    const message = turns[1]?.input.userMessage ?? "";
    assert.match(message, /Notes for this attempt[^]*- Previous attempt .* reported partial: half done/);
    assert.ok(message.includes("- Previous attempt skipped AC-9: impossible here"), message);
    assert.ok(!(turns[1]?.input.packet?.decisions ?? []).some((line) => line.includes("Previous attempt")));
    assert.deepEqual(replayTransitions(runtime.runEvents(outcome)), []);
  } finally {
    await workspace.cleanup();
  }
});

test("orchestrator triage: accept is refused for a writing task, fail stops the task without a retry", async () => {
  const workspace = await createTempWorkspace({ "src/a.js": "a\n", "src/b.js": "b\n" }, { git: false });
  try {
    const slot = createDelegationSlot();
    const answers: string[] = [];
    const planner: Planner = {
      propose: async (input) =>
        testPlan(input, [
          { key: "fix", owned_paths: ["src/a.js"], risk: "trivial" },
          { key: "after", owned_paths: ["src/b.js"], depends_on: ["fix"], risk: "trivial" },
        ]),
      async triage(input) {
        const port = slot.current();
        assert.ok(port?.triage !== undefined);
        const caller = { runId: input.runId, role: "orchestrator" as const, toolCallId: "call_triage" };
        assert.equal(input.acceptable, false);
        for (const decision of [
          { task: "other", decision: "fail" as const },
          { task: "fix", decision: "accept" as const },
          { task: "fix", decision: "fail" as const, guidance: "out of scope" },
          { task: "fix", decision: "retry" as const },
        ]) {
          const result = port.triage(decision, caller);
          answers.push(result.ok ? `ok: ${result.text}` : `${result.code}: ${result.message}`);
        }
      },
    };
    const runtime = createTestRuntime({
      workspace,
      planner,
      delegation: slot,
      script: async (context) => {
        // No change produced: a partial report with an artifact would go to review instead of triage.
        const call = await context.toolCall("exec", { exitCode: 0 });
        await context.reply(workerClaim(context, call, { status: "partial", summary: "could not finish" }));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.exitCode, 5);
    assert.match(answers[0] ?? "", /^execution_failed: no report of task other is being triaged; the report under triage is fix/);
    assert.match(answers[1] ?? "", /^invalid_arguments: accept is only for read-only tasks that changed nothing/);
    assert.match(answers[2] ?? "", /^ok: decision for fix recorded: fail/);
    assert.match(answers[3] ?? "", /^invalid_arguments: task fix is already decided/);
    assert.equal(runtime.driver.turns.length, 1, "no retry after the orchestrator failed the task");
    const events = runtime.runEvents(outcome);
    const states = events.flatMap((event) => (event.type === "task/state_changed" ? [`${event.data.to}`] : []));
    assert.deepEqual(states, ["ready", "running", "failed"], "fix fails without a retry; its dependent never starts");
    assert.deepEqual(replayTransitions(events), []);
  } finally {
    await workspace.cleanup();
  }
});

test("role manifests' skills are primary; a custom AGENTS.md reaches context, the generated one does not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-live-"));
  try {
    const builtin = await loadCanonicalStructure(root);
    assert.deepEqual(await builtin.skills.primary?.("explorer"), ["codebase-exploration"]);
    assert.deepEqual(await builtin.skills.primary?.("implementer"), ["implementation"]);
    assert.deepEqual(await builtin.skills.primary?.("reviewer"), ["code-review"]);
    assert.equal(builtin.instructions.entrypoint, undefined, "no AGENTS.md");

    const generated = createStructureFiles("repository").find((file) => file.relativePath === "AGENTS.md")?.content ?? "";
    await writeFile(path.join(root, "AGENTS.md"), generated.replaceAll("\n", "\r\n"));
    assert.equal((await loadCanonicalStructure(root)).instructions.entrypoint, undefined, "the unmodified Synorch entrypoint is left out");

    await writeFile(path.join(root, "AGENTS.md"), "# Repo rules\n\nUse tabs. Run `node check.mjs` after edits.\n");
    const custom = await loadCanonicalStructure(root);
    assert.equal(custom.instructions.entrypoint?.path, "AGENTS.md");
    assert.match(custom.instructions.entrypoint?.text ?? "", /performed by the Synorch runtime\):\n# Repo rules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
