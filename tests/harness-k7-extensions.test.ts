import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { SkillCatalog } from "../src/harness/context/index.ts";
import { pluginCommand, setExtensionDisabled, skillsCommand } from "../src/harness/cli/extensions-command.ts";
import { addMarketplace, createExtensions, expandBody, mayReadPath, stagePlugin, type ExtensionSettings } from "../src/harness/cli/extensions/index.ts";

/** K7: skills, markdown commands and plugins (Claude Code formats) from every source. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

const skill = (name: string, description: string, body = "Do the thing.", extra = ""): string => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;

const noCanonical: SkillCatalog = { list: () => [{ name: "tdd", description: "built-in tdd", triggers: [] }], load: async (name) => (name === "tdd" ? "Skill tdd (builtin):\nred green" : undefined) };

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly claude: string;
  readonly workspace: string;
  readonly plugin: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-k7-"));
  roots.push(root);
  const home = path.join(root, "synorch");
  const claude = path.join(root, "claude");
  const workspace = path.join(root, "repo");
  const plugin = path.join(root, "fx-plugin");
  await write(path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"), skill("deploy", "Project deploy."));
  await write(path.join(workspace, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\nargument-hint: [env]\n---\nShip to $ARGUMENTS now.\n");
  await write(path.join(home, "skills", "deploy", "SKILL.md"), skill("deploy", "User deploy."));
  await write(path.join(home, "commands", "hello.md"), "Say hello to $1 and $0.\n");
  await write(path.join(claude, "skills", "review", "SKILL.md"), skill("review", "Claude user review skill."));
  await write(path.join(claude, "skills", "tdd", "SKILL.md"), skill("tdd", "Claude tdd overrides builtin."));
  await write(path.join(claude, ".credentials.json"), '{"secret":"never-read"}');
  await write(path.join(claude, "settings.json"), JSON.stringify({ env: { TOKEN: "x" }, enabledPlugins: { "cp@mkt": true, "off@mkt": false } }));
  const cp = path.join(claude, "plugins", "cache", "mkt", "cp", "1.0.0");
  await write(path.join(cp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cp", version: "1.0.0", description: "Claude plugin" }));
  await write(path.join(cp, "skills", "lint", "SKILL.md"), skill("lint", "Lint from a Claude plugin."));
  await write(path.join(cp, ".mcp.json"), JSON.stringify({ mcpServers: { cpserver: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/s.js"] } } }));
  const off = path.join(claude, "plugins", "cache", "mkt", "off", "1.0.0");
  await write(path.join(off, "skills", "nope", "SKILL.md"), skill("nope", "Disabled in Claude."));
  await write(
    path.join(claude, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "cp@mkt": [{ scope: "user", installPath: cp, version: "1.0.0" }], "off@mkt": [{ scope: "user", installPath: off, version: "1.0.0" }] } }),
  );
  await write(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fx", version: "0.1.0", description: "Fixture plugin" }));
  await write(path.join(plugin, "skills", "hello", "SKILL.md"), skill("hello", "Plugin hello skill.", "Hello from ${CLAUDE_PLUGIN_ROOT}."));
  await write(path.join(plugin, "commands", "greet.md"), "---\ndescription: Greet someone\n---\nGreet $ARGUMENTS warmly.\n");
  await write(path.join(plugin, "agents", "helper.md"), "---\nname: helper\n---\nAgent.\n");
  await write(path.join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [] } }));
  await write(path.join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { fxserver: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] } } }));
  return { root, home, claude, workspace, plugin };
}

const settings: ExtensionSettings = { includeClaudeSkills: true, includeClaudePlugins: true, disabledSkills: [], disabledPlugins: [] };

async function extensionsFor(fx: Fixture, trusted: () => boolean, overrides: Partial<ExtensionSettings> = {}) {
  return createExtensions({ home: fx.home, workspaceRoot: fx.workspace, env: {}, platform: process.platform, claudeHome: fx.claude, settings: { ...settings, ...overrides }, trusted, canonicalCatalog: noCanonical, canonical: { origin: "builtin", skills: [{ name: "tdd", description: "built-in tdd", path: ".ai/skills/tdd/SKILL.md" }] } });
}

test("precedence project > user > claude > builtin, project skills gated by trust", async () => {
  const fx = await fixture();
  let trusted = false;
  const extensions = await extensionsFor(fx, () => trusted);
  const state = (name: string) => extensions.statuses().filter((status) => status.item.name === name).map((status) => `${status.item.source}:${status.state}`);
  assert.deepEqual(state("deploy"), ["project:needs-trust", "user:active"]);
  assert.deepEqual(state("tdd"), ["claude:active", "builtin:shadowed"]);
  assert.equal(extensions.find("ship"), undefined, "an untrusted project command is not invocable");
  trusted = true;
  assert.deepEqual(state("deploy"), ["project:active", "user:shadowed"]);
  assert.equal(extensions.find("ship")?.source, "project");
  const text = await extensions.invocationText(extensions.find("ship")!, "prod");
  assert.match(text ?? "", /^Command \/ship prod\n<synorch-attachments>/);
  assert.match(text ?? "", /Ship to prod now\./);
});

test("Claude plugins: enabled state from Claude settings, read in place, never the credentials", async () => {
  const fx = await fixture();
  const extensions = await extensionsFor(fx, () => true);
  const plugins = extensions.state().plugins;
  assert.equal(plugins.find((plugin) => plugin.key === "cp@mkt")?.enabled, true);
  assert.equal(plugins.find((plugin) => plugin.key === "off@mkt")?.offReason, "claude");
  assert.ok(extensions.find("cp:lint"));
  assert.equal(extensions.find("off:nope"), undefined);
  const server = extensions.mcpServers().find((definition) => definition.name === "cpserver");
  assert.equal(server?.source, "claude-plugin");
  assert.equal(server?.args[0], `${path.join(fx.claude, "plugins", "cache", "mkt", "cp", "1.0.0")}/s.js`);
  assert.equal(mayReadPath(fx.claude, path.join(fx.claude, ".credentials.json")), false);
  assert.equal(mayReadPath(fx.claude, path.join(fx.claude, "settings.json")), false, "settings.json is read only through readClaudeEnabledPlugins");
  assert.equal(mayReadPath(fx.claude, path.join(fx.claude, "skills", "review", "SKILL.md")), true);
  assert.equal(mayReadPath(fx.claude, path.join(fx.root, "elsewhere")), true);
  // Turned off in Synorch only: Claude's settings are untouched.
  const before = await readFile(path.join(fx.claude, "settings.json"), "utf8");
  const next = await setExtensionDisabled(fx.home, "plugins", "cp@mkt", true);
  await extensions.reload(next);
  assert.equal(extensions.find("cp:lint"), undefined);
  assert.equal(await readFile(path.join(fx.claude, "settings.json"), "utf8"), before);
  // include_claude: false drops every Claude item.
  const none = await extensionsFor(fx, () => true, { includeClaudeSkills: false, includeClaudePlugins: false });
  assert.equal(none.statuses().some((status) => status.item.source === "claude"), false);
});

test("model catalog: Claude-native routes leave Claude's own skills out; load serves the body", async () => {
  const fx = await fixture();
  const extensions = await extensionsFor(fx, () => true);
  const all = (await extensions.skills.list("session")).map((entry) => entry.name);
  assert.ok(all.includes("review") && all.includes("cp:lint") && all.includes("deploy") && all.includes("tdd"));
  const native = (await extensions.skills.list("session", { claudeNative: true })).map((entry) => entry.name);
  assert.equal(native.includes("review"), false);
  assert.equal(native.includes("cp:lint"), false);
  assert.equal(native.includes("tdd"), false, "Claude's tdd wins over the built-in and Claude already has it");
  assert.ok(native.includes("deploy"));
  assert.match((await extensions.skills.load("deploy")) ?? "", /Skill deploy \(project: .*\):\nDo the thing\./);
});

test("plugin install from a path and from a marketplace; skills, commands, MCP servers; agents and hooks listed", async () => {
  const fx = await fixture();
  const staged = await stagePlugin(fx.plugin, { home: fx.home, cwd: fx.root, env: {} });
  assert.deepEqual(staged.contents.agents, ["helper"]);
  assert.deepEqual(staged.contents.hooks, ["PostToolUse"]);
  const record = await staged.commit();
  assert.equal(record.dir, path.join(fx.home, "plugins", "installed", "fx"));
  const extensions = await extensionsFor(fx, () => true);
  assert.equal(extensions.find("fx:hello")?.source, "plugin");
  const greet = extensions.find("fx:greet");
  assert.match((await extensions.invocationText(greet!, "Ada")) ?? "", /Greet Ada warmly\./);
  const server = extensions.mcpServers().find((definition) => definition.name === "fxserver");
  assert.equal(server?.source, "plugin");
  assert.equal(server?.args[0], `${record.dir}/server.js`);
  assert.match((await extensions.skills.load("fx:hello")) ?? "", new RegExp(`Hello from ${record.dir.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const market = path.join(fx.root, "market");
  await write(path.join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "local-market", owner: { name: "t" }, plugins: [{ name: "mp", source: "./plugins/mp", description: "From a marketplace" }] }));
  await write(path.join(market, "plugins", "mp", "skills", "mpskill", "SKILL.md"), skill("mpskill", "Marketplace skill."));
  const added = await addMarketplace(market, { home: fx.home, cwd: fx.root, env: {} });
  assert.deepEqual(added.plugins, ["mp"]);
  const fromMarket = await stagePlugin("mp@local-market", { home: fx.home, cwd: fx.root, env: {} });
  assert.equal(fromMarket.contents.name, "mp");
  await fromMarket.commit();
  await extensions.reload();
  assert.ok(extensions.find("mp:mpskill"));
});

test("argument substitution follows Claude Code", () => {
  assert.equal(expandBody("a $ARGUMENTS b $1 $0", "x y"), "a x y b y x");
  assert.equal(expandBody("no placeholders", "x"), "no placeholders\n\nARGUMENTS: x");
  assert.equal(expandBody("Fix $issue on $branch", "12 main", { argumentNames: ["issue", "branch"] }), "Fix 12 on main");
});

test("syn skills and syn plugin CLI", async () => {
  const fx = await fixture();
  const out: string[] = [];
  const io = { home: fx.home, cwd: fx.workspace, env: {}, platform: process.platform, stdout: (text: string) => void out.push(text), stderr: (text: string) => void out.push(text), claudeHome: fx.claude };
  assert.equal(await skillsCommand(["list"], undefined, false, io), 0);
  assert.match(out.join(""), /deploy\s+project\s+needs trust/);
  assert.match(out.join(""), /review\s+claude\s+on/);
  out.length = 0;
  assert.equal(await skillsCommand(["disable", "review"], undefined, false, io), 0);
  assert.match(await readFile(path.join(fx.home, "config.yaml"), "utf8"), /skills:\n\s+disabled:\n\s+- review/);
  out.length = 0;
  assert.equal(await pluginCommand(["install", fx.plugin], undefined, false, io), 2, "without --yes and no terminal nothing is installed");
  assert.match(out.join(""), /MCP servers \(1\): fxserver/);
  out.length = 0;
  assert.equal(await pluginCommand(["install", fx.plugin, "--yes"], undefined, false, io), 0);
  assert.equal(await pluginCommand(["list"], undefined, false, io), 0);
  assert.match(out.join(""), /fx 0\.1\.0 · synorch · on/);
  assert.match(out.join(""), /cp@mkt 1\.0\.0 · claude · on/);
});
