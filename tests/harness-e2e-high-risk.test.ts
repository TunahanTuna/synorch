import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/harness/contracts/index.ts";
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
  planArguments,
  projectionIssues,
  readSession,
  ScriptedInput,
  text,
  trustWorkspace,
  writeConfig,
  type Sandbox,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Verification level 3, "high-risk change": strong isolation (a worktree is mandatory; without git
 * the task is refused rather than run in a weaker workspace), a separate reviewer on an independent
 * model with its own evidence, explicit evidence per criterion, and in `ask` mode a human approves
 * the plan and every effectful action. Everything below the CLI is real; only models are scripted.
 */

const WEAK = 'export function check(token) {\n  return token.length > 0;\n}\n';
const STRONG = 'export function check(token) {\n  return typeof token === "string" && token.length >= 32;\n}\n';
const CHECK = 'import { check } from "./src/auth.js";\nif (check("x")) { console.error("weak token accepted"); process.exit(1); }\nif (!check("k".repeat(32))) process.exit(1);\nconsole.log("ok");\n';
const VERIFY = "node check.mjs";
const FILES = { "src/auth.js": WEAK, "check.mjs": CHECK, "package.json": '{ "type": "module" }\n', "README.md": "# auth\n" };

const ROUTES = [
  { tier: "orchestrator", adapter: "plan-script", model: "planner" },
  { tier: "complex_worker", adapter: "impl-script", model: "impl-model" },
  { tier: "complex_worker", role: "reviewer", adapter: "review-script", model: "review-model" },
  { tier: "fast_worker", adapter: "impl-script", model: "impl-model" },
] as const;

function adapters() {
  const orchestrator = createScriptedAdapter(
    [
      call("plan_propose", () =>
        planArguments("Harden token checks", [
          { key: "harden-auth", risk: "high-risk", owned: ["src/auth.js"], read: ["src/auth.js", "check.mjs"], verification: [VERIFY], criteria: ["short tokens are rejected", "32-character tokens are accepted"] },
        ]),
      ),
      text("planned"),
    ],
    { adapterId: "plan-script" },
  );
  const implementer = createScriptedAdapter(
    [
      call("write_file", () => ({ path: "src/auth.js", content: STRONG, expected_digest: sha256(WEAK) })),
      call("exec", () => ({ argv: ["node", "check.mjs"] })),
      call("task_report", (ids) => ({
        status: "completed",
        summary: "tokens shorter than 32 characters are rejected",
        acceptance_evidence: ["AC-1", "AC-2"].map((id) => ({ criterion_id: id, evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "worker" }] })),
        commands_run: [{ command: VERIFY, exit_code: 0, evidence: { kind: "tool-call", ref: ids.at(-1), produced_by: "worker" } }],
      })),
      text("implemented"),
    ],
    { adapterId: "impl-script" },
  );
  const reviewerSaw: string[] = [];
  const reviewer = createScriptedAdapter(
    [
      calls((request) => {
        reviewerSaw.push(JSON.stringify(request.messages));
        return [{ name: "exec", arguments: { argv: ["node", "check.mjs"] } }];
      }),
      call("review_report", (ids) => ({
        criteria: ["AC-1", "AC-2"].map((id) => ({ criterion_id: id, verdict: "met", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "reviewer" }] })),
        findings: [],
        decision: "accept",
      })),
      text("reviewed"),
    ],
    { adapterId: "review-script" },
  );
  return { orchestrator, implementer, reviewer, reviewerSaw };
}

async function assertHighRiskRun(sandbox: Sandbox, sessionId: string, reviewerSaw: readonly string[]): Promise<void> {
  assert.equal(await readFile(path.join(sandbox.workspace, "src/auth.js"), "utf8"), STRONG, "the reviewed artifact was integrated");
  const runLog = await readSession(sandbox.home, sessionId);
  assert.equal(eventsOf(runLog, "plan/proposed")[0]?.data.plan.risk, "high-risk");
  const attempts = eventsOf(runLog, "attempt/started");
  assert.deepEqual(attempts.map((event) => event.data.role), ["implementer", "reviewer"]);
  assert.equal(attempts[0]?.data.isolation.mode, "worktree", "a high-risk writer always gets a worktree");
  assert.equal(attempts[1]?.data.isolation.mode, "shared-read-only");
  assert.notEqual(attempts[0]?.data.session_id, attempts[1]?.data.session_id, "the reviewer runs in its own session");
  assert.equal(eventsOf(runLog, "route/decided").find((event) => event.data.decision.role === "reviewer")?.data.decision.route.model_id, "review-model");
  const review = eventsOf(runLog, "review/recorded")[0];
  assert.equal(review?.data.decision, "accept");
  assert.deepEqual(eventsOf(runLog, "task/state_changed").map((event) => event.data.to), ["ready", "running", "verifying", "reviewing", "completed"]);
  assert.ok(!reviewerSaw.some((messages) => messages.includes("implemented")), "the reviewer never sees the implementer transcript");
  for (const attempt of attempts) {
    const log = await readSession(sandbox.home, attempt.data.session_id ?? "");
    assert.deepEqual(projectionIssues(log), []);
    const exec = eventsOf(log, "tool/result_recorded").find((event) => event.data.result.exit_code !== undefined);
    assert.equal(exec?.data.result.exit_code, 0, `${attempt.data.role} produced its own passing test evidence`);
  }
  assert.deepEqual(projectionIssues(runLog), []);
}

