import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { sha256, type ModelRequest } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import {
  call,
  calls,
  capture,
  createSandbox,
  eventsOf,
  overridesFor,
  parseFrames,
  projectionIssues,
  readSession,
  text,
  trustWorkspace,
  writeConfig,
  type Sandbox,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Regression tests for the first live run (real subscription models, Windows, autonomous, trusted
 * workspace) of `syn run "src-add.mjs içindeki add fonksiyonu yanlış hesaplıyor. Düzelt; node
 * check.mjs 'ok' yazdırmalı."`, which failed with exit 5:
 *
 * - the orchestrator asked the user for profile approval in text (the constitution says so);
 * - the plan put `node check.mjs` on an explorer, which has no exec tool;
 * - the explorer tried to read_file its skill under .ai/skills (outside its read scope);
 * - its `partial` report was retried identically and the run failed before fix-add ran.
 *
 * Real store, policy, gateway, tools, worktree isolation, evidence verification and review gate;
 * only the models are scripted.
 */

const GOAL = "src-add.mjs içindeki add fonksiyonu yanlış hesaplıyor. Düzelt; node check.mjs 'ok' yazdırmalı.";
const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
const CHECK = 'import { add } from "./src-add.mjs";\nif (add(2, 3) !== 5) { console.error("add is wrong"); process.exit(1); }\nconsole.log("ok");\n';
const VERIFY = "node check.mjs";

interface TaskShape {
  readonly key: string;
  readonly role: "explorer" | "implementer" | "reviewer";
  readonly dependsOn?: readonly string[];
  readonly owned?: readonly string[];
  readonly read?: readonly string[];
  readonly risk?: "trivial" | "standard";
  readonly tier: "fast_worker" | "complex_worker";
  readonly criteria: readonly string[];
  readonly verification?: readonly string[];
}

function plan(tasks: readonly TaskShape[]): Record<string, unknown> {
  return {
    goal: GOAL,
    risk: "standard",
    scope: ["src-add.mjs", "check.mjs"],
    tasks: tasks.map((task) => ({
      key: task.key,
      role: task.role,
      objective: `Do ${task.key}.`,
      depends_on: task.dependsOn ?? [],
      owned_paths: task.owned ?? [],
      read_paths: task.read ?? ["src-add.mjs", "check.mjs"],
      risk: task.risk ?? "standard",
      model_tier: task.tier,
      acceptance_criteria: task.criteria.map((statement, index) => ({ id: `AC-${index + 1}`, statement })),
      verification: task.verification ?? [],
    })),
    expected_external_effects: [],
    verification: [],
    budget: { max_wall_time_seconds: 600, max_steps: 90 },
    assumptions: [],
  };
}

/** The plan of the live run: the explorer must "run node check.mjs", which it cannot. */
const LIVE_PLAN = plan([
  { key: "explore-add", role: "explorer", tier: "fast_worker", risk: "trivial", verification: [VERIFY], criteria: ["add fonksiyonunun hatası bulunur", "Başlangıç durumu node check.mjs çalıştırılarak kaydedilir"] },
  { key: "fix-add", role: "implementer", dependsOn: ["explore-add"], owned: ["src-add.mjs"], tier: "complex_worker", verification: [VERIFY], criteria: ["node check.mjs prints ok"] },
  { key: "review-add", role: "reviewer", dependsOn: ["fix-add"], tier: "complex_worker", criteria: ["the fix changes nothing but add"] },
]);

const FIXED_PLAN = plan([
  { key: "explore-add", role: "explorer", tier: "fast_worker", risk: "trivial", criteria: ["the faulty line of add is identified"] },
  { key: "fix-add", role: "implementer", dependsOn: ["explore-add"], owned: ["src-add.mjs"], tier: "complex_worker", verification: [VERIFY], criteria: ["node check.mjs prints ok"] },
  { key: "review-add", role: "reviewer", dependsOn: ["fix-add"], tier: "complex_worker", criteria: ["the fix changes nothing but add"] },
]);

function systemText(request: ModelRequest): string {
  return request.system.map((block) => block.text).join("\n");
}

function toolErrors(request: ModelRequest): string[] {
  return request.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "tool_result" && part.is_error ? [part.text] : [])),
  );
}

function toolResults(request: ModelRequest): string {
  return request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "tool_result" ? [part.text] : []))).join("\n");
}

