import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRole } from "../../contracts/index.ts";
import type { SkillCatalog, SkillEntry, SkillListOptions } from "../../context/index.ts";
import { parseMcpServerEntry, toDefinition, MCP_SERVER_NAME_PATTERN, type McpServerDefinition } from "../../mcp/index.ts";
import { claudeDirectory, mayReadReal } from "./claude-home.ts";
import { expandBody, parseMarkdown, type MarkdownMeta } from "./markdown.ts";
import { discoverClaudePlugins, pluginsHome, readPlugin, readPluginStore, scanCommands, scanSkills, type CommandRef, type PluginContents, type ReadGuard, type SkillRef } from "./plugins.ts";

/**
 * K7 skills, markdown commands and plugins as one catalog. Sources, highest precedence first on a
 * name clash (the listing shows what is shadowed):
 *
 *   project  <repo>/.synorch/skills, .claude/skills, .agents/skills (+ commands/): repository
 *            content, used only once the workspace is trusted ("needs trust" otherwise)
 *   user     <synorch home>/skills, <synorch home>/commands
 *   plugin   plugins installed with `syn plugin install` (namespaced `<plugin>:<name>`)
 *   claude   Claude Code's own: ~/.claude/skills, ~/.claude/commands and the plugins enabled in
 *            Claude Code (`skills.include_claude` / `plugins.include_claude`, default on)
 *   builtin  the Synorch skills (and a repository's legacy `.ai/skills`, served as before)
 *
 * Claude Code native routes already load Claude's own items; the model catalog leaves them out
 * there (no duplicates) while Synorch's own items still reach Claude through `load_skill`.
 */

export type ExtensionSource = "project" | "user" | "plugin" | "claude" | "builtin";
export const EXTENSION_SOURCES: readonly ExtensionSource[] = ["project", "user", "plugin", "claude", "builtin"];

export interface ExtensionItem {
  readonly kind: "skill" | "command";
  /** Invocation name: `deploy`, or `<plugin>:<name>` for a plugin's item. */
  readonly name: string;
  readonly source: ExtensionSource;
  /** Where it comes from (file path, or `builtin:…`). */
  readonly location: string;
  /** The plugin key (`name`, Claude's `name@marketplace`) of a plugin item. */
  readonly plugin: string | undefined;
  readonly meta: MarkdownMeta;
  /** Repository content: active only in a trusted workspace. */
  readonly needsTrust: boolean;
  /** Claude Code loads it itself on its native routes (user-level Claude items and Claude plugins). */
  readonly claudeNative: boolean;
  readonly file: string | undefined;
  readonly content: string | undefined;
  readonly dir: string | undefined;
  readonly pluginRoot: string | undefined;
  /** Served by the canonical catalog (built-in or `.ai/skills`), role visibility included. */
  readonly canonical: boolean;
}

export type ItemState = "active" | "shadowed" | "disabled" | "needs-trust";

export interface ItemStatus {
  readonly item: ExtensionItem;
  readonly state: ItemState;
  /** The winning item's source, for a shadowed one. */
  readonly shadowedBy: ExtensionItem | undefined;
}

export interface PluginEntry {
  /** `name` for a Synorch plugin, Claude's `name@marketplace` for a Claude one. */
  readonly key: string;
  readonly origin: "synorch" | "claude";
  readonly contents: PluginContents;
  /** Where it came from (install source, or Claude's scope). */
  readonly detail: string;
  readonly enabled: boolean;
  /** Why it is off: turned off in Synorch, or disabled in Claude Code. */
  readonly offReason: "synorch" | "claude" | undefined;
  /** A Claude plugin a Synorch plugin of the same name replaces. */
  readonly shadowed: boolean;
}

export interface ExtensionState {
  readonly items: readonly ExtensionItem[];
  readonly plugins: readonly PluginEntry[];
  readonly problems: readonly string[];
}

