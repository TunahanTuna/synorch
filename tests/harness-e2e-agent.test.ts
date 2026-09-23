import assert from "node:assert/strict";
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
  planArguments,
  projectionIssues,
  readSession,
  ScriptedInput,
  taskReport,
  text,
  writeConfig,
  type Sandbox,
} from "./fixtures/cli/runtime/support.ts";

/**
 * `syn agent`: an orchestrated session fed from piped input (plain renderer), the in-session
 * commands of cli-experience.md, and `--resume` / `--fork` of the saved session.
 */

const ROUTES = [
  { tier: "orchestrator", adapter: "plan-script", model: "planner" },
  { tier: "complex_worker", adapter: "worker-script", model: "worker" },
  { tier: "fast_worker", adapter: "worker-script", model: "worker" },
] as const;

function adapters(file: string, before: string, after: string) {
  return [
    createScriptedAdapter(
      [call("plan_propose", () => planArguments(`Edit ${file}`, [{ key: "edit", risk: "trivial", owned: [file], read: [file] }])), text("planned")],
      { adapterId: "plan-script" },
    ),
    createScriptedAdapter(
      [call("write_file", () => ({ path: file, content: after, expected_digest: sha256(before) })), taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]), text("edited")],
      { adapterId: "worker-script" },
    ),
  ];
}

async function agent(sandbox: Sandbox, args: readonly string[], input: string, scripted: ReturnType<typeof adapters> = adapters("unused.md", "", "")) {
  const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input) });
  const code = await runHarnessCommand(["agent", "--legacy", "--plain", ...args], io.io, overridesFor(sandbox, { adapters: scripted }));
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

test("syn agent runs a goal from piped input and answers the in-session commands", async () => {
  const sandbox = await createSandbox({ "notes.md": "one\n", "README.md": "# agent\n" });
  try {
    await writeConfig(sandbox.home, ROUTES);
    const commands = ["/plan", "/tasks", "/evidence", "/permissions", "/model", "/diff", "/context", "/memory", "/help", "/exit"];
    const session = await agent(sandbox, [], ["Add a second line to notes.md", ...commands, ""].join("\n"), adapters("notes.md", "one\n", "one\ntwo\n"));
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stdout, /Run run_\S+ succeeded \(exit 0\)/);
    assert.match(session.stdout, /plan plan_\S+ v1 sha256:/);
    assert.match(session.stdout, /approval allowed-for-scope by orchestrator \(autonomous\)/);
    assert.match(session.stdout, /edit task_\S+ completed \(implementer; notes\.md\)/);
    assert.match(session.stdout, /AC-1: tool-call:call_/);
    assert.match(session.stdout, /implementer: read=allow workspace-write=allow/);
    assert.match(session.stdout, /configured orchestrator -> scripted\/planner via plan-script \(user\)/);
    assert.match(session.stdout, /task_\S+ sha256:\S+: notes\.md/);
    assert.match(session.stdout, /- harness \(harness\) ~\d+/);
    assert.match(session.stdout, /0 proposal\(s\) waiting/);
    assert.match(session.stdout, /\/cancel\s+cancel the active run/);
    const saved = /Session saved: (ses_\S+)/.exec(session.stderr)?.[1];
    assert.ok(saved !== undefined, session.stderr);

    const resumed = await agent(sandbox, ["--resume", saved], "Add a third line\n", adapters("notes.md", "one\ntwo\n", "one\ntwo\nthree\n"));
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /recovered ses_\S+: 0 open item\(s\) closed/);
    const log = await readSession(sandbox.home, saved);
    assert.equal(eventsOf(log, "run/created").length, 2, "the resumed session continues in the same log");
    assert.equal(eventsOf(log, "session/resumed").length, 1);
    assert.deepEqual(projectionIssues(log), []);

    const forked = await agent(sandbox, ["--fork", saved], "/exit\n");
    assert.equal(forked.code, 0, forked.stderr);
    const child = /forked ses_\S+@\d+ into (ses_\S+)/.exec(forked.stdout)?.[1];
    assert.ok(child !== undefined, forked.stdout);
    const childLog = await readSession(sandbox.home, child);
    const opened = eventsOf(childLog, "session/opened").at(-1);
    assert.equal(opened?.data.parent?.session_id, saved, "the fork records its parent");
    assert.equal(eventsOf(childLog, "run/created").length, 2, "a fork reads its ancestor's history");
  } finally {
    await sandbox.cleanup();
  }
});

test("syn agent without any configured route fails with a usage exit and a next step", async () => {
  const sandbox = await createSandbox({ "README.md": "# agent\n" });
  try {
    const session = await agent(sandbox, [], "/exit\n");
    assert.equal(session.code, 2);
    assert.match(session.stderr, /Error \[config_invalid\]: no model route is configured for tier orchestrator/);
    assert.match(session.stderr, /next: syn doctor --runtime/);
  } finally {
    await sandbox.cleanup();
  }
});
