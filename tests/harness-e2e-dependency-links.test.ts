import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createSloppyModelAdapter } from "../src/harness/orchestration/testing.ts";
import { capture, createSandbox, eventsOf, overridesFor, parseFrames, readSession, trustWorkspace, writeConfig } from "./fixtures/cli/runtime/support.ts";

/**
 * ADR-19 security seam: an ignored dependency directory (node_modules, .venv) of the main tree is
 * linked (junction/symlink) into the attempt worktree so verification finds installed packages.
 * A write through that link would land in the MAIN tree, so the worker manager adds every linked
 * directory to the attempt policy's forbidden paths. Real runtime; only the models are scripted.
 */

const DEPENDENCY = "module.exports = 1;\n";

test("ADR-19 a linked dependency directory is forbidden to the attempt: a write through it is denied and the main tree keeps its bytes", async () => {
  const sandbox = await createSandbox({ ".gitignore": "node_modules/\n", "src/a.js": "export const a = 1;\n", "package.json": '{ "type": "module" }\n' }, { git: true });
  try {
    await mkdir(path.join(sandbox.workspace, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(sandbox.workspace, "node_modules", "dep", "index.js"), DEPENDENCY);
    await trustWorkspace(sandbox);
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "astra", model: "gpt-6-astra" },
      { tier: "fast_worker", adapter: "luna", model: "gpt-5.6-luna" },
      { tier: "complex_worker", adapter: "luna", model: "gpt-5.6-luna" },
    ]);
    const plan = {
      goal: "set a to 2",
      risk: "trivial",
      scope: ["src/a.js"],
      tasks: [
        {
          key: "edit-a",
          role: "implementer",
          objective: "Set a to 2.",
          depends_on: [],
          owned_paths: ["src/a.js"],
          read_paths: ["src/a.js"],
          risk: "trivial",
          model_tier: "fast_worker",
          acceptance_criteria: [{ id: "AC-1", statement: "src/a.js exports 2" }],
          verification: [],
        },
      ],
      expected_external_effects: [],
      verification: [],
      budget: { max_wall_time_seconds: 600, max_steps: 30 },
      assumptions: [],
    };
    const orchestrator = createSloppyModelAdapter([{ when: /^Goal:/, steps: [{ calls: [{ name: "plan_propose", arguments: plan }] }] }], { adapterId: "astra" });
    const worker = createSloppyModelAdapter(
      [
        {
          when: /^Task task_\w+ \(implementer\)/,
          steps: [
            { calls: [{ name: "write_file", arguments: { path: "node_modules/dep/index.js", content: "module.exports = 'pwned';\n", expected_digest: sha256(DEPENDENCY) } }] },
            { calls: [{ name: "write_file", arguments: { path: "src/a.js", content: "export const a = 2;\n", expected_digest: sha256("export const a = 1;\n") } }] },
            { calls: [{ name: "task_report", arguments: { status: "completed", summary: "a is 2", acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "file", ref: "src/a.js", produced_by: "worker" }] }] } }] },
          ],
        },
      ],
      { adapterId: "luna" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "set a to 2", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, worker] }));
    const { frames } = parseFrames(run.stdout());
    assert.equal(code, 0, `${run.stderr()}\n${JSON.stringify(frames.at(-1))}`);

    const denied = worker.views[1]?.last;
    assert.equal(denied?.isError, true, "the write through the dependency link is refused");
    assert.match(denied?.text ?? "", /path_outside_scope|policy_denied/);
    assert.equal(await readFile(path.join(sandbox.workspace, "node_modules", "dep", "index.js"), "utf8"), DEPENDENCY, "the main tree's dependency is untouched");
    assert.equal(await readFile(path.join(sandbox.workspace, "src", "a.js"), "utf8"), "export const a = 2;\n");

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    const started = eventsOf(runLog, "attempt/started")[0];
    assert.equal(started?.data.isolation.mode, "worktree");
    assert.deepEqual(started?.data.isolation.dependency_links, ["node_modules"]);
    const policy = eventsOf(runLog, "policy/snapshot").find((event) => event.data.policy.role === "implementer");
    assert.ok(policy?.data.policy.forbidden.includes("node_modules"), "the linked directory is forbidden in the attempt's effective policy");
  } finally {
    await sandbox.cleanup();
  }
});
