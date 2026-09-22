import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine, explainPermission } from "../src/harness/policy/index.ts";
import { createToolRegistry, resolveWorkspacePath, ToolScopeViolation } from "../src/harness/tools/index.ts";
import { createGatewayHarness } from "../src/harness/tools/testing.ts";

const engine = createPolicyEngine();
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
    sandbox: FULL,
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

function write(target: string, role: AgentRole = "implementer"): NormalizedAction {
  return normalizedActionSchema.parse({
    tool_name: "write_file",
    tool_version: "1.0.0",
    effect: "workspace-write",
    role,
    args_digest: digestOf(target),
    paths: [{ path: target, access: "write" }],
    network_hosts: [],
    destructive: false,
  });
}

function codes(decision: PolicyDecision): string[] {
  return decision.reasons.map((reason) => reason.code);
}

function assertNotAllowlisted(decision: PolicyDecision, layer: "role" | "sandbox", label: string): void {
  assert.equal(decision.decision, "deny", `${label}: ${JSON.stringify(decision.reasons)}`);
  const reason = decision.reasons.find((entry) => entry.code === "exec-not-allowlisted");
  assert.ok(reason !== undefined, `${label}: ${JSON.stringify(decision.reasons)}`);
  assert.equal(reason.layer, layer, label);
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

const NOT_ALLOWLISTED: readonly (readonly string[])[] = [
  ["node", "-e", "1"],
  ["python", "-c", "pass"],
  ["echo", "hi"],
  ["sort", "-o", "out.txt", "in.txt"],
];

test("SEC-H1 read-only roles cannot run non-allowlisted exec, even under a full sandbox, but may run git status", () => {
  const rcaScope: Scope = { owned: [], read: [], forbidden: [] };
  const readOnly = [
    { role: "reviewer" as const, policy: engine.compute(inputs({ role: "reviewer" })) },
    { role: "debugger" as const, policy: engine.compute(inputs({ role: "debugger", taskScope: rcaScope })) },
    { role: "reviewer" as const, policy: engine.compute(inputs({ role: "reviewer", sandbox: PARTIAL })) },
  ];
  for (const { role, policy } of readOnly) {
    for (const argv of [...NOT_ALLOWLISTED, ["git", "diff", "--output=patch.txt"], ["git", "-c", "alias.x=!true", "status"], ["rg", "--pre", "script", "x"], ["cat", "../outside.txt"]]) {
      assertNotAllowlisted(engine.evaluate(exec(argv, role), policy), "role", `${role} ${policy.sandbox.enforcement} ${argv.join(" ")}`);
    }
    for (const argv of [["git", "status"], ["git", "log", "--oneline", "-5"], ["rg", "TODO", "src"], ["ls", "src"]]) {
      const decision = engine.evaluate(exec(argv, role), policy);
      assert.equal(decision.decision, "allow", `${role} ${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`);
      assert.ok(codes(decision).includes("exec-allowlisted"), `${role} ${argv.join(" ")}`);
    }
  }
  const debuggerWithOwned = engine.compute(inputs({ role: "debugger" }));
  assert.equal(engine.evaluate(exec(["echo", "hi"], "debugger"), debuggerWithOwned).decision, "allow", "a debugger that owns paths is a writer");

  const verifying = engine.compute(inputs({ role: "reviewer", taskScope: { ...rcaScope, verification_commands: ["node --test tests/a.test.ts"] } }));
  assert.equal(engine.evaluate(exec(["node", "--test", "tests/a.test.ts"], "reviewer"), verifying).decision, "allow");
  assertNotAllowlisted(engine.evaluate(exec(["node", "--test", "tests/b.test.ts"], "reviewer"), verifying), "role", "only the exact verification command");

  const explained = explainPermission(exec(["node", "-e", "1"], "reviewer"), readOnly[0]?.policy ?? verifying);
  assertNotAllowlisted(explained, "role", "explainPermission surfaces the allowlist verdict");
});

test("SEC-H1 a read-only reviewer's non-allowlisted exec is denied by the gateway and never spawned", async (t) => {
  const root = await tempDir(t, "syn-sec-h1-");
  const marker = path.join(root, "spawned.txt");
  const policy = engine.compute(inputs({ role: "reviewer", workspaceRoot: root, sandbox: FULL }));
  const harness = createGatewayHarness({
    engine,
    policy,
    approvals: createHeadlessApprovalBroker({ mode: policy.mode }),
    sandboxReport: FULL,
    registry: createToolRegistry({ classifyCommand, environment: process.env }),
  });
  await writeFile(path.join(root, "touch.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`);
  const outcome = await harness.call("exec", { argv: ["node", "touch.mjs"] });
  assert.equal(outcome.state, "denied");
  assert.equal(outcome.result.error?.code, "policy_denied");
  assert.ok(harness.ofType("tool/policy_decided")[0]?.data.decision.reasons.some((reason) => reason.code === "exec-not-allowlisted"));
  assert.equal(harness.ofType("tool/execution_started").length, 0);
  assert.equal(existsSync(marker), false, "the process was not spawned");
});

test("SEC-H3 partial sandbox: verification command and pnpm test run; inline interpreters and unknown programs are denied; ask mode asks; full sandbox unchanged", () => {
  const scope: Scope = { owned: ["src/**"], read: [], forbidden: [], verification_commands: ["pnpm run verify:ci"] };
  // SEC-N1: verification and build/test commands need a trusted workspace without a full sandbox; SEC-N3: no git commit.
  const trustedEngine = createPolicyEngine({ workspaceTrusted: () => true });
  const partial = trustedEngine.compute(inputs({ sandbox: PARTIAL, taskScope: scope }));
  assert.equal(partial.exec_confinement, "allowlist");
  assert.deepEqual(partial.verification_commands, ["pnpm run verify:ci"]);
  for (const argv of [["pnpm", "run", "verify:ci"], ["pnpm", "test"], ["pnpm", "install", "--frozen-lockfile"], ["node", "--test", "tests/a.test.ts"], ["tsc", "-p", "tsconfig.json", "--noEmit"], ["git", "status"], ["cargo", "test"], ["go", "test", "./..."]]) {
    const decision = trustedEngine.evaluate(exec(argv), partial);
    assert.equal(decision.decision, "allow", `${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`);
    assert.ok(codes(decision).includes("exec-allowlisted"), argv.join(" "));
  }
  for (const argv of [
    ...NOT_ALLOWLISTED,
    ["node", "-pe", "1"],
    ["node", "--test", "--eval", "1"],
    ["bash", "-lc", "true"],
    ["pwsh", "-Command", "1"],
    ["cmd", "/c", "ver"],
    ["deno", "eval", "1"],
    ["ruby", "-e", "1"],
    ["perl", "-E", "1"],
    ["pnpm", "--config.script-shell=node", "test"],
    ["pnpm", "test", "--script-shell=node"],
    ["go", "test", "-exec", "sh", "./..."],
    ["tsc", "--outDir", "/elsewhere"],
    ["pnpm", "install"],
  ]) {
    assertNotAllowlisted(engine.evaluate(exec(argv), partial), "sandbox", argv.join(" "));
  }

  const ask = engine.compute(inputs({ mode: "ask", sandbox: PARTIAL, taskScope: scope }));
  assert.equal(ask.exec_confinement, "ask");
  const asked = engine.evaluate(exec(["echo", "hi"]), ask);
  assert.equal(asked.decision, "ask", JSON.stringify(asked.reasons));
  assert.ok(codes(asked).includes("exec-unconfined"));

  const full = engine.compute(inputs({ sandbox: FULL, taskScope: scope }));
  assert.equal(full.exec_confinement, "full-sandbox");
  for (const argv of NOT_ALLOWLISTED) {
    const decision = engine.evaluate(exec(argv), full);
    assert.equal(decision.decision, "allow", `${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`);
    assert.ok(!codes(decision).some((code) => code.startsWith("exec-")), argv.join(" "));
  }
});

test("SEC-H3 a non-allowlisted exec under a partial sandbox is sandbox_insufficient at the gateway and never spawned", async (t) => {
  const root = await tempDir(t, "syn-sec-h3-");
  const marker = path.join(root, "spawned.txt");
  const argv = ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
  const policy = engine.compute(inputs({ workspaceRoot: root, sandbox: PARTIAL, taskScope: { owned: ["src/**"], read: [], forbidden: [], verification_commands: [commandLine(["node", "-e", "1"])] } }));
  const harness = createGatewayHarness({
    engine,
    policy,
    approvals: createHeadlessApprovalBroker({ mode: policy.mode }),
    sandboxReport: PARTIAL,
    registry: createToolRegistry({ classifyCommand, environment: process.env }),
  });
  const outcome = await harness.call("exec", { argv });
  assert.equal(outcome.state, "denied");
  assert.equal(outcome.result.error?.code, "sandbox_insufficient");
  assert.ok(harness.ofType("tool/policy_decided")[0]?.data.decision.reasons.some((reason) => reason.code === "exec-not-allowlisted" && reason.layer === "sandbox"));
  assert.equal(harness.ofType("tool/execution_started").length, 0);
  assert.equal(existsSync(marker), false, "the process was not spawned");
});

test("SEC-H2 an opaque inline script and a non-literal program name are unclassifiable and denied", () => {
  const full = engine.compute(inputs({ sandbox: FULL }));
  for (const argv of [
    ["powershell", "-EncodedCommand", "!!!not-base64!!!"],
    ["pwsh", "-enc", "AAA"],
    ["powershell", "-Command:Write-Output hi"],
  ]) {
    const decision = engine.evaluate(exec(argv), full);
    assert.equal(decision.decision, "deny", `${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`);
    assert.ok(codes(decision).includes("opaque-script"), `${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`);
  }
  const partial = engine.compute(inputs({ sandbox: PARTIAL }));
  for (const argv of [["$SHELL", "-c", "true"], ["./build.sh"], ["C:\\tools\\node.exe", "--test"], ["%COMSPEC%", "/c", "ver"], ["`which node`", "--test"]]) {
    const decision = engine.evaluate(exec(argv), partial);
    assertNotAllowlisted(decision, "sandbox", argv.join(" "));
    assert.ok(decision.reasons.some((reason) => /not a plain literal word|unclassifiable/.test(reason.message)), `${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`);
  }
});

test("SEC-L1 path forms Windows rewrites or reinterprets are rejected before policy matching", async (t) => {
  const root = await tempDir(t, "syn-sec-l1-");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "ok.ts"), "x");
  const rejected = [
    "src.",
    "src/ok.ts.",
    "src./ok.ts",
    "src /ok.ts",
    "src/ok.ts:stream",
    "src/ok.ts::$DATA",
    "C:ok.ts",
    "src/CON",
    "nul",
    "src/nul.txt",
    "aux.tar.gz",
    "src/COM1.log",
    "LPT9",
    "\\\\?\\C:\\Windows\\win.ini",
    "\\\\.\\PhysicalDrive0",
    "//?/C:/x",
    "//./pipe/x",
  ];
  for (const candidate of rejected) {
    for (const access of ["read", "write"] as const) {
      await assert.rejects(resolveWorkspacePath(root, candidate, access), ToolScopeViolation, `${candidate} (${access})`);
    }
  }
  for (const candidate of ["src/ok.ts", "src/.hidden", "src/a.b/c.ts", "src/console.ts", "src/nullable.ts", "src/com10.ts"]) {
    await resolveWorkspacePath(root, candidate, "write");
  }
});

test("SEC-L1 an 8.3 short name whose long name differs is rejected", async (t) => {
  const root = await tempDir(t, "syn-sec-l1-short-");
  await mkdir(path.join(root, "averylongdirectoryname"), { recursive: true });
  const short = path.join(root, "AVERYL~1");
  if (process.platform !== "win32" || !existsSync(short)) {
    t.skip("8.3 short names are not generated on this volume");
    return;
  }
  await assert.rejects(resolveWorkspacePath(root, "AVERYL~1/x.ts", "write"), ToolScopeViolation);
  await assert.rejects(resolveWorkspacePath(root, "AVERYL~1", "read"), ToolScopeViolation);
  await resolveWorkspacePath(root, "averylongdirectoryname/x.ts", "write");
});

test("SEC-L3 writes into the Synorch home are denied, the worker's own worktree is writable, and .git hooks/config are reserved", async (t) => {
  const base = await tempDir(t, "syn-sec-l3-");
  const home = path.join(base, "synhome");
  const workspace = path.join(base, "repo");
  const worktree = path.join(home, "worktrees", "proj", "att_1");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  const guarded = createPolicyEngine({ synorchHome: home });

  const containing = guarded.compute(inputs({ workspaceRoot: base, taskScope: { owned: ["synhome/**", "repo/**"], read: [], forbidden: [] } }));
  const intoHome = guarded.evaluate(write("synhome/config.yaml"), containing);
  assert.equal(intoHome.decision, "deny", JSON.stringify(intoHome.reasons));
  assert.equal(intoHome.rail, "reserved-path-write");
  assert.ok(codes(intoHome).includes("synorch-home-write"));
  if (process.platform === "win32") {
    const folded = createPolicyEngine({ synorchHome: home.toUpperCase() });
    assert.equal(folded.evaluate(write("synhome/sessions/x.jsonl"), containing).decision, "deny", "canonical paths are compared case-insensitively");
  }
  assert.equal(guarded.evaluate(write("repo/src/a.ts"), containing).decision, "allow");

  const own = guarded.compute(inputs({ workspaceRoot: worktree }));
  const ownWrite = guarded.evaluate(write("src/a.ts"), own);
  assert.equal(ownWrite.decision, "allow", JSON.stringify(ownWrite.reasons));

  const linked = guarded.compute(inputs({ workspaceRoot: workspace }));
  await symlink(home, path.join(workspace, "src", "link"), process.platform === "win32" ? "junction" : "dir");
  const throughLink = guarded.evaluate(write("src/link/config.yaml"), linked);
  assert.equal(throughLink.decision, "deny", "a link into the Synorch home resolves there");
  assert.ok(codes(throughLink).includes("synorch-home-write"));

  for (const target of [".git/hooks/pre-commit", ".GIT/Hooks/post-checkout", ".git/config", "sub/.git/hooks/x"]) {
    const decision = engine.evaluate(write(target), engine.compute(inputs({ taskScope: { owned: ["**/*.ts", "sub/**"], read: [], forbidden: [] } })));
    assert.equal(decision.decision, "deny", target);
    assert.equal(decision.rail, "reserved-path-write", target);
    assert.ok(codes(decision).includes("git-hooks-or-config"), `${target}: ${JSON.stringify(decision.reasons)}`);
  }

  const full = engine.compute(inputs());
  for (const argv of [["git", "config", "core.hooksPath", "hooks"], ["git", "-c", "core.hooksPath=/tmp/h", "status"], ["git", "config", "user.name", "x"], ["git", "config", "--add", "a.b", "c"], ["git", "config", "set", "a.b", "c"]]) {
    const decision = engine.evaluate(exec(argv), full);
    assert.equal(decision.decision, "deny", argv.join(" "));
    assert.equal(decision.rail, "reserved-path-write", `${argv.join(" ")}: ${JSON.stringify(decision.reasons)}`);
  }
  for (const argv of [["git", "config", "--get", "user.name"], ["git", "config", "user.name"], ["git", "config", "--list"]]) {
    assert.equal(engine.evaluate(exec(argv), full).rail, undefined, argv.join(" "));
  }
});
