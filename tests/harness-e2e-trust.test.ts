import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { deriveProjectId, sha256, type AnyModelAdapter } from "../src/harness/contracts/index.ts";
import { commandHelp, parseHarnessArgs, runHarnessCommand, TRUST_AUDIT_TITLE, UsageError } from "../src/harness/cli/index.ts";
import { createWorkspaceTrustStore, TRUST_FILE, workspaceIdentity } from "../src/harness/policy/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { createSessionStore } from "../src/harness/store/index.ts";
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
  text,
  writeConfig,
  type Sandbox,
} from "./fixtures/cli/runtime/support.ts";

/**
 * SEC-N1 end to end: without a full sandbox, a plan whose verification commands run repository
 * code needs a trusted workspace. Trust comes only from the user scope (`syn trust`, the one-time
 * interactive prompt) or `--trust-workspace` for one run; repository content never grants it.
 * Grants, revocations and uses are audited. Fixtures are benign: a tiny module and its check.
 */

const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
const CHECK = 'import { add } from "./src/add.js";\nif (add(2, 3) !== 5) { console.error("add is wrong"); process.exit(1); }\nconsole.log("ok");\n';
const VERIFY = "node check.mjs";
const FILES = { "src/add.js": BUGGY, "check.mjs": CHECK, "package.json": '{ "type": "module" }\n', "README.md": "# calc\n" };

async function configure(sandbox: Sandbox): Promise<void> {
  await writeConfig(sandbox.home, [
    { tier: "orchestrator", adapter: "plan-script", model: "planner" },
    { tier: "complex_worker", adapter: "impl-script", model: "impl-model" },
    { tier: "complex_worker", role: "reviewer", adapter: "review-script", model: "review-model" },
    { tier: "fast_worker", adapter: "impl-script", model: "impl-model" },
  ]);
}

/** The standard fix-add scenario: the implementer and the reviewer each run the verification command. */
function scenario(): { readonly adapters: readonly AnyModelAdapter[]; readonly implementer: ReturnType<typeof createScriptedAdapter> } {
  const orchestrator = createScriptedAdapter(
    [
      call("plan_propose", () =>
        planArguments("Fix add()", [{ key: "fix-add", risk: "standard", owned: ["src/add.js"], read: ["src/add.js", "check.mjs"], verification: [VERIFY], criteria: ["add(2, 3) returns 5"] }]),
      ),
      text("planned"),
    ],
    { adapterId: "plan-script" },
  );
  const implementer = createScriptedAdapter(
    [
      call("write_file", () => ({ path: "src/add.js", content: FIXED, expected_digest: sha256(BUGGY) })),
      call("exec", () => ({ argv: ["node", "check.mjs"] })),
      call("task_report", (ids) => ({
        status: "completed",
        summary: "add() now adds; the check passes",
        acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "worker" }] }],
        commands_run: [{ command: VERIFY, exit_code: 0, evidence: { kind: "tool-call", ref: ids.at(-1), produced_by: "worker" } }],
      })),
      text("implemented"),
    ],
    { adapterId: "impl-script" },
  );
  const reviewer = createScriptedAdapter(
    [
      calls(() => [{ name: "exec", arguments: { argv: ["node", "check.mjs"] } }]),
      call("review_report", (ids) => ({
        criteria: [{ criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "test-run", ref: ids.at(-1), produced_by: "reviewer" }] }],
        findings: [],
        decision: "accept",
      })),
      text("reviewed"),
    ],
    { adapterId: "review-script" },
  );
  return { adapters: [orchestrator, implementer, reviewer], implementer };
}

async function auditEvents(sandbox: Sandbox) {
  const sessions = createSessionStore(sandbox.home);
  const audit = (await sessions.list(deriveProjectId(sandbox.workspace, process.platform))).find((summary) => summary.manifest.title === TRUST_AUDIT_TITLE);
  return audit === undefined ? [] : readSession(sandbox.home, audit.manifest.session_id);
}

async function doctorTrust(sandbox: Sandbox, home = sandbox.home): Promise<{ readonly status: string; readonly summary: string }> {
  const doctor = capture({ cwd: sandbox.workspace });
  await runHarnessCommand(["doctor", "--runtime", "--json"], doctor.io, overridesFor(sandbox, { home }));
  const report = JSON.parse(doctor.stdout()) as { checks: { id: string; status: string; summary: string }[] };
  const check = report.checks.find((entry) => entry.id === "trust");
  assert.ok(check !== undefined, doctor.stdout());
  return check;
}

