import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  createId,
  deriveProjectId,
  digestText,
  HarnessError,
  sha256,
  type SessionEvent,
  type TaskContextPacket,
} from "../src/harness/contracts/index.ts";
import {
  compileTaskPacket,
  createBudgetTracker,
  createIsolationProvider,
  createWorkerManager,
  refreshPacketSources,
} from "../src/harness/orchestration/index.ts";
import { createRunRecorder } from "../src/harness/orchestration/recorder.ts";
import {
  createFakePolicyEngine,
  createMemoryBlobStore,
  createMemorySessionStore,
  createScriptedDriverFactory,
  createScriptedPlanner,
  createScriptedRouter,
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  TEST_SANDBOX,
  testPlan,
  workerClaim,
  type TurnScript,
} from "../src/harness/orchestration/testing.ts";

function packetFor(root: string, sources: { path: string; digest: ReturnType<typeof sha256> }[]): TaskContextPacket {
  const runId = createId("run");
  return compileTaskPacket({
    plan: {
      schema_version: 1,
      plan_id: createId("plan"),
      run_id: runId,
      version: 1,
      goal: `work in ${root}`,
      risk: "trivial",
      scope: ["docs/**"],
      tasks: [],
      expected_external_effects: [],
      verification: [],
      budget: { max_wall_time_seconds: 60, max_steps: 10 },
      assumptions: [],
      created_at: "2026-09-22T10:00:00Z",
    } as never,
    planDigest: sha256("plan"),
    task: {
      key: "doc",
      role: "implementer",
      objective: "update docs",
      depends_on: [],
      owned_paths: ["docs/out.md"],
      read_paths: ["docs/spec.md"],
      risk: "trivial",
      model_tier: "fast_worker",
      acceptance_criteria: [{ id: "AC-1", statement: "done" }],
      verification: [],
    },
    taskId: createId("task"),
    createdAt: "2026-09-22T10:00:00Z",
    sources,
    findings: [],
    forbiddenPaths: [],
    preferWorktree: false,
  });
}

async function managerFor(root: string, home: string, script: TurnScript) {
  const sessions = createMemorySessionStore();
  const blobs = createMemoryBlobStore();
  const log = await sessions.create({ session_id: createId("session"), project_id: deriveProjectId(root, process.platform), workspace_root: root, created_at: new Date().toISOString() });
  const runId = createId("run");
  const recorder = createRunRecorder(log, blobs, runId);
  const projectId = deriveProjectId(root, process.platform);
  const manager = createWorkerManager({
    run: { runId, mode: "autonomous", workspaceRoot: root, projectId, recorder },
    sessions,
    blobs,
    router: createScriptedRouter(),
    policy: createFakePolicyEngine(),
    isolation: createIsolationProvider({ workspaceRoot: root, projectId, home, blobs }),
    createDriver: createScriptedDriverFactory(script),
    sandbox: TEST_SANDBOX,
    budget: createBudgetTracker({ scope: "run", limits: { maxCostUsd: undefined, maxWallTimeSeconds: undefined, maxSteps: undefined, maxToolCalls: undefined } }),
  });
  return { manager, log, sessions };
}

const byType = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.filter((event) => event.type === type);

