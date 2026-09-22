import assert from "node:assert/strict";
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
  overridesFor,
  parseFrames,
  planArguments,
  readSession,
  ScriptedInput,
  taskReport,
  text,
  toolResultIds,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * `ask_user` is bound to the session's renderer: in an interactive terminal the orchestrator's
 * question is shown and the typed answer returns as the tool result; headless (JSONL, piped input)
 * it answers `approval_unavailable`, and a run that cannot plan without the answer exits 3.
 */

const ROUTES = [
  { tier: "orchestrator", adapter: "plan-script", model: "planner" },
  { tier: "complex_worker", adapter: "worker-script", model: "worker" },
  { tier: "fast_worker", adapter: "worker-script", model: "worker" },
] as const;

test("headless: ask_user is unavailable and a run that cannot plan without the answer exits 3", async () => {
  const sandbox = await createSandbox({ "README.md": "# ask\n" });
  try {
    await writeConfig(sandbox.home, ROUTES);
    const orchestrator = createScriptedAdapter([call("ask_user", () => ({ question: "Which folder holds the docs?" })), text("I cannot plan without knowing the folder.")], { adapterId: "plan-script" });
    const worker = createScriptedAdapter([text("never")], { adapterId: "worker-script" });
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Document the API", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, worker] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 3, run.stderr());
    const last = frames.at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.data.code, "approval_unavailable");
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const result = eventsOf(await readSession(sandbox.home, hello.data.session_id), "tool/result_recorded").find((event) => event.data.result.error?.code === "approval_unavailable");
    assert.ok(result !== undefined, "the refusal is recorded as the tool result the model saw");
    assert.equal(worker.requests.length, 0);
  } finally {
    await sandbox.cleanup();
  }
});

test("interactive: the orchestrator's question is shown and the typed answer is its tool result", async () => {
  const sandbox = await createSandbox({ "docs/api.md": "api\n", "README.md": "# ask\n" });
  try {
    await writeConfig(sandbox.home, ROUTES);
    const answers: string[] = [];
    const orchestrator = createScriptedAdapter(
      [
        call("ask_user", () => ({ question: "Which folder holds the docs?", options: ["docs", "site"] })),
        calls((request) => {
          const last = request.messages.at(-1);
          answers.push(last?.content.map((part) => (part.type === "tool_result" ? JSON.stringify(part) : "")).join("") ?? "");
          return [{ name: "plan_propose", arguments: planArguments("Document the API", [{ key: "doc", risk: "trivial", owned: ["docs/api.md"], read: ["docs/api.md"] }]) }];
        }),
        text("planned"),
      ],
      { adapterId: "plan-script" },
    );
    const worker = createScriptedAdapter(
      [call("write_file", () => ({ path: "docs/api.md", content: "api documented\n", expected_digest: sha256("api\n") })), taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]), text("done")],
      { adapterId: "worker-script" },
    );
    const run = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput("docs\n", true), stdinIsTTY: true });
    const code = await runHarnessCommand(["run", "Document the API", "--plain"], run.io, overridesFor(sandbox, { adapters: [orchestrator, worker] }));
    assert.equal(code, 0, `${run.stdout()}\n${run.stderr()}`);
    assert.match(run.stdout(), /Question from the orchestrator: Which folder holds the docs\?/);
    assert.match(run.stdout(), /Options: docs \| site/);
    assert.match(run.stdout(), /^Approval allowed-for-scope by orchestrator \(autonomous self-approval, audited\)$/m);
    assert.doesNotMatch(run.stdout(), /warning: Approval/, "the plain renderer does not present an audited self-approval as a warning");
    assert.match(answers[0] ?? "", /The user answered: docs/);
    assert.equal(toolResultIds(orchestrator.requests[1]!).length, 1);
  } finally {
    await sandbox.cleanup();
  }
});
