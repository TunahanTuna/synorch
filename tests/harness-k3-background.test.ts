import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { sha256, type ModelRequest } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, eventsOf, FakeInput, overridesFor, planArguments, readSession, taskReport, text, trustWorkspace, writeConfig } from "./fixtures/cli/runtime/support.ts";

/**
 * K3 (UX-GATE-02): in an interactive session `orchestrate` returns at once with a run id, the
 * conversation stays open, and the run's result block reaches the agent as a completion note (a
 * follow-up turn when idle); `run_cancel` stops a background run.
 */

const README = "# Synorch\n\nThis is teh readme.\n";
const README_FIXED = "# Synorch\n\nThis is the readme.\n";

/** A terminal whose typed lines wait until the session starts reading. */
class TypedInput extends FakeInput {
  private readonly queued: string[] = [];

  public constructor() {
    super(true);
  }

  public override send(value: string): void {
    if (this.listenerCount("data") > 0) super.send(value);
    else this.queued.push(value);
  }

  public override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void);
    if (event === "data" && this.queued.length > 0) setImmediate(() => this.queued.splice(0).forEach((value) => super.send(value)));
    return this;
  }
}

async function waitFor(read: () => string, pattern: RegExp, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(read())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}\n${read()}`);
    await delay(10);
  }
}

function toolResults(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => message.content.flatMap((part) => (part.type === "tool_result" ? [part.text] : [])));
}

function userTexts(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? []).filter((message) => message.role === "user").flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])));
}

async function routes(home: string): Promise<void> {
  await writeConfig(home, [
    { tier: "session" as never, adapter: "chat-script", model: "chat" },
    { tier: "orchestrator", adapter: "plan-script", model: "planner" },
    { tier: "complex_worker", adapter: "worker-script", model: "worker" },
    { tier: "fast_worker", adapter: "worker-script", model: "worker" },
  ]);
}

function planner() {
  return createScriptedAdapter(
    [call("plan_propose", () => planArguments("Fix the typo in README.md", [{ key: "fix-typo", risk: "trivial", owned: ["README.md"], read: ["README.md"], tier: "fast_worker" }])), text("planned")],
    { adapterId: "plan-script" },
  );
}

test("background orchestrate: the tool returns at once, the chat stays open, and a completion note starts a follow-up turn", async () => {
  const sandbox = await createSandbox({ "README.md": README });
  await trustWorkspace(sandbox);
  try {
    await routes(sandbox.home);
    const chat = createScriptedAdapter(
      [call("orchestrate", () => ({ goal: "Fix the typo in README.md", reason: "Shows the background path." })), text("Workers are on it."), text("Workers fixed the typo in README.md.")],
      { adapterId: "chat-script" },
    );
    const worker = createScriptedAdapter(
      [call("write_file", () => ({ path: "README.md", content: README_FIXED, expected_digest: sha256(README) })), taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]), text("fixed")],
      { adapterId: "worker-script" },
    );
    const input = new TypedInput();
    const io = capture({ cwd: sandbox.workspace, stdin: input, stdinIsTTY: true });
    const session = runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [chat, planner(), worker] }));
    input.send("fix the readme typo with workers\n");
    await waitFor(io.stdout, /Workers run in the background \(run-1\)/);
    await waitFor(io.stdout, /synorch: Workers fixed the typo in README\.md\./, 60_000);
    input.send("/runs\n");
    await waitFor(io.stdout, /run-1\s+succeeded\s+1\/1 tasks/);
    input.send("/exit\n");
    const code = await session;
    const stdout = io.stdout();
    assert.equal(code, 0, `${stdout}\n${io.stderr()}`);
    assert.equal(await readFile(path.join(sandbox.workspace, "README.md"), "utf8"), README_FIXED, "the worker's fix was integrated");
    assert.match(stdout, /Background workers run-1 finished/);

    assert.ok(toolResults(chat.requests[1]).some((result) => result.includes("Started worker run run-1 in the background")), "orchestrate returned before the run ended");
    const followUp = chat.requests[2];
    assert.ok(userTexts(followUp).some((value) => value.includes("background worker run run-1 ended: succeeded") && value.includes("Orchestration succeeded")), "the completion note carries the result block");

    const sessionId = /--resume (ses_\S+)\)/.exec(io.stderr())?.[1] ?? "";
    const log = await readSession(sandbox.home, sessionId);
    assert.deepEqual(eventsOf(log, "turn/started").map((event) => event.data.trigger), ["user", "follow-up"]);
  } finally {
    await sandbox.cleanup();
  }
});

test("run_cancel stops a background run and the agent is told it ended cancelled", async () => {
  const sandbox = await createSandbox({ "README.md": README });
  await trustWorkspace(sandbox);
  try {
    await routes(sandbox.home);
    const chat = createScriptedAdapter(
      [call("orchestrate", () => ({ goal: "Fix the typo in README.md", reason: "Cancel path." })), call("run_cancel", () => ({})), text("Stopped the workers."), text("The run was cancelled; nothing changed.")],
      { adapterId: "chat-script" },
    );
    const worker = createScriptedAdapter(
      [call("write_file", () => ({ path: "README.md", content: README_FIXED, expected_digest: sha256(README) })), taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]), text("fixed")],
      { adapterId: "worker-script" },
    );
    const input = new TypedInput();
    const io = capture({ cwd: sandbox.workspace, stdin: input, stdinIsTTY: true });
    const session = runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [chat, planner(), worker] }));
    input.send("fix it with workers, then stop\n");
    await waitFor(() => `${io.stdout()}${io.stderr()}`, /Background workers run-1 cancelled/, 60_000);
    await waitFor(io.stdout, /synorch: The run was cancelled; nothing changed\./, 60_000);
    input.send("/exit\n");
    const code = await session;
    assert.equal(code, 0, `${io.stdout()}\n${io.stderr()}`);
    assert.ok(toolResults(chat.requests[2]).some((result) => result.includes("Cancelling run-1")), "run_cancel answered");
    assert.ok(userTexts(chat.requests[3]).some((value) => value.includes("background worker run run-1 ended: cancelled")), "the agent is told the run was cancelled");
  } finally {
    await sandbox.cleanup();
  }
});
