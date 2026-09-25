import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createId, sha256, type SandboxReport } from "../src/harness/contracts/index.ts";
import type { SkillCatalog } from "../src/harness/context/index.ts";
import { renderPacketView } from "../src/harness/context/index.ts";
import {
  approveHooks,
  claudeToolInput,
  createExtensions,
  createHookEngine,
  gatewayHooks,
  matcherMatches,
  parseHookConfig,
  personaBaseRole,
  personaModelTier,
  stagePlugin,
  type HookProcessRunner,
  type HookSource,
} from "../src/harness/cli/extensions/index.ts";
import { compileTaskPacket } from "../src/harness/orchestration/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { createSandboxRunner, createToolGateway, createToolRegistry } from "../src/harness/tools/index.ts";
import { createMemoryBlobStore, createMemoryEventStore } from "../src/harness/tools/testing.ts";

/** K7 hooks (Claude Code format) and plugin agents as worker personas. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-k7h-"));
  roots.push(root);
  return root;
}

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

const PARTIAL: SandboxReport = { backend: "none", platform: "other", enforcement: "partial", filesystem: "partial", network: "partial", process: "partial", notes: [] };
const noCanonical: SkillCatalog = { list: () => [], load: async () => undefined };
const settings = { includeClaudeSkills: false, includeClaudePlugins: true, disabledSkills: [], disabledPlugins: [] };

function source(origin: HookSource["origin"], config: unknown): HookSource {
  return { key: origin === "user" ? "user" : `${origin}-plugin`, origin, config: parseHookConfig(config).config, digest: "d", state: "active", pluginRoot: undefined, pluginData: undefined };
}

test("Claude matcher rules and tool mapping", () => {
  assert.equal(matcherMatches("Edit|Write", ["Edit", "MultiEdit", "apply_patch"]), true);
  assert.equal(matcherMatches("Bash", ["Read", "read_file"]), false);
  assert.equal(matcherMatches("mcp__.*", ["mcp__github__issue"]), true);
  assert.equal(matcherMatches(undefined, ["anything"]), true);
  const input = claudeToolInput("exec", { argv: ["git", "commit", "-m", "a b"] }, "/w");
  assert.equal(input.command, "git commit -m 'a b'");
  assert.equal(claudeToolInput("read_file", { path: "src/a.ts" }, path.resolve("/w")).file_path, path.resolve("/w", "src/a.ts"));
});

test("a PreToolUse hook exiting 2 denies the call through the gateway; stderr is the reason", async () => {
  const root = await tempRoot();
  await write(path.join(root, "a.txt"), "hello\n");
  const engine = createPolicyEngine({ workspaceTrusted: () => true });
  const policy = engine.compute({ mode: "autonomous", role: "implementer", runId: createId("run"), taskId: createId("task"), workspaceRoot: root, taskScope: { owned: ["**"], read: [], forbidden: [], verification_commands: [] }, userConfig: undefined, workspaceConfig: undefined, sandbox: PARTIAL, grants: [] });
  const hooks = createHookEngine({
    env: process.env,
    sources: () => [source("user", { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('secrets live here');process.exit(2)})"] }] }] })],
  });
  const events = createMemoryEventStore();
  const gateway = createToolGateway({ events, blobs: createMemoryBlobStore(), registry: createToolRegistry({ classifyCommand }), policy: engine, approvals: createHeadlessApprovalBroker(), sandbox: createSandboxRunner(PARTIAL), hooks: gatewayHooks(hooks, { workspaceRoot: root, permissionMode: () => undefined }) });
  const call = (name: string, args: Record<string, unknown>) =>
    gateway.invoke({ tool_call_id: createId("toolCall"), provider_call_id: `p-${name}`, tool_name: name, arguments: args }, { runId: policy.run_id, taskId: policy.task_id, attemptId: undefined, role: policy.role, policy }, new AbortController().signal);
  const denied = await call("read_file", { path: "a.txt" });
  assert.equal(denied.state, "denied");
  assert.match(denied.result.error?.message ?? "", /hook-denied .*secrets live here/);
  const decided = events.events.find((event) => event.type === "tool/policy_decided");
  assert.equal(decided?.type === "tool/policy_decided" ? decided.data.decision.reasons[0]?.code : undefined, "hook-denied");
  // A tool the matcher does not name runs normally.
  assert.equal((await call("list_dir", { path: "." })).state, "succeeded");
});

test("plugin hooks run only once approved; a changed plugin needs a new approval; Claude plugin hooks start off", async () => {
  const root = await tempRoot();
  const home = path.join(root, "home");
  const claude = path.join(root, "claude");
  const plugin = path.join(root, "hp");
  const hooksJson = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }], FileChanged: [] } });
  await write(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "hp", version: "1.0.0" }));
  await write(path.join(plugin, "hooks", "hooks.json"), hooksJson("echo one"));
  const staged = await stagePlugin(plugin, { home, cwd: root, env: {} });
  assert.ok(staged.contents.problems.some((problem) => problem.includes("FileChanged")), "unsupported events are reported");
  const record = await staged.commit();
  const cp = path.join(claude, "plugins", "cache", "mkt", "cp", "1.0.0");
  await write(path.join(cp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cp" }));
  await write(path.join(cp, "hooks", "hooks.json"), hooksJson("echo claude"));
  await write(path.join(claude, "settings.json"), JSON.stringify({ enabledPlugins: { "cp@mkt": true } }));
  await write(path.join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "cp@mkt": [{ scope: "user", installPath: cp }] } }));

  const ran: string[] = [];
  const runner: HookProcessRunner = async (hook) => {
    ran.push(hook.command);
    return { code: 0, stdout: "", stderr: "", timedOut: false, error: undefined };
  };
  const extensions = await createExtensions({ home, workspaceRoot: root, env: {}, platform: process.platform, claudeHome: claude, settings, trusted: () => true, canonicalCatalog: noCanonical, hookRunner: runner });
  const states = () => Object.fromEntries(extensions.hooks.sources().map((entry) => [entry.key, entry.state]));
  assert.deepEqual(states(), { hp: "pending", "cp@mkt": "pending" });
  const context = { sessionId: "s", cwd: root, permissionMode: undefined, claudeNative: false, signal: new AbortController().signal };
  assert.equal((await extensions.hooks.run("PreToolUse", {}, ["Bash"], context)).ran, 0, "nothing runs before approval");

  const hp = extensions.hooks.sources().find((entry) => entry.key === "hp");
  await approveHooks(home, "hp", hp?.digest ?? "");
  await extensions.reload();
  assert.deepEqual(states(), { hp: "active", "cp@mkt": "pending" });
  await extensions.hooks.run("PreToolUse", {}, ["Bash"], context);
  assert.deepEqual(ran, ["echo one"]);

  await write(path.join(record.dir, "hooks", "hooks.json"), hooksJson("echo two"));
  await extensions.reload();
  assert.equal(states().hp, "changed");
  ran.length = 0;
  await extensions.hooks.run("PreToolUse", {}, ["Bash"], context);
  assert.deepEqual(ran, [], "changed hooks do not run");
});

test("Claude-sourced hooks are skipped on Claude Code native routes; Synorch's own still run", async () => {
  const ran: string[] = [];
  const runner: HookProcessRunner = async (hook) => {
    ran.push(hook.command);
    return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: `ctx ${hook.command}` } }), stderr: "", timedOut: false, error: undefined };
  };
  const stop = (command: string) => ({ Stop: [{ hooks: [{ type: "command", command }] }] });
  const engine = createHookEngine({ env: {}, sources: () => [source("claude", stop("claude-hook")), source("synorch", stop("synorch-hook"))], run: runner });
  const context = { sessionId: "s", cwd: ".", permissionMode: "auto", signal: new AbortController().signal };
  const native = await engine.run("Stop", {}, [], { ...context, claudeNative: true });
  assert.deepEqual(ran, ["synorch-hook"]);
  assert.deepEqual(native.context, ["ctx synorch-hook"]);
  ran.length = 0;
  await engine.run("Stop", {}, [], { ...context, claudeNative: false });
  assert.deepEqual(ran, ["claude-hook", "synorch-hook"]);
});

test("a plugin agent becomes a worker persona in the task packet", async () => {
  const root = await tempRoot();
  const home = path.join(root, "home");
  const plugin = path.join(root, "ap");
  await write(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ap" }));
  await write(path.join(plugin, "agents", "sec-reviewer.md"), "---\nname: sec-reviewer\ndescription: Security review specialist\ntools: Read, Grep, Glob\nmodel: haiku\n---\nLook for injection bugs first.\n");
  await (await stagePlugin(plugin, { home, cwd: root, env: {} })).commit();
  const extensions = await createExtensions({ home, workspaceRoot: root, env: {}, platform: process.platform, claudeHome: undefined, settings, trusted: () => true, canonicalCatalog: noCanonical });
  const agent = extensions.personas.find("ap:sec-reviewer");
  assert.ok(agent !== undefined);
  assert.equal(personaBaseRole(agent), "reviewer");
  assert.equal(personaModelTier(agent.model), "fast_worker");

  const packet = compileTaskPacket({
    plan: { schema_version: 1, plan_id: createId("plan"), run_id: createId("run"), version: 1, goal: "g", risk: "standard", scope: ["src/**"], tasks: [], expected_external_effects: [], verification: [], budget: { max_wall_time_seconds: 60, max_steps: 10 }, assumptions: [], created_at: "2026-09-25T10:00:00Z" } as never,
    planDigest: sha256("plan"),
    task: { key: "t", role: "explorer", objective: "Audit auth", depends_on: [], owned_paths: [], read_paths: [], risk: "standard", model_tier: "fast_worker", agent: "ap:sec-reviewer", acceptance_criteria: [{ id: "AC-1", statement: "findings listed" }], verification: [] },
    taskId: createId("task"),
    createdAt: "2026-09-25T10:00:00Z",
    sources: [],
    findings: [],
    forbiddenPaths: [],
    preferWorktree: true,
    personas: (id) => {
      const found = extensions.personas.find(id);
      return found === undefined ? undefined : { id: found.id, instructions: found.body };
    },
  });
  assert.deepEqual(packet.persona, { id: "ap:sec-reviewer", instructions: "Look for injection bugs first." });
  assert.match(renderPacketView(packet), /Persona ap:sec-reviewer[^\n]*\nLook for injection bugs first\./);
});
