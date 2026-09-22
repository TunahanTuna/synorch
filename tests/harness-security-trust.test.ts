import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createId,
  digestOf,
  normalizedActionSchema,
  type AgentRole,
  type NormalizedAction,
  type PolicyDecision,
  type PolicyInputs,
  type SandboxReport,
} from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { createToolRegistry } from "../src/harness/tools/index.ts";
import { createGatewayHarness } from "../src/harness/tools/testing.ts";

/**
 * SEC-N1 workspace trust gate, SEC-N2 git reads outside the workspace, SEC-N3 workers never
 * integrate, SEC-N5 refusals run before the exact verification-command match. Policy-level checks
 * need no process; the gateway checks prove a denied command is never spawned (sentinel files in
 * mkdtemp directories) and that a trusted workspace runs its test command.
 */

const untrusted = createPolicyEngine({ workspaceTrusted: () => false });
const trusted = createPolicyEngine({ workspaceTrusted: () => true });
const FULL: SandboxReport = { backend: "bubblewrap", platform: "linux", enforcement: "full", filesystem: "full", network: "full", process: "full", notes: [] };
const PARTIAL: SandboxReport = {
  backend: "policy-only",
  platform: "win32",
  enforcement: "partial",
  filesystem: "partial",
  network: "unavailable",
  process: "partial",
  notes: ["no OS filesystem sandbox on Windows in v1"],
};

type Scope = NonNullable<PolicyInputs["taskScope"]>;

function inputs(overrides: Partial<PolicyInputs> = {}): PolicyInputs {
  return {
    mode: "autonomous",
    role: "implementer",
    runId: createId("run"),
    taskId: createId("task"),
    workspaceRoot: "/w",
    taskScope: { owned: ["src/**"], read: [], forbidden: [] },
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: PARTIAL,
    grants: [],
    ...overrides,
  };
}

function exec(argv: readonly string[], role: AgentRole = "implementer"): NormalizedAction {
  return normalizedActionSchema.parse({
    tool_name: "exec",
    tool_version: "1.0.0",
    effect: "exec",
    role,
    args_digest: digestOf(argv),
    paths: [{ path: ".", access: "read" }],
    command: { argv, cwd: "." },
    network_hosts: [],
    destructive: false,
  });
}

function codes(decision: PolicyDecision): string[] {
  return decision.reasons.map((reason) => reason.code);
}

function show(argv: readonly string[], decision: PolicyDecision): string {
  return `${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`;
}

function assertDenied(decision: PolicyDecision, argv: readonly string[], code = "exec-not-allowlisted"): void {
  assert.equal(decision.decision, "deny", show(argv, decision));
  assert.ok(codes(decision).includes(code), show(argv, decision));
}

function assertAllowed(decision: PolicyDecision, argv: readonly string[]): void {
  assert.equal(decision.decision, "allow", show(argv, decision));
}

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

