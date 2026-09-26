import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { capture, createSandbox, eventsOf, overridesFor, readSession, ScriptedInput, text, writeConfig, type Sandbox } from "./fixtures/cli/runtime/support.ts";

/**
 * `syn agent` fed from piped input (plain renderer): a conversation is saved, `--resume` continues
 * the same log and `--fork` branches it with its parent recorded. The orchestrated paths are covered
 * by the `orchestrate` tool tests and by `syn run`.
 */

const ROUTES = [{ tier: "session" as never, adapter: "chat-script", model: "chat" }] as const;

async function agent(sandbox: Sandbox, args: readonly string[], input: string, replies: readonly string[] = []) {
  const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, false), stdinIsTTY: false });
  const adapters = [createScriptedAdapter(replies.map((reply) => text(reply)), { adapterId: "chat-script" })];
  const code = await runHarnessCommand(["agent", "--plain", ...args], io.io, overridesFor(sandbox, { adapters }));
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

function savedId(stderr: string): string {
  const id = /--resume (ses_\S+)\)/.exec(stderr)?.[1];
  assert.ok(id !== undefined, stderr);
  return id;
}

test("syn agent saves a piped conversation; --resume continues it and --fork branches it", async () => {
  const sandbox = await createSandbox({ "README.md": "# agent\n" });
  try {
    await writeConfig(sandbox.home, ROUTES as never);
    const first = await agent(sandbox, [], "hello\n/exit\n", ["Hi, what should we work on?"]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Hi, what should we work on\?/);
    const saved = savedId(first.stderr);

    const resumed = await agent(sandbox, ["--resume", saved], "and now?\n/exit\n", ["Still here."]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /Resumed/);
    const log = await readSession(sandbox.home, saved);
    assert.equal(eventsOf(log, "turn/started").length, 2, "the resumed conversation continues in the same log");
    assert.equal(eventsOf(log, "session/resumed").length, 1);

    const forked = await agent(sandbox, ["--fork", saved], "/exit\n");
    assert.equal(forked.code, 0, forked.stderr);
    const child = savedId(forked.stderr);
    assert.notEqual(child, saved);
    const opened = eventsOf(await readSession(sandbox.home, child), "session/opened").at(-1);
    assert.equal(opened?.data.parent?.session_id, saved, "the fork records its parent");
  } finally {
    await sandbox.cleanup();
  }
});

test("syn agent without any configured route fails headless with the two commands that connect one", async () => {
  const sandbox = await createSandbox({ "README.md": "# agent\n" });
  try {
    const session = await agent(sandbox, [], "/exit\n");
    assert.equal(session.code, 2);
    assert.match(session.stderr, /Error \[config_invalid\]: no model is connected for the conversation: run syn login openai, then syn config set routes\.session openai\/gpt-6-sol/);
    assert.match(session.stderr, /next: syn login openai && syn config set routes\.session openai\/gpt-6-sol/);
  } finally {
    await sandbox.cleanup();
  }
});

test("syn agent at a terminal without a route connects a provider first and saves routes.session", async () => {
  const sandbox = await createSandbox({ "README.md": "# agent\n" });
  try {
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput("4\ny\n/exit\n", true), stdinIsTTY: true });
    const offline = async (): Promise<Response> => {
      throw new Error("offline");
    };
    const overrides = overridesFor(sandbox, { fetch: offline as never, authOptions: { claudeProbe: async () => ({ installed: true, version: "9.9.9" }) } });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overrides);
    const shown = io.stdout() + io.stderr();
    assert.equal(code, 0, shown);
    assert.match(shown, /Connect a model provider/);
    assert.match(shown, /Connected Claude Code .* anthropic\/opus-5\.5@claude-code \(saved as routes\.session\)/);
    assert.match(await readFile(path.join(sandbox.home, "config.yaml"), "utf8"), /session[\s\S]*anthropic[\s\S]*opus-5\.5[\s\S]*claude-code/);
  } finally {
    await sandbox.cleanup();
  }
});
