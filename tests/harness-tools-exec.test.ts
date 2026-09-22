import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createId, sandboxReportSchema, type ProcessSpec, type SandboxReport } from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import {
  childEnvironment,
  createSandboxRunner,
  createToolRegistry,
  probeSandbox,
  sandboxedArgv,
} from "../src/harness/tools/index.ts";
import { createGatewayHarness, replayToolCallTransitions, type GatewayHarness } from "../src/harness/tools/testing.ts";

// SEC-N1: without a full sandbox, verification commands run only in a trusted workspace; these
// tests exercise exec itself, so the workspace is trusted. SEC-N5: inline code and non-literal
// program paths are refused before the exact match, so each test runs `node <script file>`.
const engine = createPolicyEngine({ workspaceTrusted: () => true });
const NODE = process.execPath;

/** Writes a script into the workspace and returns the plain `node <absolute script>` argv that runs it. */
async function nodeScript(root: string, name: string, source: string): Promise<string[]> {
  const file = path.join(root, name);
  await writeFile(file, source);
  return ["node", file];
}
const SPAWN_TREE = fileURLToPath(new URL("./fixtures/sandbox/spawn-tree.mjs", import.meta.url));
const PARTIAL: SandboxReport = {
  backend: "policy-only",
  platform: "win32",
  enforcement: "partial",
  filesystem: "partial",
  network: "unavailable",
  process: "partial",
  notes: [],
};

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "syn-i3-exec-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(path.join(root, "src", "auth"), { recursive: true });
  return root;
}

/** POSIX single-quoting, so a verification string parses back to exactly this argv. */
function commandLine(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/**
 * The partial sandbox runs only exact verification commands and a vetted build/test list, so each
 * test names the exact argv it runs as a verification command of its task.
 */
function harnessFor(
  root: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  verification: readonly (readonly string[])[] = [],
): GatewayHarness {
  return createGatewayHarness({
    engine,
    policy: engine.compute({
      mode: "autonomous",
      role: "implementer",
      runId: createId("run"),
      taskId: createId("task"),
      workspaceRoot: root,
      taskScope: { owned: ["src/auth/**"], read: [], forbidden: [], verification_commands: verification.map(commandLine) },
      userConfig: undefined,
      workspaceConfig: undefined,
      sandbox: PARTIAL,
      grants: [],
    }),
    approvals: createHeadlessApprovalBroker(),
    sandboxReport: PARTIAL,
    registry: createToolRegistry({ classifyCommand, environment }),
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error("timed out waiting");
}

test("AC-8: cancelling exec terminates the whole child tree and yields cancelled", async (t) => {
  const root = await workspace(t);
  const pidFile = path.join(root, "src", "auth", "pids.json");
  const harness = harnessFor(root, process.env, [["node", SPAWN_TREE, pidFile]]);
  const controller = new AbortController();
  const pending = harness.call("exec", { argv: ["node", SPAWN_TREE, pidFile] }, controller.signal);
  const pids = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(pidFile, "utf8")) as { child: number; grandchild: number };
    } catch {
      return undefined;
    }
  }, 15_000);
  assert.ok(alive(pids.child) && alive(pids.grandchild), "tree is running before cancellation");
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.state, "cancelled");
  assert.equal(outcome.result.error?.code, "cancelled");
  await waitFor(async () => (!alive(pids.child) && !alive(pids.grandchild) ? true : undefined), 10_000);
  assert.equal(alive(pids.grandchild), false, "grandchild terminated");
  assert.deepEqual(replayToolCallTransitions(harness.events.events), []);
});

test("exec timeout terminates the process tree and reports timeout", async (t) => {
  const root = await workspace(t);
  const argv = await nodeScript(root, "hang.mjs", "setInterval(() => {}, 1000);\n");
  const harness = harnessFor(root, process.env, [argv]);
  const outcome = await harness.call("exec", { argv, timeout_ms: 300 });
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.result.error?.code, "timeout");
});

