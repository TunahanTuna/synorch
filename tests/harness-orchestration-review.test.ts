import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContextBuilder, createSourceReader } from "../src/harness/context/index.ts";
import {
  completionPacketSchema,
  createId,
  packetDigest,
  reviewPacketSchema,
  sha256,
  type CompletionPacket,
  type ReviewPacket,
  type SessionEvent,
  type TaskContextPacket,
} from "../src/harness/contracts/index.ts";
import {
  compileTaskPacket,
  mayComplete,
  resolveEvidence,
  reviewRequired,
  verifyCompletion,
  verifyReview,
  type EvidenceIndex,
} from "../src/harness/orchestration/index.ts";
import type { AttemptLog } from "../src/harness/orchestration/attempt-log.ts";
import {
  createScriptedPlanner,
  createStaticToolRegistry,
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  reviewerClaim,
  testPlan,
  workerClaim,
  type ScriptContext,
} from "../src/harness/orchestration/testing.ts";

const SECRET = "IMPLEMENTER-PRIVATE-REASONING-7f3a";

function ofType<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

function taskStates(events: readonly SessionEvent[]): string[] {
  return ofType(events, "task/state_changed").map((event) => event.data.to);
}

async function implementer(context: ScriptContext): Promise<void> {
  await context.say(`${SECRET}: thinking about the change`);
  await context.write("src/feature.ts", "export const feature = true;\n");
  const call = await context.toolCall("exec", { exitCode: 0, text: "tests passed" });
  await context.reply(workerClaim(context, call));
}

test("AC-2 the reviewer never sees the implementer transcript and a standard task completes only after an accepting review", async () => {
  const workspace = await createTempWorkspace({ "src/index.ts": "export {};\n" }, { git: true });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "feature", owned_paths: ["src/feature.ts"], risk: "standard", verification: ["pnpm test"] }]));
    const runtime = createTestRuntime({
      workspace,
      planner,
      context: ({ sessions, blobs }) =>
        createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(), sources: createSourceReader(workspace.root) }),
      script: async (context) => {
        if (context.input.role === "reviewer") {
          const call = await context.toolCall("exec", { exitCode: 0, text: "reviewer ran tests" });
          await context.reply(reviewerClaim(context, call, "accept"));
          return;
        }
        await implementer(context);
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);

    const reviewerTurn = runtime.driver.turns.find((turn) => turn.input.role === "reviewer");
    const implementerTurn = runtime.driver.turns.find((turn) => turn.input.role === "implementer");
    assert.ok(reviewerTurn !== undefined && implementerTurn !== undefined);
    assert.notEqual(reviewerTurn.input.sessionId, implementerTurn.input.sessionId);
    assert.ok(reviewerTurn.context?.ok === true);
    const reviewerInput = JSON.stringify(reviewerTurn.context.request);
    assert.ok(!reviewerInput.includes(SECRET), "the reviewer request must not contain the implementer transcript");
    assert.ok(reviewerInput.includes("pinned at sha256:"), "the reviewer receives the pinned artifact");

    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    const reviews = ofType(events, "review/recorded");
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.data.decision, "accept");
    const review = reviewPacketSchema.parse(JSON.parse(Buffer.from(await runtime.blobs.get(reviews[0]!.data.blob.digest)).toString("utf8")));
    assert.equal(review.independence.separate_context, true);
    assert.notEqual(review.reviewer_attempt_id, review.reviewed_attempt_id);
    assert.equal(review.independence.same_provider, false);
    assert.ok(review.criteria.every((criterion) => criterion.evidence.some((evidence) => evidence.produced_by === "reviewer")));
    assert.deepEqual(taskStates(events), ["ready", "running", "verifying", "reviewing", "completed"]);
    const completedAt = events.findIndex((event) => event.type === "task/state_changed" && event.data.to === "completed");
    const reviewedAt = events.findIndex((event) => event.type === "review/recorded");
    assert.ok(reviewedAt < completedAt);
    assert.equal(await readFile(path.join(workspace.root, "src", "feature.ts"), "utf8"), "export const feature = true;\n");
  } finally {
    await workspace.cleanup();
  }
});

