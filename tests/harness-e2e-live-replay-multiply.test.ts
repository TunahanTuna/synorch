import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { reviewPacketSchema, type SessionEvent } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createSloppyModelAdapter, type SloppyResponse, type SloppyView } from "../src/harness/orchestration/testing.ts";
import { createBlobStore } from "../src/harness/store/index.ts";
import { capture, createSandbox, eventsOf, overridesFor, parseFrames, projectionIssues, readSession, trustWorkspace, writeConfig, type Sandbox } from "./fixtures/cli/runtime/support.ts";

/**
 * Replay of live run run_01M37V2JT0F8HTZGTZWFF8QVCZ ("src-test.js dosyası oluştur, çarpma işlemi
 * fonksiyonu yaz"; tests/fixtures/live, verbatim from ~/.synorch/sessions/syn-smoke-2fecb8f8) through
 * the real runtime with a sloppy-model adapter. Live the run failed although the implementer created
 * the file correctly: (A1) the plan's verification held `node --input-type=module -e "import …"`,
 * which the harness can never run, and nothing checked it at plan time; (A2) the worker got two
 * evidence-repair rounds for that plan problem; (A3) the plan's `max_steps: 10` was the whole run's
 * step budget, so both reviewer attempts ended `budget_exceeded` without a report. Now plan_propose
 * dry-runs the verification, the orchestrator re-proposes with a check script the implementer owns,
 * the harness verification passes and the reviewer reports inside its guaranteed steps.
 */

interface RecordedStep {
  readonly text?: string;
  readonly calls?: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
  readonly reconstructed?: boolean;
}

interface LiveRun {
  readonly run_id: string;
  readonly goal: string;
  readonly files: Readonly<Record<string, string>>;
  readonly orchestrator: { readonly planning: readonly RecordedStep[] };
  readonly implementer: readonly (readonly RecordedStep[])[];
  readonly reviewer: readonly (readonly RecordedStep[])[];
}

const RUN = JSON.parse(readFileSync(new URL("./fixtures/live/run-01M37V2JT0F8HTZGTZWFF8QVCZ.json", import.meta.url), "utf8")) as LiveRun;

function respond(step: RecordedStep | undefined): SloppyResponse | undefined {
  if (step === undefined) return undefined;
  const calls = step.calls ?? [];
  return calls.length > 0 ? { calls, ...(step.text === undefined ? {} : { text: step.text }) } : { text: step.text ?? "" };
}

async function liveSandbox(): Promise<Sandbox> {
  const sandbox = await createSandbox(RUN.files, { git: true });
  await trustWorkspace(sandbox);
  await writeConfig(sandbox.home, [
    { tier: "orchestrator", adapter: "sol", model: "gpt-6-sol" },
    { tier: "fast_worker", adapter: "luna", model: "gpt-6-luna" },
    { tier: "complex_worker", adapter: "sol", model: "gpt-6-sol" },
  ]);
  return sandbox;
}

async function blobJson(home: string, digest: string): Promise<unknown> {
  return JSON.parse(Buffer.from(await createBlobStore(home).get(digest as never)).toString("utf8")) as unknown;
}

function states(events: readonly SessionEvent[], taskId: string | undefined): string[] {
  return eventsOf(events, "task/state_changed").filter((event) => event.data.task_id === taskId).map((event) => event.data.to);
}

