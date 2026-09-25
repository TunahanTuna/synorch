import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createId, sha256, type SessionEvent } from "../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { resolveAttachments } from "../src/harness/cli/attachments.ts";
import { OrchestrationTracker } from "../src/harness/cli/orchestration-view.ts";
import { CONVERSATION_COMMANDS, conversationPaletteEntries } from "../src/harness/cli/slash-commands.ts";
import { UsageLedger } from "../src/harness/cli/usage-stats.ts";
import { createAgentDriver } from "../src/harness/core/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, eventsOf, overridesFor, planArguments, readSession, ScriptedInput, taskReport, text, writeConfig } from "./fixtures/cli/runtime/support.ts";

/**
 * K1-U2 session features (ADR-21): plan mode narrows the conversation to reading until the user
 * says go; the `orchestrate` tool runs the coordinator inside the turn and reports a result block;
 * one command registry feeds the palette; usage is aggregated and persisted; attachments inline
 * files with their digest; leftover steering is handed back to the caller.
 */

const BROKEN = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
const PATCH = "*** Begin Patch\n*** Update File: src-add.mjs\n@@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch";

test("plan mode: read-only until /go, then the edit lands; /usage and /why explain what happened", async () => {
  const sandbox = await createSandbox({ "src-add.mjs": BROKEN });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), "routes:\n  - { tier: session, provider: scripted, model: chat, adapter: chat-script }\n");
    const model = createScriptedAdapter(
      [
        call("apply_patch", () => ({ patch: PATCH })),
        text("Plan: flip the minus to a plus in src-add.mjs, then run the tests."),
        call("read_file", () => ({ path: "src-add.mjs" })),
        call("apply_patch", () => ({ patch: PATCH })),
        text("Done."),
      ],
      { adapterId: "chat-script" },
    );
    const input = ["/plan", "fix add", "/go", "/why apply_patch", "/usage", "/cost", "/help", "/exit", ""].join("\n");
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, true), stdinIsTTY: true });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [model] }));
    const stdout = io.stdout();
    assert.equal(code, 0, io.stderr());
    assert.match(stdout, /Plan mode on/);
    assert.match(stdout, /\/go carries it out here/);
    assert.match(stdout, /Plan mode off/);
    assert.equal(await readFile(path.join(sandbox.workspace, "src-add.mjs"), "utf8"), FIXED, "the edit landed after /go");

    const [first] = model.requests;
    assert.ok(first !== undefined && !first.tools.some((tool) => tool.name === "apply_patch" || tool.name === "exec"), "plan mode hides edit and command tools");
    const sessionId = /--resume (ses_\S+)\)/.exec(io.stderr())?.[1] ?? "";
    const log = await readSession(sandbox.home, sessionId);
    const decisions = eventsOf(log, "tool/policy_decided").filter((event) => event.data.action.tool_name === "apply_patch");
    assert.deepEqual(decisions.map((event) => event.data.decision.decision), ["deny", "allow"], "denied in plan mode, allowed after /go");
    const told = model.requests[1]?.messages.some((message) => message.content.some((part) => part.type === "tool_result" && part.text.includes("plan mode is on")));
    assert.ok(told, "the model is told why the edit was refused");

    assert.match(stdout, /Why was this allowed\? apply_patch src-add\.mjs \(succeeded\)/, "/why shows the latest decision as a why card");
    assert.match(stdout, /session +5 req - 260 in - 70 out/, "/usage shows the usage view");
    assert.match(stdout, /This session: cost unknown for this route · 330 tokens · 5 requests/, "/cost");
    assert.match(stdout, /\/review \[focus\]/, "/help comes from the registry");
    const usage = JSON.parse(await readFile(path.join(sandbox.home, "usage", "usage.json"), "utf8")) as { days: Record<string, Record<string, { requests: number }>> };
    const today = Object.values(usage.days)[0] ?? {};
    assert.equal(Object.values(today).reduce((sum, bucket) => sum + bucket.requests, 0), 5, "the daily aggregate is persisted");
  } finally {
    await sandbox.cleanup();
  }
});

const README = "# Synorch\n\nThis is teh readme.\n";
const README_FIXED = "# Synorch\n\nThis is the readme.\n";