test("report tools are the claim channel; attempt sessions and the integrate step are recorded", async () => {
  const workspace = await createTempWorkspace({ "src/index.ts": "export {};\n" }, { git: true });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "feature", owned_paths: ["src/feature.ts"], risk: "standard", verification: ["pnpm test"] }]));
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        if (context.input.role === "reviewer") {
          const call = await context.toolCall("exec", { exitCode: 0, text: "reviewer ran tests" });
          await context.report("review_report", { decision: "block" }, { ok: false });
          await context.report("review_report", reviewerClaim(context, call, "accept"));
          await context.say("```json\n{\"decision\": \"block\"}\n```");
          return;
        }
        await context.write("src/feature.ts", "export const feature = true;\n");
        const call = await context.toolCall("exec", { exitCode: 0, text: "tests passed" });
        await context.report("task_report", workerClaim(context, call));
        await context.say("```json\n{\"status\": \"failed\", \"summary\": \"a stale block the tool report overrides\"}\n```");
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.equal(ofType(events, "review/recorded")[0]?.data.decision, "accept");

    const started = ofType(events, "attempt/started");
    assert.equal(started.length, 2);
    for (const attempt of started) {
      assert.equal(attempt.event_version, 2);
      const turn = runtime.driver.turns.find((entry) => entry.input.attemptId === attempt.data.attempt_id);
      assert.equal(attempt.data.session_id, turn?.input.sessionId);
    }

    const integrated = ofType(events, "task/integrated");
    assert.equal(integrated.length, 1);
    assert.deepEqual(integrated[0]?.data.paths, ["src/feature.ts"]);
    assert.equal(integrated[0]?.data.attempt_id, started.find((attempt) => attempt.data.role === "implementer")?.data.attempt_id);
    const integratedAt = events.findIndex((event) => event.type === "task/integrated");
    const completedAt = events.findIndex((event) => event.type === "task/state_changed" && event.data.to === "completed");
    assert.ok(integratedAt >= 0 && integratedAt < completedAt);
  } finally {
    await workspace.cleanup();
  }
});

test("AC-2 a reviewer that only cites worker evidence cannot accept; the task fails and nothing is integrated", async () => {
  const workspace = await createTempWorkspace({ "src/index.ts": "export {};\n" }, { git: true });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "feature", owned_paths: ["src/feature.ts"], risk: "standard" }]));
    let workerCall = "";
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        if (context.input.role === "reviewer") {
          await context.reply({
            criteria: (context.input.packet?.acceptance_criteria ?? []).map((criterion) => ({
              criterion_id: criterion.id,
              verdict: "met",
              evidence: [{ kind: "test-run", ref: workerCall, produced_by: "worker" }],
            })),
            findings: [],
            decision: "accept",
          });
          return;
        }
        await context.write("src/feature.ts", "export const feature = 1;\n");
        workerCall = await context.toolCall("exec", { exitCode: 0 });
        await context.reply(workerClaim(context, workerCall));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "failed");
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.equal(ofType(events, "review/recorded").length, 0, "a schema-invalid review is never recorded");
    assert.ok(!taskStates(events).includes("completed"));
    assert.equal(taskStates(events).at(-1), "failed");
    await assert.rejects(readFile(path.join(workspace.root, "src", "feature.ts"), "utf8"));
  } finally {
    await workspace.cleanup();
  }
});

test("AC-2 a reviewer passing off the implementer's tool call as its own evidence is an invalid review", async () => {
  const workspace = await createTempWorkspace({ "src/index.ts": "export {};\n" }, { git: true });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "feature", owned_paths: ["src/feature.ts"], risk: "standard" }]));
    let workerCall = "";
    const runtime = createTestRuntime({
      workspace,
      planner,
      limits: { maxReviewAttempts: 1 },
      script: async (context) => {
        if (context.input.role === "reviewer") {
          await context.reply({
            criteria: (context.input.packet?.acceptance_criteria ?? []).map((criterion) => ({
              criterion_id: criterion.id,
              verdict: "met",
              evidence: [{ kind: "test-run", ref: workerCall, produced_by: "reviewer" }],
            })),
            findings: [],
            decision: "accept",
          });
          return;
        }
        await context.write("src/feature.ts", "x\n");
        workerCall = await context.toolCall("exec", { exitCode: 0 });
        await context.reply(workerClaim(context, workerCall));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "failed");
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.equal(ofType(events, "review/recorded").length, 1);
    assert.ok(!taskStates(events).includes("completed"));
    await assert.rejects(readFile(path.join(workspace.root, "src", "feature.ts"), "utf8"));
  } finally {
    await workspace.cleanup();
  }
});

