import assert from "node:assert/strict";
import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createId, type EffectivePolicy, type NormalizedAction, type PolicyEngine, type SandboxReport } from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { createToolRegistry, resolveWorkspacePath, ToolScopeViolation } from "../src/harness/tools/index.ts";
import { createGatewayHarness, replayToolCallTransitions, type GatewayHarness } from "../src/harness/tools/testing.ts";

/**
 * AC-1: every way of naming a location outside the owned paths is refused with
 * `write-outside-scope`, at the moment of the action, and the outside file is never touched.
 */

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
const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

interface Layout {
  readonly root: string;
  readonly outside: string;
  readonly secret: string;
}

async function layout(t: TestContext): Promise<Layout> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "syn-i3-paths-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "src", "auth"), { recursive: true });
  await mkdir(path.join(root, "src", "billing"), { recursive: true });
  await mkdir(outside, { recursive: true });
  const secret = path.join(outside, "secret.txt");
  await writeFile(secret, "outside-original");
  await writeFile(path.join(root, "src", "billing", "invoice.ts"), "billing-original");
  return { root, outside, secret };
}

function policyFor(root: string): EffectivePolicy {
  return engine.compute({
    mode: "autonomous",
    role: "implementer",
    runId: createId("run"),
    taskId: createId("task"),
    workspaceRoot: root,
    taskScope: { owned: ["src/auth/**"], read: [], forbidden: ["src/billing/**"] },
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: PARTIAL,
    grants: [],
  });
}

function harnessFor(root: string, policyEngine: PolicyEngine = engine): GatewayHarness {
  return createGatewayHarness({
    engine: policyEngine,
    policy: policyFor(root),
    approvals: createHeadlessApprovalBroker(),
    sandboxReport: PARTIAL,
    registry: createToolRegistry({ classifyCommand }),
  });
}

async function tryLink(create: () => Promise<void>, t: TestContext): Promise<boolean> {
  try {
    await create();
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip(`this platform refuses to create the link without privileges (${error.code})`);
      return false;
    }
    throw error;
  }
}

async function assertRefused(harness: GatewayHarness, args: Record<string, unknown>, layoutInfo: Layout, tool = "write_file"): Promise<void> {
  const outcome = await harness.call(tool, args);
  assert.equal(outcome.state, "denied", JSON.stringify(outcome.result));
  assert.equal(outcome.result.error?.code, "path_outside_scope", JSON.stringify(outcome.result));
  assert.equal(outcome.decision?.rail, "write-outside-scope");
  assert.equal(await readFile(layoutInfo.secret, "utf8"), "outside-original");
  assert.equal(await readFile(path.join(layoutInfo.root, "src", "billing", "invoice.ts"), "utf8"), "billing-original");
  assert.equal(harness.ofType("tool/execution_started").length, 0);
  assert.deepEqual(replayToolCallTransitions(harness.events.events), []);
}

test("AC-1: a plain owned write is allowed (control case)", async (t) => {
  const paths = await layout(t);
  const harness = harnessFor(paths.root);
  const outcome = await harness.call("write_file", { path: "src/auth/ok.ts", content: "ok" });
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.result));
});

test("AC-1: '..' traversal out of the workspace is write-outside-scope", async (t) => {
  const paths = await layout(t);
  await assertRefused(harnessFor(paths.root), { path: "../outside/secret.txt", content: "pwned" }, paths);
  await assertRefused(harnessFor(paths.root), { path: "src/auth/../../../outside/secret.txt", content: "pwned" }, paths);
});

test("AC-1: '..' that stays inside the workspace but leaves the owned paths is write-outside-scope", async (t) => {
  const paths = await layout(t);
  await assertRefused(harnessFor(paths.root), { path: "src/auth/../billing/invoice.ts", content: "pwned" }, paths);
});

test("AC-1: absolute paths outside the workspace are write-outside-scope; absolute owned paths resolve normally", async (t) => {
  const paths = await layout(t);
  await assertRefused(harnessFor(paths.root), { path: paths.secret, content: "pwned" }, paths);
  const inside = await harnessFor(paths.root).call("write_file", { path: path.join(paths.root, "src", "auth", "abs.ts"), content: "ok" });
  assert.equal(inside.state, "succeeded", JSON.stringify(inside.result));
});

