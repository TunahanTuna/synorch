import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  FakeInput,
  overridesFor,
  planArguments,
  projectionIssues,
  readSession,
  taskReport,
  text,
  trustWorkspace,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Verification level 3, "user correction while running": in a terminal `syn agent` session a line
 * typed during a run is queued as steering, applied at the next safe boundary (before the next
 * dispatch, never inside a running attempt), the orchestrator is consulted (`task_status`,
 * `task_spawn`), and the plan is re-versioned: the old plan is superseded only once the revision is
 * approved, and the tasks that start afterwards receive the steering in their packets.
 */

/** A terminal whose typed lines wait until the session starts reading (no keystroke is lost under load). */
class TypedInput extends FakeInput {
  private readonly queued: string[] = [];

  public constructor() {
    super(true);
  }

  public override send(text: string): void {
    if (this.listenerCount("data") > 0) super.send(text);
    else this.queued.push(text);
  }

  public override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void);
    if (event === "data" && this.queued.length > 0) setImmediate(() => this.queued.splice(0).forEach((text) => super.send(text)));
    return this;
  }
}

async function waitFor(read: () => string, pattern: RegExp, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(read())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}\n${read()}`);
    await delay(10);
  }
}

test("steering typed during a run is applied at a safe boundary through a re-versioned plan", async () => {
  const sandbox = await createSandbox({ "docs/a.md": "a\n", "docs/b.md": "b\n", "README.md": "# steer\n" });
  await trustWorkspace(sandbox);
  try {
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "worker-script", model: "worker" },
      { tier: "fast_worker", adapter: "worker-script", model: "worker" },
    ]);
    const input = new TypedInput();
    const consultSaw: string[] = [];
    const orchestrator = createScriptedAdapter(
      [
        call("plan_propose", () =>
          planArguments("Edit a then b", [
            { key: "edit-a", risk: "trivial", owned: ["docs/a.md"], read: ["docs/a.md"] },
            { key: "edit-b", risk: "trivial", owned: ["docs/b.md"], read: ["docs/b.md"], dependsOn: ["edit-a"] },
          ]),
        ),
        calls((request) => {
          consultSaw.push(JSON.stringify(request.messages));
          return [{ name: "task_status", arguments: {} }];
        }),
        call("task_spawn", () => ({
          packet: {
            key: "changelog",
            role: "implementer",
            objective: "Record the tab convention in docs/CHANGELOG.md.",
            depends_on: ["edit-b"],
            owned_paths: ["docs/CHANGELOG.md"],
            read_paths: [],
            risk: "trivial",
            model_tier: "fast_worker",
            acceptance_criteria: [{ id: "AC-1", statement: "the changelog mentions tabs" }],
            verification: [],
          },
        })),
        text("consulted"),
      ],
      { adapterId: "plan-script" },
    );
    const workerRequests: string[] = [];
    const worker = createScriptedAdapter(
      [
        calls(() => {
          input.send("use tabs, not spaces\n");
          return [{ name: "write_file", arguments: { path: "docs/a.md", content: "a edited\n", expected_digest: sha256("a\n") } }];
        }),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        calls((request) => {
          workerRequests.push(request.system.map((block) => block.text).join("\n"));
          return [{ name: "write_file", arguments: { path: "docs/b.md", content: "b edited\n", expected_digest: sha256("b\n") } }];
        }),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        call("write_file", () => ({ path: "docs/CHANGELOG.md", content: "- tabs, not spaces\n" })),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        text("changelog done"),
      ],
      { adapterId: "worker-script" },
    );

    const io = capture({ cwd: sandbox.workspace, stdin: input, stdinIsTTY: true });
    const session = runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [orchestrator, worker] }));
    input.send("Edit a then b\n");
    await waitFor(io.stdout, /Run run_\S+ (succeeded|failed) \(exit \d+\)/, 60_000);
    input.send("/exit\n");
    const code = await session;
    assert.equal(code, 0, `${io.stdout()}\n${io.stderr()}`);
    assert.match(io.stdout(), /queued as steering for the next safe boundary/);
    assert.match(io.stdout(), /Run run_\S+ succeeded \(exit 0\)/);

    const sessionId = /Session saved: (ses_\S+)/.exec(io.stderr())?.[1];
    assert.ok(sessionId !== undefined, io.stderr());
    const log = await readSession(sandbox.home, sessionId);
    assert.deepEqual(projectionIssues(log), [], "the re-versioned plan replays cleanly");
    assert.equal(eventsOf(log, "steer/queued")[0]?.data.text, "use tabs, not spaces");
    const plans = eventsOf(log, "plan/proposed").map((event) => event.data.plan);
    assert.deepEqual(plans.map((plan) => plan.version), [1, 2]);
    assert.ok(plans[1]?.assumptions.includes("User steering: use tabs, not spaces"));
    assert.deepEqual(plans[1]?.tasks.map((task) => task.key), ["edit-a", "edit-b", "changelog"], "the orchestrator's task_spawn joined the revision");
    const transitions = eventsOf(log, "plan/state_changed").map((event) => `${event.data.plan_id === plans[0]?.plan_id ? "v1" : "v2"}:${event.data.from}->${event.data.to}`);
    assert.deepEqual(transitions, ["v1:proposed->approved", "v1:approved->superseded", "v2:proposed->approved"]);

    assert.ok(consultSaw.some((messages) => messages.includes("use tabs, not spaces")), "the orchestrator was consulted with the steering");
    const statusResult = eventsOf(log, "tool/result_recorded").find((event) => event.data.result.text.startsWith("plan plan_"));
    assert.match(statusResult?.data.result.text ?? "", /edit-a task_\S+ .*: completed/);
    assert.ok(workerRequests[0]?.includes("User steering: use tabs, not spaces"), "the task dispatched after the boundary carries the steering");
    assert.ok(!worker.requests[0]?.system.some((block) => block.text.includes("User steering")), "the attempt that was running is never changed mid-flight");
    assert.equal(await readFile(path.join(sandbox.workspace, "docs/CHANGELOG.md"), "utf8"), "- tabs, not spaces\n", "the spawned follow-up ran after the revision was approved");
    assert.equal(await readFile(path.join(sandbox.workspace, "docs/b.md"), "utf8"), "b edited\n");
  } finally {
    await sandbox.cleanup();
  }
});