test("exec runs argv without a shell, reports the exit code and keeps shell metacharacters literal", async (t) => {
  const root = await workspace(t);
  const argv = [...(await nodeScript(root, "echo-args.mjs", "console.log(process.argv.slice(2).join('|')); process.exit(3);\n")), "a && b", "$(whoami)", "> out.txt"];
  const harness = harnessFor(root, process.env, [argv, ["definitely-not-a-real-program-xyz"]]);
  const outcome = await harness.call("exec", { argv });
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.result));
  assert.equal(outcome.result.exit_code, 3);
  assert.match(outcome.result.text, /a && b\|\$\(whoami\)\|> out\.txt/);
  const missing = await harness.call("exec", { argv: ["definitely-not-a-real-program-xyz"] });
  assert.equal(missing.state, "failed");
  assert.equal(missing.result.error?.code, "execution_failed");
});

test("exec passes only allowlisted parent variables plus permitted model variables", async (t) => {
  const root = await workspace(t);
  const parent = { ...process.env, OPENAI_API_KEY: "sk-parent-secret-should-not-leak", SYNORCH_TEST_SECRET: "hidden" };
  const argv = await nodeScript(root, "env.mjs", "console.log(JSON.stringify({o: process.env.OPENAI_API_KEY ?? null, s: process.env.SYNORCH_TEST_SECRET ?? null, m: process.env.MY_FLAG ?? null, p: Boolean(process.env.PATH || process.env.Path)}));\n");
  const harness = harnessFor(root, parent, [argv]);
  const outcome = await harness.call("exec", {
    argv,
    env: { MY_FLAG: "on" },
  });
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.result));
  assert.match(outcome.result.text, /\{"o":null,"s":null,"m":"on","p":true\}/);

  for (const env of [{ PATH: "/evil" }, { NODE_OPTIONS: "--require evil.js" }, { LD_PRELOAD: "evil.so" }, { ANTHROPIC_API_KEY: "x" }, { "BAD NAME": "x" }]) {
    const refused = await harness.call("exec", { argv, env });
    assert.equal(refused.result.error?.code, "invalid_arguments", JSON.stringify(env));
  }
  const environment = childEnvironment({ PATH: "/bin", HOME: "/home/u", GITHUB_TOKEN: "ghp_x" }, { EXTRA: "1", PATH: "/evil" });
  assert.deepEqual(environment, { PATH: "/bin", HOME: "/home/u", EXTRA: "1" });
});

test("exec refuses shell scripts on stdin so policy can always inspect them", async (t) => {
  const root = await workspace(t);
  const pipe = await nodeScript(root, "pipe.mjs", "process.stdin.pipe(process.stdout);\n");
  const harness = harnessFor(root, process.env, [pipe]);
  for (const shell of ["bash", "sh", "cmd", "powershell", "pwsh"]) {
    const outcome = await harness.call("exec", { argv: [shell], stdin: "rm -rf /" });
    assert.equal(outcome.state, "denied");
    assert.equal(outcome.result.error?.code, "invalid_arguments");
  }
  const piped = await harness.call("exec", { argv: pipe, stdin: "hello stdin" });
  assert.match(piped.result.text, /hello stdin/);
});

test("exec cwd is resolved inside the workspace and outside cwd is refused", async (t) => {
  const root = await workspace(t);
  const cwd = await nodeScript(root, "cwd.mjs", "console.log(process.cwd());\n");
  const harness = harnessFor(root, process.env, [cwd]);
  const inside = await harness.call("exec", { argv: cwd, cwd: "src/auth" });
  assert.equal(inside.state, "succeeded", JSON.stringify(inside.result));
  assert.match(inside.result.text, /auth/);
  const outside = await harness.call("exec", { argv: cwd, cwd: ".." });
  assert.equal(outside.state, "denied");
  assert.equal(outside.result.error?.code, "path_outside_scope");
});

test("process output beyond the tool limit is truncated and flagged", async (t) => {
  const root = await workspace(t);
  const runner = createSandboxRunner(PARTIAL);
  const result = await runner.run(
    { argv: [NODE, "-e", "process.stdout.write('z'.repeat(50000))"], cwd: root, env: childEnvironment(process.env), stdin: undefined, timeoutMs: 10_000, outputLimitBytes: 1024, writeRoots: [], network: "deny" },
    new AbortController().signal,
  );
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, "exited");
});