test("orchestrate tool: the coordinator runs inside the turn and the agent reports from the result block", async () => {
  const sandbox = await createSandbox({ "README.md": README });
  try {
    await writeConfig(sandbox.home, [
      { tier: "session" as never, adapter: "chat-script", model: "chat" },
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "worker-script", model: "worker" },
      { tier: "fast_worker", adapter: "worker-script", model: "worker" },
    ]);
    const chat = createScriptedAdapter(
      [call("orchestrate", () => ({ goal: "Fix the typo in README.md", reason: "Shows the worker path end to end." })), text("Workers fixed the typo.")],
      { adapterId: "chat-script" },
    );
    const planner = createScriptedAdapter(
      [call("plan_propose", () => planArguments("Fix the typo in README.md", [{ key: "fix-typo", risk: "trivial", owned: ["README.md"], read: ["README.md"], tier: "fast_worker" }])), text("planned")],
      { adapterId: "plan-script" },
    );
    const worker = createScriptedAdapter(
      [call("write_file", () => ({ path: "README.md", content: README_FIXED, expected_digest: sha256(README) })), taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]), text("fixed")],
      { adapterId: "worker-script" },
    );
    const input = ["fix the readme typo with workers", "/tasks", "/diff", "/exit", ""].join("\n");
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, false), stdinIsTTY: false });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [chat, planner, worker] }));
    const stdout = io.stdout();
    assert.equal(code, 0, io.stderr());
    assert.equal(await readFile(path.join(sandbox.workspace, "README.md"), "utf8"), README_FIXED, "the worker's fix was integrated");
    assert.doesNotMatch(stdout, /Starting workers/, "the rationale is audit (session log, /runs), not a transcript line");
    assert.match(stdout, /1\. fix-typo \(implementer\)/, "the plan block is shown before workers start");
    assert.match(stdout, /workers: done in/, "the board's pinned summary");
    assert.match(stdout, /Changed 1 file README\.md/);
    assert.doesNotMatch(stdout, /independently reviewed/, "a trivial worker task without review is never labelled reviewed");
    assert.match(stdout, /synorch: Workers fixed the typo\./);
    assert.match(stdout, /fix-typo task_\S+ completed/, "/tasks reads the conversation's worker run");
    assert.match(stdout, /Integrated by workers \(checked by Synorch\)/);

    const sessionId = /--resume (ses_\S+)\)/.exec(io.stderr())?.[1] ?? "";
    const log = await readSession(sandbox.home, sessionId);
    assert.equal(log.filter((event) => /^(plan|task|attempt|run)\//.test(event.type)).length, 0, "run events live in the run's own session");
    const result = eventsOf(log, "tool/result_recorded").find((event) => event.data.result.text.includes("Orchestration"));
    assert.equal(result?.data.state, "succeeded");
    assert.match(result?.data.result.text ?? "", /Orchestration succeeded[\s\S]*fix-typo[\s\S]*Changed \(1 files/);
    const second = chat.requests[1];
    assert.ok(second?.messages.some((message) => message.content.some((part) => part.type === "tool_result" && part.text.includes("Orchestration succeeded"))), "the agent sees the result block");
  } finally {
    await sandbox.cleanup();
  }
});

test("command registry: every session command is registered once and feeds the palette", () => {
  const names = CONVERSATION_COMMANDS.map((command) => command.name);
  for (const required of ["/help", "/plan", "/model", "/review", "/commit", "/undo", "/allow", "/trust", "/usage", "/evidence", "/why", "/compact", "/context", "/clear", "/resume", "/memory", "/mouse", "/cost"]) {
    assert.ok(names.includes(required), required);
  }
  assert.equal(new Set(names).size, names.length, "no duplicates");
  const entries = conversationPaletteEntries();
  assert.ok(entries.every((entry) => !entry.name.startsWith("/") && entry.description.length > 0), "palette rows carry names without the slash");
  assert.ok(!entries.some((entry) => entry.name === "mouse" || entry.name === "exit"), "renderer-local commands stay the renderer's");
  assert.equal(entries.find((entry) => entry.name === "model")?.argsHint, "[tier] [provider/model] [--save]");
  assert.equal(entries.find((entry) => entry.name === "workers")?.argsHint, "<goal>", "a required argument makes Enter complete");
});

