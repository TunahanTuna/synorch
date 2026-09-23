import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, eventsOf, overridesFor, readSession, ScriptedInput, text } from "./fixtures/cli/runtime/support.ts";

/**
 * ADR-08 owner revision (2026-09-24): an interactive conversation starts in auto mode. A command
 * outside the allowlist is asked for with an action card instead of refused; "Always allow" is
 * persisted per workspace and audited; "Deny and tell Synorch why" reaches the model; full access
 * runs it without a prompt; headless keeps default-deny.
 */

const GEN = 'import { writeFileSync } from "node:fs";\nwriteFileSync("out.txt", "generated\\n");\n';
const ROUTE = "routes:\n  - { tier: session, provider: scripted, model: chat, adapter: perm-script }\n";

function script(times: number) {
  const steps = [];
  for (let index = 0; index < times; index += 1) steps.push(call("exec", () => ({ argv: ["node", "gen.mjs"] })), text(`run ${index + 1} done`));
  return createScriptedAdapter(steps, { adapterId: "perm-script" });
}

test("auto mode asks for a command outside the allowlist; Always allow persists; deny with a reason tells the model", async () => {
  const sandbox = await createSandbox({ "gen.mjs": GEN });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), ROUTE);
    const model = script(2);
    const input = ["generate", "4", "use the npm script", "generate again", "2", "/permissions", "/exit", ""].join("\n");
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, true), stdinIsTTY: true });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [model] }));
    const stdout = io.stdout();
    assert.equal(code, 0, io.stderr());
    assert.match(stdout, /Allow Synorch to run this command\? node gen\.mjs/);
    assert.match(stdout, /2\. Always allow `node gen\.mjs` in this folder/);
    const told = model.requests[1]?.messages.some((message) => message.content.some((part) => part.type === "tool_result" && part.text.includes("the user said: use the npm script")));
    assert.ok(told, "the denial reason reaches the model");
    assert.equal(await readFile(path.join(sandbox.workspace, "out.txt"), "utf8"), "generated\n", "allowed after the second prompt");
    const grants = JSON.parse(await readFile(path.join(sandbox.home, "command-grants.json"), "utf8")) as { workspaces: Record<string, string[]> };
    assert.deepEqual(Object.values(grants.workspaces), [["node gen.mjs"]]);
    assert.match(stdout, /Mode +auto/);
    assert.match(stdout, /Always allowed +node gen\.mjs/);

    const log = await readSession(sandbox.home, /--resume (ses_\S+)\)/.exec(io.stderr())?.[1] ?? "");
    assert.deepEqual(eventsOf(log, "tool/policy_decided").map((event) => event.data.decision.decision), ["ask", "ask"]);
    assert.deepEqual(eventsOf(log, "approval/decided").map((event) => event.data.decision.outcome), ["rejected", "allowed-for-scope"]);
    assert.equal(eventsOf(log, "command/allowed")[0]?.data.prefix, "node gen.mjs", "the grant is audited");
  } finally {
    await sandbox.cleanup();
  }
});

test("full access runs it without a prompt and says so in red; headless default-deny refuses it", async () => {
  const sandbox = await createSandbox({ "gen.mjs": GEN });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), ROUTE);
    const full = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(["generate", "/exit", ""].join("\n"), true), stdinIsTTY: true });
    assert.equal(await runHarnessCommand(["agent", "--plain", "--permission-mode", "full"], full.io, overridesFor(sandbox, { adapters: [script(1)] })), 0, full.stderr());
    assert.match(`${full.stdout()}${full.stderr()}`, /Full access: Synorch edits and runs any command in this folder without asking/);
    assert.doesNotMatch(full.stdout(), /Allow Synorch to run this command/);
    assert.equal(await readFile(path.join(sandbox.workspace, "out.txt"), "utf8"), "generated\n");
    await assert.rejects(readFile(path.join(sandbox.home, "trust.json"), "utf8"), "full access trusts for the session only");

    const headless = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(["generate", ""].join("\n"), false), stdinIsTTY: false });
    assert.equal(await runHarnessCommand(["agent", "--plain"], headless.io, overridesFor(sandbox, { adapters: [script(1)] })), 0, headless.stderr());
    const log = await readSession(sandbox.home, /--resume (ses_\S+)\)/.exec(headless.stderr())?.[1] ?? "");
    assert.deepEqual(eventsOf(log, "tool/policy_decided").map((event) => event.data.decision.decision), ["deny"], "headless keeps default-deny");
  } finally {
    await sandbox.cleanup();
  }
});