test("SEC-N1 a headless run whose plan needs trust exits 3 before any worker; --trust-workspace runs it once and records trust/used", async () => {
  const sandbox = await createSandbox(FILES, { git: true });
  try {
    await configure(sandbox);
    const untrusted = scenario();
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Fix add()", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: untrusted.adapters }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 3, run.stderr());
    const last = frames.at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.data.code, "approval_unavailable");
    assert.match(last.data.message, /workspace trust unavailable.*not trusted/);
    assert.match(last.data.next_command ?? "", /syn trust/);
    assert.equal(untrusted.implementer.requests.length, 0, "no worker ran");
    assert.equal(await readFile(path.join(sandbox.workspace, "src/add.js"), "utf8"), BUGGY);
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const log = await readSession(sandbox.home, hello.data.session_id);
    assert.equal(eventsOf(log, "attempt/started").length, 0);
    assert.equal(eventsOf(log, "trust/used").length, 0);
    const snapshot = eventsOf(log, "policy/snapshot")[0];
    assert.equal(snapshot?.data.policy.workspace_trusted, false);

    const flagged = scenario();
    const second = capture({ cwd: sandbox.workspace });
    const flaggedCode = await runHarnessCommand(["run", "Fix add()", "--mode", "jsonl", "--trust-workspace"], second.io, overridesFor(sandbox, { adapters: flagged.adapters }));
    const parsed = parseFrames(second.stdout());
    assert.equal(flaggedCode, 0, second.stderr());
    assert.equal(await readFile(path.join(sandbox.workspace, "src/add.js"), "utf8"), FIXED);
    const secondHello = parsed.frames[0];
    assert.ok(secondHello?.type === "hello");
    const flaggedLog = await readSession(sandbox.home, secondHello.data.session_id);
    const used = eventsOf(flaggedLog, "trust/used");
    assert.equal(used.length, 1);
    assert.equal(used[0]?.data.source, "flag");
    assert.equal(used[0]?.data.sandbox_enforcement, "partial");
    assert.equal(existsSync(path.join(sandbox.home, TRUST_FILE)), false, "--trust-workspace is never persisted");
  } finally {
    await sandbox.cleanup();
  }
});

test("SEC-N1 syn trust grants in the user scope only, is audited, shows in doctor, is used by the next run and is revoked", async () => {
  const sandbox = await createSandbox(FILES, { git: true });
  try {
    await configure(sandbox);
    assert.equal((await doctorTrust(sandbox)).status, "warn");
    const grant = capture({ cwd: sandbox.root });
    assert.equal(await runHarnessCommand(["trust", "--target", sandbox.workspace], grant.io, overridesFor(sandbox)), 0, grant.stderr());
    assert.match(grant.stdout(), /tests and build scripts will run with your user permissions; Synorch cannot confine them on this platform/);
    const stored = JSON.parse(await readFile(path.join(sandbox.home, TRUST_FILE), "utf8")) as { workspaces: { root: string; identity: string; granted_by: string }[] };
    const identity = workspaceIdentity(sandbox.workspace);
    assert.deepEqual(stored.workspaces.map((record) => [record.root, record.identity, record.granted_by]), [[identity.root, identity.identity, "command"]]);
    assert.equal(existsSync(path.join(sandbox.workspace, ".synorch")), false, "nothing is written into the repository");
    const granted = eventsOf(await auditEvents(sandbox), "trust/granted");
    assert.deepEqual(granted.map((event) => [event.data.source, event.data.repo_identity, event.actor.kind]), [["command", identity.identity, "user"]]);
    const trusted = await doctorTrust(sandbox);
    assert.equal(trusted.status, "ok");
    assert.match(trusted.summary, /workspace trusted/);

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Fix add()", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: scenario().adapters }));
    const { frames } = parseFrames(run.stdout());
    assert.equal(code, 0, run.stderr());
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const log = await readSession(sandbox.home, hello.data.session_id);
    assert.deepEqual(eventsOf(log, "trust/used").map((event) => event.data.source), ["store"]);
    assert.equal(eventsOf(log, "policy/snapshot")[0]?.data.policy.workspace_trusted, true);

    const revoke = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["trust", "--revoke"], revoke.io, overridesFor(sandbox)), 0, revoke.stderr());
    assert.match(revoke.stdout(), /Revoked trust/);
    assert.equal(eventsOf(await auditEvents(sandbox), "trust/revoked").length, 1);
    assert.equal((await doctorTrust(sandbox)).status, "warn");
  } finally {
    await sandbox.cleanup();
  }
});

