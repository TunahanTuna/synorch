import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createId, type SandboxReport } from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { BackgroundProcessManager, createToolRegistry } from "../src/harness/tools/index.ts";
import { createGatewayHarness, type GatewayHarness } from "../src/harness/tools/testing.ts";

const engine = createPolicyEngine({ workspaceTrusted: () => true });
const PARTIAL: SandboxReport = { backend: "policy-only", platform: "win32", enforcement: "partial", filesystem: "partial", network: "unavailable", process: "partial", notes: [] };

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "syn-k42-bg-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}

function commandLine(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

function harnessFor(root: string, processes: BackgroundProcessManager, verification: readonly (readonly string[])[]): GatewayHarness {
  return createGatewayHarness({
    engine,
    policy: engine.compute({
      mode: "autonomous",
      role: "implementer",
      runId: createId("run"),
      taskId: createId("task"),
      workspaceRoot: root,
      taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: verification.map(commandLine) },
      userConfig: undefined,
      workspaceConfig: undefined,
      sandbox: PARTIAL,
      grants: [],
    }),
    approvals: createHeadlessApprovalBroker(),
    sandboxReport: PARTIAL,
    registry: createToolRegistry({ classifyCommand, processes }),
  });
}

test("exec background: starts, streams output, lists, and kills the process tree", async (t) => {
  const root = await workspace(t);
  const script = path.join(root, "server.mjs");
  await writeFile(script, "console.log('ready on 3000');\nlet n = 0;\nsetInterval(() => console.log('tick ' + (++n)), 100);\n");
  const argv = ["node", script];
  const processes = new BackgroundProcessManager();
  t.after(() => processes.killAll());
  const harness = harnessFor(root, processes, [argv]);

  const started = await harness.call("exec", { argv, background: true, name: "dev server" });
  assert.equal(started.state, "succeeded", started.result.error?.message);
  assert.match(started.result.text, /^p1 · dev server \(node .*server\.mjs\) · running · /);
  assert.match(started.result.text, /ready on 3000/);
  assert.equal(processes.running().length, 1);

  const more = await harness.call("process_output", { handle: "p1", wait_ms: 2000 });
  assert.equal(more.state, "succeeded");
  assert.match(more.result.text, /tick \d+/);
  assert.doesNotMatch(more.result.text, /ready on 3000/, "a read returns only output after the previous read");

  const listed = await harness.call("process_list", {});
  assert.match(listed.result.text, /p1 · dev server/);

  const killed = await harness.call("process_kill", { handle: "p1" });
  assert.equal(killed.state, "succeeded");
  assert.match(killed.result.text, /stopped p1/);
  assert.equal(processes.running().length, 0);
  assert.equal(processes.get("p1")?.state, "killed");

  const unknown = await harness.call("process_output", { handle: "p9" });
  assert.equal(unknown.result.error?.code, "invalid_arguments");
});

test("exec background: a quick command reports its exit; process_wait returns the status", async (t) => {
  const root = await workspace(t);
  const quick = path.join(root, "quick.mjs");
  await writeFile(quick, "console.log('done');\n");
  const slow = path.join(root, "slow.mjs");
  await writeFile(slow, "setTimeout(() => { console.log('finished'); process.exit(3); }, 1800);\n");
  const processes = new BackgroundProcessManager();
  t.after(() => processes.killAll());
  const harness = harnessFor(root, processes, [["node", quick], ["node", slow]]);

  const ended = await harness.call("exec", { argv: ["node", quick], background: true });
  assert.match(ended.result.text, /exited 0/);
  assert.equal(ended.result.exit_code, 0);

  const started = await harness.call("exec", { argv: ["node", slow], background: true });
  assert.match(started.result.text, /running/);
  const waited = await harness.call("process_wait", { handle: "p2", timeout_ms: 10_000 });
  assert.match(waited.result.text, /exited 3/);
  assert.match(waited.result.text, /finished/);
  assert.equal(waited.result.exit_code, 3);
});

test("exec background goes through the same policy as exec: an unlisted command is refused before anything starts", async (t) => {
  const root = await workspace(t);
  const script = path.join(root, "other.mjs");
  await writeFile(script, "setInterval(() => {}, 1000);\n");
  const processes = new BackgroundProcessManager();
  const harness = harnessFor(root, processes, []);
  const outcome = await harness.call("exec", { argv: ["node", script], background: true });
  assert.equal(outcome.state, "denied");
  assert.equal(processes.list().length, 0);
});

test("killAllSync stops running processes for process-exit cleanup", async (t) => {
  const root = await workspace(t);
  const script = path.join(root, "idle.mjs");
  await writeFile(script, "setInterval(() => {}, 1000);\n");
  const processes = new BackgroundProcessManager();
  const harness = harnessFor(root, processes, [["node", script]]);
  await harness.call("exec", { argv: ["node", script], background: true });
  assert.equal(processes.running().length, 1);
  processes.killAllSync();
  assert.equal(processes.running().length, 0);
  await processes.waitForExit("p1", 5_000, new AbortController().signal);
  t.after(() => processes.killAll());
});
