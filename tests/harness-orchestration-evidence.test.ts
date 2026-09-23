import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { completionPacketSchema, createId, sha256, type SessionEvent } from "../src/harness/contracts/index.ts";
import {
  commandArgv,
  firstPathToken,
  perTaskStepLimit,
  renderTriagePrompt,
  resolvePointer,
  type EvidenceIndex,
  type RecordedToolCall,
  type TriageInput,
  type VerificationRequest,
  type VerificationResult,
} from "../src/harness/orchestration/index.ts";
import type { AttemptLog } from "../src/harness/orchestration/attempt-log.ts";
import { createScriptedPlanner, createTempWorkspace, createTestRuntime, replayTransitions, testPlan, workerClaim } from "../src/harness/orchestration/testing.ts";

/**
 * ADR-18 D1/D2 unit behaviour: the tolerant resolver on the pointers the live models actually
 * wrote, harness verification with substitution and in-session verification repair, the triage
 * rendering of resolved evidence (F10) and the per-task step limit (F13).
 */

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly state?: RecordedToolCall["state"];
  readonly exitCode?: number;
  readonly provider?: string;
  readonly changed?: readonly string[];
}

function logOf(calls: readonly Call[]): AttemptLog {
  const toolCalls = new Map<string, RecordedToolCall>();
  const ordinals = new Map<number, string>();
  for (const [index, call] of calls.entries()) {
    const id = createId("toolCall");
    ordinals.set(index + 1, id);
    toolCalls.set(id, {
      name: call.name,
      state: call.state ?? "succeeded",
      exitCode: call.exitCode,
      ordinal: index + 1,
      providerCallId: call.provider ?? `call_p${index + 1}`,
      arguments: call.args,
      ...(call.changed === undefined ? {} : { changedPaths: call.changed }),
    });
  }
  return { sessionId: createId("session"), toolCalls, eventTypes: new Map(), compactionBlobs: new Set(), finalAssistantText: undefined, assistantTexts: [], reports: [], ordinals };
}

function indexOf(log: AttemptLog, files: readonly string[], changed: readonly string[] = []): EvidenceIndex {
  return { log, artifactDigest: undefined, changedPaths: changed, fileDigest: async (relative) => (files.includes(relative) ? sha256(relative) : undefined) };
}

const FILES = ["src-add.mjs", "check.mjs", "package.json", "README.md"];

/** Live run 2, implementer attempt 2 (ses_01M35W1A4NJE9CW0MKGJTGAHX5), in call order. */
const RUN_2_ATTEMPT_2 = logOf([
  { name: "load_skill", args: { name: "implementation" } },
  { name: "read_file", args: { path: "src-add.mjs" } },
  { name: "read_file", args: { path: "check.mjs" } },
  { name: "apply_patch", args: { patch: "*** Begin Patch" }, state: "denied" },
  { name: "write_file", args: { path: "src-add.mjs", content: "x" }, changed: ["src-add.mjs"] },
  { name: "exec", args: { argv: ["node", "check.mjs"] }, exitCode: 0, provider: "call_TDpvuzlqxoRWLaGyj3k88lGA" },
  { name: "git_diff", args: { paths: ["src-add.mjs"], context_lines: 3 } },
  { name: "read_file", args: { path: "src-add.mjs" } },
  { name: "load_skill", args: { name: "verification" } },
]);

/** Live run 1, explorer attempts 1 and 2 (ses_01M35SV1FWB11YAAVCYPK3XBZ2, ses_01M35SVY4FJAW1DSFNBSX2WE7Y). */
const RUN_1_EXPLORER_1 = logOf([
  { name: "read_file", args: { path: ".ai/skills/codebase-exploration/SKILL.md" }, state: "denied" },
  ...["src-add.mjs", "check.mjs", "package.json", "README.md"].map((file) => ({ name: "read_file", args: { path: file } })),
  ...["src-add.mjs", "check.mjs", "package.json"].map((file) => ({ name: "search", args: { path: file, pattern: ".*", max_results: 20 } })),
]);
const RUN_1_EXPLORER_2 = logOf([
  { name: "read_file", args: { path: ".ai/skills/codebase-exploration/SKILL.md" }, state: "denied" },
  ...["src-add.mjs", "check.mjs", "package.json", "README.md"].map((file) => ({ name: "read_file", args: { path: file } })),
]);

