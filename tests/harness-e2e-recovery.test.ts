import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jsonlFrameSchema, splitJsonlLines, type JsonlFrame, type SessionEvent } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { capture, createSandbox, eventsOf, FakeInput, overridesFor, planArguments, readSession } from "./fixtures/cli/runtime/support.ts";

/**
 * Verification level 3, "crash after the tool ran, before its result was recorded" (Faz 1 gate,
 * I1 AC-4 end to end): a real `syn run` process is killed while its worker's `exec` is running.
 * `syn agent --resume` then recovers the run session and the attempt session it started: the call
 * is closed as `tool/interrupted {outcome: unknown}`, the side effect is not repeated, and the user
 * sees what was recovered.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const HANG = [
  'import { appendFileSync } from "node:fs";',
  "appendFileSync(\"marker.txt\", `${process.pid}\\n`);",
  "setTimeout(() => process.exit(0), 120000);",
  "",
].join("\n");

class EndingInput extends FakeInput {
  public override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void);
    if (event === "end") setImmediate(() => this.emit("end"));
    return this;
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the crash point");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("crash after tool/execution_started: resume records tool/interrupted and never re-runs the call", { timeout: 90_000 }, async () => {
  const sandbox = await createSandbox({ "hang.mjs": HANG, "README.md": "# crash\n" });
  let orphan: number | undefined;
  try {
    const plannerScript = path.join(sandbox.home, "planner.json");
    const workerScript = path.join(sandbox.home, "worker.json");
    await writeFile(
      plannerScript,
      JSON.stringify([
        { tool_calls: [{ name: "plan_propose", arguments: planArguments("Run the hanging tool", [{ key: "hang", risk: "trivial", owned: ["marker.txt"], read: ["hang.mjs"] }]) }] },
        { text: "planned" },
      ]),
    );
    await writeFile(workerScript, JSON.stringify([{ tool_calls: [{ name: "exec", arguments: { argv: ["node", "hang.mjs"], timeout_ms: 120000 } }] }, { text: "unreachable" }]));
    await writeFile(
      path.join(sandbox.home, "config.yaml"),
      [
        "adapters:",
        `  - { id: plan-script, kind: scripted, script: ${JSON.stringify(plannerScript)} }`,
        `  - { id: worker-script, kind: scripted, script: ${JSON.stringify(workerScript)} }`,
        "routes:",
        "  - { tier: orchestrator, provider: scripted, model: planner, adapter: plan-script }",
        "  - { tier: complex_worker, provider: scripted, model: worker, adapter: worker-script }",
        "  - { tier: fast_worker, provider: scripted, model: worker, adapter: worker-script }",
        "",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [CLI, "run", "Run the hanging tool", "--mode", "jsonl"], {
      cwd: sandbox.workspace,
      env: { ...process.env, SYNORCH_HOME: sandbox.home, SYNORCH_CREDENTIAL_STORE: "file", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const frames: JsonlFrame[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const { lines, rest } = splitJsonlLines(buffer + chunk);
      buffer = rest;
      for (const line of lines) frames.push(jsonlFrameSchema.parse(JSON.parse(line)));
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const started = (): SessionEvent | undefined =>
      frames.flatMap((frame) => (frame.type === "event" && frame.data.type === "tool/execution_started" ? [frame.data] : [])).find((event) => event.actor.role === "implementer");
    await until(() => started() !== undefined && existsSync(path.join(sandbox.workspace, "marker.txt")), 60_000);
    child.kill("SIGKILL");
    await exited;
    orphan = Number((await readFile(path.join(sandbox.workspace, "marker.txt"), "utf8")).trim());
    try {
      process.kill(orphan);
    } catch {
      orphan = undefined;
    }

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    assert.ok(!frames.some((frame) => frame.type === "result" || frame.type === "error"), "the process died before any terminal frame");
    const crashed = started();
    assert.ok(crashed?.type === "tool/execution_started");
    const callId = crashed.data.tool_call_id;
    const attemptSession = crashed.session_id;

    const resume = capture({ cwd: sandbox.workspace, stdin: new EndingInput() });
    const code = await runHarnessCommand(["agent", "--resume", hello.data.session_id, "--plain"], resume.io, overridesFor(sandbox));
    assert.equal(code, 0, resume.stderr());
    assert.match(resume.stdout(), /1 tool call\(s\) interrupted with unknown outcome \(not re-run\)/);

    const attemptLog = await readSession(sandbox.home, attemptSession);
    assert.equal(eventsOf(attemptLog, "tool/execution_started").filter((event) => event.data.tool_call_id === callId).length, 1, "the call started exactly once");
    assert.equal(eventsOf(attemptLog, "tool/result_recorded").filter((event) => event.data.tool_call_id === callId).length, 0);
    const interrupted = eventsOf(attemptLog, "tool/interrupted");
    assert.deepEqual(interrupted.map((event) => [event.data.tool_call_id, event.data.outcome, event.data.idempotent]), [[callId, "unknown", false]]);
    assert.equal((await readFile(path.join(sandbox.workspace, "marker.txt"), "utf8")).trim().split("\n").length, 1, "the side effect happened once");

    const runLog = await readSession(sandbox.home, hello.data.session_id);
    assert.equal(eventsOf(runLog, "session/resumed").length, 1);
    assert.equal(eventsOf(runLog, "run/state_changed").at(-1)?.data.to, "interrupted");

    const again = capture({ cwd: sandbox.workspace, stdin: new EndingInput() });
    assert.equal(await runHarnessCommand(["agent", "--resume", hello.data.session_id, "--plain"], again.io, overridesFor(sandbox)), 0, again.stderr());
    assert.equal(eventsOf(await readSession(sandbox.home, attemptSession), "tool/interrupted").length, 1, "a second resume recovers nothing twice");
  } finally {
    if (orphan !== undefined) {
      try {
        process.kill(orphan);
      } catch {
        orphan = undefined;
      }
    }
    await sandbox.cleanup();
  }
});