async function liveSandbox(): Promise<Sandbox> {
  const sandbox = await createSandbox({ "src-add.mjs": BUGGY, "check.mjs": CHECK, "package.json": '{ "type": "module" }\n' }, { git: true });
  await trustWorkspace(sandbox);
  await writeConfig(sandbox.home, [
    { tier: "orchestrator", adapter: "plan-script", model: "astra" },
    { tier: "fast_worker", adapter: "explore-script", model: "luna" },
    { tier: "complex_worker", adapter: "impl-script", model: "sol" },
    { tier: "complex_worker", role: "reviewer", adapter: "review-script", model: "sol-review" },
  ]);
  return sandbox;
}

function implementerScript(seen: string[]) {
  return createScriptedAdapter(
    [
      calls((request) => {
        seen.push(systemText(request));
        return [{ name: "write_file", arguments: { path: "src-add.mjs", content: FIXED, expected_digest: sha256(BUGGY) } }];
      }),
      call("exec", () => ({ argv: ["node", "check.mjs"] })),
      call("task_report", (ids) => ({
        status: "completed",
        summary: "add() now adds; node check.mjs prints ok",
        acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "worker" }] }],
        commands_run: [{ command: VERIFY, exit_code: 0, evidence: { kind: "tool-call", ref: ids.at(-1), produced_by: "worker" } }],
      })),
      text("implemented"),
    ],
    { adapterId: "impl-script" },
  );
}

function reviewerScript(seen: string[]) {
  return createScriptedAdapter(
    [
      calls((request) => {
        seen.push(systemText(request));
        return [{ name: "exec", arguments: { argv: ["node", "check.mjs"] } }];
      }),
      call("review_report", (ids) => ({
        criteria: [
          { criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "reviewer" }] },
          { criterion_id: "AC-2", verdict: "met", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "reviewer" }] },
        ],
        findings: [],
        decision: "accept",
      })),
      text("reviewed"),
    ],
    { adapterId: "review-script" },
  );
}