test("replay live run run_01M37V2JT0F8HTZGTZWFF8QVCZ: the refused verification is rejected at plan time, the revised plan verifies and the reviewer reports within its steps", async () => {
  const sandbox = await liveSandbox();
  try {
    const planning = RUN.orchestrator.planning;
    const [implementerSteps = []] = RUN.implementer;
    const [reviewerSteps = []] = RUN.reviewer;
    // One adapter plays the orchestrator and the reviewer (both gpt-6-sol live), selected by the turn's user message.
    const sol = createSloppyModelAdapter(
      [
        { when: /^Goal:/, steps: (view: SloppyView) => respond(planning[view.step]) },
        { when: /^Independent review of attempt/, steps: (view: SloppyView) => respond(reviewerSteps[view.step]) },
      ],
      { adapterId: "sol" },
    );
    const luna = createSloppyModelAdapter([{ when: /^Task task_\w+ \(implementer\)/, steps: (view: SloppyView) => respond(implementerSteps[view.step]) }], { adapterId: "luna" });

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", RUN.goal, "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [sol, luna] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${last?.type === "result" ? JSON.stringify(last.data) : JSON.stringify(last)}`);
    assert.ok(last?.type === "result");
    assert.equal(last.data.status, "succeeded");
    assert.equal(await readFile(path.join(sandbox.workspace, "src-test.js"), "utf8"), "export function multiply(a, b) {\n  return a * b;\n}\n");
    assert.match(await readFile(path.join(sandbox.workspace, "check-multiply.mjs"), "utf8"), /multiply\(0\.5, 4\), 2/);

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const log = await readSession(sandbox.home, hello.data.session_id);
    assert.deepEqual(projectionIssues(log), []);

    // A1: plan v1 (verbatim) came back from plan_propose as an actionable rejection naming the command, the code and the alternative.
    const rejection = sol.views.find((view) => view.last?.name === "plan_propose" && view.last.isError);
    assert.ok(rejection !== undefined, "plan_propose rejected the refused verification in-turn");
    const text = rejection.last?.text ?? "";
    assert.match(text, /verification command "node --input-type=module -e/);
    assert.match(text, /shell-syntax/);
    assert.match(text, /inline code/);
    assert.match(text, /node check-implement-multiply\.mjs|check script owned by the implementer/);
    assert.match(text, /revision\(s\) left/);
    const proposed = eventsOf(log, "plan/proposed");
    assert.equal(proposed.length, 1, "only the dry-run-clean plan is recorded");
    assert.deepEqual(proposed[0]?.data.plan.tasks[0]?.verification, ["node --check src-test.js", "node check-multiply.mjs"]);
    assert.equal(proposed[0]?.data.plan.budget.max_steps, 10, "the orchestrator's (verbatim) step estimate");

    // A3: the run's step budget is the guaranteed allocation (implementer + reviewer), not the plan's 10.
    assert.equal(eventsOf(log, "budget/exceeded").length, 0);
    const implement = last.data.tasks[0];
    assert.deepEqual(states(log, implement?.task_id), ["ready", "running", "verifying", "reviewing", "completed"]);
    const issued = eventsOf(log, "task/packet_issued").filter((event) => event.data.task_id === implement?.task_id && event.data.kind === "full");
    const limits = await Promise.all(issued.map(async (event) => ((await blobJson(sandbox.home, event.data.blob.digest)) as { role: string; limits: { max_steps: number } })));
    assert.deepEqual(limits.map((packet) => [packet.role, packet.limits.max_steps]), [["implementer", 25], ["reviewer", 25]]);

    // A2: the harness ran both commands itself; nothing went back to the worker.
    const ran = eventsOf(log, "attempt/verification_ran");
    assert.deepEqual(ran.map((event) => [event.data.command, event.data.status]), [["node --check src-test.js", "passed"], ["node check-multiply.mjs", "passed"]]);
    assert.match(ran[1]?.data.output_excerpt ?? "", /ok/);
    assert.equal(eventsOf(log, "attempt/repair_requested").length, 0);

    // The reviewer's recorded steps 0 and 2 plus the reconstructed checks and report fit its limit: one review, accepted.
    const reviews = eventsOf(log, "review/recorded");
    assert.deepEqual(reviews.map((event) => event.data.decision), ["accept"]);
    const review = reviewPacketSchema.parse(await blobJson(sandbox.home, reviews[0]!.data.blob.digest));
    assert.ok(review.criteria.every((criterion) => criterion.verdict === "met"));
    const reviewerStarts = eventsOf(log, "attempt/started").filter((event) => event.data.role === "reviewer");
    assert.equal(reviewerStarts.length, 1);
    assert.ok(!sol.views.some((view) => /Finish now|report-only turn/.test(view.userText)), "the reviewer never ran into its limit");
    assert.equal(eventsOf(log, "task/integrated").length, 1);
  } finally {
    await sandbox.cleanup();
  }
});

/** The reconstructed, dry-run-clean plan v2 of the fixture with another budget. */
function planV2(budget: { max_wall_time_seconds: number; max_steps: number }): Record<string, unknown> {
  const proposal = RUN.orchestrator.planning[2]?.calls?.[0]?.arguments ?? {};
  return { ...proposal, budget };
}

const CHECK = "import assert from 'node:assert/strict';\nimport { multiply } from './src-test.js';\nassert.equal(multiply(2, 3), 6);\nconsole.log('ok');\n";
const MULTIPLY = "export function multiply(a, b) {\n  return a * b;\n}\n";

function reviewReport(refs: { readonly read: string; readonly check: string }): SloppyResponse {
  return {
    calls: [
      {
        name: "review_report",
        arguments: {
          criteria: ["AC-1", "AC-2", "AC-3", "AC-4"].map((id) => ({ criterion_id: id, verdict: "met", evidence: [{ kind: id === "AC-2" ? "test-run" : "file", ref: id === "AC-2" ? refs.check : refs.read, produced_by: "reviewer" }] })),
          findings: [],
          decision: "accept",
        },
      },
    ],
  };
}

test("the live step budget shape (plan max_steps 10; implementer 8 steps, reviewer 5) no longer starves the reviewer: the run's step budget is the guaranteed allocation", async () => {
  const sandbox = await liveSandbox();
  try {
    const sol = createSloppyModelAdapter(
      [
        { when: /^Goal:/, steps: [{ calls: [{ name: "plan_propose", arguments: planV2({ max_wall_time_seconds: 180, max_steps: 10 }) }] }] },
        {
          when: /^Independent review of attempt/,
          steps: [
            { calls: [{ name: "git_status", arguments: {} }] },
            { calls: [{ name: "read_file", arguments: { path: "src-test.js" } }] },
            { calls: [{ name: "read_file", arguments: { path: "check-multiply.mjs" } }] },
            { calls: [{ name: "exec", arguments: { argv: ["node", "check-multiply.mjs"] } }] },
            reviewReport({ read: "#2", check: "#4" }),
          ],
        },
      ],
      { adapterId: "sol" },
    );
    const luna = createSloppyModelAdapter(
      [
        {
          when: /^Task task_\w+ \(implementer\)/,
          steps: [
            { calls: [{ name: "load_skill", arguments: { name: "implementation" } }] },
            { calls: [{ name: "read_file", arguments: { path: "src-add.mjs" } }] },
            { calls: [{ name: "write_file", arguments: { path: "src-test.js", content: MULTIPLY } }] },
            { calls: [{ name: "write_file", arguments: { path: "check-multiply.mjs", content: CHECK } }] },
            { calls: [{ name: "exec", arguments: { argv: ["node", "--check", "src-test.js"] } }] },
            { calls: [{ name: "exec", arguments: { argv: ["node", "check-multiply.mjs"] } }] },
            { calls: [{ name: "read_file", arguments: { path: "src-test.js" } }] },
            {
              calls: [
                {
                  name: "task_report",
                  arguments: {
                    status: "completed",
                    summary: "multiply and its check script are in place; both checks pass",
                    acceptance_evidence: [
                      { criterion_id: "AC-1", evidence: [{ kind: "file", ref: "#3", produced_by: "worker" }] },
                      { criterion_id: "AC-2", evidence: [{ kind: "test-run", ref: "#6", produced_by: "worker" }] },
                      { criterion_id: "AC-3", evidence: [{ kind: "file", ref: "#4", produced_by: "worker" }] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      { adapterId: "luna" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", RUN.goal, "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [sol, luna] }));
    const { frames } = parseFrames(run.stdout());
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${JSON.stringify(last)}`);
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const log = await readSession(sandbox.home, hello.data.session_id);
    assert.equal(eventsOf(log, "budget/exceeded").length, 0, "13 worker steps fit: the run guarantees 25 implementer + 25 reviewer steps");
    assert.equal(luna.requests.length, 8);
    assert.equal(sol.views.filter((view) => view.userText.startsWith("Independent review")).length, 5);
    assert.deepEqual(eventsOf(log, "review/recorded").map((event) => event.data.decision), ["accept"]);
  } finally {
    await sandbox.cleanup();
  }
});

