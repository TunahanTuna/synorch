import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { createClaudeCodeAdapter, createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, eventsOf, overridesFor, parseFrames, planArguments, projectionIssues, readSession, text, writeConfig } from "./fixtures/cli/runtime/support.ts";

/**
 * K1.5 cross-provider orchestration: the orchestrator on OpenAI (scripted), the implementer on the
 * Claude Code bridge (a fake `claude` speaking stream-json and calling Synorch tools over MCP), the
 * reviewer on OpenAI again. Real store, policy, gateway, isolation, coordinator and MCP bridge.
 */

const FAKE_WORKER = fileURLToPath(new URL("./fixtures/providers/fake-claude-worker.mjs", import.meta.url));
const README = "# Synorch\n\nThis is teh readme.\n";
const FIXED = "# Synorch\n\nThis is the readme.\n";

test("cross-provider run: OpenAI orchestrator, Claude Code bridge implementer, OpenAI reviewer", async () => {
  const sandbox = await createSandbox({ "README.md": README }, { git: true });
  const reportFile = path.join(sandbox.root, "fake-worker.json");
  const saved = { path: process.env.FAKE_WORKER_PATH, content: process.env.FAKE_WORKER_CONTENT, report: process.env.FAKE_WORKER_REPORT };
  process.env.FAKE_WORKER_PATH = "README.md";
  process.env.FAKE_WORKER_CONTENT = FIXED;
  process.env.FAKE_WORKER_REPORT = reportFile;
  try {
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", provider: "openai", adapter: "plan-script", model: "gpt-6-sol" },
      { tier: "complex_worker", provider: "anthropic", adapter: "claude-code", model: "opus-5.5" },
      { tier: "complex_worker", role: "reviewer", provider: "openai", adapter: "review-script", model: "gpt-6-luna" },
      { tier: "fast_worker", provider: "openai", adapter: "review-script", model: "gpt-6-luna" },
    ]);
    const orchestrator = createScriptedAdapter(
      [call("plan_propose", () => planArguments("Fix the typo in README.md", [{ key: "fix-typo", risk: "standard", owned: ["README.md"], read: ["README.md"], criteria: ["README.md says 'the readme'"] }])), text("planned")],
      { adapterId: "plan-script", providerId: "openai", authMethod: "oauth-subscription" },
    );
    const reviewer = createScriptedAdapter(
      [
        call("read_file", () => ({ path: "README.md" })),
        call("review_report", (ids) => ({
          criteria: [{ criterion_id: "AC-1", verdict: "met", evidence: [{ kind: "tool-call", ref: ids.at(-1), produced_by: "reviewer" }] }],
          findings: [],
          decision: "accept",
        })),
        text("reviewed"),
      ],
      { adapterId: "review-script", providerId: "openai", authMethod: "oauth-subscription" },
    );
    const bridge = createClaudeCodeAdapter({ experimental: true, executable: { command: process.execPath, args: [FAKE_WORKER] }, interruptGraceMs: 1_000 });

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Fix the typo in README.md", "--mode", "jsonl"], run.io, overridesFor(sandbox, { adapters: [orchestrator, reviewer, bridge] }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 0, `${run.stderr()}\n${JSON.stringify(frames.at(-1))}`);
    assert.equal(await readFile(path.join(sandbox.workspace, "README.md"), "utf8"), FIXED, "the bridge worker's edit was reviewed and integrated");

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    const attempts = eventsOf(runLog, "attempt/started");
    assert.deepEqual(attempts.map((event) => event.data.role), ["implementer", "reviewer"]);
    assert.equal(attempts[0]?.data.route.adapter_id, "claude-code");
    assert.equal(attempts[0]?.data.route.provider_id, "anthropic");
    assert.equal(attempts[0]?.data.route.model_id, "opus-5.5");
    assert.equal(attempts[1]?.data.route.provider_id, "openai");
    const reviewerDecision = eventsOf(runLog, "route/decided").find((event) => event.data.decision.role === "reviewer")?.data.decision;
    assert.match(reviewerDecision?.reason ?? "", /independent of the implementer provider anthropic/);
    assert.equal(eventsOf(runLog, "review/recorded")[0]?.data.decision, "accept");

    const implementerLog = await readSession(sandbox.home, attempts[0]?.data.session_id ?? "");
    assert.deepEqual(projectionIssues(implementerLog), [], "the bridge attempt replays through the recovery projection");
    const proposed = eventsOf(implementerLog, "tool/call_proposed").map((event) => event.data.tool_name);
    assert.ok(proposed.includes("write_file") && proposed.includes("task_report"), `MCP tool calls are recorded like native ones: ${proposed.join(", ")}`);
    assert.ok(eventsOf(implementerLog, "provider/usage").length >= 1, "bridge usage is recorded");

    const fake = JSON.parse(await readFile(reportFile, "utf8")) as { argv: string[]; tools: string[]; calls: { name: string; isError: boolean }[] };
    assert.equal(fake.argv[fake.argv.indexOf("--model") + 1], "claude-opus-5-5", "opus-5.5 maps to the id Claude Code accepts");
    assert.ok(fake.tools.includes("task_report"), "the report tool is offered over MCP");
    assert.deepEqual(fake.calls.map((entry) => [entry.name, entry.isError]), [["write_file", false], ["task_report", false]]);
  } finally {
    for (const [key, value] of [["FAKE_WORKER_PATH", saved.path], ["FAKE_WORKER_CONTENT", saved.content], ["FAKE_WORKER_REPORT", saved.report]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await sandbox.cleanup();
  }
});