/** POSIX single-quoting, so a verification string parses back to exactly this argv. */
function commandLine(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

const VERIFY = "pnpm run verify:ci";
const scope: Scope = { owned: ["src/**"], read: [], forbidden: [], verification_commands: [VERIFY] };
const CODE_RUNNING: readonly (readonly string[])[] = [
  ["pnpm", "run", "verify:ci"],
  ["pnpm", "test"],
  ["npm", "run", "build"],
  ["node", "--test", "tests/a.test.ts"],
  ["tsc", "-p", "tsconfig.json", "--noEmit"],
  ["cargo", "test"],
  ["go", "test", "./..."],
];

test("SEC-N1 untrusted workspace on a partial sandbox: verification and build/test commands are denied as workspace-untrusted in autonomous mode", () => {
  const policy = untrusted.compute(inputs({ taskScope: scope }));
  assert.equal(policy.workspace_trusted, false);
  for (const argv of CODE_RUNNING) {
    const decision = untrusted.evaluate(exec(argv), policy);
    assertDenied(decision, argv, "workspace-untrusted");
    assert.ok(decision.reasons.some((reason) => reason.code === "workspace-untrusted" && reason.layer === "user" && /syn trust/.test(reason.message)), show(argv, decision));
  }
  for (const argv of [["git", "status"], ["rg", "TODO", "src"], ["ls", "src"]]) assertAllowed(untrusted.evaluate(exec(argv), policy), argv);

  const reviewer = untrusted.compute(inputs({ role: "reviewer", taskScope: { owned: [], read: [], forbidden: [], verification_commands: [VERIFY] } }));
  assertDenied(untrusted.evaluate(exec(["pnpm", "run", "verify:ci"], "reviewer"), reviewer), ["pnpm", "run", "verify:ci"], "workspace-untrusted");
});

test("SEC-N1 untrusted workspace in ask mode asks for code-executing commands; a trusted or fully sandboxed workspace runs them", () => {
  const ask = untrusted.compute(inputs({ mode: "ask", taskScope: scope }));
  for (const argv of CODE_RUNNING) {
    const decision = untrusted.evaluate(exec(argv), ask);
    assert.equal(decision.decision, "ask", show(argv, decision));
    assert.ok(codes(decision).includes("workspace-untrusted"), show(argv, decision));
  }
  const trustedPolicy = trusted.compute(inputs({ taskScope: scope }));
  assert.equal(trustedPolicy.workspace_trusted, true);
  for (const argv of CODE_RUNNING) {
    const decision = trusted.evaluate(exec(argv), trustedPolicy);
    assertAllowed(decision, argv);
    assert.ok(codes(decision).includes("exec-allowlisted"), show(argv, decision));
  }
  const full = untrusted.compute(inputs({ sandbox: FULL, taskScope: scope }));
  for (const argv of CODE_RUNNING) assertAllowed(untrusted.evaluate(exec(argv), full), argv);
  const fullReviewer = untrusted.compute(inputs({ role: "reviewer", sandbox: FULL, taskScope: { owned: [], read: [], forbidden: [], verification_commands: [VERIFY] } }));
  assertAllowed(untrusted.evaluate(exec(["pnpm", "run", "verify:ci"], "reviewer"), fullReviewer), ["pnpm", "run", "verify:ci"]);
});

test("SEC-N1 the default engine (no trust source) is untrusted", () => {
  const engine = createPolicyEngine();
  const policy = engine.compute(inputs({ taskScope: scope }));
  assert.notEqual(policy.workspace_trusted, true);
  assertDenied(engine.evaluate(exec(["pnpm", "test"]), policy), ["pnpm", "test"], "workspace-untrusted");
});

test("SEC-N1 node --test module loading, custom reporters and outside reporter destinations are refused even when trusted and even as exact verification commands", async (t) => {
  const outside = await tempDir(t, "syn-sec-n1-outside-");
  const outsideFile = path.join(outside, "report.txt");
  const refused: readonly (readonly string[])[] = [
    ["node", "--test", "--test-reporter=./reporter.mjs", "tests/a.test.ts"],
    ["node", "--test", "--test-reporter", "./reporter.mjs", "tests/a.test.ts"],
    ["node", "--test", "--test-reporter=node_modules/evil/index.js"],
    ["node", "--test", "--test-reporter=spec", `--test-reporter-destination=${outsideFile}`],
    ["node", "--test", "--test-reporter=spec", "--test-reporter-destination", outsideFile],
    ["node", "--test", "--test-reporter=spec", "--test-reporter-destination=../report.txt"],
    ["node", "--import", "./setup.mjs", "--test"],
    ["node", "--import=./setup.mjs", "--test"],
    ["node", "--test", "--import", "tsx"],
    ["node", "--require", "./setup.cjs", "--test"],
    ["node", "-r", "./setup.cjs", "--test"],
    ["node", "-r./setup.cjs", "--test"],
    ["node", "--loader", "./loader.mjs", "--test"],
    ["node", "--experimental-loader=./loader.mjs", "--test"],
    ["node", "--env-file=.env", "--test"],
    ["node", "--test", "--test-global-setup=setup.mjs"],
    ["node", "--experimental-config-file=node.config.json", "--test"],
    ["node", "--inspect=0.0.0.0:9229", "--test"],
  ];
  const verification = [...refused.map(commandLine), "NODE_OPTIONS=--require=./setup.cjs node --test"];
  const policy = trusted.compute(inputs({ taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: verification } }));
  const askPolicy = trusted.compute(inputs({ mode: "ask", taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: verification } }));
  for (const argv of refused) {
    assertDenied(trusted.evaluate(exec(argv), policy), argv);
    assertDenied(trusted.evaluate(exec(argv), askPolicy), argv);
  }
  // The assignment-prefixed string never matches the bare argv it would otherwise reduce to.
  const bare = untrusted.compute(inputs({ taskScope: { owned: [], read: [], forbidden: [], verification_commands: ["NODE_OPTIONS=--require=./setup.cjs node --test"] }, role: "reviewer" }));
  assertDenied(untrusted.evaluate(exec(["node", "--test"], "reviewer"), bare), ["node", "--test"]);
  for (const argv of [
    ["node", "--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "tests/a.test.ts"],
    ["node", "--test", "--test-reporter", "junit", "--test-reporter-destination", "reports/junit.xml"],
    ["node", "--test", "--experimental-strip-types", "--test-name-pattern=SEC", "tests/a.test.ts"],
  ]) {
    assertAllowed(trusted.evaluate(exec(argv), policy), argv);
  }
});