test("AC-2 mayComplete: standard and high-risk need an accepting review, trivial does not", () => {
  const standard = { risk: "standard", role: "implementer" } as const;
  assert.equal(reviewRequired(standard), true);
  assert.equal(mayComplete(standard, undefined), false);
  assert.equal(mayComplete(standard, { decision: "revise", problems: [] }), false);
  assert.equal(mayComplete(standard, { decision: "invalid", problems: [] }), false);
  assert.equal(mayComplete(standard, { decision: "accept", problems: [] }), true);
  assert.equal(mayComplete({ risk: "high-risk", role: "debugger" }, undefined), false);
  assert.equal(mayComplete({ risk: "trivial", role: "implementer" }, undefined), true);
});

test("AC-2 revise sends a delta packet to a new attempt that continues from the reviewed artifact", async () => {
  const workspace = await createTempWorkspace({ "src/index.ts": "export {};\n" }, { git: true });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "feature", owned_paths: ["src/**"], risk: "standard" }]));
    let reviews = 0;
    const seen: string[] = [];
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        if (context.input.role === "reviewer") {
          reviews += 1;
          const call = await context.toolCall("exec", { exitCode: 0 });
          await context.reply(reviewerClaim(context, call, reviews === 1 ? "revise" : "accept"));
          return;
        }
        const existing = await readFile(path.join(context.root, "src", "feature.ts"), "utf8").catch(() => "");
        seen.push(existing);
        await context.write("src/feature.ts", `${existing}line${seen.length}\n`);
        const call = await context.toolCall("exec", { exitCode: 0 });
        await context.reply(workerClaim(context, call));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    assert.deepEqual(seen, ["", "line1\n"], "the revise attempt starts from the reviewed artifact");
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.deepEqual(taskStates(events), ["ready", "running", "verifying", "reviewing", "changes_requested", "ready", "running", "verifying", "reviewing", "completed"]);
    const deltas = ofType(events, "task/packet_issued").filter((event) => event.data.kind === "delta");
    assert.equal(deltas.length, 1);
    const implementerTurns = runtime.driver.turns.filter((turn) => turn.input.role === "implementer");
    assert.notEqual(implementerTurns[0]?.input.attemptId, implementerTurns[1]?.input.attemptId);
    assert.ok(implementerTurns[1]?.input.packet?.decisions.some((decision) => decision.includes("review:F-1")));
    assert.equal(await readFile(path.join(workspace.root, "src", "feature.ts"), "utf8"), "line1\nline2\n");
  } finally {
    await workspace.cleanup();
  }
});

function emptyLog(overrides: Partial<AttemptLog> = {}): AttemptLog {
  return {
    sessionId: createId("session"),
    toolCalls: new Map(),
    eventTypes: new Map(),
    compactionBlobs: new Set(),
    finalAssistantText: undefined,
    assistantTexts: [],
    reports: [],
    ...overrides,
  };
}