test("AC-c1 every evidence pointer the live models wrote resolves, with the method that matched", async () => {
  const cases: [AttemptLog, "tool-call" | "test-run" | "file", string, string, string | undefined][] = [
    [RUN_2_ATTEMPT_2, "file", "functions.read_file src-add.mjs (post-change): add returns a + b", "tool-name-args", "src-add.mjs"],
    [RUN_2_ATTEMPT_2, "tool-call", "functions.git_diff src-add.mjs: - a - b / + a + b", "tool-name-args", undefined],
    [RUN_2_ATTEMPT_2, "test-run", "functions.exec node check.mjs: exit code 0; stdout ok", "tool-name-args", undefined],
    [RUN_1_EXPLORER_1, "tool-call", "functions.search src-add.mjs", "tool-name-args", undefined],
    [RUN_1_EXPLORER_1, "tool-call", "functions.search check.mjs", "tool-name-args", undefined],
    [RUN_1_EXPLORER_1, "file", "src-add.mjs:1-3; check.mjs:1-3", "path-token", "src-add.mjs"],
    [RUN_1_EXPLORER_2, "file", "src-add.mjs:1-3 — `add(a, b)` returns `a - b`, establishing the defect.", "path-token", "src-add.mjs"],
    [RUN_1_EXPLORER_2, "file", "check.mjs:2-3 — `add(2, 3) !== 5` emits `add is wrong` and exits 1; otherwise prints `ok`.", "path-token", "check.mjs"],
    [RUN_1_EXPLORER_2, "file", "package.json:1 — project is an ES module, so the check imports `src-add.mjs` as written.", "path-token", "package.json"],
  ];
  for (const [log, kind, ref, method, file] of cases) {
    const resolution = await resolvePointer({ kind, ref, produced_by: "worker" }, indexOf(log, FILES, ["src-add.mjs"]), "AC-1");
    assert.equal(resolution.status, "resolved", `${ref}: ${resolution.reason ?? ""}`);
    assert.equal(resolution.method, method, ref);
    if (file !== undefined) assert.equal(resolution.path, file, ref);
  }
  // The search pointers resolve to the search call on the named file, not merely any search.
  const search = await resolvePointer({ kind: "tool-call", ref: "functions.search check.mjs", produced_by: "worker" }, indexOf(RUN_1_EXPLORER_1, FILES));
  assert.equal(RUN_1_EXPLORER_1.toolCalls.get(search.tool_call_id ?? "")?.arguments?.path, "check.mjs");
});