test("SEC-N1 an untrusted workspace's test command is denied at the gateway and never spawned; a trusted one runs", async (t) => {
  const root = await tempDir(t, "syn-sec-n1-");
  const marker = path.join(root, "spawned.txt");
  await writeFile(path.join(root, "probe.test.mjs"), `import { writeFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("probe", () => writeFileSync(${JSON.stringify(marker)}, "x"));\n`);
  const argv = ["node", "--test", "probe.test.mjs"];
  const run = async (engine: typeof trusted) => {
    const policy = engine.compute(inputs({ workspaceRoot: root, taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: [commandLine(argv)] } }));
    const harness = createGatewayHarness({
      engine,
      policy,
      approvals: createHeadlessApprovalBroker({ mode: policy.mode }),
      sandboxReport: PARTIAL,
      registry: createToolRegistry({ classifyCommand, environment: process.env }),
    });
    return { harness, outcome: await harness.call("exec", { argv }) };
  };

  const denied = await run(untrusted);
  assert.equal(denied.outcome.state, "denied");
  assert.equal(denied.outcome.result.error?.code, "policy_denied");
  assert.ok(denied.harness.ofType("tool/policy_decided")[0]?.data.decision.reasons.some((reason) => reason.code === "workspace-untrusted"));
  assert.equal(denied.harness.ofType("tool/execution_started").length, 0);
  assert.equal(existsSync(marker), false, "the untrusted test command was not spawned");

  const allowed = await run(trusted);
  assert.equal(allowed.outcome.state, "succeeded", JSON.stringify(allowed.outcome.result));
  assert.equal(existsSync(marker), true, "the trusted test command ran");
});

test("SEC-N2 git arguments that read or write outside the workspace are refused for read-only roles and writers", async (t) => {
  const outside = await tempDir(t, "syn-sec-n2-outside-");
  const outsideFile = path.join(outside, "secret.txt");
  await writeFile(outsideFile, "sentinel\n");
  const escapes: readonly (readonly string[])[] = [
    ["git", "diff", "--no-index", outsideFile, "README.md"],
    ["git", "diff", "--no-index", "../secret.txt", "README.md"],
    ["git", "diff", `-O${outsideFile}`],
    ["git", "diff", "-O", outsideFile],
    ["git", "diff", `--orderfile=${outsideFile}`],
    ["git", "blame", "--contents", outsideFile, "README.md"],
    ["git", "blame", `--contents=${outsideFile}`, "README.md"],
    ["git", "log", "--output=patch.txt", "-p"],
    ["git", "show", `--output=${outsideFile}`],
    ["git", "diff", "--output-indicator-new=+"],
    ["git", "diff", "--ext-diff"],
    ["git", "log", "-p", "--textconv"],
    ["git", "show", "--textconv", "HEAD:README.md"],
    ["git", "diff", "HEAD", "--", outsideFile],
    ["git", "log", "--", "../outside.txt"],
    ["git", "show", "HEAD:../outside.txt"],
    ["git", "blame", `--ignore-revs-file=${outsideFile}`, "README.md"],
    ["git", "ls-files", "~/x"],
  ];
  const cases = [
    { role: "reviewer" as const, policy: trusted.compute(inputs({ role: "reviewer", taskScope: { owned: [], read: [], forbidden: [] } })) },
    { role: "reviewer" as const, policy: trusted.compute(inputs({ role: "reviewer", sandbox: FULL, taskScope: { owned: [], read: [], forbidden: [] } })) },
    { role: "explorer" as const, policy: trusted.compute(inputs({ role: "explorer", taskScope: { owned: [], read: [], forbidden: [] } })) },
    { role: "implementer" as const, policy: trusted.compute(inputs()) },
    { role: "debugger" as const, policy: trusted.compute(inputs({ role: "debugger" })) },
  ];
  for (const { role, policy } of cases) {
    for (const argv of escapes) {
      const decision = trusted.evaluate(exec(argv, role), policy);
      assert.equal(decision.decision, "deny", `${role} ${policy.sandbox.enforcement} ${show(argv, decision)}`);
    }
    for (const argv of [["git", "status"], ["git", "diff", "HEAD", "--", "src/a.ts"], ["git", "log", "--oneline", "-5"], ["git", "show", "HEAD:README.md"], ["git", "blame", "README.md"]]) {
      const decision = trusted.evaluate(exec(argv, role), policy);
      if (role === "explorer") assert.equal(decision.decision, "deny", `explorer never execs: ${show(argv, decision)}`);
      else assertAllowed(decision, argv);
    }
  }
});