export interface ExtensionLoadInput {
  readonly home: string;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** Claude Code's home (`claudeHome(env)`); undefined reads nothing of Claude's. */
  readonly claudeHome: string | undefined;
  readonly includeClaudeSkills: boolean;
  readonly includeClaudePlugins: boolean;
  readonly disabledPlugins: readonly string[];
  /** The workspace is trusted (project-scope Claude plugin state is read only then). */
  readonly trusted: boolean;
  /** Canonical skills (`name`, `description`, where), listed as `builtin` (or `project` for `.ai/skills`). */
  readonly canonical?: { readonly origin: "repository" | "builtin"; readonly skills: readonly { readonly name: string; readonly description: string; readonly path: string }[] };
  /** Skip `<repo>/.synorch/*` when the workspace's `.synorch` is the Synorch home itself. */
  readonly skipProjectSynorch?: boolean;
  /** The folder is no project (the home folder): no project-scope skills or commands at all. */
  readonly skipProjectScope?: boolean;
}

const PROJECT_SKILL_DIRS = [".synorch/skills", ".claude/skills", ".agents/skills"] as const;
const PROJECT_COMMAND_DIRS = [".synorch/commands", ".claude/commands"] as const;
const SOURCE_RANK: Readonly<Record<ExtensionSource, number>> = { project: 0, user: 1, plugin: 2, claude: 3, builtin: 4 };

function item(partial: Omit<ExtensionItem, "file" | "content" | "dir" | "pluginRoot" | "plugin" | "canonical" | "claudeNative" | "needsTrust"> & Partial<ExtensionItem>): ExtensionItem {
  return { file: undefined, content: undefined, dir: undefined, pluginRoot: undefined, plugin: undefined, canonical: false, claudeNative: false, needsTrust: false, ...partial };
}

function skillItem(skill: SkillRef, source: ExtensionSource, extra: Partial<ExtensionItem> = {}): ExtensionItem {
  return item({ kind: "skill", name: skill.name, source, location: skill.file, meta: skill.meta, file: skill.file, dir: skill.dir, ...extra });
}

function commandItem(command: CommandRef, source: ExtensionSource, extra: Partial<ExtensionItem> = {}): ExtensionItem {
  return item({ kind: "command", name: command.name, source, location: command.file ?? "(inline)", meta: command.meta, file: command.file, content: command.content, ...extra });
}

function pluginItems(contents: PluginContents, source: ExtensionSource, key: string, claudeNative: boolean): ExtensionItem[] {
  const extra = { plugin: key, pluginRoot: contents.root, claudeNative };
  return [
    ...contents.skills.map((skill) => skillItem({ ...skill, name: `${contents.name}:${skill.name}` }, source, extra)),
    ...contents.commands.map((command) => commandItem({ ...command, name: `${contents.name}:${command.name}` }, source, extra)),
  ];
}

/** Reads every source once (no process is started, nothing is written). */
export async function loadExtensions(input: ExtensionLoadInput): Promise<ExtensionState> {
  const items: ExtensionItem[] = [];
  const problems: string[] = [];
  const plugins: PluginEntry[] = [];
  const disabledPlugins = new Set(input.disabledPlugins);

  for (const relative of input.skipProjectScope === true ? [] : PROJECT_SKILL_DIRS) {
    if (input.skipProjectSynorch === true && relative.startsWith(".synorch/")) continue;
    for (const skill of await scanSkills(path.join(input.workspaceRoot, relative))) items.push(skillItem(skill, "project", { needsTrust: true }));
  }
  for (const relative of input.skipProjectScope === true ? [] : PROJECT_COMMAND_DIRS) {
    if (input.skipProjectSynorch === true && relative.startsWith(".synorch/")) continue;
    for (const command of await scanCommands(path.join(input.workspaceRoot, relative))) items.push(commandItem(command, "project", { needsTrust: true }));
  }
  for (const skill of await scanSkills(path.join(input.home, "skills"))) items.push(skillItem(skill, "user"));
  for (const command of await scanCommands(path.join(input.home, "commands"))) items.push(commandItem(command, "user"));

  const store = await readPluginStore(input.home);
  const synorchNames = new Set<string>();
  for (const record of store.plugins) {
    const contents = await readPlugin(record.dir, { name: record.name });
    synorchNames.add(contents.name);
    const enabled = !disabledPlugins.has(record.name);
    plugins.push({ key: record.name, origin: "synorch", contents, detail: record.marketplace === undefined ? record.source : `${record.source}`, enabled, offReason: enabled ? undefined : "synorch", shadowed: false });
    for (const problem of contents.problems) problems.push(`plugin ${record.name}: ${problem}`);
    if (enabled) items.push(...pluginItems(contents, "plugin", record.name, false));
  }

  const claudeHome = input.claudeHome;
  const guard: ReadGuard = async (target) => claudeHome !== undefined && (await mayReadReal(claudeHome, target));
  if (input.includeClaudeSkills && claudeHome !== undefined) {
    for (const skill of await scanSkills(claudeDirectory(claudeHome, "skills"), guard)) items.push(skillItem(skill, "claude", { claudeNative: true }));
    for (const command of await scanCommands(claudeDirectory(claudeHome, "commands"), guard)) items.push(commandItem(command, "claude", { claudeNative: true }));
  }
  if (input.includeClaudePlugins && claudeHome !== undefined) {
    const found = await discoverClaudePlugins({ claudeHome, workspaceRoot: input.workspaceRoot, trusted: input.trusted, platform: input.platform });
    problems.push(...found.problems);
    for (const plugin of found.plugins) {
      const shadowed = synorchNames.has(plugin.contents.name);
      const offReason = !plugin.enabledInClaude ? "claude" : disabledPlugins.has(plugin.id) ? "synorch" : undefined;
      const enabled = offReason === undefined && !shadowed;
      plugins.push({ key: plugin.id, origin: "claude", contents: plugin.contents, detail: `Claude Code, ${plugin.scope} scope`, enabled, offReason, shadowed });
      if (enabled) items.push(...pluginItems(plugin.contents, "claude", plugin.id, true));
    }
  }

  for (const skill of input.canonical?.skills ?? []) {
    const source: ExtensionSource = input.canonical?.origin === "repository" ? "project" : "builtin";
    items.push(
      item({
        kind: "skill",
        name: skill.name,
        source,
        location: input.canonical?.origin === "repository" ? skill.path : `builtin:${skill.path}`,
        meta: { name: skill.name, description: skill.description, whenToUse: undefined, argumentHint: undefined, argumentNames: [], allowedTools: [], modelInvocable: true, userInvocable: true },
        canonical: true,
      }),
    );
  }
  return { items, plugins, problems };
}

