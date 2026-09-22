import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import {
  call,
  capture,
  createSandbox,
  eventsOf,
  frameEvents,
  overridesFor,
  parseFrames,
  projectionIssues,
  planArguments,
  readSession,
  taskReport,
  text,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Verification level 3, "trivial doc fix" (I5 AC-5): one worker, targeted evidence, no review and
 * no approval beyond the orchestrator's audited self-approval of its own plan (autonomous mode).
 * Everything below the CLI is real: session store, policy, gateway, tools, isolation, coordinator.
 */

const README = "# Synorch\n\nThis is teh readme.\n";
const FIXED = "# Synorch\n\nThis is the readme.\n";

test("trivial doc fix: a single worker, targeted evidence, no redundant review or approval (AC-5)", async () => {
  const sandbox = await createSandbox({ "README.md": README });
  try {
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "worker-script", model: "worker" },
      { tier: "fast_worker", adapter: "worker-script", model: "worker" },
    ]);
    const orchestrator = createScriptedAdapter(
      [call("plan_propose", () => planArguments("Fix the typo in README.md", [{ key: "fix-typo", risk: "trivial", owned: ["README.md"], read: ["README.md"], tier: "fast_worker" }])), text("planned")],
      { adapterId: "plan-script" },
    );
    const worker = createScriptedAdapter(
      [
        call("write_file", () => ({ path: "README.md", content: FIXED, expected_digest: sha256(README) })),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        text("fixed"),
      ],
      { adapterId: "worker-script" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Fix the typo in README.md", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, worker] }));

    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, [], run.stderr());
    assert.equal(code, 0, run.stderr());
    const last = frames.at(-1);
    assert.ok(last?.type === "result" && last.data.status === "succeeded" && last.data.exit_code === 0);
    assert.equal(last.data.tasks.length, 1);
    assert.equal(last.data.tasks[0]?.state, "completed");
    assert.equal(last.data.usage?.source, "provider-reported", "usage is visible with its source label");

    assert.equal(await readFile(path.join(sandbox.workspace, "README.md"), "utf8"), FIXED, "the fix reached the workspace");

    const events = frameEvents(frames);
    const runLog = await readSession(sandbox.home, frames[0]?.type === "hello" ? frames[0].data.session_id : "");
    assert.equal(eventsOf(runLog, "attempt/started").length, 1, "a single worker");
    assert.deepEqual(projectionIssues(runLog), [], "the run log replays through the recovery projection");
    assert.equal(eventsOf(runLog, "review/recorded").length, 0, "trivial work needs no independent review");
    const decisions = eventsOf(runLog, "approval/decided").map((event) => event.data.decision);
    assert.deepEqual(
      decisions.map((decision) => [decision.subject_kind, decision.decided_by, decision.mode]),
      [["plan", "orchestrator", "autonomous"]],
      "only the audited self-approval of the plan",
    );
    assert.equal(eventsOf(events, "approval/requested").length, 1);
    assert.equal(eventsOf(runLog, "task/integrated").length, 1);
    assert.deepEqual(eventsOf(runLog, "task/integrated")[0]?.data.paths, ["README.md"]);
    assert.ok(eventsOf(events, "tool/execution_started").length >= 2, "worker tool calls stream through the same JSONL channel");

    const show = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["show", last.run_id, "--json"], show.io, overridesFor(sandbox)), 0, show.stderr());
    const report = JSON.parse(show.stdout()) as { attempts: unknown[]; evidence: { criteria: { criterion_id: string; evidence: string[] }[] }[]; approvals: { decided_by: string }[]; reviews: unknown[] };
    assert.equal(report.attempts.length, 1);
    assert.equal(report.reviews.length, 0);
    assert.equal(report.evidence[0]?.criteria[0]?.criterion_id, "AC-1");
    assert.match(report.evidence[0]?.criteria[0]?.evidence[0] ?? "", /^tool-call:call_/);
    assert.deepEqual(report.approvals.map((approval) => approval.decided_by), ["orchestrator"]);

    const runs = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["runs", "--json"], runs.io, overridesFor(sandbox)), 0);
    const listed = JSON.parse(runs.stdout()) as { run_id: string; state: string }[];
    assert.deepEqual(listed.map((entry) => [entry.run_id, entry.state]), [[last.run_id, "completed"]]);
  } finally {
    await sandbox.cleanup();
  }
});
