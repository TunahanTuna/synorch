import type { SkillCatalog } from "../../context/index.ts";
import type { McpServerDefinition } from "../../mcp/index.ts";
import { createPersonaCatalog, type PersonaCatalog, type PluginAgent } from "./agents.ts";
import { createMergedSkillCatalog, itemBody, loadExtensions, pluginDataDir, pluginMcpServers, resolveItems, type ExtensionItem, type ExtensionLoadInput, type ExtensionState, type ItemStatus } from "./catalog.ts";
import { createHookEngine, hookSources, readHookApprovals, type HookApprovals, type HookConfig, type HookEngine, type HookProcessRunner, type HookSource } from "./hooks.ts";

/**
 * K7: one runtime's skills, commands and plugins. `reload()` re-reads every source (after an
 * install, enable or disable); trust is read live, so trusting the workspace activates the
 * repository's skills at once.
 */
export interface ExtensionSettings {
  readonly includeClaudeSkills: boolean;
  readonly includeClaudePlugins: boolean;
  readonly disabledSkills: readonly string[];
  readonly disabledPlugins: readonly string[];
  /** `hooks:` of the user configuration. */
  readonly userHooks?: HookConfig;
}

export interface Extensions {
  readonly skills: SkillCatalog;
  /** The environment the sources were resolved with (Claude home, plugin variables). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Claude Code's home, when its items are read at all. */
  readonly claudeHome: string | undefined;
  state(): ExtensionState;
  statuses(): ItemStatus[];
  /** Active items the user can invoke as `/<name>`, minus names a built-in command already uses. */
  invocable(reserved: ReadonlySet<string>): ExtensionItem[];
  /** The active item for `/<name>`. */
  find(name: string): ExtensionItem | undefined;
  /** The user message a manual invocation sends; undefined when the item cannot be read. */
  invocationText(entry: ExtensionItem, args: string): Promise<string | undefined>;
  mcpServers(): readonly McpServerDefinition[];
  problems(): readonly string[];
  settings(): ExtensionSettings;
  /** Hooks of the user configuration and of enabled plugins (plugin hooks run once approved). */
  readonly hooks: HookEngine;
  /** Agents of enabled plugins, as orchestration worker personas. */
  readonly personas: PersonaCatalog;
  /** Applies new settings (after the user configuration changed) and re-reads every source. */
  reload(settings?: ExtensionSettings): Promise<void>;
}

export interface ExtensionsOptions extends Omit<ExtensionLoadInput, "includeClaudeSkills" | "includeClaudePlugins" | "disabledPlugins" | "trusted"> {
  readonly settings: ExtensionSettings;
  readonly trusted: () => boolean;
  readonly canonicalCatalog: SkillCatalog;
  /** Tests: replaces the hook process runner. */
  readonly hookRunner?: HookProcessRunner;
}

function pluginAgents(state: ExtensionState): PluginAgent[] {
  return state.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.contents.agentDefs.map((agent) => ({ ...agent, id: `${plugin.contents.name}:${agent.name}`, plugin: plugin.key, origin: plugin.origin })));
}

export async function createExtensions(options: ExtensionsOptions): Promise<Extensions> {
  let settings = options.settings;
  const read = (): Promise<ExtensionState> =>
    loadExtensions({
      ...options,
      includeClaudeSkills: settings.includeClaudeSkills,
      includeClaudePlugins: settings.includeClaudePlugins,
      disabledPlugins: settings.disabledPlugins,
      trusted: options.trusted(),
    });
  let state = await read();
  let approvals: HookApprovals = await readHookApprovals(options.home);
  const computeSources = (): HookSource[] =>
    hookSources({
      user: settings.userHooks ?? {},
      plugins: state.plugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => ({ key: plugin.key, origin: plugin.origin, root: plugin.contents.root, data: pluginDataDir(plugin, options), config: plugin.contents.hookConfig })),
      approvals,
    });
  let sources = computeSources();
  let agents = pluginAgents(state);
  const disabled = (): ReadonlySet<string> => new Set(settings.disabledSkills);
  let mcp = pluginMcpServers(state, options);
  const statuses = (): ItemStatus[] => resolveItems(state.items, { trusted: options.trusted(), disabled: disabled() });
  const active = (): ExtensionItem[] => statuses().filter((status) => status.state === "active").map((status) => status.item);
  return {
    env: options.env,
    claudeHome: options.claudeHome,
    skills: createMergedSkillCatalog({ canonical: options.canonicalCatalog, state: () => state, trusted: options.trusted, disabled, workspaceRoot: options.workspaceRoot }),
    state: () => state,
    statuses,
    invocable: (reserved) => active().filter((entry) => entry.meta.userInvocable && !reserved.has(entry.name.toLowerCase())),
    find: (name) => active().find((entry) => entry.name === name) ?? active().find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
    async invocationText(entry, args) {
      const canonical = entry.canonical ? await options.canonicalCatalog.load(entry.name) : undefined;
      const body = entry.canonical ? (canonical === undefined ? undefined : args.trim() === "" ? canonical : `${canonical}\n\nARGUMENTS: ${args.trim()}`) : await itemBody(entry, args, options.workspaceRoot);
      if (body === undefined) return undefined;
      const label = entry.kind === "skill" ? "Skill" : "Command";
      const shown = `${label} /${entry.name}${args.trim() === "" ? "" : ` ${args.trim()}`}`;
      const tools = entry.meta.allowedTools.length === 0 ? "" : `\n(The ${entry.kind} lists allowed-tools ${entry.meta.allowedTools.join(" ")}; Synorch's permission mode still decides.)`;
      return `${shown}\n<synorch-attachments>\nThe user invoked the ${entry.kind} /${entry.name} (${entry.source}: ${entry.location}). Follow these instructions for this request:${tools}\n\n${body}\n</synorch-attachments>`;
    },
    mcpServers: () => mcp.servers,
    problems: () => [...state.problems, ...mcp.problems],
    settings: () => settings,
    hooks: createHookEngine({ env: options.env, sources: () => sources, ...(options.hookRunner === undefined ? {} : { run: options.hookRunner }) }),
    personas: createPersonaCatalog(() => agents),
    async reload(next) {
      if (next !== undefined) settings = next;
      state = await read();
      approvals = await readHookApprovals(options.home);
      sources = computeSources();
      agents = pluginAgents(state);
      mcp = pluginMcpServers(state, options);
    },
  };
}
