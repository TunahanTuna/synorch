import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { completionPacketSchema, reviewPacketSchema, sha256, type SessionEvent } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import {
  createSloppyModelAdapter,
  digestsIn,
  type SloppyResponse,
  type SloppyView,
} from "../src/harness/orchestration/testing.ts";
import { createBlobStore } from "../src/harness/store/index.ts";
import { capture, createSandbox, eventsOf, overridesFor, parseFrames, projectionIssues, readSession, trustWorkspace, writeConfig, type Sandbox } from "./fixtures/cli/runtime/support.ts";

/**
 * Replays of the two failed live runs (ADR-18 W2 / AC-c1, AC-c4): the models' recorded outputs
 * (tests/fixtures/live, verbatim from ~/.synorch/sessions/syn-smoke-2fecb8f8) drive the real
 * runtime — store, policy, gateway, tools, worktree isolation, orchestration — through a
 * sloppy-model adapter. Live, both runs failed although the right fix was made: every evidence
 * pointer was prose (`functions.exec node check.mjs: exit code 0`, `src-add.mjs:1-3 — …`), the
 * verifier wanted exact harness ids, and a revise burned the only retry. Now the harness runs the
 * verification itself, resolves pointers tolerantly and reviews the artifact.
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
  readonly orchestrator: { readonly planning: readonly RecordedStep[]; readonly triage: readonly RecordedStep[] };
  readonly implementer?: readonly (readonly RecordedStep[])[];
  readonly explorer?: readonly (readonly RecordedStep[])[];
}

function loadRun(name: string): LiveRun {
  return JSON.parse(readFileSync(new URL(`./fixtures/live/${name}.json`, import.meta.url), "utf8")) as LiveRun;
}

const RUN_1 = loadRun("run-01M35SSARRMK87VYMT770BNM3X");
const RUN_2 = loadRun("run-01M35VYXAC79ST06QZBAFGWT1S");
const BUGGY = RUN_2.files["src-add.mjs"] ?? "";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
/** The replayed files are CRLF (as the live worktree held them); the fix is compared line by line. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

function fill(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of replacements) result = result.split(from).join(to);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, replacements));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, replacements)]));
  return value;
}

function respond(step: RecordedStep | undefined, replacements: ReadonlyMap<string, string> = new Map()): SloppyResponse | undefined {
  if (step === undefined) return undefined;
  const calls = (step.calls ?? []).map((call) => ({ name: call.name, arguments: fill(call.arguments, replacements) as Record<string, unknown> }));
  return calls.length > 0 ? { calls, ...(step.text === undefined ? {} : { text: step.text }) } : { text: step.text ?? "" };
}

/** The digest the model copied out of the harness's stale_precondition error ("expected X, found Y"). */
function foundInLastError(view: SloppyView): string {
  const error = [...view.results].reverse().find((result) => result.isError && digestsIn(result.text).length > 0);
  return digestsIn(error?.text ?? "").at(-1) ?? sha256(BUGGY);
}

/** Attempt 2 copied the "current digest" out of the previous attempt's summary in its packet notes. */
function foundInPacket(view: SloppyView): string {
  const noted = /mevcut özet (sha256:[0-9a-f]{64})/.exec(`${view.userText}\n${view.system}`)?.[1];
  const read = view.results.find((result) => result.name === "read_file" && !result.isError);
  return noted ?? digestsIn(read?.text ?? "")[0] ?? sha256(BUGGY);
}

/** A packet source digest as the model would copy it from its system context. */
function packetDigestOf(view: SloppyView, file: string): string {
  const pattern = new RegExp(`"digest":\\s*"(sha256:[0-9a-f]{64})",\\s*"path":\\s*"${file.replace(/\./g, "\\.")}"`);
  return pattern.exec(view.system)?.[1] ?? sha256(BUGGY);
}

/** Per-attempt scripts: each new attempt's first request starts the next recorded attempt. */
function attempts(scripts: readonly ((view: SloppyView) => SloppyResponse | undefined)[]): (view: SloppyView) => SloppyResponse | undefined {
  let current = -1;
  return (view) => {
    if (view.step === 0) current = Math.min(current + 1, scripts.length - 1);
    return scripts[Math.max(0, current)]?.(view);
  };
}