function samplePacket(): TaskContextPacket {
  const runId = createId("run");
  const planId = createId("plan");
  return compileTaskPacket({
    plan: {
      schema_version: 1,
      plan_id: planId,
      run_id: runId,
      version: 1,
      goal: "g",
      risk: "standard",
      scope: ["src/**"],
      tasks: [],
      expected_external_effects: [],
      verification: [],
      budget: { max_wall_time_seconds: 60, max_steps: 10 },
      assumptions: [],
      created_at: "2026-09-22T10:00:00Z",
    } as never,
    planDigest: sha256("plan"),
    task: {
      key: "t",
      role: "implementer",
      objective: "o",
      depends_on: [],
      owned_paths: ["src/**"],
      read_paths: [],
      risk: "standard",
      model_tier: "complex_worker",
      acceptance_criteria: [
        { id: "AC-1", statement: "one" },
        { id: "AC-2", statement: "two" },
      ],
      verification: ["pnpm test"],
    },
    taskId: createId("task"),
    createdAt: "2026-09-22T10:00:00Z",
    sources: [],
    findings: [],
    forbiddenPaths: [],
    preferWorktree: true,
  });
}

function completion(packet: TaskContextPacket, evidence: CompletionPacket["acceptance_evidence"], commands: CompletionPacket["commands_run"] = []): CompletionPacket {
  return completionPacketSchema.parse({
    schema_version: 2,
    task_id: packet.task_id,
    attempt_id: createId("attempt"),
    packet_digest: packetDigest(packet),
    status: "completed",
    summary: "done",
    changed_paths: [],
    tool_call_ids: [],
    acceptance_evidence: evidence,
    commands_run: commands,
    decisions_made: [],
    skipped_checks: [],
    unresolved_risks: [],
    recommended_context_updates: [],
  });
}

test("AC-3 a criterion without resolvable evidence yields revise, naming the criterion", async () => {
  const packet = samplePacket();
  const call = createId("toolCall");
  const index: EvidenceIndex = {
    log: emptyLog({ toolCalls: new Map([[call, { name: "exec", state: "succeeded", exitCode: 0 }]]) }),
    artifactDigest: undefined,
    changedPaths: [],
    fileDigest: async () => undefined,
  };
  const evidence = { kind: "test-run" as const, ref: call, produced_by: "worker" as const };
  const commands = [{ command: "pnpm test", exit_code: 0, evidence }];
  const full = await verifyCompletion(packet, completion(packet, [{ criterion_id: "AC-1", evidence: [evidence] }, { criterion_id: "AC-2", evidence: [evidence] }], commands), index);
  assert.equal(full.decision, "pass", full.problems.join("; "));
  const missing = await verifyCompletion(packet, completion(packet, [{ criterion_id: "AC-1", evidence: [evidence] }], commands), index);
  assert.equal(missing.decision, "revise");
  assert.deepEqual(missing.unevidenced, ["AC-2"]);
  const fabricated = await verifyCompletion(
    packet,
    completion(packet, [{ criterion_id: "AC-1", evidence: [evidence] }, { criterion_id: "AC-2", evidence: [{ kind: "tool-call", ref: createId("toolCall"), produced_by: "worker" }] }], commands),
    index,
  );
  assert.equal(fabricated.decision, "revise");
  assert.deepEqual(fabricated.unevidenced, ["AC-2"]);
  const unrun = await verifyCompletion(packet, completion(packet, [{ criterion_id: "AC-1", evidence: [evidence] }, { criterion_id: "AC-2", evidence: [evidence] }]), index);
  assert.equal(unrun.decision, "revise");
  assert.ok(unrun.problems.some((problem) => problem.includes("pnpm test")));
});

test("AC-3 changed paths outside the owned scope are rejected against the real diff", async () => {
  const packet = samplePacket();
  const index: EvidenceIndex = { log: emptyLog(), artifactDigest: sha256("a"), changedPaths: ["docs/x.md"], fileDigest: async () => undefined };
  const result = await verifyCompletion(packet, completion(packet, [{ criterion_id: "AC-1", evidence: [{ kind: "artifact", ref: "x", produced_by: "worker" }] }]), index);
  assert.equal(result.decision, "reject");
  assert.ok(result.problems.some((problem) => problem.includes("docs/x.md")));
});