test("SEC-N1 repository content can never grant trust: a trust file in the repo, a home inside the repo and a replaced repository are all untrusted", async () => {
  const sandbox = await createSandbox(FILES, { git: true });
  try {
    await configure(sandbox);
    const identity = workspaceIdentity(sandbox.workspace);
    const forged = `${JSON.stringify({ schema_version: 1, workspaces: [{ root: identity.root, identity: identity.identity, granted_at: "2026-09-23T00:00:00.000Z", granted_by: "command" }] })}\n`;
    await mkdir(path.join(sandbox.workspace, ".synorch"), { recursive: true });
    await writeFile(path.join(sandbox.workspace, ".synorch", TRUST_FILE), forged);
    await writeFile(path.join(sandbox.workspace, TRUST_FILE), forged);
    assert.equal((await doctorTrust(sandbox)).status, "warn", "a trust file shipped in the repository is never read");

    const insideHome = path.join(sandbox.workspace, ".synorch");
    const inside = createWorkspaceTrustStore(insideHome).status(sandbox.workspace);
    assert.equal(inside.trusted, false, "a home inside the workspace could be repository content");
    assert.match(inside.reason ?? "", /inside the workspace/);
    const refused = capture({ cwd: sandbox.workspace });
    assert.notEqual(await runHarnessCommand(["trust"], refused.io, overridesFor(sandbox, { home: insideHome })), 0);
    assert.match(refused.stderr(), /inside the workspace/);
    assert.equal(await readFile(path.join(insideHome, TRUST_FILE), "utf8"), forged, "the refused grant did not touch the file");

    await writeFile(path.join(sandbox.home, TRUST_FILE), forged.replace(identity.identity, `git:${"0".repeat(64)}`));
    const replaced = createWorkspaceTrustStore(sandbox.home).status(sandbox.workspace);
    assert.equal(replaced.trusted, false, "a different repository at a trusted path is not trusted");
    assert.match(replaced.reason ?? "", /changed since it was trusted/);
  } finally {
    await sandbox.cleanup();
  }
});

test("SEC-N1 an interactive session asks once through the approval UI; yes persists and audits trust, and the run uses it", async () => {
  const sandbox = await createSandbox(FILES, { git: true });
  try {
    await configure(sandbox);
    const run = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput("y\n", true), stdinIsTTY: true });
    const code = await runHarnessCommand(["run", "Fix add()", "--plain"], run.io, overridesFor(sandbox, { adapters: scenario().adapters }));
    assert.equal(code, 0, `${run.stdout()}\n${run.stderr()}`);
    assert.match(run.stdout(), /Approval needed \(workspace-trust\)/);
    assert.match(run.stdout(), /tests and build scripts will run with your user permissions; Synorch cannot confine them on this platform/);
    const granted = eventsOf(await auditEvents(sandbox), "trust/granted");
    assert.deepEqual(granted.map((event) => event.data.source), ["prompt"]);
    assert.equal(createWorkspaceTrustStore(sandbox.home).status(sandbox.workspace).trusted, true);
    assert.equal(await readFile(path.join(sandbox.workspace, "src/add.js"), "utf8"), FIXED);
  } finally {
    await sandbox.cleanup();
  }
});

test("SEC-N1 declining the interactive prompt leaves the workspace untrusted and nothing is stored", async () => {
  const sandbox = await createSandbox(FILES, { git: true });
  try {
    await configure(sandbox);
    const run = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput("n\n", true), stdinIsTTY: true });
    const code = await runHarnessCommand(["run", "Fix add()", "--plain"], run.io, overridesFor(sandbox, { adapters: scenario().adapters }));
    assert.notEqual(code, 0, "the verification command could not run");
    assert.match(run.stderr(), /workspace not trusted/);
    assert.match(run.stdout(), /exec denied: node check\.mjs .*the workspace is not trusted/);
    assert.equal(existsSync(path.join(sandbox.home, TRUST_FILE)), false);
    assert.equal(eventsOf(await auditEvents(sandbox), "trust/granted").length, 0);
    assert.equal(await readFile(path.join(sandbox.workspace, "src/add.js"), "utf8"), BUGGY, "nothing unverified was integrated");
  } finally {
    await sandbox.cleanup();
  }
});

test("SEC-N1 syn trust and --trust-workspace parse strictly; trust help states the risk", () => {
  assert.deepEqual(parseHarnessArgs(["trust"]), { kind: "trust", common: { target: undefined, plain: false, color: "auto" }, revoke: false });
  assert.deepEqual(parseHarnessArgs(["trust", "--revoke", "--target", "repo"]), { kind: "trust", common: { target: "repo", plain: false, color: "auto" }, revoke: true });
  assert.throws(() => parseHarnessArgs(["trust", "extra"]), UsageError);
  assert.throws(() => parseHarnessArgs(["trust", "--yes"]), UsageError);
  const run = parseHarnessArgs(["run", "goal", "--trust-workspace"]);
  assert.ok(run.kind === "run" && run.trustWorkspace);
  const plain = parseHarnessArgs(["run", "goal"]);
  assert.ok(plain.kind === "run" && !plain.trustWorkspace);
  assert.throws(() => parseHarnessArgs(["agent", "--trust-workspace"]), UsageError, "the flag is for one run only");
  assert.match(commandHelp("trust"), /cannot confine code/);
  assert.match(commandHelp("run"), /--trust-workspace/);
});