test("SEC-N2 a git escape given as an exact verification command is still refused", async (t) => {
  const outside = await tempDir(t, "syn-sec-n2-verify-");
  const outsideFile = path.join(outside, "secret.txt");
  await writeFile(outsideFile, "sentinel\n");
  const argv = ["git", "diff", "--no-index", outsideFile, "README.md"];
  const policy = trusted.compute(inputs({ taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: [commandLine(argv)] } }));
  assertDenied(trusted.evaluate(exec(argv), policy), argv);
});

test("SEC-N3 workers can never stage, commit or rewrite the repository; only the harness integrates", () => {
  const writing: readonly (readonly string[])[] = [
    ["git", "add", "-A"],
    ["git", "add", "."],
    ["git", "add", "src/a.ts"],
    ["git", "commit", "-m", "wip"],
    ["git", "commit", "-am", "wip"],
    ["git", "stash"],
    ["git", "stash", "push", "-m", "x"],
    ["git", "checkout", "main"],
    ["git", "reset", "HEAD~1"],
    ["git", "switch", "feature"],
    ["git", "restore", "src/a.ts"],
    ["git", "rebase", "main"],
    ["git", "merge", "feature"],
    ["git", "tag", "v1.0.0"],
    ["git", "branch", "feature"],
    ["git", "branch", "-m", "renamed"],
    ["git", "cherry-pick", "abc123"],
  ];
  const verification = writing.map(commandLine);
  const policies = [
    { role: "implementer" as const, policy: trusted.compute(inputs({ taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: verification } })) },
    { role: "implementer" as const, policy: trusted.compute(inputs({ mode: "ask", taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: verification } })) },
    { role: "implementer" as const, policy: trusted.compute(inputs({ sandbox: FULL, taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: verification } })) },
    { role: "debugger" as const, policy: trusted.compute(inputs({ role: "debugger", taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: verification } })) },
  ];
  for (const { role, policy } of policies) {
    for (const argv of writing) {
      const decision = trusted.evaluate(exec(argv, role), policy);
      assert.equal(decision.decision, "deny", `${role} ${policy.mode} ${policy.sandbox.enforcement} ${show(argv, decision)}`);
      assert.ok(decision.reasons.some((reason) => /only the harness integrates/.test(reason.message)), `${role} ${show(argv, decision)}`);
    }
  }
});

test("SEC-N5 inline code and unrecognised programs are refused before the exact verification-command match", () => {
  const smuggled: readonly (readonly string[])[] = [
    ["node", "-e", "require('fs').writeFileSync('x','y')"],
    ["node", "--eval=1"],
    ["node", "-p", "process.env"],
    ["python", "-c", "pass"],
    ["bash", "-c", "true"],
    ["sh", "-c", "echo hi > x"],
    ["pwsh", "-Command", "1"],
    ["cmd", "/c", "ver"],
    ["./build.sh"],
    ["$SHELL", "-c", "true"],
    ["C:\\tools\\node.exe", "script.js"],
  ];
  const verification = smuggled.map(commandLine);
  for (const role of ["implementer", "reviewer"] as const) {
    for (const engine of [trusted, untrusted]) {
      const policy = engine.compute(inputs({ role, taskScope: { owned: role === "reviewer" ? [] : ["src/**"], read: [], forbidden: [], verification_commands: verification } }));
      for (const argv of smuggled) {
        const decision = engine.evaluate(exec(argv, role), policy);
        assertDenied(decision, argv);
        assert.ok(!codes(decision).includes("exec-allowlisted"), `${role} ${show(argv, decision)}`);
      }
    }
  }
});
