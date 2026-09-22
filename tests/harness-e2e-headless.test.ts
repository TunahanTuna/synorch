import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createId, deriveProjectId, type ModelRequest } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { createSessionStore } from "../src/harness/store/index.ts";
import {
  call,
  capture,
  createSandbox,
  eventsOf,
  frameEvents,
  overridesFor,
  parseFrames,
  planArguments,
  readSession,
  text,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Headless and machine-mode exits through the real runtime (I5 AC-2/AC-3, ADR-15): an approval a
 * headless run cannot give ends with an `error` frame and exit 3; a user cancellation exits 130; a
 * session held by another writer exits 8. stdout always carries only valid frames.
 */

const ROUTES = [
  { tier: "orchestrator", adapter: "plan-script", model: "planner" },
  { tier: "complex_worker", adapter: "worker-script", model: "worker" },
  { tier: "fast_worker", adapter: "worker-script", model: "worker" },
] as const;

function planner() {
  return createScriptedAdapter(
    [call("plan_propose", () => planArguments("Edit a", [{ key: "edit-a", risk: "trivial", owned: ["src/a.txt"], read: ["src/a.txt"] }])), text("planned")],
    { adapterId: "plan-script" },
  );
}

test("headless approval in ask mode ends with an error frame and exit 3; nothing runs (AC-3)", async () => {
  const sandbox = await createSandbox({ "src/a.txt": "a\n", "README.md": "# r\n" });
  try {
    await writeConfig(sandbox.home, ROUTES);
    const worker = createScriptedAdapter([text("must not run")], { adapterId: "worker-script" });
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Edit a", "--mode", "jsonl", "--policy", "ask"], run.io, overridesFor(sandbox, { adapters: [planner(), worker] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 3);
    const last = frames.at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.data.code, "approval_unavailable");
    assert.equal(last.data.exit_code, 3);
    assert.equal(last.data.workspace_effect, "none");
    assert.ok(frames.every((frame) => frame.run_id === last.run_id));
    const hello = frames[0];
    assert.ok(hello?.type === "hello" && hello.data.policy_mode === "ask");
    const decided = eventsOf(frameEvents(frames), "approval/decided").map((event) => event.data.decision);
    assert.deepEqual(decided.map((decision) => [decision.subject_kind, decision.outcome, decision.decided_by]), [["plan", "unavailable", "broker"]]);
    assert.equal(eventsOf(frameEvents(frames), "attempt/started").length, 0);
    assert.equal(worker.requests.length, 0);
  } finally {
    await sandbox.cleanup();
  }
});

test("user cancellation during a model stream exits 130 with a cancelled error frame (AC-3)", async () => {
  const sandbox = await createSandbox({ "src/a.txt": "a\n", "README.md": "# r\n" });
  try {
    await writeConfig(sandbox.home, ROUTES);
    const controller = new AbortController();
    const slow = createScriptedAdapter(
      [
        (request: ModelRequest) => {
          setTimeout(() => controller.abort(), 0);
          return [
            { type: "text_delta", index: 0, text: "thinking" },
            ...Array.from({ length: 200 }, () => ({ type: "text_delta" as const, index: 0, text: "." })),
            { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: `never ${request.request_id}` }] } },
          ];
        },
      ],
      { adapterId: "plan-script", yieldBetweenEvents: true },
    );
    const worker = createScriptedAdapter([text("must not run")], { adapterId: "worker-script" });
    const run = capture({ cwd: sandbox.workspace, signal: controller.signal });
    const code = await runHarnessCommand(["run", "Edit a", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [slow, worker] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 130, run.stderr());
    const last = frames.at(-1);
    assert.ok(last?.type === "error" && last.data.code === "cancelled" && last.data.exit_code === 130);
    const events = frameEvents(frames);
    assert.ok(eventsOf(events, "model/response_failed").some((event) => event.data.error.code === "cancelled"), "the stream ended as cancelled, never settled");
    assert.equal(eventsOf(events, "model/response_settled").length, 0);
    assert.equal(eventsOf(events, "run/state_changed").at(-1)?.data.to, "cancelled");
  } finally {
    await sandbox.cleanup();
  }
});

test("a session held by another writer exits 8 and names the fork command (AC-3)", async () => {
  const sandbox = await createSandbox({ "README.md": "# r\n" });
  try {
    await writeConfig(sandbox.home, ROUTES);
    const store = createSessionStore(sandbox.home);
    const held = await store.create({
      session_id: createId("session"),
      project_id: deriveProjectId(sandbox.workspace, process.platform),
      workspace_root: sandbox.workspace,
      created_at: new Date().toISOString(),
    });
    try {
      const agent = capture({ cwd: sandbox.workspace });
      const code = await runHarnessCommand(["agent", "--resume", held.sessionId, "--plain"], agent.io, overridesFor(sandbox, { adapters: [planner(), createScriptedAdapter([text("unused")], { adapterId: "worker-script" })] }));
      assert.equal(code, 8, agent.stderr());
      assert.match(agent.stderr(), /Error \[session_locked\]/);
      assert.match(agent.stderr(), new RegExp(`next: syn agent --fork ${held.sessionId}`));
    } finally {
      await held.close();
    }
    const events = await readSession(sandbox.home, held.sessionId);
    assert.equal(eventsOf(events, "session/resumed").length, 0, "a refused resume writes nothing");
    await access(path.join(sandbox.home, "sessions"));
  } finally {
    await sandbox.cleanup();
  }
});