test("an attempt near its step limit is told to finish now; at the limit without a report it gets one report-only turn with only the report tool", async () => {
  const sandbox = await liveSandbox();
  try {
    const sol = createSloppyModelAdapter(
      [
        { when: /^Goal:/, steps: [{ calls: [{ name: "plan_propose", arguments: planV2({ max_wall_time_seconds: 180, max_steps: 4 }) }] }] },
        {
          when: /^Independent review of attempt/,
          steps: [
            { calls: [{ name: "read_file", arguments: { path: "src-test.js" } }] },
            { calls: [{ name: "exec", arguments: { argv: ["node", "check-multiply.mjs"] } }] },
            reviewReport({ read: "#1", check: "#2" }),
          ],
        },
      ],
      { adapterId: "sol" },
    );
    const luna = createSloppyModelAdapter(
      [
        {
          when: /^Task task_\w+ \(implementer\)/,
          steps: [{ calls: [{ name: "load_skill", arguments: { name: "implementation" } }] }, { calls: [{ name: "write_file", arguments: { path: "src-test.js", content: MULTIPLY } }] }],
        },
        {
          // The finish-now message: the model keeps working instead of reporting.
          when: /^Harness: 2 step\(s\) left before the step limit\. Finish now: call `task_report`/,
          steps: [{ calls: [{ name: "write_file", arguments: { path: "check-multiply.mjs", content: CHECK } }] }, { calls: [{ name: "exec", arguments: { argv: ["node", "check-multiply.mjs"] } }] }],
        },
        {
          when: /^Harness: the step limit is reached\. This is a report-only turn/,
          steps: [
            {
              calls: [
                { name: "read_file", arguments: { path: "src-test.js" } },
                {
                  name: "task_report",
                  arguments: {
                    status: "completed",
                    summary: "multiply and its check are in place",
                    acceptance_evidence: [
                      { criterion_id: "AC-1", evidence: [{ kind: "file", ref: "#2", produced_by: "worker" }] },
                      { criterion_id: "AC-2", evidence: [{ kind: "test-run", ref: "#4", produced_by: "worker" }] },
                      { criterion_id: "AC-3", evidence: [{ kind: "file", ref: "#3", produced_by: "worker" }] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      { adapterId: "luna" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(
      ["run", RUN.goal, "--mode", "jsonl"],
      run.io,
      overridesFor(sandbox, { adapters: [sol, luna], limits: { stepFloors: { worker: 4, reviewer: 25, finishWarning: 2 } } }),
    );
    const { frames } = parseFrames(run.stdout());
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${JSON.stringify(last)}`);
    assert.equal(luna.requests.length, 5, "2 steps, then 2 finish-now steps, then 1 report-only step");
    const reportOnly = luna.views.at(-1);
    assert.match(reportOnly?.userText ?? "", /report-only turn/);
    assert.deepEqual(reportOnly?.request.tools.map((tool) => tool.name), ["task_report"], "only the report tool is offered");
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const log = await readSession(sandbox.home, hello.data.session_id);
    const started = eventsOf(log, "attempt/started").find((event) => event.data.role === "implementer");
    const attemptLog = await readSession(sandbox.home, started!.data.session_id!);
    const refused = eventsOf(attemptLog, "message/recorded").flatMap((event) => (event.data.message?.content ?? []).flatMap((part) => (part.type === "tool_result" && part.is_error ? [part.text] : [])));
    assert.ok(refused.some((text) => /not executed: this is a report-only turn/.test(text)), "the extra read_file was answered without running");
    assert.equal(eventsOf(attemptLog, "tool/call_proposed").filter((event) => event.data.tool_name === "read_file").length, 0, "the refused call never reached the gateway");
    assert.equal(eventsOf(log, "attempt/completion_recorded")[0]?.data.status, "completed");
    assert.deepEqual(eventsOf(log, "review/recorded").map((event) => event.data.decision), ["accept"]);
  } finally {
    await sandbox.cleanup();
  }
});
