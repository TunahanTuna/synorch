import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, overridesFor, planArguments, ScriptedInput, taskReport, text, writeConfig } from "./fixtures/cli/runtime/support.ts";

/** K1.7 plain-mode text equivalents: the delegation line in the main chat, `/workers` and `/worker <key> [message]`. */

const README = "# Synorch\n\nThis is teh readme.\n";
const README_FIXED = "# Synorch\n\nThis is the readme.\n";

test("plain mode: delegation line, /workers lists the run's workers, /worker shows the assignment and refuses a finished worker", async () => {
  const sandbox = await createSandbox({ "README.md": README });
  try {
    await writeConfig(sandbox.home, [
      { tier: "session" as never, adapter: "chat-script", model: "chat" },
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "worker-script", model: "worker" },
      { tier: "fast_worker", adapter: "worker-script", model: "worker" },
    ]);
    const chat = createScriptedAdapter([call("orchestrate", () => ({ goal: "Fix the typo in README.md", reason: "Two areas." })), text("Done.")], { adapterId: "chat-script" });
    const planner = createScriptedAdapter(
      [call("plan_propose", () => planArguments("Fix the typo in README.md", [{ key: "fix-typo", risk: "trivial", owned: ["README.md"], read: ["README.md"], tier: "fast_worker" }])), text("planned")],
      { adapterId: "plan-script" },
    );
    const worker = createScriptedAdapter(
      [call("write_file", () => ({ path: "README.md", content: README_FIXED, expected_digest: sha256(README) })), taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]), text("fixed")],
      { adapterId: "worker-script" },
    );
    const input = ["fix the readme typo with workers", "/workers", "/worker fix-typo", "/worker fix-typo please also fix the title", "/worker nope", "/exit", ""].join("\n");
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, false), stdinIsTTY: false });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [chat, planner, worker] }));
    const stdout = io.stdout();
    assert.equal(code, 0, io.stderr());
    assert.match(stdout, /-> fix-typo \(implementer, worker\): Do fix-typo/, "the main chat shows the delegation card");
    assert.match(stdout, /Workers . 0 running/);
    assert.match(stdout, /fix-typo\s+implementer\s+completed\s+worker/, "/workers lists key, role, status and model");
    assert.match(stdout, /fix-typo - implementer - worker - completed/, "/worker shows the worker snapshot header");
    assert.match(stdout, /Assignment[\s\S]*owns\s+README\.md[\s\S]*AC-1: fix-typo is done/, "with the orchestrator's assignment");
    assert.match(stdout, /Write README\.md/, "and the worker's transcript so far");
    assert.match(`${stdout}${io.stderr()}`, /fix-typo is not running \(completed\); nothing was sent/);
    assert.match(stdout, /No worker nope . known: fix-typo/);
  } finally {
    await sandbox.cleanup();
  }
});