test("AC-3 a review that leaves a criterion unassessed or unverifiable is revise, not accept", async () => {
  const packet = samplePacket();
  const workerCall = createId("toolCall");
  const reviewerCall = createId("toolCall");
  const done = completion(packet, [
    { criterion_id: "AC-1", evidence: [{ kind: "tool-call", ref: workerCall, produced_by: "worker" }] },
    { criterion_id: "AC-2", evidence: [{ kind: "tool-call", ref: workerCall, produced_by: "worker" }] },
  ]);
  const artifact = sha256("artifact");
  const worker: EvidenceIndex = { log: emptyLog({ toolCalls: new Map([[workerCall, { name: "exec", state: "succeeded", exitCode: 0 }]]) }), artifactDigest: artifact, changedPaths: [], fileDigest: async () => undefined };
  const reviewer: EvidenceIndex = { log: emptyLog({ toolCalls: new Map([[reviewerCall, { name: "exec", state: "succeeded", exitCode: 0 }]]) }), artifactDigest: artifact, changedPaths: [], fileDigest: async () => undefined };
  const review = (criteria: ReviewPacket["criteria"], decision: ReviewPacket["decision"]): ReviewPacket =>
    reviewPacketSchema.parse({
      schema_version: 2,
      task_id: packet.task_id,
      reviewed_attempt_id: done.attempt_id,
      reviewer_attempt_id: createId("attempt"),
      completion_digest: packetDigest(done),
      reviewed_artifact_digest: artifact,
      reviewer_route: { provider_id: "anthropic", model_id: "m" },
      independence: { separate_context: true, same_provider: false, same_model: false },
      criteria,
      findings: [],
      decision,
    });
  const met = { verdict: "met" as const, evidence: [{ kind: "test-run" as const, ref: reviewerCall, produced_by: "reviewer" as const }] };
  const accepted = await verifyReview(review([{ criterion_id: "AC-1", ...met }, { criterion_id: "AC-2", ...met }], "accept"), packet, done, { worker, reviewer });
  assert.equal(accepted.decision, "accept");
  const partial = await verifyReview(review([{ criterion_id: "AC-1", ...met }], "revise"), packet, done, { worker, reviewer });
  assert.equal(partial.decision, "revise");
  assert.ok(partial.problems.some((problem) => problem.includes("AC-2")));
  const unverifiable = await verifyReview(review([{ criterion_id: "AC-1", ...met }, { criterion_id: "AC-2", verdict: "unverifiable", evidence: [] }], "revise"), packet, done, { worker, reviewer });
  assert.equal(unverifiable.decision, "revise");
});

test("AC-3 evidence must resolve: unknown calls, failed test runs and review pointers are not evidence", async () => {
  const ok = createId("toolCall");
  const failed = createId("toolCall");
  const index: EvidenceIndex = {
    log: emptyLog({ toolCalls: new Map([[ok, { name: "exec", state: "succeeded", exitCode: 0 }], [failed, { name: "exec", state: "succeeded", exitCode: 1 }]]) }),
    artifactDigest: sha256("artifact"),
    changedPaths: [],
    fileDigest: async (relative) => (relative === "src/a.ts" ? sha256("a") : undefined),
  };
  assert.equal(await resolveEvidence({ kind: "tool-call", ref: ok, produced_by: "worker" }, index), undefined);
  assert.match((await resolveEvidence({ kind: "test-run", ref: failed, produced_by: "worker" }, index)) ?? "", /exited 1/);
  assert.match((await resolveEvidence({ kind: "tool-call", ref: createId("toolCall"), produced_by: "worker" }, index)) ?? "", /not a tool call/);
  assert.match((await resolveEvidence({ kind: "review", ref: "review:F-1", produced_by: "reviewer" }, index)) ?? "", /not first-hand/);
  assert.equal(await resolveEvidence({ kind: "file", ref: "src/a.ts#L3", produced_by: "worker" }, index), undefined);
  assert.match((await resolveEvidence({ kind: "file", ref: "src/a.ts", digest: sha256("b"), produced_by: "worker" }, index)) ?? "", /changed/);
  assert.equal(await resolveEvidence({ kind: "artifact", ref: sha256("artifact"), produced_by: "worker" }, index), undefined);
});

