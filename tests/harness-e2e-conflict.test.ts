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
  overridesFor,
  parseFrames,
  planArguments,
  readSession,
  taskReport,
  text,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Verification level 3, "two conflicting tasks" (Faz 2 gate): a plan whose two unordered tasks own
 * the same path is rejected and never recorded; the orchestrator's corrected plan orders them, and
 * the scheduler runs the second writer only after the first one completed and was integrated. The
 * shared scripted worker would interleave (and fail) if the two attempts ever ran concurrently.
 */

test("two conflicting tasks: an unordered overlap is rejected and the ordered pair never writes in parallel", async () => {
  const sandbox = await createSandbox({ "notes.md": "a\n", "README.md": "# notes\n" });
  try {
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "worker-script", model: "worker" },
      { tier: "fast_worker", adapter: "worker-script", model: "worker" },
    ]);
    const overlapping = [
      { key: "append-b", risk: "trivial" as const, owned: ["notes.md"], read: ["notes.md"] },
      { key: "append-c", risk: "trivial" as const, owned: ["notes.md"], read: ["notes.md"] },
    ];
    const orchestrator = createScriptedAdapter(
      [
        call("plan_propose", () => planArguments("Append two lines", overlapping)),
        text("first plan"),
        call("plan_propose", () => planArguments("Append two lines", [overlapping[0] ?? { key: "x" }, { ...overlapping[1], key: "append-c", dependsOn: ["append-b"] }])),
        text("second plan"),
      ],
      { adapterId: "plan-script" },
    );
    const worker = createScriptedAdapter(
      [
        call("write_file", () => ({ path: "notes.md", content: "a\nb\n", expected_digest: sha256("a\n") })),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        text("b appended"),
        call("write_file", () => ({ path: "notes.md", content: "a\nb\nc\n", expected_digest: sha256("a\nb\n") })),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        text("c appended"),
      ],
      { adapterId: "worker-script" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Append two lines", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, worker] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 0, run.stderr());
    assert.match(run.stderr(), /plan candidate 1 rejected/);
    assert.equal(await readFile(path.join(sandbox.workspace, "notes.md"), "utf8"), "a\nb\nc\n");

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    assert.equal(eventsOf(runLog, "plan/proposed").length, 1, "the overlapping plan was never recorded as a plan");
    assert.equal(eventsOf(runLog, "tool/call_proposed").filter((event) => event.data.tool_name === "plan_propose").length, 2);

    const created = new Map(eventsOf(runLog, "task/created").map((event) => [event.data.key, event.data.task_id]));
    const first = created.get("append-b");
    const second = created.get("append-c");
    const completedFirst = eventsOf(runLog, "task/state_changed").find((event) => event.data.task_id === first && event.data.to === "completed");
    const integratedFirst = eventsOf(runLog, "task/integrated").find((event) => event.data.task_id === first);
    const startedSecond = eventsOf(runLog, "attempt/started").find((event) => event.data.task_id === second);
    assert.ok(completedFirst !== undefined && integratedFirst !== undefined && startedSecond !== undefined);
    assert.ok(integratedFirst.seq < completedFirst.seq && completedFirst.seq < startedSecond.seq, "the second writer starts only after the first completed");
    for (const attempt of eventsOf(runLog, "attempt/started")) {
      const finished = eventsOf(runLog, "attempt/state_changed").find((event) => event.data.attempt_id === attempt.data.attempt_id);
      const overlapping = eventsOf(runLog, "attempt/started").filter((other) => other.seq > attempt.seq && finished !== undefined && other.seq < finished.seq);
      assert.deepEqual(overlapping, [], "no other attempt started while one was running");
    }
  } finally {
    await sandbox.cleanup();
  }
});