export interface ResolveOptions {
  readonly trusted: boolean;
  readonly disabled: ReadonlySet<string>;
}

function available(entry: ExtensionItem, options: ResolveOptions): boolean {
  return !options.disabled.has(entry.name) && (!entry.needsTrust || options.trusted);
}

/**
 * Every item with its state. Per name the highest-precedence available item wins (a skill before a
 * command of the same source); an untrusted or disabled item never shadows another.
 */
export function resolveItems(items: readonly ExtensionItem[], options: ResolveOptions): ItemStatus[] {
  const groups = new Map<string, ExtensionItem[]>();
  for (const entry of items) groups.set(entry.name, [...(groups.get(entry.name) ?? []), entry]);
  const statuses: ItemStatus[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.kind === b.kind ? 0 : a.kind === "skill" ? -1 : 1));
    const winner = ordered.find((entry) => available(entry, options));
    for (const entry of ordered) {
      if (entry === winner) statuses.push({ item: entry, state: "active", shadowedBy: undefined });
      else if (options.disabled.has(entry.name)) statuses.push({ item: entry, state: "disabled", shadowedBy: undefined });
      else if (entry.needsTrust && !options.trusted) statuses.push({ item: entry, state: "needs-trust", shadowedBy: undefined });
      else statuses.push({ item: entry, state: "shadowed", shadowedBy: winner });
    }
  }
  return statuses.sort((a, b) => (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : SOURCE_RANK[a.item.source] - SOURCE_RANK[b.item.source]));
}

/** A plugin's persistent data directory (`${CLAUDE_PLUGIN_DATA}`): Claude's for a Claude plugin, Synorch's otherwise. */
export function pluginDataDir(plugin: Pick<PluginEntry, "key" | "origin">, input: { readonly home: string; readonly claudeHome: string | undefined }): string {
  const safeId = plugin.key.replace(/[^A-Za-z0-9_-]/g, "-");
  const claudeHome = input.claudeHome ?? pluginsHome(input.home);
  return plugin.origin === "claude" ? path.join(claudeDirectory(claudeHome, "plugins"), "data", safeId) : path.join(pluginsHome(input.home), "data", safeId);
}

