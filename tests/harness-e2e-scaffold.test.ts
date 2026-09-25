import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { isInstallCommand } from "../src/harness/orchestration/worker-manager.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
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
  taskReport,
  text,
  trustWorkspace,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * P0-A owner benchmark ("create an empty React project"): a scaffold handed to a fast worker through
 * orchestration in a folder that is not a git repository (scoped-dir, like the benchmark). Expected:
 * one attempt, the planner's reviewer task dropped, no review round, the install runs once (reused in
 * the verification-repair round), generated outputs (node_modules, dist) never reach the artifact, and
 * the install's lockfile is pinned with the verified state so integration does not see a moved artifact.
 */

const PACKAGE = '{\n  "name": "app",\n  "private": true,\n  "type": "module",\n  "scripts": { "build": "node build.mjs" }\n}\n';
const MAIN = 'import React from "react";\nexport default function App() {\n  return null;\n}\n';
const BROKEN_BUILD = 'console.error("build.mjs: not implemented yet");\nprocess.exit(1);\n';
const BUILD = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "const here = dirname(fileURLToPath(import.meta.url));",
  'mkdirSync(join(here, "dist"), { recursive: true });',
  'writeFileSync(join(here, "dist", "index.html"), `<div id="root"></div>${Date.now()}`);',
  'mkdirSync(join(here, "node_modules", ".vite"), { recursive: true });',
  'writeFileSync(join(here, "node_modules", ".vite", "deps.json"), String(Date.now()));',
  'console.log("built");',
  "",
].join("\n");
const INSTALL = "npm install --prefix app --offline --no-audit --no-fund";
const BUILD_COMMAND = "node app/build.mjs";

test("install commands are recognised by argv", () => {
  for (const argv of [["npm", "install"], ["npm", "ci"], ["pnpm", "install", "--frozen-lockfile"], ["pnpm"], ["yarn"], ["npm.cmd", "i"], ["uv", "sync"], ["pip", "install", "-r", "requirements.txt"], ["python", "-m", "pip", "install", "x"]]) {
    assert.ok(isInstallCommand(argv), argv.join(" "));
  }
  for (const argv of [["npm", "run", "build"], ["npm", "test"], ["npm"], ["node", "install.js"], ["pnpm", "test"]]) {
    assert.ok(!isInstallCommand(argv), argv.join(" "));
  }
});

test("scaffold via orchestration: one attempt, no review, one install, generated outputs excluded (P0-A)", async () => {
  const sandbox = await createSandbox({ "README.md": "# empty\n" });
  await trustWorkspace(sandbox);
  try {
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "worker-script", model: "worker" },
      { tier: "fast_worker", adapter: "worker-script", model: "worker" },
    ]);
    const orchestrator = createScriptedAdapter(
      [
        call("plan_propose", () =>
          planArguments("Create an empty React project in app/", [
            { key: "scaffold", risk: "standard", owned: ["app/**"], tier: "fast_worker", verification: [INSTALL, BUILD_COMMAND], criteria: ["app/ holds a React project that builds"] },
            { key: "review-scaffold", role: "reviewer", dependsOn: ["scaffold"], owned: [], tier: "complex_worker", criteria: ["the scaffold is minimal"] },
          ]),
        ),
        text("planned"),
      ],
      { adapterId: "plan-script" },
    );
    const worker = createScriptedAdapter(
      [
        calls(() => [
          { name: "write_file", arguments: { path: "app/package.json", content: PACKAGE } },
          { name: "write_file", arguments: { path: "app/src/App.jsx", content: MAIN } },
          { name: "write_file", arguments: { path: "app/build.mjs", content: BROKEN_BUILD } },
        ]),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        // Verification-repair round: the harness build failed; the worker fixes build.mjs.
        call("write_file", () => ({ path: "app/build.mjs", content: BUILD, expected_digest: sha256(BROKEN_BUILD) })),
        taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]),
        text("fixed the build"),
      ],
      { adapterId: "worker-script" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(
      ["run", "Create an empty React project in app/", "--mode", "jsonl"],
      run.io,
      overridesFor(sandbox, { adapters: [orchestrator, worker], limits: { review: "proportional" } }),
    );
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, [], run.stderr());
    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    if (code !== 0) {
      // Platform-only failures (Windows CI) are otherwise opaque: show what the harness ran and what the tools answered.
      const ran = eventsOf(runLog, "attempt/verification_ran").map((event) => `${event.data.command}: ${event.data.status} (${event.data.duration_ms} ms) ${event.data.output_excerpt.slice(0, 400)}`);
      const transitions = runLog.filter((event) => event.type === "attempt/state_changed" || event.type === "task/state_changed" || event.type === "attempt/repair_requested").map((event) => `${event.type} ${JSON.stringify(event.data).slice(0, 600)}`);
      assert.fail(`exit ${code}\n${run.stderr()}\n${JSON.stringify(frames.at(-1))}\nverification:\n${ran.join("\n")}\nstates:\n${transitions.join("\n")}`);
    }

    const plan = eventsOf(runLog, "plan/proposed")[0]?.data.plan;
    assert.deepEqual(plan?.tasks.map((task) => task.key), ["scaffold"], "the planner's reviewer task for a single-task plan is dropped");
    const attempts = eventsOf(runLog, "attempt/started");
    assert.deepEqual(attempts.map((event) => event.data.role), ["implementer"], "one attempt, no reviewer");
    assert.equal(attempts[0]?.data.isolation.mode, "scoped-dir");
    assert.equal(eventsOf(runLog, "review/recorded").length, 0, "no review round");
    assert.equal(eventsOf(runLog, "attempt/repair_requested").length, 1, "the failing build cost one in-session repair");

    const runs = eventsOf(runLog, "attempt/verification_ran");
    const installs = runs.filter((event) => event.data.command === INSTALL);
    assert.equal(installs.length, 2, "install is verified in both rounds");
    assert.equal(installs.filter((event) => !event.data.output_excerpt.includes("(reused)")).length, 1, "but executed only once");
    assert.ok(installs.every((event) => event.data.status === "passed"));
    const builds = runs.filter((event) => event.data.command === BUILD_COMMAND);
    assert.deepEqual(builds.map((event) => event.data.status), ["failed", "passed"], "the build re-runs after the fix");

    const states = eventsOf(runLog, "task/state_changed").map((event) => event.data.to);
    assert.deepEqual(states, ["ready", "running", "verifying", "completed"]);
    const integrated = eventsOf(runLog, "task/integrated")[0]?.data.paths ?? [];
    assert.ok(integrated.includes("app/package.json") && integrated.includes("app/build.mjs"), integrated.join(", "));
    assert.ok(!integrated.some((entry) => entry.includes("node_modules/") || entry.includes("/dist/")), `generated outputs are not part of the artifact: ${integrated.join(", ")}`);
    await access(path.join(sandbox.workspace, "app", "dist", "index.html"));
    assert.equal(await readFile(path.join(sandbox.workspace, "app", "build.mjs"), "utf8"), BUILD);

    const last = frames.at(-1);
    assert.ok(last?.type === "result" && last.data.status === "succeeded");
  } finally {
    await sandbox.cleanup();
  }
});
