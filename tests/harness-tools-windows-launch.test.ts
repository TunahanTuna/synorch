import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createId, type SandboxReport } from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { createToolRegistry } from "../src/harness/tools/index.ts";
import { createGatewayHarness, type GatewayHarness } from "../src/harness/tools/testing.ts";
import { planLaunch, quoteCmdArgument, UnsafeLaunchError } from "../src/harness/tools/windows-launch.ts";

const engine = createPolicyEngine();
const WINDOWS = process.platform === "win32";
const windowsOnly = { skip: WINDOWS ? false : "Windows command shims only exist on Windows" };
const PARTIAL: SandboxReport = {
  backend: "policy-only",
  platform: "win32",
  enforcement: "partial",
  filesystem: "partial",
  network: "unavailable",
  process: "partial",
  notes: [],
};

/** Prints every argument it receives as hex, so the test compares exact bytes. */
const ECHO_ARGS = 'process.stdout.write("ARGS:" + JSON.stringify(process.argv.slice(2).map((a) => Buffer.from(a, "utf8").toString("hex"))) + "\\n");\n';

/** npm cmd-shim output (as written for the global `pnpm.cmd`). */
const NPM_SHIM = (script: string): string =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    "",
  ].join("\r\n");

/** pnpm (@zkochan/cmd-shim) output, as in `node_modules/.bin/tsc.CMD`. */
const PNPM_SHIM = (script: string, nodePath: string): string =>
  [
    "@SETLOCAL",
    "@IF NOT DEFINED NODE_PATH (",
    `  @SET "NODE_PATH=${nodePath}"`,
    ") ELSE (",
    `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
    ")",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${script}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${script}" %*`,
    ")",
    "",
  ].join("\r\n");

/** A hand-written shim that is not on a known form, so it runs through cmd.exe and re-parses `%*`. */
const GENERIC_SHIM = '@echo off\r\nsetlocal enableextensions\r\nnode "%~dp0echo-args.mjs" %*\r\n';

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A bin directory (with a space, `&` and parentheses in its name) holding the fixture shims. */
async function binDir(t: TestContext): Promise<string> {
  const bin = path.join(await tempDir(t, "syn-shim-"), "bin dir (x) & y");
  await mkdir(path.join(bin, "lib"), { recursive: true });
  await writeFile(path.join(bin, "echo-args.mjs"), ECHO_ARGS);
  await writeFile(path.join(bin, "lib", "echo-args.mjs"), ECHO_ARGS);
  await writeFile(path.join(bin, "npm-echo.cmd"), NPM_SHIM("lib\\echo-args.mjs"));
  await writeFile(path.join(bin, "pnpm-echo.CMD"), PNPM_SHIM("lib\\echo-args.mjs", "C:\\fixture\\node_modules"));
  await writeFile(path.join(bin, "generic-echo.cmd"), GENERIC_SHIM);
  await writeFile(path.join(bin, "pnpm.cmd"), NPM_SHIM("lib\\echo-args.mjs"));
  return bin;
}

/** The parent environment with `bin` first on PATH (every existing PATH spelling replaced). */
function withPath(bin: string): Record<string, string> {
  const env: Record<string, string> = {};
  let original = "";
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.toUpperCase() === "PATH") original = value;
    else env[key] = value;
  }
  env.PATH = `${bin};${original}`;
  return env;
}

function commandLine(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

function harnessFor(root: string, environment: Record<string, string>, verification: readonly (readonly string[])[]): GatewayHarness {
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
    registry: createToolRegistry({ classifyCommand, environment }),
  });
}

function receivedArgs(text: string): string[] {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith("ARGS:"));
  assert.ok(line !== undefined, `fixture output missing:\n${text}`);
  return (JSON.parse(line.slice(5)) as string[]).map((hex) => Buffer.from(hex, "hex").toString("utf8"));
}

/** Arguments that would split, expand or redirect if cmd.exe ever parsed them unquoted. */
function hostileArguments(marker: string): string[] {
  return [
    `a&type nul>"${marker}-amp"`,
    `b|type nul>"${marker}-pipe"`,
    `"&type nul>"${marker}-quote"&"`,
    "%PATH%",
    "%SYNORCH_FIXTURE:a=b%",
    "%SYNORCH_FIXTURE%",
    "^caret^^",
    'say "hi"',
    "!PATH!",
    "(paren) <in> >out",
    "trailing\\",
    'back\\"slash',
    "",
    "sp ace",
    "%~dp0 %1 %*",
    "ünïcødé",
  ];
}

test("quoteCmdArgument double-quotes every argument, doubles quotes, neutralizes % and refuses line breaks", () => {
  assert.equal(quoteCmdArgument(""), '""');
  assert.equal(quoteCmdArgument("a&b"), '"a&b"');
  assert.equal(quoteCmdArgument('q"x'), '"q""x"');
  assert.equal(quoteCmdArgument("%PATH%"), '"%%cd:~,%PATH%%cd:~,%"');
  assert.equal(quoteCmdArgument("dir\\"), '"dir\\\\"');
  assert.equal(quoteCmdArgument('a\\"b'), '"a\\\\""b"');
  assert.equal(quoteCmdArgument("a\\b"), '"a\\b"');
  for (const unsafe of ["a\nb", "a\rb", "a\0b"]) assert.throws(() => quoteCmdArgument(unsafe), UnsafeLaunchError);
});

test("planLaunch leaves argv unchanged on non-Windows platforms", async () => {
  const plan = await planLaunch(["pnpm", "test", "a&b"], { cwd: tmpdir(), env: { PATH: "/usr/bin" }, platform: "linux" });
  assert.deepEqual(plan, { file: "pnpm", args: ["test", "a&b"], env: { PATH: "/usr/bin" }, verbatim: false, via: "direct" });
});

