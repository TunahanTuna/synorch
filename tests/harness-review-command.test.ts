import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, overridesFor, text, writeConfig } from "./fixtures/cli/runtime/support.ts";

/** `syn review --json`: pinned diff, scripted reviewer, one JSON object and the verdict as exit code. */

async function review(argv: readonly string[], report: (ids: readonly string[]) => Record<string, unknown>, setup?: (workspace: string) => Promise<void>) {
  const sandbox = await createSandbox({ "src/a.mjs": "export const a = 1;\n" }, { git: true });
  try {
    await writeFile(path.join(sandbox.workspace, "src", "a.mjs"), "export const a = null;\n");
    await setup?.(sandbox.workspace);
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", provider: "openai", adapter: "worker-script", model: "gpt-6-sol" },
      { tier: "complex_worker", provider: "openai", adapter: "worker-script", model: "gpt-6-sol" },
      { tier: "complex_worker", role: "reviewer", provider: "anthropic", adapter: "review-script", model: "opus-5.5" },
    ]);
    const idle = createScriptedAdapter([text("idle")], { adapterId: "worker-script", providerId: "openai", authMethod: "oauth-subscription" });
    const reviewer = createScriptedAdapter([call("read_file", () => ({ path: "src/a.mjs" })), call("review_report", report), text("reviewed")], {
      adapterId: "review-script",
      providerId: "anthropic",
      authMethod: "oauth-subscription",
    });
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(argv, run.io, overridesFor(sandbox, { adapters: [idle, reviewer] }));
    return { code, stdout: run.stdout(), stderr: run.stderr() };
  } finally {
    await sandbox.cleanup();
  }
}

const criteria = (ids: readonly string[]) => ["AC-1", "AC-2", "AC-3", "AC-4"].map((id) => ({ criterion_id: id, verdict: "met", evidence: [{ kind: "tool-call", ref: ids.at(-1), produced_by: "reviewer" }] }));

test("syn review --json: an approving reviewer exits 0 with one JSON object", async () => {
  const { code, stdout, stderr } = await review(["review", "--json"], (ids) => ({ criteria: criteria(ids), findings: [], decision: "accept" }));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout) as Record<string, any>;
  assert.equal(result.schema, 1);
  assert.equal(result.status, "reviewed");
  assert.equal(result.verdict, "approve");
  assert.equal(result.decision, "accept");
  assert.equal(result.target, "workspace");
  assert.equal(result.cross_provider, true);
  assert.deepEqual(result.reviewer, { provider_id: "anthropic", model_id: "opus-5.5" });
  assert.deepEqual(result.artifact.files, ["src/a.mjs"]);
  assert.match(result.artifact.digest, /^sha256:|^[0-9a-f]{16,}/);
  assert.equal(result.criteria.length, 4);
});

test("syn review --json: a major finding exits 1; a run-<n> target is a JSON error with exit 3", async () => {
  const changes = await review(["review", "--json"], (ids) => ({
    criteria: criteria(ids),
    findings: [{ id: "F-1", severity: "major", summary: "a is null", path: "src/a.mjs", line: 1 }],
    decision: "revise",
  }));
  assert.equal(changes.code, 1, changes.stderr);
  assert.equal(JSON.parse(changes.stdout).verdict, "changes_requested");
  const unsupported = await review(["review", "--json", "run-1"], () => ({}));
  assert.equal(unsupported.code, 3);
  assert.equal(JSON.parse(unsupported.stdout).error.code, "usage_invalid");
});