test("AC-3 an attempt that omits evidence is sent back with the missing criterion and succeeds on retry", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial", criteria: ["first", "second"] }]));
    let attempts = 0;
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        attempts += 1;
        await context.write("docs/a.md", `a${attempts}\n`);
        const call = await context.toolCall("exec", { exitCode: 0 });
        const claim = workerClaim(context, call);
        if (attempts === 1) (claim.acceptance_evidence as unknown[]).splice(1, 1);
        await context.reply(claim);
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    const failure = ofType(events, "task/state_changed").find((event) => event.data.to === "failed");
    assert.match(failure?.data.reason ?? "", /AC-2/);
    const second = runtime.driver.turns[1]?.input.packet;
    assert.ok(second?.decisions.some((decision) => decision.includes("AC-2")));
  } finally {
    await workspace.cleanup();
  }
});

test("AC-5 a retry is a new attempt and the failed attempt and its evidence stay in the log", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial" }]));
    let attempts = 0;
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        attempts += 1;
        const call = await context.toolCall("exec", { exitCode: attempts === 1 ? 1 : 0 });
        if (attempts === 1) {
          await context.write("docs/a.md", "broken\n");
          await context.reply({ status: "failed", summary: "tests failed", unresolved_risks: ["flaky"] });
          return;
        }
        await context.write("docs/a.md", "fixed\n");
        await context.reply(workerClaim(context, call));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    const started = ofType(events, "attempt/started");
    assert.equal(started.length, 2);
    assert.notEqual(started[0]?.data.attempt_id, started[1]?.data.attempt_id);
    const completions = ofType(events, "attempt/completion_recorded");
    assert.deepEqual(completions.map((event) => event.data.status), ["failed", "completed"]);
    const first = completionPacketSchema.parse(JSON.parse(Buffer.from(await runtime.blobs.get(completions[0]!.data.blob.digest)).toString("utf8")));
    assert.equal(first.attempt_id, started[0]?.data.attempt_id);
    assert.ok(first.tool_call_ids.length === 1, "the failed attempt's tool evidence is preserved");
    assert.ok(runtime.workers[0]?.attempt(started[0]!.data.attempt_id) !== undefined);
    assert.deepEqual(taskStates(events), ["ready", "running", "failed", "retry_pending", "ready", "running", "verifying", "completed"]);
    assert.equal(await readFile(path.join(workspace.root, "docs", "a.md"), "utf8"), "fixed\n");
  } finally {
    await workspace.cleanup();
  }
});

test("AC-5 retries stop at the limit and the task stays failed with every attempt recorded", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial" }]));
    const runtime = createTestRuntime({
      workspace,
      planner,
      limits: { maxRetries: 1 },
      script: async (context) => {
        await context.write("docs/a.md", "broken\n");
        await context.reply({ status: "failed", summary: "cannot" });
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.exitCode, 5);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.equal(ofType(events, "attempt/started").length, 2);
    assert.equal(taskStates(events).at(-1), "failed");
    assert.equal(await readFile(path.join(workspace.root, "docs", "a.md"), "utf8"), "a\n", "a failed scoped-dir attempt is reverted");
  } finally {
    await workspace.cleanup();
  }
});

test("ADR-10 an rca-only debugger gets no write scope and must report a root cause", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n" }, { git: false });
  try {
    const planner = createScriptedPlanner((input) => testPlan(input, [{ key: "rca", role: "debugger", risk: "trivial", read_paths: ["src/**"] }]));
    let attempts = 0;
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        attempts += 1;
        const call = await context.toolCall("read_file");
        const claim = workerClaim(context, call);
        if (attempts === 1) delete claim.root_cause;
        await context.reply(claim);
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const debuggerPolicies = runtime.policy.computed.filter((policy) => policy.role === "debugger");
    assert.ok(debuggerPolicies.length > 0);
    assert.ok(debuggerPolicies.every((policy) => policy.write_scope.length === 0 && policy.effects["workspace-write"] === "deny"));
    assert.equal(runtime.driver.turns[0]?.input.packet?.write_mode, "rca-only");
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    const failure = ofType(events, "task/state_changed").find((event) => event.data.to === "failed");
    assert.match(failure?.data.reason ?? "", /root_cause/);
  } finally {
    await workspace.cleanup();
  }
});