test("AC-c1 resolution order: harness id, #n short ref, provider call id; prose that names nothing does not resolve", async () => {
  const index = indexOf(RUN_2_ATTEMPT_2, FILES, ["src-add.mjs"]);
  const exec = RUN_2_ATTEMPT_2.ordinals?.get(6) ?? "";
  const byId = await resolvePointer({ kind: "test-run", ref: exec, produced_by: "worker" }, index);
  assert.deepEqual([byId.status, byId.method, byId.tool_call_id], ["resolved", "tool-call-id", exec]);
  const byShortRef = await resolvePointer({ kind: "test-run", ref: "#6 node check.mjs exit 0", produced_by: "worker" }, index);
  assert.deepEqual([byShortRef.method, byShortRef.tool_call_id], ["short-ref", exec]);
  const byBracket = await resolvePointer({ kind: "tool-call", ref: "[#7]", produced_by: "worker" }, index);
  assert.equal(byBracket.method, "short-ref");
  const byProvider = await resolvePointer({ kind: "test-run", ref: "call_TDpvuzlqxoRWLaGyj3k88lGA", produced_by: "worker" }, index);
  assert.deepEqual([byProvider.method, byProvider.tool_call_id], ["provider-call-id", exec]);
  const mcp = await resolvePointer({ kind: "test-run", ref: "mcp__synorch__exec node check.mjs", produced_by: "worker" }, index);
  assert.equal(mcp.method, "tool-name-args");

  const failures: [string, "tool-call" | "test-run" | "file", RegExp][] = [
    ["#42", "tool-call", /#42 is not a tool call of this attempt/],
    ["functions.exec npm test", "test-run", /no exec call of this attempt matches/],
    ["functions.run_tests all", "test-run", /no run_tests call ran in this attempt/],
    ["the diff looks right", "tool-call", /cite the \[#n\]/],
    ["#4", "tool-call", /ended denied/],
    ["docs/missing.md:3 — nothing", "file", /does not exist/],
  ];
  for (const [ref, kind, reason] of failures) {
    const resolution = await resolvePointer({ kind, ref, produced_by: "worker" }, index);
    assert.equal(resolution.status, "unresolved", ref);
    assert.equal(resolution.method, undefined);
    assert.match(resolution.reason ?? "", reason, ref);
  }
  const failedRun = logOf([{ name: "exec", args: { argv: ["node", "check.mjs"] }, exitCode: 1 }]);
  const exited = await resolvePointer({ kind: "test-run", ref: "functions.exec node check.mjs", produced_by: "worker" }, indexOf(failedRun, FILES));
  assert.match(exited.reason ?? "", /exited 1/, "a test run that failed is never evidence, however it is cited");
  const unread = await resolvePointer({ kind: "file", ref: "README.md:1 — title", produced_by: "worker" }, indexOf(RUN_2_ATTEMPT_2, FILES));
  assert.match(unread.reason ?? "", /neither changed nor read/, "a file pointer from prose needs the attempt to have touched the file");
});

test("path tokens and verification argv are extracted conservatively", () => {
  assert.equal(firstPathToken("src/a.ts#L3 (post-change) — prose"), "src/a.ts");
  assert.equal(firstPathToken("`check.mjs:2-3` — exits 1"), "check.mjs");
  assert.equal(firstPathToken("functions.exec node — nothing"), undefined);
  assert.deepEqual(commandArgv("node check.mjs"), ["node", "check.mjs"]);
  assert.deepEqual(commandArgv("git diff -- src-add.mjs check.mjs"), ["git", "diff", "--", "src-add.mjs", "check.mjs"]);
  assert.deepEqual(commandArgv("pnpm test -- --grep 'a b'"), ["pnpm", "test", "--", "--grep", "a b"]);
  for (const shell of ["pnpm test && echo ok", "FOO=1 node x.js", "node $(pwd)/x.js", "cat a | grep b", "ls *.ts"]) assert.equal(commandArgv(shell), undefined, shell);
});

function ofType<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

test("AC-c3 / AC-c4 a failed harness verification is repaired in the same session, keeping the workspace", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial", verification: ["pnpm test", "pnpm lint && echo ok"] }]));
    const runs: VerificationRequest[] = [];
    const verification = async (request: VerificationRequest): Promise<VerificationResult> => {
      runs.push(request);
      const passed = runs.length > 1;
      return { status: passed ? "passed" : "failed", termination: "exited", exitCode: passed ? 0 : 1, output: passed ? "1 passed" : "1 failed\nexpected a2", durationMs: 5 };
    };
    let turns = 0;
    const runtime = createTestRuntime({
      workspace,
      planner,
      verification,
      script: async (context) => {
        turns += 1;
        await context.write("docs/a.md", `a${turns}\n`);
        const call = await context.toolCall("read_file");
        await context.reply(
          workerClaim(context, call, {
            acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "tool-call", ref: turns === 1 ? "the suite is green" : call, produced_by: "worker" }] }],
            commands_run: [],
            skipped_checks: [{ check: "pnpm lint && echo ok", reason: "not needed" }],
          }),
        );
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.deepEqual(ofType(events, "task/state_changed").map((event) => event.data.to), ["ready", "running", "verifying", "completed"]);
    const ran = ofType(events, "attempt/verification_ran");
    assert.deepEqual(ran.map((event) => [event.data.command, event.data.status]), [
      ["pnpm test", "failed"],
      ["pnpm lint && echo ok", "not-run"],
      ["pnpm test", "passed"],
      ["pnpm lint && echo ok", "not-run"],
    ]);
    assert.match(ran[1]?.data.reason ?? "", /shell syntax/);
    assert.deepEqual(runs.map((run) => run.argv), [["pnpm", "test"], ["pnpm", "test"]], "a command that is not a plain argv is never handed to the runner");
    assert.ok(runs.every((run) => run.role === "implementer" && run.policy.role === "implementer" && run.policy.verification_commands?.includes("pnpm test")), "it runs under the attempt's own policy");
    const repair = ofType(events, "attempt/repair_requested");
    assert.equal(repair.length, 1);
    assert.equal(repair[0]?.data.kind, "verification-repair");
    assert.match(runtime.driver.turns[1]?.input.userMessage ?? "", /pnpm test: failed \(exit 1\)/);
    const completion = completionPacketSchema.parse(JSON.parse(Buffer.from(await runtime.blobs.get(ofType(events, "attempt/completion_recorded")[0]!.data.blob.digest)).toString("utf8")));
    assert.deepEqual(completion.repairs, { report_corrections: 0, evidence_repairs: 0, verification_repairs: 1 });
    assert.deepEqual(completion.harness_evidence?.verification.map((record) => record.status), ["passed", "not-run"]);
    const substitute = completion.evidence_resolution?.filter((entry) => entry.method === "harness-substitute") ?? [];
    assert.equal(substitute.length, 0, "a not-run command blocks substitution: every harness check must pass");
    assert.ok(completion.evidence_resolution?.some((entry) => entry.criterion_id === "AC-1" && entry.method === "tool-call-id"));
    assert.equal(await readFile(path.join(workspace.root, "docs", "a.md"), "utf8"), "a2\n");
  } finally {
    await workspace.cleanup();
  }
});