function harnessRef(view: SloppyView): string | undefined {
  return /(ses_[0-9A-HJKMNP-TV-Z]{26}#\d+) harness-verification/.exec(view.userText)?.[1];
}

function refFromCorrection(view: SloppyView, tool: string): string | undefined {
  const correction = [...view.results].reverse().find((result) => result.isError && result.text.includes("Valid refs"));
  const match = new RegExp(`#(\\d+) ${tool}`).exec(correction?.text ?? "");
  return match === null ? undefined : `#${match[1]}`;
}

async function liveSandbox(run: LiveRun): Promise<Sandbox> {
  const sandbox = await createSandbox(run.files, { git: true });
  await trustWorkspace(sandbox);
  await writeConfig(sandbox.home, [
    { tier: "orchestrator", adapter: "astra", model: "gpt-6-astra" },
    { tier: "fast_worker", adapter: "luna", model: "gpt-5.6-luna" },
    { tier: "complex_worker", adapter: "sol", model: "gpt-5.6-sol" },
    { tier: "fast_worker", role: "reviewer", adapter: "sol", model: "gpt-5.6-sol" },
    { tier: "complex_worker", role: "reviewer", adapter: "sol", model: "gpt-5.6-sol" },
  ]);
  return sandbox;
}

async function blobJson(home: string, digest: string): Promise<unknown> {
  return JSON.parse(Buffer.from(await createBlobStore(home).get(digest as never)).toString("utf8")) as unknown;
}

function taskStates(events: readonly SessionEvent[], taskId: string | undefined): string[] {
  return eventsOf(events, "task/state_changed")
    .filter((event) => event.data.task_id === taskId)
    .map((event) => event.data.to);
}

test("replay live run 2 (run_01M35VYXAC79ST06QZBAFGWT1S): prose evidence resolves, the harness runs node check.mjs and the reviewed fix is integrated", async () => {
  const sandbox = await liveSandbox(RUN_2);
  try {
    const orchestrator = createSloppyModelAdapter(
      [
        { when: /^Goal:/, steps: (view) => respond(RUN_2.orchestrator.planning[view.step]) },
        { when: /^Worker report needs your decision/, steps: (view) => respond(RUN_2.orchestrator.triage[view.step]) },
      ],
      { adapterId: "astra" },
    );
    const [attempt1 = [], attempt2 = []] = RUN_2.implementer ?? [];
    const implementer = createSloppyModelAdapter(
      [
        {
          when: /^Task task_\w+ \(implementer\)/,
          steps: attempts([
            (view) => respond(attempt1[view.step], new Map([["{{FOUND_DIGEST}}", foundInLastError(view)]])),
            (view) => respond(attempt2[view.step], new Map([["{{FOUND_DIGEST}}", foundInPacket(view)]])),
          ]),
        },
      ],
      { adapterId: "luna" },
    );
    const reviewer = createSloppyModelAdapter(
      [
        {
          when: /^Independent review of attempt/,
          steps: [
            { calls: [{ name: "read_file", arguments: { path: "src-add.mjs" } }, { name: "git_diff", arguments: { paths: ["src-add.mjs"] } }] },
            { calls: [{ name: "exec", arguments: { argv: ["node", "check.mjs"] } }] },
            {
              calls: [
                {
                  name: "review_report",
                  arguments: {
                    criteria: [
                      { criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "tool-call", ref: "functions.git_diff src-add.mjs: - a - b / + a + b", produced_by: "reviewer" }] },
                      { criterion_id: "AC-2", verdict: "met", evidence: [{ kind: "test-run", ref: "functions.exec node check.mjs → exit 0, stdout ok", produced_by: "reviewer" }] },
                      { criterion_id: "AC-3", verdict: "met", evidence: [{ kind: "tool-call", ref: "manual inspection: the change is minimal and nothing else moved", produced_by: "reviewer" }] },
                    ],
                    findings: [],
                    decision: "accept",
                  },
                },
              ],
            },
            (view) => ({
              calls: [
                {
                  name: "review_report",
                  arguments: {
                    criteria: [
                      { criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "tool-call", ref: "functions.git_diff src-add.mjs", produced_by: "reviewer" }] },
                      {
                        criterion_id: "AC-2",
                        verdict: "met",
                        evidence: [
                          { kind: "test-run", ref: "functions.exec node check.mjs → exit 0, stdout ok", produced_by: "reviewer" },
                          ...(harnessRef(view) === undefined ? [] : [{ kind: "harness-verification", ref: harnessRef(view), produced_by: "harness" }]),
                        ],
                      },
                      { criterion_id: "AC-3", verdict: "met", evidence: [{ kind: "tool-call", ref: refFromCorrection(view, "git_diff") ?? "functions.git_diff src-add.mjs", produced_by: "reviewer" }] },
                    ],
                    findings: [],
                    decision: "accept",
                  },
                },
              ],
            }),
          ],
          after: "İnceleme tamamlandı: kabul.",
        },
      ],
      { adapterId: "sol" },
    );

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", RUN_2.goal, "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, implementer, reviewer] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${last?.type === "result" ? JSON.stringify(last.data) : JSON.stringify(last)}`);
    assert.ok(last?.type === "result");
    assert.equal(last.data.status, "succeeded");
    assert.equal(lf(await readFile(path.join(sandbox.workspace, "src-add.mjs"), "utf8")), FIXED, "the reviewed fix reaches the main tree");

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    assert.deepEqual(projectionIssues(runLog), []);
    const fixTask = last.data.tasks[0]?.task_id;
    assert.deepEqual(taskStates(runLog, fixTask), ["ready", "running", "needs_context", "ready", "running", "verifying", "reviewing", "completed"]);
    const implementerStarts = eventsOf(runLog, "attempt/started").filter((event) => event.data.role === "implementer");
    assert.deepEqual(implementerStarts.map((event) => [event.data.isolation.mode, event.data.isolation.reused === true]), [["worktree", false], ["worktree", true]], "the triage retry reuses the task's worktree (ADR-19)");

    // AC-c3: the harness ran the verification command itself in the attempt workspace.
    const ran = eventsOf(runLog, "attempt/verification_ran");
    assert.equal(ran.length, 1);
    assert.equal(ran[0]?.data.command, "node check.mjs");
    assert.equal(ran[0]?.data.status, "passed");
    assert.match(ran[0]?.data.output_excerpt ?? "", /ok/);

    // AC-c1: the three recorded prose pointers of attempt 2 resolved, with their method.
    const completions = eventsOf(runLog, "attempt/completion_recorded");
    assert.deepEqual(completions.map((event) => event.data.status), ["needs_context", "completed"]);
    const completion = completionPacketSchema.parse(await blobJson(sandbox.home, completions[1]!.data.blob.digest));
    assert.equal(completion.harness_evidence?.verification[0]?.status, "passed");
    assert.deepEqual(completion.harness_evidence?.diff?.changed_paths, ["src-add.mjs"]);
    const byRef = new Map((completion.evidence_resolution ?? []).filter((entry) => entry.criterion_id !== undefined).map((entry) => [entry.ref, entry]));
    for (const ref of ["functions.read_file src-add.mjs (post-change): add returns a + b", "functions.git_diff src-add.mjs: - a - b / + a + b", "functions.exec node check.mjs: exit code 0; stdout ok"]) {
      assert.equal(byRef.get(ref)?.status, "resolved", ref);
      assert.equal(byRef.get(ref)?.method, "tool-name-args", ref);
    }
    assert.deepEqual(completion.commands_run.map((command) => [command.command, command.exit_code]), [["node check.mjs", 0]], "commands_run comes from the log");
    assert.equal(eventsOf(runLog, "attempt/repair_requested").length, 0, "the recorded report needs no repair");

    // AC-c7 / AC-c9: the dispatched packet cites sources with the attempt workspace's raw digest and inlines the small read_paths.
    const issued = eventsOf(runLog, "task/packet_issued").filter((event) => event.data.kind === "full" && event.data.task_id === fixTask);
    const packet = (await blobJson(sandbox.home, issued[1]!.data.blob.digest)) as { context: { digest_scheme?: string; sources: { path: string; digest: string }[]; inline_sources?: { path: string; digest: string; content: string }[] } };
    assert.equal(packet.context.digest_scheme, "workspace-raw-v1");
    const rawDigest = sha256(RUN_2.files["src-add.mjs"] ?? "");
    assert.equal(packet.context.sources.find((source) => source.path === "src-add.mjs")?.digest, rawDigest, "the CRLF bytes' digest, a valid write precondition in the worktree");
    assert.deepEqual(packet.context.inline_sources?.map((source) => [source.path, source.digest]), [["check.mjs", sha256(RUN_2.files["check.mjs"] ?? "")], ["src-add.mjs", rawDigest]]);

    // The reviewer accept path, including one in-call correction round for an unresolvable pointer.
    const reviews = eventsOf(runLog, "review/recorded");
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.data.decision, "accept");
    const review = reviewPacketSchema.parse(await blobJson(sandbox.home, reviews[0]!.data.blob.digest));
    assert.deepEqual(review.repairs, { report_corrections: 1 });
    assert.ok(review.evidence_resolution?.every((entry) => entry.status === "resolved"));
    const correction = reviewer.views.find((view) => view.last?.isError === true && view.last.text.includes("Evidence pointers that do not resolve"));
    assert.ok(correction !== undefined, "the reviewer got an actionable correction");
    assert.match(correction.last?.text ?? "", /AC-3: 'manual inspection/);
    assert.match(correction.last?.text ?? "", /#\d+ git_diff src-add\.mjs/);
    assert.equal(eventsOf(runLog, "task/integrated").length, 1);
  } finally {
    await sandbox.cleanup();
  }
});

test("replay live run 1 (run_01M35SSARRMK87VYMT770BNM3X): the explorer's partial report is triaged, its prose refs resolve, and fix-add passes harness verification and review", async () => {
  const sandbox = await liveSandbox(RUN_1);
  try {
    const orchestrator = createSloppyModelAdapter(
      [
        { when: /^Goal:/, steps: (view) => respond(RUN_1.orchestrator.planning[view.step]) },
        { when: /^Worker report needs your decision/, steps: (view) => respond(RUN_1.orchestrator.triage[view.step]) },
      ],
      { adapterId: "astra" },
    );
    const [explorer1 = [], explorer2 = []] = RUN_1.explorer ?? [];
    // fix-add never ran live: run 2's implementer transcript with run 1's criterion ids (AC-2, AC-3).
    const reconstructed = (RUN_2.implementer ?? [])[1] ?? [];
    const renumber = new Map([["\"AC-2\"", "\"AC-3\""], ["\"AC-1\"", "\"AC-2\""]]);
    const fixAdd = reconstructed.map((step) => JSON.parse([...renumber].reduce((text, [from, to]) => text.split(from).join(to), JSON.stringify(step))) as RecordedStep);
    const worker = createSloppyModelAdapter(
      [
        { when: /^Task task_\w+ \(explorer\)/, steps: attempts([(view) => respond(explorer1[view.step]), (view) => respond(explorer2[view.step])]) },
        { when: /^Task task_\w+ \(implementer\)/, steps: (view) => respond(fixAdd[view.step], new Map([["{{FOUND_DIGEST}}", packetDigestOf(view, "src-add.mjs")]])) },
      ],
      { adapterId: "luna" },
    );
    const reviewer = createSloppyModelAdapter(
      [
        {
          when: (text) => text.startsWith("Independent review of attempt") && text.includes("Changed files (0)"),
          steps: [
            { calls: [{ name: "read_file", arguments: { path: "src-add.mjs" } }, { name: "read_file", arguments: { path: "check.mjs" } }] },
            {
              calls: [
                {
                  name: "review_report",
                  arguments: {
                    criteria: [{ criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "file", ref: "src-add.mjs:2 — `return a - b`, check.mjs:2 expects 5", produced_by: "reviewer" }] }],
                    findings: [],
                    decision: "accept",
                  },
                },
              ],
            },
          ],
        },
        {
          when: /^Independent review of attempt/,
          steps: [
            { calls: [{ name: "git_diff", arguments: { paths: ["src-add.mjs", "check.mjs"] } }, { name: "exec", arguments: { argv: ["node", "check.mjs"] } }] },
            // A report with a missing field: the gateway rejects it against the schema.
            { calls: [{ name: "review_report", arguments: { criteria: [{ criterion_id: "AC-2", verdict: "met", evidence: [{ kind: "test-run", ref: "functions.exec node check.mjs" }] }], decision: "accept" } }] },
            (view) => ({
              calls: [
                {
                  name: "review_report",
                  arguments: {
                    criteria: [
                      { criterion_id: "AC-2", verdict: "met", evidence: [{ kind: "tool-call", ref: "functions.git_diff src-add.mjs check.mjs: only src-add.mjs changed", produced_by: "reviewer" }] },
                      { criterion_id: "AC-3", verdict: "met", evidence: [{ kind: "test-run", ref: "functions.exec node check.mjs: exit code 0; stdout ok", produced_by: "reviewer" }] },
                      {
                        criterion_id: "AC-4",
                        verdict: "met",
                        evidence: [
                          { kind: "test-run", ref: "functions.exec node check.mjs", produced_by: "reviewer" },
                          ...(harnessRef(view) === undefined ? [] : [{ kind: "harness-verification", ref: harnessRef(view), produced_by: "harness" }]),
                        ],
                      },
                    ],
                    findings: [{ id: "F-1", severity: "info", summary: "Tek operatör değişikliği; check.mjs değişmedi." }],
                    decision: "accept",
                  },
                },
              ],
            }),
          ],
        },
      ],
      { adapterId: "sol" },
    );

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", RUN_1.goal, "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, worker, reviewer] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${last?.type === "result" ? JSON.stringify(last.data) : JSON.stringify(last)}`);
    assert.ok(last?.type === "result");
    assert.equal(last.data.status, "succeeded");
    assert.deepEqual(last.data.tasks.map((task) => task.state), ["completed", "completed", "completed"]);
    assert.equal(lf(await readFile(path.join(sandbox.workspace, "src-add.mjs"), "utf8")), FIXED);

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    assert.deepEqual(projectionIssues(runLog), []);
    const [explore, fix] = last.data.tasks;
    assert.deepEqual(taskStates(runLog, explore?.task_id), ["ready", "running", "verifying", "reviewing", "completed"], "one explorer attempt: triage accepted it, no blind retry");

    // AC-c1: the explorer's recorded prose pointers resolved.
    const completions = eventsOf(runLog, "attempt/completion_recorded");
    const explorerCompletion = completionPacketSchema.parse(await blobJson(sandbox.home, completions[0]!.data.blob.digest));
    assert.equal(explorerCompletion.status, "partial");
    const methods = (explorerCompletion.evidence_resolution ?? []).map((entry) => [entry.ref, entry.status, entry.method]);
    assert.deepEqual(methods, [
      ["functions.search src-add.mjs", "resolved", "tool-name-args"],
      ["functions.search check.mjs", "resolved", "tool-name-args"],
      ["src-add.mjs:1-3; check.mjs:1-3", "resolved", "path-token"],
    ]);

    // AC-c3: fix-add's verification commands ran in the harness; the reviewers accepted.
    const ran = eventsOf(runLog, "attempt/verification_ran").filter((event) => event.data.task_id === fix?.task_id);
    assert.deepEqual(ran.map((event) => [event.data.command, event.data.status]), [["node check.mjs", "passed"], ["git diff -- src-add.mjs check.mjs", "passed"]]);
    const reviews = eventsOf(runLog, "review/recorded");
    assert.deepEqual(reviews.map((event) => event.data.decision), ["accept", "accept"]);
    const fixReview = reviewPacketSchema.parse(await blobJson(sandbox.home, reviews[1]!.data.blob.digest));
    assert.ok(fixReview.criteria.every((criterion) => criterion.verdict === "met"));
    assert.ok(fixReview.evidence_resolution?.some((entry) => entry.produced_by === "harness" && entry.status === "resolved" && entry.method === "harness-record"), "harness evidence is independent evidence for the reviewer");
  } finally {
    await sandbox.cleanup();
  }
});