test("AC-4 a changed source stops dispatch with context/source_changed and starts no attempt", async () => {
  const workspace = await createTempWorkspace({ "docs/spec.md": "v1\n", "docs/out.md": "" }, { git: false });
  try {
    const packet = packetFor(workspace.root, [{ path: "docs/spec.md", digest: digestText("v1\n") }]);
    await writeFile(path.join(workspace.root, "docs", "spec.md"), "v2\n");
    const { manager, sessions, log } = await managerFor(workspace.root, workspace.home, async () => "completed");
    await assert.rejects(
      manager.dispatch(packet, new AbortController().signal),
      (error: unknown) => error instanceof HarnessError && error.info.code === "stale_packet",
    );
    const events = sessions.store(log.sessionId)?.events ?? [];
    const changed = byType(events, "context/source_changed");
    assert.equal(changed.length, 1);
    assert.ok(changed[0]?.type === "context/source_changed" && changed[0].data.actual === digestText("v2\n") && changed[0].data.path === "docs/spec.md");
    assert.equal(byType(events, "attempt/started").length, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("AC-4 a missing source is stale too, and a fresh packet dispatches", async () => {
  const workspace = await createTempWorkspace({ "docs/spec.md": "v1\n" }, { git: false });
  try {
    const { manager } = await managerFor(workspace.root, workspace.home, async (context) => {
      const call = await context.toolCall("read_file");
      await context.write("docs/out.md", "out\n");
      await context.reply(workerClaim(context, call));
    });
    const missing = packetFor(workspace.root, [{ path: "docs/gone.md", digest: digestText("x") }]);
    await assert.rejects(manager.dispatch(missing, new AbortController().signal), /packet sources changed/);
    const fresh = packetFor(workspace.root, [{ path: "docs/spec.md", digest: digestText("v1\n") }]);
    const handle = await manager.dispatch(fresh, new AbortController().signal);
    assert.equal((await handle.completion).status, "completed");
  } finally {
    await workspace.cleanup();
  }
});

test("AC-4 a source changing while the worker runs returns needs_context regardless of the worker's claim", async () => {
  const workspace = await createTempWorkspace({ "docs/spec.md": "v1\n", "docs/out.md": "" }, { git: false });
  try {
    const { manager, sessions, log } = await managerFor(workspace.root, workspace.home, async (context) => {
      await writeFile(path.join(workspace.root, "docs", "spec.md"), "changed by the user\n");
      await context.write("docs/out.md", "stale work\n");
      const call = await context.toolCall("exec", { exitCode: 0 });
      await context.reply(workerClaim(context, call));
    });
    const packet = packetFor(workspace.root, [{ path: "docs/spec.md", digest: digestText("v1\n") }]);
    const handle = await manager.dispatch(packet, new AbortController().signal);
    const completion = await handle.completion;
    assert.equal(completion.status, "needs_context");
    const events = sessions.store(log.sessionId)?.events ?? [];
    assert.equal(byType(events, "context/source_changed").length, 1);
    assert.deepEqual(replayTransitions(events), []);
  } finally {
    await workspace.cleanup();
  }
});

test("AC-4 the worker's own owned-path edits do not count as a stale source in flight", async () => {
  const workspace = await createTempWorkspace({ "docs/spec.md": "v1\n", "docs/out.md": "before\n" }, { git: false });
  try {
    const { manager } = await managerFor(workspace.root, workspace.home, async (context) => {
      await context.write("docs/out.md", "after\n");
      const call = await context.toolCall("exec", { exitCode: 0 });
      await context.reply(workerClaim(context, call));
    });
    const packet = packetFor(workspace.root, [
      { path: "docs/spec.md", digest: digestText("v1\n") },
      { path: "docs/out.md", digest: digestText("before\n") },
    ]);
    assert.equal((await (await manager.dispatch(packet, new AbortController().signal)).completion).status, "completed");
  } finally {
    await workspace.cleanup();
  }
});

test("AC-4 re-packaging refreshes digests and drops facts whose source changed", () => {
  const base = packetFor("/w", [{ path: "docs/spec.md", digest: digestText("v1\n") }]);
  const withFact: TaskContextPacket = {
    ...base,
    known_facts: [{ statement: "spec says v1", source: "docs/spec.md", source_digest: digestText("v1\n"), confidence: "verified" }],
  };
  const refreshed = refreshPacketSources(withFact, new Map([["docs/spec.md", digestText("v2\n")]]), "2026-09-22T11:00:00Z");
  assert.equal(refreshed.context.sources[0]?.digest, digestText("v2\n"));
  assert.equal(refreshed.known_facts.length, 0);
  assert.ok(refreshed.open_questions.some((question) => question.includes("spec says v1")));
});

test("AC-4 the coordinator re-packages after needs_context and completes with fresh sources", async () => {
  const workspace = await createTempWorkspace({ "docs/spec.md": "v1\n" }, { git: false });
  try {
    let attempts = 0;
    const planner = createScriptedPlanner((input) =>
      testPlan(input, [{ key: "doc", owned_paths: ["docs/out.md"], read_paths: ["docs/spec.md"], risk: "trivial" }]),
    );
    const runtime = createTestRuntime({
      workspace,
      planner,
      script: async (context) => {
        attempts += 1;
        if (attempts === 1) await writeFile(path.join(workspace.root, "docs", "spec.md"), "v2\n");
        await context.write("docs/out.md", `from ${attempts}\n`);
        const call = await context.toolCall("exec", { exitCode: 0 });
        await context.reply(workerClaim(context, call));
      },
    });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    const events = runtime.runEvents(outcome);
    assert.deepEqual(replayTransitions(events), []);
    assert.ok(events.some((event) => event.type === "context/source_changed"));
    const states = events.flatMap((event) => (event.type === "task/state_changed" ? [event.data.to] : []));
    assert.deepEqual(states, ["ready", "running", "needs_context", "ready", "running", "verifying", "completed"]);
    const second = runtime.driver.turns[1]?.input.packet;
    assert.equal(second?.context.sources.find((source) => source.path === "docs/spec.md")?.digest, digestText("v2\n"));
  } finally {
    await workspace.cleanup();
  }
});
