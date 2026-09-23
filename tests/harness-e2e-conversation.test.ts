import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createId, digestOf, sha256, type NormalizedAction } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createPolicyEngine } from "../src/harness/policy/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, eventsOf, overridesFor, readSession, ScriptedInput, TEST_SANDBOX, text } from "./fixtures/cli/runtime/support.ts";

/**
 * K0 vertical slice (ADR-21): `syn agent` is a conversation. A greeting is one model request with no
 * plan; the agent reads and explains, edits the main tree (checkpointed), runs a test after the
 * trust question at the first repository-code command, and `/undo` restores the file. Plain
 * interactive mode (a terminal on stdin), a scripted model, the real runtime.
 */

const BROKEN = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
const TEST_FILE = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./src-add.mjs";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n';

test("syn agent: greeting without a plan, read and explain, edit, exec after trust, /undo", async () => {
  const sandbox = await createSandbox({ "src-add.mjs": BROKEN, "add.test.mjs": TEST_FILE });
  try {
    // Only an orchestrator route: the conversation falls back to it (no `session` tier configured).
    await writeFile(path.join(sandbox.home, "config.yaml"), "routes:\n  - { tier: orchestrator, provider: scripted, model: chat, adapter: conv-script }\n");
    const model = createScriptedAdapter(
      [
        text("Merhaba! Ne üzerinde çalışalım?"),
        call("read_file", () => ({ path: "src-add.mjs" })),
        text("`add` toplama yerine çıkarma yapıyor (`src-add.mjs:2`)."),
        call("apply_patch", () => ({ patch: "*** Begin Patch\n*** Update File: src-add.mjs\n@@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch" })),
        text("Düzelttim; bağımsız olarak incelenmedi."),
        call("exec", () => ({ argv: ["node", "--test"] })),
        text("Test geçti."),
      ],
      { adapterId: "conv-script" },
    );
    const input = ["selam", "src-add.mjs ne yapıyor?", "add'i düzelt", "testi çalıştır", "s", "/undo", "/exit", ""].join("\n");
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, true), stdinIsTTY: true });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [model] }));
    const stdout = io.stdout();
    assert.equal(code, 0, io.stderr());

    assert.match(stdout, /^synorch: Merhaba! Ne üzerinde çalışalım\?$/m);
    assert.match(stdout, /^tool: Read src-add\.mjs - 3 lines$/m);
    assert.match(stdout, /^tool: Edit src-add\.mjs - \+1 -1$/m);
    assert.match(stdout, /^tool: Run node --test - \+ exit 0/m);
    assert.match(stdout, /Reverted src-add\.mjs/);
    assert.doesNotMatch(stdout, /(ses|run|call|turn)_[0-9A-Z]{26}|->|\{"/, "no ids, state transitions or JSON in the default view");
    assert.equal(await readFile(path.join(sandbox.workspace, "src-add.mjs"), "utf8"), BROKEN, "/undo restored the file");

    const sessionId = /--resume (ses_\S+)\)/.exec(io.stderr())?.[1];
    assert.ok(sessionId !== undefined, io.stderr());
    const log = await readSession(sandbox.home, sessionId);
    const firstTurnEnd = log.findIndex((event) => event.type === "turn/ended");
    assert.equal(log.slice(0, firstTurnEnd).filter((event) => event.type === "model/request_prepared").length, 1, "a greeting is one model request");
    assert.equal(log.filter((event) => /^(plan|task|attempt|run)\//.test(event.type)).length, 0, "no plan, task, attempt or run in a conversation");
    assert.ok(log.every((event) => event.run_id === undefined), "conversation turns belong to no run");
    assert.ok(eventsOf(log, "message/recorded").some((event) => event.actor.kind === "agent" && event.actor.role === "session"));
    const [checkpoint] = eventsOf(log, "checkpoint/recorded");
    assert.equal(checkpoint?.data.files[0]?.path, "src-add.mjs");
    assert.equal(checkpoint?.data.files[0]?.after, sha256(FIXED), "the checkpoint pins the edited content");
    assert.deepEqual(eventsOf(log, "checkpoint/restored")[0]?.data.restored, ["src-add.mjs"]);
    const exec = eventsOf(log, "tool/result_recorded").find((event) => event.data.result.exit_code !== undefined);
    assert.equal(exec?.data.result.exit_code, 0, "the test ran after the trust answer and passed");
    await assert.rejects(readFile(path.join(sandbox.home, "trust.json"), "utf8"), "trust for this session only is never saved");
  } finally {
    await sandbox.cleanup();
  }
});

test("session rails: reserved paths, role manifests and git history stay out of reach", () => {
  const engine = createPolicyEngine({ workspaceTrusted: () => true });
  const policy = engine.compute({
    mode: "autonomous",
    role: "session",
    runId: undefined,
    taskId: undefined,
    workspaceRoot: process.cwd(),
    taskScope: undefined,
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: TEST_SANDBOX,
    grants: [],
    commandGrants: ["node scripts/build.mjs"],
  });
  const action = (paths: NormalizedAction["paths"], command?: NormalizedAction["command"]): NormalizedAction => ({
    tool_name: command === undefined ? "write_file" : "exec",
    tool_version: "1",
    effect: command === undefined ? "workspace-write" : "exec",
    role: "session",
    args_digest: digestOf(createId("toolCall")),
    paths,
    ...(command === undefined ? {} : { command }),
    network_hosts: [],
    destructive: false,
  });
  const decide = (candidate: NormalizedAction) => engine.evaluate(candidate, policy).decision;
  assert.equal(decide(action([{ path: "src/app.ts", access: "write" }])), "allow", "the workspace is the conversation agent's write scope");
  for (const reserved of [".git/config", ".git/HEAD", ".synorch/config.yaml", ".ai/agents/implementer/AGENT.md"]) {
    assert.equal(decide(action([{ path: reserved, access: "write" }])), "deny", reserved);
  }
  assert.equal(decide(action([{ path: ".", access: "read" }], { argv: ["git", "commit", "-m", "x"], cwd: "." })), "deny", "git history changes are refused");
  assert.equal(decide(action([{ path: ".", access: "read" }], { argv: ["node", "scripts/build.mjs", "--fast"], cwd: "." })), "allow", "an /allow prefix extends the allowlist");
  assert.equal(decide(action([{ path: ".", access: "read" }], { argv: ["node", "scripts/other.mjs"], cwd: "." })), "deny", "anything else stays refused");
  assert.equal(decide(action([{ path: ".", access: "read" }], { argv: ["rm", "-rf", "/"], cwd: "." })), "deny", "destructive commands stay refused");
});