test("AC-1: UNC and device paths are write-outside-scope on every platform", async (t) => {
  const paths = await layout(t);
  for (const candidate of ["\\\\localhost\\c$\\Windows\\win.ini", "//server/share/file.txt", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\PhysicalDrive0"]) {
    await assertRefused(harnessFor(paths.root), { path: candidate, content: "pwned" }, paths);
  }
});

test("AC-1: a directory junction/symlink inside the owned paths that points outside is write-outside-scope", async (t) => {
  const paths = await layout(t);
  const linkPath = path.join(paths.root, "src", "auth", "escape");
  if (!(await tryLink(() => symlink(paths.outside, linkPath, DIRECTORY_LINK), t))) return;
  await assertRefused(harnessFor(paths.root), { path: "src/auth/escape/secret.txt", content: "pwned" }, paths);
  await assertRefused(harnessFor(paths.root), { path: "src/auth/escape/new.txt", content: "pwned" }, paths);
  await assert.rejects(access(path.join(paths.outside, "new.txt")));
});

test("AC-1: a junction/symlink to a forbidden directory inside the workspace is write-outside-scope", async (t) => {
  const paths = await layout(t);
  const linkPath = path.join(paths.root, "src", "auth", "billing-alias");
  if (!(await tryLink(() => symlink(path.join(paths.root, "src", "billing"), linkPath, DIRECTORY_LINK), t))) return;
  await assertRefused(harnessFor(paths.root), { path: "src/auth/billing-alias/invoice.ts", content: "pwned" }, paths);
});

test("AC-1: a file symlink pointing outside is write-outside-scope", async (t) => {
  const paths = await layout(t);
  const linkPath = path.join(paths.root, "src", "auth", "secret-link.txt");
  if (!(await tryLink(() => symlink(paths.secret, linkPath, "file"), t))) return;
  await assertRefused(harnessFor(paths.root), { path: "src/auth/secret-link.txt", content: "pwned" }, paths);
});

test("AC-1: a dangling link is refused instead of creating its target", async (t) => {
  const paths = await layout(t);
  const linkPath = path.join(paths.root, "src", "auth", "dangling");
  if (!(await tryLink(() => symlink(path.join(paths.outside, "missing-dir"), linkPath, DIRECTORY_LINK), t))) return;
  await assertRefused(harnessFor(paths.root), { path: "src/auth/dangling/file.txt", content: "pwned" }, paths);
});

test("AC-1: a case variant of a forbidden or unowned path is write-outside-scope", async (t) => {
  const paths = await layout(t);
  await assertRefused(harnessFor(paths.root), { path: "SRC/BILLING/invoice.ts", content: "pwned" }, paths);
  await assertRefused(harnessFor(paths.root), { path: "src/Billing/invoice.ts", content: "pwned" }, paths);
});

test("AC-1: on a case-insensitive volume the canonical case of an owned path comes from the file system", { skip: process.platform !== "win32" && "Windows-only: needs a case-insensitive volume" }, async (t) => {
  const paths = await layout(t);
  const outcome = await harnessFor(paths.root).call("write_file", { path: "SRC/AUTH/cased.ts", content: "ok" });
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.result));
  assert.deepEqual(outcome.result.changed_paths, ["src/auth/cased.ts"]);
});

test("AC-1: an owned file that is a hard link to an outside file is write-outside-scope", async (t) => {
  const paths = await layout(t);
  const linked = path.join(paths.root, "src", "auth", "hardlink.txt");
  if (!(await tryLink(() => link(paths.secret, linked), t))) return;
  await assertRefused(harnessFor(paths.root), { path: "src/auth/hardlink.txt", content: "pwned", expected_digest: null }, paths);
});

test("AC-1: apply_patch goes through the same resolution (traversal and forbidden targets)", async (t) => {
  const paths = await layout(t);
  const patch = "--- /dev/null\n+++ b/../outside/new.txt\n@@ -0,0 +1 @@\n+pwned\n";
  await assertRefused(harnessFor(paths.root), { patch, expected: { "../outside/new.txt": null } }, paths, "apply_patch");
  const billing = "--- a/src/billing/invoice.ts\n+++ b/src/billing/invoice.ts\n@@ -1 +1 @@\n-billing-original\n+pwned\n";
  await assertRefused(harnessFor(paths.root), { patch: billing, expected: { "src/billing/invoice.ts": null } }, paths, "apply_patch");
});

test("AC-1: TOCTOU — a directory swapped for a link after the policy check is refused at action time", async (t) => {
  const paths = await layout(t);
  const target = path.join(paths.root, "src", "auth", "cache");
  await mkdir(target);
  let swapped = false;
  const swapping: PolicyEngine = {
    compute: (inputs) => engine.compute(inputs),
    evaluate(action: NormalizedAction, policy: EffectivePolicy) {
      const decision = engine.evaluate(action, policy);
      renameSync(target, `${target}-moved`);
      try {
        symlinkSync(paths.outside, target, DIRECTORY_LINK);
        swapped = true;
      } catch {
        mkdirSync(target);
      }
      return decision;
    },
  };
  const harness = harnessFor(paths.root, swapping);
  const outcome = await harness.call("write_file", { path: "src/auth/cache/secret.txt", content: "pwned", expected_digest: null });
  if (!swapped) {
    t.skip("could not create a directory link on this platform");
    return;
  }
  assert.equal(outcome.decision?.decision, "allow", "the policy saw the pre-swap path");
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.result.error?.code, "path_outside_scope");
  assert.equal(await readFile(paths.secret, "utf8"), "outside-original");
  assert.deepEqual(replayToolCallTransitions(harness.events.events), []);
});

test("AC-1: resolveWorkspacePath canonicalizes and reports every escape as a ToolScopeViolation", async (t) => {
  const paths = await layout(t);
  const resolved = await resolveWorkspacePath(paths.root, "./src//auth/../auth/x.ts", "write");
  assert.equal(resolved.relative, "src/auth/x.ts");
  assert.equal(resolved.exists, false);
  for (const candidate of ["..", "../x", paths.outside, "\\\\server\\share", "", "a\0b"]) {
    await assert.rejects(resolveWorkspacePath(paths.root, candidate, "write"), (error: unknown) => error instanceof ToolScopeViolation && error.rail === "write-outside-scope", candidate);
  }
  await assert.rejects(resolveWorkspacePath(paths.root, "../x", "read"), (error: unknown) => error instanceof ToolScopeViolation && error.rail === undefined);
});