/** Plugin MCP servers as client definitions (`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` expanded). */
export function pluginMcpServers(state: ExtensionState, input: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly claudeHome: string | undefined }): { readonly servers: McpServerDefinition[]; readonly problems: string[] } {
  const servers: McpServerDefinition[] = [];
  const problems: string[] = [];
  for (const plugin of state.plugins) {
    if (!plugin.enabled) continue;
    const data = pluginDataDir(plugin, input);
    const environment = { ...input.env, CLAUDE_PLUGIN_ROOT: plugin.contents.root, CLAUDE_PLUGIN_DATA: data };
    for (const [name, raw] of Object.entries(plugin.contents.mcpServers)) {
      if (!MCP_SERVER_NAME_PATTERN.test(name)) {
        problems.push(`plugin ${plugin.key}: MCP server ${name}: names are 1-32 letters, digits, - or _`);
        continue;
      }
      const parsed = parseMcpServerEntry(raw);
      if ("error" in parsed) {
        problems.push(`plugin ${plugin.key}: MCP server ${name}: ${parsed.error}`);
        continue;
      }
      servers.push(toDefinition(name, parsed.entry, plugin.origin === "claude" ? "claude-plugin" : "plugin", path.join(plugin.contents.root, ".mcp.json"), environment, { baseDir: plugin.contents.root }));
    }
  }
  return { servers, problems };
}

/** The text a skill or command contributes: its body with Claude's placeholders expanded. */
export async function itemBody(entry: ExtensionItem, args: string, projectDir: string): Promise<string | undefined> {
  let text = entry.content;
  if (text === undefined && entry.file !== undefined) text = await readFile(entry.file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const document = parseMarkdown(text);
  return expandBody(document.body, args, { skillDir: entry.dir, pluginRoot: entry.pluginRoot, projectDir, argumentNames: entry.meta.argumentNames });
}

export interface MergedSkillCatalogOptions {
  readonly canonical: SkillCatalog;
  readonly state: () => ExtensionState;
  readonly trusted: () => boolean;
  readonly disabled: () => ReadonlySet<string>;
  readonly workspaceRoot: string;
}

const SKILL_TEXT_LIMIT = 60 * 1024;

/**
 * The model's skill catalog over every source: the canonical catalog (built-in / `.ai/skills`, role
 * visibility kept) plus the active K7 skills that allow model invocation. On a Claude Code native
 * route (`options.claudeNative`) Claude's own items are left out: Claude already has them.
 */
export function createMergedSkillCatalog(options: MergedSkillCatalogOptions): SkillCatalog {
  const winners = (): Map<string, ExtensionItem> => {
    const statuses = resolveItems(options.state().items, { trusted: options.trusted(), disabled: options.disabled() });
    return new Map(statuses.filter((status) => status.state === "active" && status.item.kind === "skill").map((status) => [status.item.name, status.item]));
  };
  const describe = (entry: ExtensionItem): string => (entry.meta.whenToUse === undefined ? entry.meta.description : `${entry.meta.description} ${entry.meta.whenToUse}`);
  return {
    async primary(role: AgentRole): Promise<readonly string[]> {
      const active = winners();
      return ((await options.canonical.primary?.(role)) ?? []).filter((name) => active.get(name)?.canonical === true);
    },
    async list(role?: AgentRole, listOptions?: SkillListOptions): Promise<readonly SkillEntry[]> {
      const active = winners();
      const canonical = new Map((await options.canonical.list(role)).map((entry) => [entry.name, entry]));
      const entries: SkillEntry[] = [];
      for (const entry of active.values()) {
        if (!entry.meta.modelInvocable) continue;
        if (listOptions?.claudeNative === true && entry.claudeNative) continue;
        if (entry.canonical) {
          const visible = canonical.get(entry.name);
          if (visible !== undefined) entries.push(visible);
          continue;
        }
        entries.push({ name: entry.name, description: describe(entry), triggers: [] });
      }
      return entries;
    },
    async load(name: string, role?: AgentRole): Promise<string | undefined> {
      const entry = winners().get(name);
      if (entry === undefined || !entry.meta.modelInvocable) return undefined;
      if (entry.canonical) return options.canonical.load(name, role);
      const body = await itemBody(entry, "", options.workspaceRoot);
      if (body === undefined) return undefined;
      const text = `Skill ${entry.name} (${entry.source}: ${entry.location}):\n${body}`;
      return text.length <= SKILL_TEXT_LIMIT ? text : `${text.slice(0, SKILL_TEXT_LIMIT)}\n[truncated]`;
    },
  };
}
