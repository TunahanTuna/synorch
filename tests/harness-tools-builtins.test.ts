import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createId, sha256, type AgentRole, type SandboxReport } from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { createToolRegistry, type ControlCallbacks } from "../src/harness/tools/index.ts";
import { createGatewayHarness, type GatewayHarness } from "../src/harness/tools/testing.ts";

const engine = createPolicyEngine();
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
  const root = await mkdtemp(path.join(tmpdir(), "syn-i3-tools-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(path.join(root, "src", "auth"), { recursive: true });
  await mkdir(path.join(root, "src", "billing"), { recursive: true });
  await writeFile(path.join(root, "src", "auth", "session.ts"), "export const ttl = 60;\nexport function refresh() {\n  return 'token';\n}\n");
  await writeFile(path.join(root, "src", "billing", "invoice.ts"), "export const secretRate = 0.2; // refresh\n");
  await writeFile(path.join(root, "README.md"), "# demo\nrefresh docs\n");
  return root;
}

function harnessFor(root: string, role: AgentRole = "implementer", control: ControlCallbacks = {}): GatewayHarness {
  return createGatewayHarness({
    engine,
    policy: engine.compute({
      mode: "autonomous",
      role,
      runId: createId("run"),
      taskId: role === "orchestrator" ? undefined : createId("task"),
      workspaceRoot: root,
      taskScope: role === "orchestrator" ? undefined : { owned: ["src/auth/**"], read: [], forbidden: ["src/billing/**"] },
      userConfig: undefined,
      workspaceConfig: undefined,
      sandbox: PARTIAL,
      grants: [],
    }),
    approvals: createHeadlessApprovalBroker(),
    sandboxReport: PARTIAL,
    registry: createToolRegistry({ classifyCommand, control }),
  });
}

const digestOfFile = async (file: string) => sha256(new Uint8Array(await readFile(file)));

test("read_file returns text, honours offset/limit, refuses forbidden paths and hides binaries", async (t) => {
  const root = await workspace(t);
  const harness = harnessFor(root);
  const whole = await harness.call("read_file", { path: "src/auth/session.ts" });
  assert.equal(whole.state, "succeeded");
  assert.match(whole.result.text, /export function refresh/);
  const slice = await harness.call("read_file", { path: "src/auth/session.ts", offset: 2, limit: 1 });
  const digest = await digestOfFile(path.join(root, "src", "auth", "session.ts"));
  assert.equal(slice.result.text, `src/auth/session.ts · digest ${digest} · lines 2-2 of 4\nexport function refresh() {`);
  assert.equal(slice.result.digest, digest);
  assert.equal(slice.result.truncated, true);
  const forbidden = await harness.call("read_file", { path: "src/billing/invoice.ts" });
  assert.equal(forbidden.state, "denied");
  await writeFile(path.join(root, "src", "auth", "blob.bin"), Buffer.from([0, 1, 2, 3]));
  const binary = await harness.call("read_file", { path: "src/auth/blob.bin" });
  assert.match(binary.result.text, /binary file/);
  const outside = await harness.call("read_file", { path: "../etc/passwd" });
  assert.equal(outside.result.error?.code, "path_outside_scope");
});

test("list_dir lists without following links and skips forbidden entries", async (t) => {
  const root = await workspace(t);
  const outcome = await harnessFor(root).call("list_dir", { path: "src", depth: 2 });
  assert.equal(outcome.state, "succeeded");
  assert.match(outcome.result.text, /src\/auth\//);
  assert.match(outcome.result.text, /src\/auth\/session\.ts/);
  assert.doesNotMatch(outcome.result.text, /invoice/);
});

test("search finds matches in the read scope and never returns forbidden files", async (t) => {
  const root = await workspace(t);
  const harness = harnessFor(root);
  const outcome = await harness.call("search", { pattern: "refresh" });
  assert.equal(outcome.state, "succeeded");
  assert.match(outcome.result.text, /src\/auth\/session\.ts:2:export function refresh/);
  assert.match(outcome.result.text, /README\.md:2:refresh docs/);
  assert.doesNotMatch(outcome.result.text, /billing/);
  const globbed = await harness.call("search", { pattern: "refresh", glob: "*.md" });
  assert.doesNotMatch(globbed.result.text, /session\.ts/);
  const invalid = await harness.call("search", { pattern: "(" });
  assert.equal(invalid.result.error?.code, "invalid_arguments");
});

test("write_file requires the current digest to overwrite and reports stale preconditions", async (t) => {
  const root = await workspace(t);
  const harness = harnessFor(root);
  const file = path.join(root, "src", "auth", "session.ts");
  const blind = await harness.call("write_file", { path: "src/auth/session.ts", content: "overwritten" });
  assert.equal(blind.result.error?.code, "invalid_arguments");
  assert.match(blind.result.error?.message ?? "", /read_file it first/);
  assert.equal(await readFile(file, "utf8"), "export const ttl = 60;\nexport function refresh() {\n  return 'token';\n}\n");
  const stale = await harness.call("write_file", { path: "src/auth/session.ts", content: "x", expected_digest: sha256("something else") });
  assert.equal(stale.result.error?.code, "stale_precondition");
  const matched = await harness.call("write_file", { path: "src/auth/session.ts", content: "fresh\n", expected_digest: await digestOfFile(file) });
  assert.equal(matched.state, "succeeded", JSON.stringify(matched.result));
  assert.equal(await readFile(file, "utf8"), "fresh\n");
  const created = await harness.call("write_file", { path: "src/auth/nested/dir/new.ts", content: "new" });
  assert.equal(created.state, "succeeded");
  assert.deepEqual(created.result.changed_paths, ["src/auth/nested/dir/new.ts"]);
});

test("apply_patch applies hunks atomically with pre-image digests and rejects mismatches", async (t) => {
  const root = await workspace(t);
  const harness = harnessFor(root);
  const file = path.join(root, "src", "auth", "session.ts");
  const patch = [
    "--- a/src/auth/session.ts",
    "+++ b/src/auth/session.ts",
    "@@ -1,2 +1,2 @@",
    "-export const ttl = 60;",
    "+export const ttl = 120;",
    " export function refresh() {",
    "--- /dev/null",
    "+++ b/src/auth/rotation.ts",
    "@@ -0,0 +1,2 @@",
    "+export const rotate = true;",
    "+export const window = 5;",
    "",
  ].join("\n");
  const original = await readFile(file, "utf8");
  const wrongDigest = await harness.call("apply_patch", { patch, expected: { "src/auth/session.ts": sha256("nope"), "src/auth/rotation.ts": null } });
  assert.equal(wrongDigest.result.error?.code, "stale_precondition");
  assert.equal(await readFile(file, "utf8"), original);

  const applied = await harness.call("apply_patch", { patch, expected: { "src/auth/session.ts": await digestOfFile(file), "src/auth/rotation.ts": null } });
  assert.equal(applied.state, "succeeded", JSON.stringify(applied.result));
  assert.deepEqual(applied.result.changed_paths?.sort(), ["src/auth/rotation.ts", "src/auth/session.ts"]);
  assert.match(await readFile(file, "utf8"), /ttl = 120;\nexport function refresh\(\) \{\n  return 'token';\n\}\n$/);
  assert.equal(await readFile(path.join(root, "src", "auth", "rotation.ts"), "utf8"), "export const rotate = true;\nexport const window = 5;\n");

  const mismatch = await harness.call("apply_patch", {
    patch: "--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-export const ttl = 999;\n+export const ttl = 1;\n",
    expected: { "src/auth/session.ts": await digestOfFile(file) },
  });
  assert.equal(mismatch.result.error?.code, "invalid_arguments");
  assert.match(mismatch.result.error?.message ?? "", /context mismatch/);

  const crlf = path.join(root, "src", "auth", "crlf.txt");
  await writeFile(crlf, "a\r\nb\r\n");
  const crlfPatch = await harness.call("apply_patch", {
    patch: "--- a/src/auth/crlf.txt\n+++ b/src/auth/crlf.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n",
    expected: { "src/auth/crlf.txt": await digestOfFile(crlf) },
  });
  assert.equal(crlfPatch.state, "succeeded", JSON.stringify(crlfPatch.result));
  assert.equal(await readFile(crlf, "utf8"), "a\r\nc\r\n");
});

test("orchestrator apply_patch is limited to .ai/tasks", async (t) => {
  const root = await workspace(t);
  const harness = harnessFor(root, "orchestrator");
  const plan = await harness.call("apply_patch", { patch: "--- /dev/null\n+++ b/.ai/tasks/plan.md\n@@ -0,0 +1 @@\n+# plan\n", expected: { ".ai/tasks/plan.md": null } });
  assert.equal(plan.state, "succeeded", JSON.stringify(plan.result));
  const product = await harness.call("apply_patch", { patch: "--- /dev/null\n+++ b/src/auth/x.ts\n@@ -0,0 +1 @@\n+x\n", expected: { "src/auth/x.ts": null } });
  assert.equal(product.state, "denied");
  assert.equal(product.decision?.rail, "write-outside-scope");
});

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("git_status separates task-scope changes from other changes; git_diff excludes forbidden paths", { skip: !gitAvailable && "git is not installed" }, async (t) => {
  const root = await workspace(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  await writeFile(path.join(root, "src", "auth", "session.ts"), "changed by task\n");
  await writeFile(path.join(root, "README.md"), "changed by user\n");
  await writeFile(path.join(root, "src", "billing", "invoice.ts"), "changed billing\n");
  const harness = harnessFor(root);
  const status = await harness.call("git_status", {});
  assert.equal(status.state, "succeeded", JSON.stringify(status.result));
  const [taskSection, otherSection] = status.result.text.split("other changes");
  assert.match(taskSection ?? "", /src\/auth\/session\.ts/);
  assert.match(otherSection ?? "", /README\.md/);
  assert.doesNotMatch(status.result.text, /invoice/);
  const diff = await harness.call("git_diff", {});
  assert.equal(diff.state, "succeeded", JSON.stringify(diff.result));
  assert.match(diff.result.text, /changed by task/);
  assert.doesNotMatch(diff.result.text, /changed billing/);
  const scoped = await harness.call("git_diff", { paths: ["README.md"] });
  assert.match(scoped.result.text, /changed by user/);
  assert.doesNotMatch(scoped.result.text, /changed by task/);
});

test("control tools route to injected callbacks and fail clearly when unwired or headless", async (t) => {
  const root = await workspace(t);
  const spawned: unknown[] = [];
  const control: ControlCallbacks = {
    taskSpawn: async (input) => {
      spawned.push(input.packet);
      return { status: "ok", text: "task dispatched", truncated: false, redactions: 0 };
    },
    memoryPropose: async (input) => ({ status: "ok", text: `queued ${input.kind}`, truncated: false, redactions: 0 }),
  };
  const orchestrator = harnessFor(root, "orchestrator", control);
  const spawn = await orchestrator.call("task_spawn", { packet: { key: "auth-fix" } });
  assert.equal(spawn.state, "succeeded");
  assert.deepEqual(spawned, [{ key: "auth-fix" }]);
  const status = await orchestrator.call("task_status", {});
  assert.equal(status.result.error?.code, "execution_failed");
  const ask = await orchestrator.call("ask_user", { question: "Which branch?" });
  assert.equal(ask.result.error?.code, "approval_unavailable");

  const worker = harnessFor(root, "implementer", control);
  const proposal = await worker.call("memory_propose", { kind: "note", rationale: "learned", content: { title: "x" } });
  assert.equal(proposal.result.text, "queued note");
  const forbiddenSpawn = await worker.call("task_spawn", { packet: {} });
  assert.equal(forbiddenSpawn.state, "denied");
  assert.ok(forbiddenSpawn.decision?.reasons.some((reason) => reason.code === "tool-not-visible"));
});

test("report tools validate against the contract schemas and are acknowledged without a callback", async (t) => {
  const root = await workspace(t);
  const worker = harnessFor(root, "implementer", {});
  const invalid = await worker.call("task_report", { status: "done" });
  assert.equal(invalid.state, "denied");
  assert.equal(invalid.result.error?.code, "invalid_arguments");
  const report = await worker.call("task_report", { status: "partial", summary: "half of it" });
  assert.equal(report.state, "succeeded", JSON.stringify(report.result));
  assert.match(report.result.text, /report recorded/);
  const notMine = await worker.call("review_report", { criteria: [{ criterion_id: "AC-1", verdict: "met", evidence: [] }], decision: "accept" });
  assert.equal(notMine.state, "denied");
  assert.ok(notMine.decision?.reasons.some((reason) => reason.code === "tool-not-visible"));

  const orchestrator = harnessFor(root, "orchestrator", {});
  const plan = await orchestrator.call("plan_propose", { goal: "g" });
  assert.equal(plan.result.error?.code, "invalid_arguments");
});