test("orchestration view: tasks with role, model, status, activity and dependencies from run and attempt events", () => {
  let now = 1_000;
  const tracker = new OrchestrationTracker("goal", "why", () => now);
  const runSession = createId("session");
  const attemptSession = createId("session");
  const runId = createId("run");
  const [first, second] = [createId("task"), createId("task")];
  const attempt = createId("attempt");
  let seq = 0;
  const event = (type: string, data: unknown, session = runSession, extra: Record<string, unknown> = {}): SessionEvent =>
    ({ type, data, session_id: session, run_id: runId, seq: (seq += 1), event_version: 1, actor: { kind: "system" }, timestamp: new Date(now).toISOString(), ...extra }) as unknown as SessionEvent;
  tracker.observe(event("run/created", { goal: "goal", policy_mode: "autonomous", headless: true, budget: {} }));
  tracker.observe(event("task/created", { task_id: first, plan_id: "plan_x", key: "map", role: "explorer", depends_on: [], owned_paths: [], risk: "trivial" }));
  tracker.observe(event("task/created", { task_id: second, plan_id: "plan_x", key: "edit", role: "implementer", depends_on: [first], owned_paths: ["a.ts"], risk: "standard" }));
  tracker.observe(event("task/state_changed", { task_id: first, from: "ready", to: "running" }));
  tracker.observe(event("attempt/started", { attempt_id: attempt, task_id: first, role: "explorer", route: { model_id: "luna" }, session_id: attemptSession }));
  now += 5_000;
  tracker.observe(event("tool/call_proposed", { tool_name: "search" }, attemptSession, { attempt_id: attempt }));
  const view = tracker.view();
  assert.equal(tracker.currentPhase, "running");
  assert.equal(view.kind, "orchestration");
  assert.equal(view.done, false);
  assert.deepEqual(
    view.tasks.map((task) => [task.key, task.role, task.model, task.state, task.activity, task.dependsOn]),
    [
      ["map", "explorer", "luna", "running", "searching", []],
      ["edit", "implementer", undefined, "draft", undefined, ["map"]],
    ],
  );
  assert.equal(view.tasks[0]?.startedAtMs, 1_000);
  // K3: a live implementer's owned paths lock the conversation agent's edits; explorers own nothing.
  assert.equal(tracker.ownerOf("a.ts", "linux"), "edit");
  assert.equal(tracker.ownerOf("b.ts", "linux"), undefined);
  assert.match(tracker.statusLines().join("\n"), /- edit \(implementer\): draft · owns a\.ts/);
  tracker.observe(event("run/state_changed", { from: "running", to: "completed", reason: "done" }));
  assert.equal(tracker.ownerOf("a.ts", "linux"), undefined, "a finished run locks nothing");
  assert.equal(tracker.view().done, true);
  assert.equal(tracker.view().outcome, "completed");
});

test("usage ledger: per model/tier buckets, API-key estimate, quota %, persisted aggregate", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "syn-usage-"));
  try {
    const ledger = new UsageLedger(home, () => new Date("2026-09-23T10:00:00Z"));
    const base = { session_id: createId("session"), seq: 1, event_version: 1, timestamp: "2026-09-23T10:00:00Z" };
    const requestId = createId("request");
    ledger.observe({ ...base, type: "model/request_prepared", actor: { kind: "agent", role: "session" }, data: { request_id: requestId, route: { provider_id: "anthropic", model_id: "claude-sonnet-x", auth_method: "api-key" } } } as unknown as SessionEvent);
    ledger.observe({ ...base, type: "provider/usage", actor: { kind: "agent", role: "session" }, data: { request_id: requestId, usage: { input_tokens: 1_000_000, output_tokens: 0, source: "provider-reported" }, quota: { source: "headers", windows: [{ name: "5h", used_percent: 42 }] } } } as unknown as SessionEvent);
    const footer = ledger.footer();
    assert.equal(footer.requests, 1);
    assert.equal(footer.quotaPercent, 42);
    assert.ok(Math.abs((footer.costUsd ?? 0) - 3) < 1e-9, "sonnet input at $3/M");
    await ledger.flush();
    const saved = JSON.parse(await readFile(path.join(home, "usage", "usage.json"), "utf8")) as { days: Record<string, Record<string, unknown>> };
    assert.deepEqual(Object.keys(saved.days["2026-09-23"] ?? {}), ["anthropic/claude-sonnet-x|session"]);
    assert.match((await ledger.report()).join("\n"), /Quota anthropic: 42% of the 5h window/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("attachments: @path inlines the file with its digest; outside paths and images are refused with a notice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-attach-"));
  try {
    await writeFile(path.join(root, "notes.md"), "hello\n");
    await writeFile(path.join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
    const outside = { id: "file-1", kind: "file" as const, label: "@../outside.txt", path: path.join(root, "..", "outside.txt"), displayPath: "../outside.txt", source: "mention" as const };
    const result = await resolveAttachments("look at @notes.md and @shot.png", [outside], { workspaceRoot: root, model: "chat" });
    assert.match(result.message, /<file path="notes\.md" digest="sha256:[0-9a-f]{64}" bytes="6">\nhello\n/);
    assert.ok(result.notices.some((notice) => /outside the workspace/.test(notice.text)));
    assert.ok(result.notices.some((notice) => /does not take image input/.test(notice.text)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("driver: steering typed after the last step settled is handed back instead of lost", () => {
  const driver = createAgentDriver({} as never);
  driver.steer("also update the docs");
  assert.deepEqual(driver.drainSteers?.(), ["also update the docs"]);
  assert.deepEqual(driver.drainSteers?.(), []);
});