test("ADR-18 D1 a sloppy task_report is rejected in the call with the valid [#n] refs, corrected once, and recorded", async () => {
  const sandbox = await liveSandbox(RUN_2);
  try {
    const plan = {
      goal: RUN_2.goal,
      risk: "trivial",
      scope: ["src-add.mjs", "check.mjs"],
      tasks: [
        {
          key: "fix-add",
          role: "implementer",
          objective: "add(a, b) a + b döndürsün.",
          depends_on: [],
          owned_paths: ["src-add.mjs"],
          read_paths: ["src-add.mjs", "check.mjs"],
          risk: "trivial",
          model_tier: "fast_worker",
          acceptance_criteria: [{ id: "AC-1", statement: "check.mjs ok yazdırır" }],
          verification: ["node check.mjs"],
        },
      ],
      expected_external_effects: [],
      verification: [],
      budget: { max_wall_time_seconds: 600, max_steps: 30 },
      assumptions: [],
    };
    const orchestrator = createSloppyModelAdapter([{ when: /^Goal:/, steps: [{ calls: [{ name: "plan_propose", arguments: plan }] }] }], { adapterId: "astra" });
    const implementer = createSloppyModelAdapter(
      [
        {
          when: /^Task task_\w+ \(implementer\)/,
          steps: [
            (view) => ({ calls: [{ name: "write_file", arguments: { path: "src-add.mjs", content: FIXED, expected_digest: packetDigestOf(view, "src-add.mjs") } }] }),
            { calls: [{ name: "exec", arguments: { argv: ["node", "check.mjs"] } }] },
            {
              calls: [
                {
                  name: "task_report",
                  arguments: { status: "completed", summary: "düzeltildi", acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "test-run", ref: "the check passed", produced_by: "worker" }] }] },
                },
              ],
            },
            (view) => ({
              calls: [
                {
                  name: "task_report",
                  arguments: {
                    status: "completed",
                    summary: "düzeltildi",
                    acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "test-run", ref: /#(\d+) exec node check\.mjs/.exec(view.last?.text ?? "")?.[0] ?? "#2", produced_by: "worker" }] }],
                  },
                },
              ],
            }),
          ],
        },
      ],
      { adapterId: "luna" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", RUN_2.goal, "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, implementer, createSloppyModelAdapter([], { adapterId: "sol" })] }));
    const { frames } = parseFrames(run.stdout());
    const last = frames.at(-1);
    assert.equal(code, 0, `${run.stderr()}\n${JSON.stringify(last)}`);
    assert.equal(lf(await readFile(path.join(sandbox.workspace, "src-add.mjs"), "utf8")), FIXED);

    const correction = implementer.views.find((view) => view.last?.isError === true);
    assert.ok(correction !== undefined, "the first report came back as invalid_arguments");
    assert.match(correction.last?.text ?? "", /- AC-1: 'the check passed' .*cite the \[#n\]/);
    assert.match(correction.last?.text ?? "", /#2 exec node check\.mjs -> exit 0/);
    assert.match(correction.last?.text ?? "", /No correction left|0 correction left/);
    assert.equal(implementer.requests.length, 4, "the accepted report ends the turn (no extra model request)");

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    const completion = completionPacketSchema.parse(await blobJson(sandbox.home, eventsOf(runLog, "attempt/completion_recorded")[0]!.data.blob.digest));
    assert.deepEqual(completion.repairs, { report_corrections: 1, evidence_repairs: 0, verification_repairs: 0 });
    assert.deepEqual(completion.evidence_resolution?.map((entry) => [entry.ref, entry.method]), [["#2 exec node check.mjs", "short-ref"]]);
    assert.equal(completion.harness_evidence?.verification[0]?.status, "passed");
  } finally {
    await sandbox.cleanup();
  }
});