test("ADR-18 harness-substitute: all harness checks passed and an in-scope diff evidence criteria whose pointers stayed unresolved", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial", criteria: ["first", "second"], verification: ["pnpm test"] }]));
    const runtime = createTestRuntime({
      workspace,
      planner,
      verification: async () => ({ status: "passed", termination: "exited", exitCode: 0, output: "ok", durationMs: 1 }),
      script: async (context) => {
        await context.write("docs/a.md", "changed\n");
        await context.reply({ status: "completed", summary: "done", acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "file", ref: "trust me", produced_by: "worker" }] }] });
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.equal(ofType(events, "attempt/repair_requested").length, 0);
    const completion = completionPacketSchema.parse(JSON.parse(Buffer.from(await runtime.blobs.get(ofType(events, "attempt/completion_recorded")[0]!.data.blob.digest)).toString("utf8")));
    assert.deepEqual(completion.evidence_resolution?.filter((entry) => entry.method === "harness-substitute").map((entry) => [entry.criterion_id, entry.kind]), [
      ["AC-1", "harness-verification"],
      ["AC-1", "harness-diff"],
      ["AC-2", "harness-verification"],
      ["AC-2", "harness-diff"],
    ]);
    assert.ok(completion.acceptance_evidence.every((entry) => entry.evidence.some((evidence) => evidence.produced_by === "harness")));
    assert.equal(completion.harness_evidence?.diff?.evidence.ref, completion.artifact_digest);
    assert.match(completion.summary, /the harness verification evidenced AC-1, AC-2/);
  } finally {
    await workspace.cleanup();
  }
});

test("F10 the triage prompt shows evidence as resolved, unresolved with the reason, or missing", () => {
  const input = {
    goal: "g",
    planVersion: 1,
    task: { key: "fix", taskId: "task_x", role: "implementer", risk: "standard", writeMode: "owned-paths" },
    attempt: 1,
    status: "completed",
    criteria: [
      { id: "AC-1", statement: "one", evidenced: true, evidence: "resolved", capabilityNote: undefined },
      { id: "AC-2", statement: "two", evidenced: false, evidence: "unresolved", reason: "#9 is not a tool call of this attempt", capabilityNote: undefined },
      { id: "AC-3", statement: "three", evidenced: false, evidence: "missing", capabilityNote: undefined },
    ],
    problems: ["AC-2 has no resolvable evidence"],
    harnessChecks: ["node check.mjs: passed (exit 0)"],
    summary: "s",
    skippedChecks: [],
    unresolvedRisks: [],
    acceptable: false,
    retriesLeft: 1,
    tasks: [],
  } as unknown as TriageInput;
  const prompt = renderTriagePrompt(input);
  assert.match(prompt, /- AC-1 \[resolved\]: one/);
  assert.match(prompt, /- AC-2 \[unresolved: #9 is not a tool call of this attempt\]: two/);
  assert.match(prompt, /- AC-3 \[missing\]: three/);
  assert.match(prompt, /did not pass verification after its in-session repairs/);
  assert.match(prompt, /Harness-run verification:\n- node check\.mjs: passed \(exit 0\)/);
});

test("F13 a task's step limit divides the plan budget among dispatching tasks, never below 25", () => {
  const task = (role: string) => ({ role }) as never;
  assert.equal(perTaskStepLimit({ budget: { max_wall_time_seconds: 60, max_steps: 30 }, tasks: [task("implementer"), task("reviewer")] }), 30, "a reviewer plan task never dispatches");
  assert.equal(perTaskStepLimit({ budget: { max_wall_time_seconds: 60, max_steps: 30 }, tasks: [task("explorer"), task("implementer")] }), 25);
  assert.equal(perTaskStepLimit({ budget: { max_wall_time_seconds: 60, max_steps: 400 }, tasks: [task("implementer"), task("debugger")] }), 200);
});
