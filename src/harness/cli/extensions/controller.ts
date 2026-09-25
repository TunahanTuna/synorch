import type { SkillCatalog } from "../../context/index.ts";
import type { McpServerDefinition } from "../../mcp/index.ts";
import { createMergedSkillCatalog, itemBody, loadExtensions, pluginMcpServers, resolveItems, type ExtensionItem, type ExtensionLoadInput, type ExtensionState, type ItemStatus } from "./catalog.ts";

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
  /** Applies new settings (after the user configuration changed) and re-reads every source. */
  reload(settings?: ExtensionSettings): Promise<void>;
}

export interface ExtensionsOptions extends Omit<ExtensionLoadInput, "includeClaudeSkills" | "includeClaudePlugins" | "disabledPlugins" | "trusted"> {
  readonly settings: ExtensionSettings;
  readonly trusted: () => boolean;
  readonly canonicalCatalog: SkillCatalog;
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
    async reload(next) {
      if (next !== undefined) settings = next;
      state = await read();
      mcp = pluginMcpServers(state, options);
    },
  };
}