test("high-risk change (autonomous): mandatory worktree, independent reviewer with its own evidence", async () => {
  const sandbox = await createSandbox(FILES, { git: true });
  await trustWorkspace(sandbox);
  try {
    await writeConfig(sandbox.home, ROUTES);
    const { orchestrator, implementer, reviewer, reviewerSaw } = adapters();
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Harden token checks", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, implementer, reviewer] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 0, run.stderr());
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    await assertHighRiskRun(sandbox, hello.data.session_id, reviewerSaw);
    const decided = eventsOf(await readSession(sandbox.home, hello.data.session_id), "approval/decided").map((event) => event.data.decision);
    assert.deepEqual(decided.map((decision) => `${decision.subject_kind}:${decision.decided_by}`), ["plan:orchestrator"], "autonomous mode: audited self-approval, no per-action prompt");
  } finally {
    await sandbox.cleanup();
  }
});

test("high-risk change (ask): the human approves the plan and every effectful action", async () => {
  const sandbox = await createSandbox(FILES, { git: true });
  await trustWorkspace(sandbox);
  try {
    await writeConfig(sandbox.home, ROUTES);
    const { orchestrator, implementer, reviewer, reviewerSaw } = adapters();
    const answers = new ScriptedInput("y\ny\ny\ny\ny\ny\n", true);
    const run = capture({ cwd: sandbox.workspace, stdin: answers, stdinIsTTY: true });
    const code = await runHarnessCommand(["run", "Harden token checks", "--plain", "--policy", "ask"], run.io, overridesFor(sandbox, { adapters: [orchestrator, implementer, reviewer] }));
    assert.equal(code, 0, `${run.stdout()}\n${run.stderr()}`);
    assert.match(run.stdout(), /Approval needed \(plan\): Plan v1: Harden token checks \(1 implementer; risk high-risk\)/);
    const sessionId = /Session (ses_\S+) opened/.exec(run.stdout())?.[1];
    assert.ok(sessionId !== undefined);
    await assertHighRiskRun(sandbox, sessionId, reviewerSaw);
    const runLog = await readSession(sandbox.home, sessionId);
    const plan = eventsOf(runLog, "approval/decided").find((event) => event.data.decision.subject_kind === "plan")?.data.decision;
    assert.equal(plan?.decided_by, "user", "in ask mode only a human approves a high-risk plan");
    assert.ok(eventsOf(runLog, "run/state_changed").some((event) => event.data.to === "waiting_for_approval"));
    const attempts = eventsOf(runLog, "attempt/started");
    const actionApprovals: string[] = [];
    for (const attempt of attempts) {
      const log = await readSession(sandbox.home, attempt.data.session_id ?? "");
      for (const event of eventsOf(log, "approval/decided")) actionApprovals.push(`${attempt.data.role}:${event.data.decision.decided_by}:${event.data.decision.outcome}`);
    }
    assert.deepEqual(actionApprovals, ["implementer:user:allowed-once", "implementer:user:allowed-once", "reviewer:user:allowed-once"], "the write and both test runs were approved by the user");
  } finally {
    await sandbox.cleanup();
  }
});

test("high-risk change without git is refused instead of running in a weaker workspace (exit 6)", async () => {
  const sandbox = await createSandbox(FILES);
  await trustWorkspace(sandbox);
  try {
    await writeConfig(sandbox.home, ROUTES);
    const { orchestrator, implementer, reviewer } = adapters();
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Harden token checks", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, implementer, reviewer] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 6, run.stderr());
    assert.equal(implementer.requests.length, 0, "no worker ran");
    assert.equal(await readFile(path.join(sandbox.workspace, "src/auth.js"), "utf8"), WEAK);
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const blocked = eventsOf(await readSession(sandbox.home, hello.data.session_id), "task/state_changed").at(-1);
    assert.equal(blocked?.data.to, "blocked");
    assert.match(blocked?.data.reason ?? "", /high-risk writing task requires a worktree/);
  } finally {
    await sandbox.cleanup();
  }
});