test("live run 1: an explorer verification plan is rejected in-turn, re-proposed, and the run completes with context-served skills", async () => {
  const sandbox = await liveSandbox();
  try {
    const orchestratorSeen: ModelRequest[] = [];
    const orchestrator = createScriptedAdapter(
      [
        calls((request) => {
          orchestratorSeen.push(request);
          return [{ name: "plan_propose", arguments: LIVE_PLAN }];
        }),
        calls((request) => {
          orchestratorSeen.push(request);
          return [{ name: "plan_propose", arguments: FIXED_PLAN }];
        }),
        text("planned"),
      ],
      { adapterId: "plan-script" },
    );
    const explorerSeen: ModelRequest[] = [];
    const explorer = createScriptedAdapter(
      [
        calls((request) => {
          explorerSeen.push(request);
          return [
            { name: "read_file", arguments: { path: ".ai/skills/codebase-exploration/SKILL.md" } },
            { name: "read_file", arguments: { path: "src-add.mjs" } },
          ];
        }),
        calls((request) => {
          explorerSeen.push(request);
          return [
            { name: "load_skill", arguments: { name: "project-discovery" } },
            { name: "load_skill", arguments: { name: "implementation" } },
          ];
        }),
        calls((request, ids) => {
          explorerSeen.push(request);
          return [
            {
              name: "task_report",
              arguments: {
                status: "completed",
                summary: "src-add.mjs line 2 returns a - b instead of a + b",
                acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "tool-call", ref: ids[1], produced_by: "worker" }] }],
              },
            },
          ];
        }),
        text("explored"),
      ],
      { adapterId: "explore-script" },
    );
    const implementerSeen: string[] = [];
    const reviewerSeen: string[] = [];

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(
      ["run", GOAL, "--mode", "jsonl"],
      run.io,
      overridesFor(sandbox, { adapters: [orchestrator, explorer, implementerScript(implementerSeen), reviewerScript(reviewerSeen)] }),
    );
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${last?.type === "result" ? JSON.stringify(last.data) : JSON.stringify(last)}`);
    assert.equal(await readFile(path.join(sandbox.workspace, "src-add.mjs"), "utf8"), FIXED);

    // (4) The orchestrator is told, with harness priority, that approvals and the profile are the runtime's job.
    const orchestratorSystem = systemText(orchestratorSeen[0] as ModelRequest);
    assert.match(orchestratorSystem, /this run is autonomous/);
    assert.match(orchestratorSystem, /Do not ask the user for plan, profile or execution approval/);
    assert.match(orchestratorSystem, /never ask the user to confirm or choose a model profile/);
    assert.match(orchestratorSystem, /do not read \.ai\/\*\*, AGENTS\.md or CLAUDE\.md with tools/);
    const harnessBlock = orchestratorSeen[0]?.system.find((block) => block.source === "harness");
    assert.equal(harnessBlock?.trust, "harness", "the approval rule is a harness-trust block, above the repository constitution");
    // (1) It plans with the role capability table and gets a structured, in-turn rejection of the live plan.
    assert.match(orchestratorSystem, /explorer: reads and searches inside its read_paths; runs NO commands/);
    const rejection = toolErrors(orchestratorSeen[1] as ModelRequest).join("\n");
    assert.match(rejection, /explore-add \(explorer\): the explorer role cannot run commands/);
    assert.match(rejection, /move it to fix-add/);
    assert.match(rejection, /AC-2: it requires running "node check\.mjs"/);
    assert.match(rejection, /call plan_propose again with the whole corrected plan/);

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    assert.deepEqual(projectionIssues(runLog), []);
    const proposed = eventsOf(runLog, "plan/proposed");
    assert.equal(proposed.length, 1, "only the corrected plan is recorded and approved");
    assert.deepEqual(proposed[0]?.data.plan.tasks[0]?.verification, []);
    const approval = eventsOf(runLog, "approval/decided")[0];
    assert.equal(approval?.data.decision.decided_by, "orchestrator", "autonomous self-approval, audited");

    // (3)(5) The explorer has its skill and the constitution in context; skills come through context, not through reads.
    const explorerSystem = systemText(explorerSeen[0] as ModelRequest);
    assert.ok(explorerSeen[0]?.system.some((block) => block.id === "skill:codebase-exploration" && block.trust === "project"), "the role's skill is loaded through the ContextBuilder");
    assert.ok(explorerSeen[0]?.system.some((block) => block.source === "constitution"), "the constitution reaches the explorer through context");
    assert.match(explorerSystem, /there is no exec tool/);
    assert.ok(!(explorerSeen[0]?.tools ?? []).some((tool) => tool.name === "exec"));
    // K1.6-P2: explorers read the whole workspace (read-only); the skill file is simply not there, its content is in context.
    assert.doesNotMatch(toolResults(explorerSeen[1] as ModelRequest), /outside the read scope/, "an explorer's read scope is the whole workspace");
    const loads = toolResults(explorerSeen[2] as ModelRequest);
    assert.match(loads, /Skill project-discovery/, "load_skill serves a catalog skill of the role");
    assert.match(loads, /skill implementation is not in the explorer catalog/, "a skill the manifest forbids is refused");

    const attempts = eventsOf(runLog, "attempt/started");
    assert.deepEqual(attempts.map((event) => event.data.role), ["explorer", "implementer", "reviewer"], "one attempt each; the reviewer task is the mandatory review");
    assert.ok(implementerSeen[0]?.includes("Finding from explore-add: src-add.mjs line 2 returns a - b"), "the explorer's findings reach the implementer's packet");
    assert.ok(reviewerSeen[0]?.includes("(reviewer task review-add) the fix changes nothing but add"), "the reviewer task's criteria join the independent review");

    assert.ok(last?.type === "result");
    assert.deepEqual(last.data.tasks.map((task) => task.state), ["completed", "completed", "completed"]);
    const reviewTaskStates = eventsOf(runLog, "task/state_changed")
      .filter((event) => event.data.task_id === last.data.tasks[2]?.task_id)
      .map((event) => event.data.to);
    assert.deepEqual(reviewTaskStates, ["ready", "running", "verifying", "completed"]);
  } finally {
    await sandbox.cleanup();
  }
});

test("live run 1: a plan that keeps ignoring role capabilities fails after two revisions with a clear message", async () => {
  const sandbox = await liveSandbox();
  try {
    const orchestrator = createScriptedAdapter(
      [call("plan_propose", () => LIVE_PLAN), call("plan_propose", () => LIVE_PLAN), call("plan_propose", () => LIVE_PLAN), text("I give up")],
      { adapterId: "plan-script" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const idle = ["explore-script", "impl-script", "review-script"].map((adapterId) => createScriptedAdapter([], { adapterId }));
    const code = await runHarnessCommand(["run", GOAL, "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, ...idle] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 5);
    const last = frames.at(-1);
    assert.ok(last?.type === "result");
    assert.match(last.data.summary, /no valid plan: the plan was rejected 3 time\(s\) \(revision limit 2\)/);
    assert.match(last.data.summary, /explorer role cannot run commands/);
    assert.equal(orchestrator.requests.length, 4, "one planning turn: three rejected proposals, then the turn ends; no second turn");
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    assert.equal(eventsOf(runLog, "plan/proposed").length, 0);
    assert.equal(eventsOf(runLog, "attempt/started").length, 0, "nothing runs without a valid plan");
  } finally {
    await sandbox.cleanup();
  }
});

test("live run 1: an explorer's partial report goes to orchestrator triage instead of a blind retry", async () => {
  const sandbox = await liveSandbox();
  try {
    const triagePrompts: string[] = [];
    const orchestrator = createScriptedAdapter(
      [
        call("plan_propose", () =>
          plan([
            { key: "explore-add", role: "explorer", tier: "fast_worker", risk: "trivial", criteria: ["the faulty line of add is identified", "the current output of the check script is recorded"] },
            { key: "fix-add", role: "implementer", dependsOn: ["explore-add"], owned: ["src-add.mjs"], tier: "complex_worker", verification: [VERIFY], criteria: ["node check.mjs prints ok"] },
          ]),
        ),
        // ADR-20: an accepted plan_propose ends the turn; the next request is the triage turn.
        calls((request) => {
          const lastUser = request.messages.filter((message) => message.role === "user").at(-1);
          triagePrompts.push(JSON.stringify(lastUser?.content ?? []));
          return [{ name: "task_triage", arguments: { task: "explore-add", decision: "accept", waive_criteria: ["AC-2"], guidance: "fix-add runs the check" } }];
        }),
        text("decided"),
      ],
      { adapterId: "plan-script" },
    );
    const explorer = createScriptedAdapter(
      [
        call("read_file", () => ({ path: "src-add.mjs" })),
        call("task_report", (ids) => ({
          status: "partial",
          summary: "line 2 returns a - b; the check output could not be recorded (no exec tool)",
          acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "tool-call", ref: ids.at(-1), produced_by: "worker" }] }],
          skipped_checks: [{ check: "AC-2", reason: "explorer has no command execution tool" }],
        })),
        text("explored"),
      ],
      { adapterId: "explore-script" },
    );
    const implementerSeen: string[] = [];
    const reviewer = createScriptedAdapter(
      [
        call("exec", () => ({ argv: ["node", "check.mjs"] })),
        call("review_report", (ids) => ({
          criteria: [{ criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "reviewer" }] }],
          findings: [],
          decision: "accept",
        })),
        text("reviewed"),
      ],
      { adapterId: "review-script" },
    );

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", GOAL, "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, explorer, implementerScript(implementerSeen), reviewer] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${last?.type === "result" ? JSON.stringify(last.data) : JSON.stringify(last)}`);
    assert.equal(await readFile(path.join(sandbox.workspace, "src-add.mjs"), "utf8"), FIXED);

    assert.match(triagePrompts[0] ?? "", /Worker report needs your decision/);
    assert.match(triagePrompts[0] ?? "", /AC-1 \[resolved\]/, "F10: the triage prompt shows the evidence after resolution");
    assert.match(triagePrompts[0] ?? "", /AC-2 \[missing\]/);
    assert.match(triagePrompts[0] ?? "", /explorer has no command execution tool/);

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    assert.deepEqual(projectionIssues(runLog), []);
    const attempts = eventsOf(runLog, "attempt/started");
    assert.deepEqual(attempts.map((event) => event.data.role), ["explorer", "implementer", "reviewer"], "no identical explorer retry");
    assert.ok(last?.type === "result");
    const explorerStates = eventsOf(runLog, "task/state_changed")
      .filter((event) => event.data.task_id === last.data.tasks[0]?.task_id)
      .map((event) => event.data.to);
    assert.deepEqual(explorerStates, ["ready", "running", "verifying", "completed"]);
    assert.ok(
      implementerSeen[0]?.includes("Note from explore-add: not established by this explorer (waived by the orchestrator in triage): AC-2 the current output of the check script is recorded"),
      "the waived criterion reaches the dependent implementer",
    );
  } finally {
    await sandbox.cleanup();
  }
});
