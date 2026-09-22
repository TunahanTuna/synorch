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
  projectionIssues,
  planArguments,
  readSession,
  text,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Verification level 3, "standard code change" (I5 AC-5): plan -> task packet -> diff in an
 * isolated git worktree -> the packet's test command -> independent review on a different model in
 * a separate session -> integration -> per-criterion report. Real store, policy, gateway, exec,
 * worktree isolation, evidence verification and review gate; only the model is scripted.
 */

const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
const CHECK = 'import { add } from "./src/add.js";\nif (add(2, 3) !== 5) { console.error("add is wrong"); process.exit(1); }\nconsole.log("ok");\n';
const VERIFY = "node check.mjs";

test("standard code change: plan, packet, diff, test, independent review and report (AC-5)", async () => {
  const sandbox = await createSandbox({ "src/add.js": BUGGY, "check.mjs": CHECK, "package.json": '{ "type": "module" }\n', "README.md": "# calc\n" }, { git: true });
  try {
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "impl-script", model: "impl-model" },
      { tier: "complex_worker", role: "reviewer", adapter: "review-script", model: "review-model" },
      { tier: "fast_worker", adapter: "impl-script", model: "impl-model" },
    ]);
    const orchestrator = createScriptedAdapter(
      [
        call("plan_propose", () =>
          planArguments("Fix add()", [{ key: "fix-add", risk: "standard", owned: ["src/add.js"], read: ["src/add.js", "check.mjs"], verification: [VERIFY], criteria: ["add(2, 3) returns 5"] }]),
        ),
        text("planned"),
      ],
      { adapterId: "plan-script" },
    );
    const implementer = createScriptedAdapter(
      [
        call("write_file", () => ({ path: "src/add.js", content: FIXED, expected_digest: sha256(BUGGY) })),
        call("exec", () => ({ argv: ["node", "check.mjs"] })),
        call("task_report", (ids) => ({
          status: "completed",
          summary: "add() now adds; the check passes",
          acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "worker" }] }],
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
          criteria: [{ criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "reviewer" }] }],
          findings: [],
          decision: "accept",
        })),
        text("reviewed"),
      ],
      { adapterId: "review-script" },
    );

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Fix add()", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, implementer, reviewer] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 0, `${run.stderr()}\n${frames.at(-1)?.type === "result" ? JSON.stringify(frames.at(-1)) : ""}`);

    assert.equal(await readFile(path.join(sandbox.workspace, "src/add.js"), "utf8"), FIXED, "the reviewed artifact was integrated");
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);

    const plan = eventsOf(runLog, "plan/proposed")[0]?.data.plan;
    assert.equal(plan?.tasks[0]?.risk, "standard");
    const packets = eventsOf(runLog, "task/packet_issued");
    assert.ok(packets.length >= 2, "a packet for the implementer and a fresh one for the reviewer");
    const attempts = eventsOf(runLog, "attempt/started");
    assert.deepEqual(attempts.map((event) => event.data.role), ["implementer", "reviewer"]);
    assert.equal(attempts[0]?.data.isolation.mode, "worktree", "a git workspace gets a worktree per writing attempt");
    assert.ok(attempts[0]?.data.isolation.path?.startsWith(path.join(sandbox.home, "worktrees")), "worktrees live under the synorch home");
    assert.equal(attempts[1]?.data.isolation.mode, "shared-read-only");
    assert.notEqual(attempts[0]?.data.session_id, attempts[1]?.data.session_id, "the reviewer runs in its own session");

    const reviewerRoute = eventsOf(runLog, "route/decided").find((event) => event.data.decision.role === "reviewer")?.data.decision;
    assert.equal(reviewerRoute?.route.model_id, "review-model", "the reviewer prefers a model independent of the implementer");
    const review = eventsOf(runLog, "review/recorded")[0];
    assert.equal(review?.data.decision, "accept");
    assert.equal(eventsOf(runLog, "task/integrated").length, 1);
    const states = eventsOf(runLog, "task/state_changed").map((event) => event.data.to);
    assert.deepEqual(states, ["ready", "running", "verifying", "reviewing", "completed"]);

    const implementerLog = await readSession(sandbox.home, attempts[0]?.data.session_id ?? "");
    const reviewerLog = await readSession(sandbox.home, attempts[1]?.data.session_id ?? "");
    for (const log of [runLog, implementerLog, reviewerLog]) assert.deepEqual(projectionIssues(log), [], "every recorded session replays through the recovery projection");
    const execResult = eventsOf(implementerLog, "tool/result_recorded").find((event) => event.data.result.exit_code !== undefined);
    assert.equal(execResult?.data.result.exit_code, 0, "the verification command ran and passed");
    assert.ok(!reviewerSaw.some((messages) => messages.includes("implemented")), "the reviewer never sees the implementer transcript");
    assert.ok(reviewerSaw.some((messages) => messages.includes("Independent review")), "the reviewer gets the completion packet and changed files");

    const last = frames.at(-1);
    assert.ok(last?.type === "result");
    assert.deepEqual(last.data.tasks.map((task) => task.state), ["completed"]);

    const show = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["show", last.run_id, "--json"], show.io, overridesFor(sandbox)), 0);
    const report = JSON.parse(show.stdout()) as { reviews: { decision: string }[]; evidence: { criteria: { criterion_id: string }[]; commands: { command: string; exit_code: number }[] }[]; usage: { source: string } };
    assert.deepEqual(report.reviews.map((entry) => entry.decision), ["accept"]);
    assert.deepEqual(report.evidence[0]?.commands, [{ command: VERIFY, exit_code: 0 }]);
    assert.equal(report.usage.source, "provider-reported");
  } finally {
    await sandbox.cleanup();
  }
});