test("planLaunch spawns npm and pnpm node shims as node <script> and sends other shims through quoted cmd.exe", windowsOnly, async (t) => {
  const bin = await binDir(t);
  const env = withPath(bin);
  const script = path.join(bin, "lib", "echo-args.mjs");

  const npm = await planLaunch(["npm-echo", "x&y"], { cwd: bin, env });
  assert.equal(npm.via, "node-shim");
  assert.equal(npm.verbatim, false);
  assert.match(npm.file, /node\.exe$/i);
  assert.deepEqual(npm.args, [script, "x&y"]);

  const pnpmUnset = await planLaunch(["pnpm-echo"], { cwd: bin, env });
  assert.equal(pnpmUnset.via, "node-shim");
  assert.equal(pnpmUnset.env.NODE_PATH, "C:\\fixture\\node_modules");
  const pnpmSet = await planLaunch(["pnpm-echo"], { cwd: bin, env: { ...env, NODE_PATH: "D:\\mine" } });
  assert.equal(pnpmSet.env.NODE_PATH, "C:\\fixture\\node_modules;D:\\mine");

  const generic = await planLaunch(["generic-echo", "x&y"], { cwd: bin, env });
  assert.equal(generic.via, "cmd-shim");
  assert.equal(generic.verbatim, true);
  assert.match(generic.file, /\\System32\\cmd\.exe$/i);
  assert.deepEqual(generic.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(generic.args[4], `""${path.join(bin, "generic-echo.cmd")}" "x&y""`);

  const tampered = path.join(bin, "tampered.cmd");
  await writeFile(tampered, `${NPM_SHIM("lib\\echo-args.mjs")}calc.exe\r\n`);
  assert.equal((await planLaunch(["tampered"], { cwd: bin, env })).via, "cmd-shim", "a shim with an unknown line is not interpreted");

  const native = await planLaunch(["node", "-v"], { cwd: bin, env });
  assert.equal(native.via, "direct");
  assert.ok(path.win32.isAbsolute(native.file), "a native executable is spawned by its resolved path");
  await assert.rejects(planLaunch(["generic-echo", "a\nb"], { cwd: bin, env }), UnsafeLaunchError);
});

for (const shim of ["npm-echo", "pnpm-echo", "generic-echo"]) {
  test(`exec passes &, |, %PATH%, ^ and " literally through the ${shim} shim and never runs a second command`, windowsOnly, async (t) => {
    const bin = await binDir(t);
    const root = await tempDir(t, "syn-shim-ws-");
    await mkdir(path.join(root, "src"), { recursive: true });
    const marker = path.join(root, "injected");
    const args = hostileArguments(marker);
    const argv = [shim, ...args];
    const environment = { ...withPath(bin), SYNORCH_FIXTURE: "x&type nul>injected-env&" };
    const harness = harnessFor(root, environment, [argv]);
    const outcome = await harness.call("exec", { argv, env: { SYNORCH_FIXTURE: environment.SYNORCH_FIXTURE } });
    assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.result));
    assert.equal(outcome.result.exit_code, 0, outcome.result.text);
    assert.deepEqual(receivedArgs(outcome.result.text), args);
    for (const suffix of ["-amp", "-pipe", "-quote"]) assert.equal(existsSync(`${marker}${suffix}`), false, `no command ran for ${suffix}`);
    assert.equal(existsSync(path.join(root, "injected-env")), false, "no variable expansion injected a command");
    assert.equal(existsSync(path.join(root, "out")), false, "no redirection happened");
  });
}

test("a pnpm .cmd shim on PATH runs through exec under the partial-sandbox allowlist as a verification command and as pnpm test", windowsOnly, async (t) => {
  const bin = await binDir(t);
  const root = await tempDir(t, "syn-shim-ws-");
  await mkdir(path.join(root, "src"), { recursive: true });
  const harness = harnessFor(root, withPath(bin), [["pnpm", "--version"]]);
  const version = await harness.call("exec", { argv: ["pnpm", "--version"] });
  assert.equal(version.state, "succeeded", JSON.stringify(version.result));
  assert.deepEqual(receivedArgs(version.result.text), ["--version"]);
  const allowlisted = await harness.call("exec", { argv: ["pnpm", "test"] });
  assert.equal(allowlisted.state, "succeeded", JSON.stringify(allowlisted.result));
  assert.deepEqual(receivedArgs(allowlisted.result.text), ["test"]);
  assert.ok(harness.ofType("tool/policy_decided").every((event) => event.data.decision.reasons.some((reason) => reason.code === "exec-allowlisted")));
});

test("the real pnpm --version runs through exec under the partial-sandbox allowlist", windowsOnly, async (t) => {
  const root = await tempDir(t, "syn-shim-ws-");
  await mkdir(path.join(root, "src"), { recursive: true });
  const probe = await planLaunch(["pnpm", "--version"], { cwd: root, env: withPath(root) });
  if (probe.via === "direct" && !path.win32.isAbsolute(probe.file)) {
    t.skip("pnpm is not on PATH");
    return;
  }
  const harness = harnessFor(root, withPath(root), [["pnpm", "--version"]]);
  const outcome = await harness.call("exec", { argv: ["pnpm", "--version"] });
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.result));
  assert.equal(outcome.result.exit_code, 0, outcome.result.text);
  assert.match(outcome.result.text, /--- stdout ---\n\d+\.\d+\.\d+/);
});