test("SandboxRunner.run reports spawn failures, timeouts and cancellation explicitly", async (t) => {
  const root = await workspace(t);
  const runner = createSandboxRunner(PARTIAL);
  const spec = { cwd: root, env: childEnvironment(process.env), stdin: undefined, timeoutMs: 10_000, outputLimitBytes: 4096, writeRoots: [], network: "deny" as const };
  const missing = await runner.run({ ...spec, argv: ["synorch-no-such-program-4f1c"] }, new AbortController().signal);
  assert.equal(missing.termination, "spawn-failed");
  assert.ok(missing.spawnError !== undefined && missing.spawnError.length > 0);
  assert.equal(missing.exitCode, null);

  const slow = await runner.run({ ...spec, argv: [NODE, "-e", "setTimeout(() => {}, 30000)"], timeoutMs: 300 }, new AbortController().signal);
  assert.equal(slow.termination, "timeout");

  const controller = new AbortController();
  const cancelled = runner.run({ ...spec, argv: [NODE, "-e", "setTimeout(() => {}, 30000)"] }, controller.signal);
  setTimeout(() => controller.abort(), 200);
  assert.equal((await cancelled).termination, "cancelled");
});

test("probeSandbox reports platform backends and fails closed on probe errors", async () => {
  const windows = await probeSandbox({ platform: "win32" });
  assert.deepEqual(sandboxReportSchema.parse(windows), windows);
  assert.equal(windows.backend, "policy-only");
  assert.equal(windows.enforcement, "partial");
  assert.equal(windows.network, "unavailable");

  const linuxWithBwrap = await probeSandbox({ platform: "linux", succeeds: async () => true });
  assert.equal(linuxWithBwrap.backend, "bubblewrap");
  assert.equal(linuxWithBwrap.enforcement, "full");
  const linuxWithout = await probeSandbox({ platform: "linux", succeeds: async () => false });
  assert.equal(linuxWithout.enforcement, "partial");

  const mac = await probeSandbox({ platform: "darwin", succeeds: async () => true, fileExists: async () => true });
  assert.equal(mac.backend, "sandbox-exec");
  const failing = await probeSandbox({
    platform: "linux",
    succeeds: async () => {
      throw new Error("probe exploded");
    },
  });
  assert.equal(failing.enforcement, "unavailable");
  assert.match(failing.notes[0] ?? "", /probe exploded/);
  assert.equal((await probeSandbox({ platform: "aix" })).enforcement, "unavailable");

  const live = await probeSandbox();
  assert.deepEqual(sandboxReportSchema.parse(live), live);
  if (process.platform === "win32") assert.equal(live.enforcement, "partial");
});

test("sandboxedArgv wraps commands for bubblewrap and sandbox-exec and leaves policy-only argv untouched", () => {
  const spec: ProcessSpec = {
    argv: ["node", "--test"],
    cwd: "/w",
    env: {},
    stdin: undefined,
    timeoutMs: 1000,
    outputLimitBytes: 1024,
    writeRoots: ["/w/src/auth"],
    network: "deny",
  };
  const bwrap = sandboxedArgv({ ...PARTIAL, backend: "bubblewrap", platform: "linux", enforcement: "full" }, spec);
  assert.equal(bwrap[0], "bwrap");
  assert.ok(bwrap.join(" ").includes("--bind /w/src/auth /w/src/auth"));
  assert.ok(bwrap.includes("--unshare-all") && !bwrap.includes("--share-net"));
  assert.deepEqual(bwrap.slice(-3), ["--", "node", "--test"]);
  const withNetwork = sandboxedArgv({ ...PARTIAL, backend: "bubblewrap", platform: "linux", enforcement: "full" }, { ...spec, network: "allow" });
  assert.ok(withNetwork.includes("--share-net"));
  const seatbelt = sandboxedArgv({ ...PARTIAL, backend: "sandbox-exec", platform: "darwin", enforcement: "full" }, spec);
  assert.equal(seatbelt[1], "-p");
  assert.match(seatbelt[2] ?? "", /\(deny file-write\*\).*\(subpath "\/w\/src\/auth"\).*\(deny network\*\)/);
  assert.deepEqual(sandboxedArgv(PARTIAL, spec), spec.argv);
});
