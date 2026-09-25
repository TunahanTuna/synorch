import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, isMap, parseDocument } from "yaml";
import type { ChoiceAnswer, ChoiceQuestion } from "../contracts/index.ts";
import {
  addMarketplace,
  claudeHome as resolveClaudeHome,
  createExtensions,
  describeContents,
  marketplacePlugins,
  PluginError,
  readPluginStore,
  removeMarketplace,
  removePlugin,
  stagePlugin,
  type Extensions,
  type ExtensionSettings,
  type GitClone,
  type ItemStatus,
  type PluginEntry,
  type StagedPlugin,
} from "./extensions/index.ts";
import { createWorkspaceTrustStore } from "../policy/index.ts";
import { loadCanonicalStructure } from "./canonical.ts";
import { CONFIG_FILE, extensionsConfigOf, isSynorchHome, loadRuntimeConfig, validateUserConfigText, type ConfigDiscoveryOptions, type UserConfigFile } from "./config.ts";

/**
 * K7 `syn skills`, `syn plugin`, `/skills` and `/plugins`: list skills and markdown commands with
 * their source and state, turn one off or on (user configuration only; Claude's files are never
 * touched), install / remove / enable / disable plugins and add marketplaces (Claude Code formats).
 */

export const SKILLS_HELP = `syn skills — skills and slash commands (Claude Code SKILL.md format)

Usage:
  syn skills [list] [--json]       Every skill and markdown command: source, state, description.
  syn skills show <name>           Where it comes from, what shadows it, its frontmatter.
  syn skills enable|disable <name> Turn one on or off for Synorch (saved in your user config).

Sources (highest first on a name clash):
  project   .synorch/skills, .claude/skills, .agents/skills, .claude/commands, .synorch/commands
            (repository content: used once the workspace is trusted)
  user      ~/.synorch/skills/<name>/SKILL.md, ~/.synorch/commands/<name>.md
  plugin    plugins installed with syn plugin install (as <plugin>:<name>)
  claude    ~/.claude/skills, ~/.claude/commands and plugins enabled in Claude Code
            (skills.include_claude / plugins.include_claude: false turns them off)
  builtin   the Synorch skills
In a session every skill and command is also /<name> [args].
`;

export const PLUGIN_HELP = `syn plugin — plugins in the Claude Code plugin format

Usage:
  syn plugin [list] [--json]                 Synorch and Claude Code plugins, what each contains.
  syn plugin install <path|git-url|name@marketplace> [--yes] [--disabled]
                                             Show what it contains, then install it into
                                             ~/.synorch/plugins (skills, commands, MCP servers).
  syn plugin remove <name>                   Uninstall a Synorch plugin.
  syn plugin enable|disable <name>           Turn a plugin on or off for Synorch (Claude plugins:
                                             name@marketplace; Claude's own settings stay as they are).
  syn plugin marketplace add <git-url|path>  Register a marketplace (.claude-plugin/marketplace.json).
  syn plugin marketplace list|remove <name>

Agents and hooks of a plugin are listed but not supported yet (hooks never run).
`;

export class ExtensionCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExtensionCommandError";
  }
}

// ---- user configuration --------------------------------------------------------------------------

async function readUserDocument(file: string): Promise<Document> {
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch {
    text = undefined;
  }
  const document = text === undefined ? new Document({}) : parseDocument(text);
  if (document.errors.length > 0) throw new ExtensionCommandError(`${file} is not valid YAML (${document.errors[0]?.message.split("\n")[0] ?? ""}); fix it with syn config edit`);
  if (!isMap(document.contents)) document.contents = document.createNode({}) as unknown as typeof document.contents;
  return document;
}

/** Adds `key` to (or removes it from) `skills.disabled` / `plugins.disabled`; returns the new settings. */
export async function setExtensionDisabled(home: string, block: "skills" | "plugins", key: string, disabled: boolean): Promise<ExtensionSettings> {
  const file = path.join(home, CONFIG_FILE);
  const document = await readUserDocument(file);
  const current = (document.toJS() as UserConfigFile | null)?.[block]?.disabled;
  const list = new Set<string>(Array.isArray(current) ? current : []);
  if (disabled) list.add(key);
  else list.delete(key);
  if (list.size === 0) {
    if (!document.hasIn([block, "disabled"])) return extensionsConfigOf((document.toJS() as UserConfigFile | null) ?? undefined);
    document.deleteIn([block, "disabled"]);
    const rest = document.getIn([block]);
    if (isMap(rest) && rest.items.length === 0) document.deleteIn([block]);
  } else document.setIn([block, "disabled"], document.createNode([...list].sort()));
  const text = document.toString({ lineWidth: 0 });
  const parsed: UserConfigFile = validateUserConfigText(text, file);
  await mkdir(home, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
  return extensionsConfigOf(parsed);
}

// ---- formatting ----------------------------------------------------------------------------------

const STATE_LABEL: Readonly<Record<ItemStatus["state"], string>> = { active: "on", shadowed: "shadowed", disabled: "off", "needs-trust": "needs trust" };

function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function describeSkills(statuses: readonly ItemStatus[], sep = "·"): string[] {
  if (statuses.length === 0) return ["No skills or commands."];
  const width = Math.min(34, Math.max(...statuses.map((status) => status.item.name.length + (status.item.kind === "command" ? 1 : 0))));
  const lines: string[] = [];
  for (const kind of ["skill", "command"] as const) {
    const rows = statuses.filter((status) => status.item.kind === kind);
    if (rows.length === 0) continue;
    const active = rows.filter((status) => status.state === "active").length;
    lines.push(`${kind === "skill" ? "Skills" : "Commands"} ${sep} ${active} on of ${rows.length}`);
    for (const status of rows) {
      const name = kind === "command" ? `/${status.item.name}` : status.item.name;
      const state = status.state === "shadowed" && status.shadowedBy !== undefined ? `shadowed by ${status.shadowedBy.source}` : STATE_LABEL[status.state];
      lines.push(`  ${name.padEnd(width + 2)}${status.item.source.padEnd(9)}${state.padEnd(20)}${oneLine(status.item.meta.description, 70)}`);
    }
  }
  return lines;
}

export function describeSkill(name: string, statuses: readonly ItemStatus[]): string[] {
  const matches = statuses.filter((status) => status.item.name === name || status.item.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) return [`No skill or command ${name}.`];
  const lines: string[] = [];
  for (const status of matches) {
    const entry = status.item;
    lines.push(`${entry.kind} ${entry.name} ${status.state === "active" ? "(on)" : `(${status.state === "shadowed" ? `shadowed by ${status.shadowedBy?.source ?? "?"}` : STATE_LABEL[status.state]})`}`);
    lines.push(`  source       ${entry.source}${entry.plugin === undefined ? "" : ` (plugin ${entry.plugin})`}`);
    lines.push(`  location     ${entry.location}`);
    lines.push(`  description  ${oneLine(entry.meta.description, 200)}`);
    if (entry.meta.whenToUse !== undefined) lines.push(`  when to use  ${oneLine(entry.meta.whenToUse, 200)}`);
    if (entry.meta.argumentHint !== undefined) lines.push(`  arguments    ${entry.meta.argumentHint}`);
    if (entry.meta.allowedTools.length > 0) lines.push(`  allowed-tools ${entry.meta.allowedTools.join(" ")} (informational: Synorch's permission mode decides)`);
    if (!entry.meta.modelInvocable) lines.push("  model        never loads it on its own (disable-model-invocation)");
    if (!entry.meta.userInvocable) lines.push("  palette      hidden (user-invocable: false)");
    if (entry.claudeNative) lines.push("  Claude Code  loads it itself on Claude routes (not duplicated there)");
    if (status.state === "needs-trust") lines.push("  trust        repository content: /trust (or syn trust) activates it");
  }
  return lines;
}

export function describePlugins(plugins: readonly PluginEntry[], sep = "·"): string[] {
  if (plugins.length === 0) return ["No plugins. Install one: syn plugin install <path|git-url|name@marketplace>"];
  const lines: string[] = [];
  for (const plugin of plugins) {
    const state = plugin.enabled ? "on" : plugin.shadowed ? "shadowed by the Synorch plugin" : plugin.offReason === "claude" ? "disabled in Claude Code" : "off in Synorch";
    lines.push(`${plugin.key}${plugin.contents.version === undefined ? "" : ` ${plugin.contents.version}`} ${sep} ${plugin.origin === "claude" ? "claude" : "synorch"} ${sep} ${state}`);
    if (plugin.contents.description !== "") lines.push(`  ${oneLine(plugin.contents.description, 100)}`);
    for (const line of describeContents(plugin.contents)) lines.push(`  ${line}`);
  }
  return lines;
}

// ---- a runtime-free catalog for the CLI ---------------------------------------------------------

export interface ExtensionCommandIO {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  stdout(text: string): void;
  stderr(text: string): void;
  readonly discovery?: ConfigDiscoveryOptions;
  /** Tests: replaces `git clone`. */
  readonly git?: GitClone;
  /** Tests: Claude's home (default `claudeHome(env)`). */
  readonly claudeHome?: string | null;
  /** Asks yes/no on a terminal; undefined when no human is attached. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

function claudeHomeOf(io: ExtensionCommandIO): string | undefined {
  return io.claudeHome === null ? undefined : (io.claudeHome ?? resolveClaudeHome(io.env));
}

async function standaloneExtensions(io: ExtensionCommandIO, root: string): Promise<Extensions> {
  const config = await loadRuntimeConfig(io.home, root, [], { platform: io.platform, ...(io.discovery ?? {}) });
  const canonical = await loadCanonicalStructure(root);
  const trusted = createWorkspaceTrustStore(io.home, { platform: io.platform }).status(root).trusted;
  return createExtensions({
    home: io.home,
    workspaceRoot: root,
    env: io.env,
    platform: io.platform,
    claudeHome: claudeHomeOf(io),
    settings: config.extensions,
    trusted: () => trusted,
    canonicalCatalog: canonical.skills,
    canonical: { origin: canonical.origin, skills: canonical.skillEntries },
    skipProjectSynorch: isSynorchHome(path.join(root, ".synorch"), io.home, io.platform),
  });
}

function statusJson(status: ItemStatus): Record<string, unknown> {
  const entry = status.item;
  return {
    name: entry.name,
    kind: entry.kind,
    source: entry.source,
    state: status.state,
    ...(status.shadowedBy === undefined ? {} : { shadowed_by: status.shadowedBy.source }),
    description: entry.meta.description,
    location: entry.location,
    ...(entry.plugin === undefined ? {} : { plugin: entry.plugin }),
  };
}

/** `syn skills …`; returns the exit code. */
export async function skillsCommand(args: readonly string[], target: string | undefined, json: boolean, io: ExtensionCommandIO): Promise<number> {
  const root = path.resolve(io.cwd, target ?? ".");
  const [verb = "list", name] = args;
  try {
    switch (verb) {
      case "list": {
        const extensions = await standaloneExtensions(io, root);
        const statuses = extensions.statuses();
        if (json) io.stdout(`${JSON.stringify({ items: statuses.map(statusJson), problems: extensions.problems() }, null, 2)}\n`);
        else io.stdout(`${[...describeSkills(statuses), ...extensions.problems().map((problem) => `warning: ${problem}`)].join("\n")}\n`);
        return 0;
      }
      case "show": {
        if (name === undefined) throw new ExtensionCommandError("syn skills show <name>");
        const extensions = await standaloneExtensions(io, root);
        io.stdout(`${describeSkill(name, extensions.statuses()).join("\n")}\n`);
        return 0;
      }
      case "enable":
      case "disable": {
        if (name === undefined) throw new ExtensionCommandError(`syn skills ${verb} <name>`);
        await setExtensionDisabled(io.home, "skills", name, verb === "disable");
        io.stdout(`${name} is ${verb === "disable" ? "off" : "on"} for Synorch (${path.join(io.home, CONFIG_FILE)}).\n`);
        return 0;
      }
      default:
        throw new ExtensionCommandError(`Unknown skills sub-command: ${verb}. Expected list, show, enable or disable.`);
    }
  } catch (error) {
    if (error instanceof ExtensionCommandError || error instanceof PluginError) {
      io.stderr(`Error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

/** `syn plugin …`; returns the exit code. */
export async function pluginCommand(args: readonly string[], target: string | undefined, json: boolean, io: ExtensionCommandIO): Promise<number> {
  const root = path.resolve(io.cwd, target ?? ".");
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const words = args.filter((arg) => !arg.startsWith("--"));
  const [verb = "list", name, extra] = words;
  const options = { home: io.home, cwd: io.cwd, env: io.env, ...(io.git === undefined ? {} : { git: io.git }), ...(claudeHomeOf(io) === undefined ? {} : { claudeHome: claudeHomeOf(io) as string }) };
  try {
    switch (verb) {
      case "list": {
        const extensions = await standaloneExtensions(io, root);
        const plugins = extensions.state().plugins;
        if (json) io.stdout(`${JSON.stringify(plugins.map((plugin) => ({ key: plugin.key, origin: plugin.origin, enabled: plugin.enabled, version: plugin.contents.version, root: plugin.contents.root, skills: plugin.contents.skills.map((skill) => skill.name), commands: plugin.contents.commands.map((command) => command.name), mcp_servers: Object.keys(plugin.contents.mcpServers), agents: plugin.contents.agents, hooks: plugin.contents.hooks })), null, 2)}\n`);
        else io.stdout(`${describePlugins(plugins).join("\n")}\n`);
        return 0;
      }
      case "install": {
        if (name === undefined) throw new ExtensionCommandError("syn plugin install <path|git-url|name@marketplace>");
        const staged = await stagePlugin(name, options);
        io.stdout(`${previewLines(staged).join("\n")}\n`);
        let proceed = flags.has("--yes");
        if (!proceed && io.confirm !== undefined) proceed = await io.confirm(`Install ${staged.contents.name}?`);
        if (!proceed) {
          await staged.discard();
          io.stdout(io.confirm === undefined ? "Not installed: pass --yes to install without a question.\n" : "Not installed.\n");
          return io.confirm === undefined ? 2 : 0;
        }
        const record = await staged.commit();
        await setExtensionDisabled(io.home, "plugins", record.name, flags.has("--disabled"));
        io.stdout(`Installed ${record.name} in ${record.dir}${flags.has("--disabled") ? " (off: syn plugin enable " + record.name + ")" : ""}.\n`);
        return 0;
      }
      case "remove":
      case "uninstall": {
        if (name === undefined) throw new ExtensionCommandError("syn plugin remove <name>");
        const removed = await removePlugin(io.home, name);
        if (removed === undefined) throw new ExtensionCommandError(`${name} is not a Synorch plugin (syn plugin list); a Claude plugin is turned off with syn plugin disable <name@marketplace>`);
        await setExtensionDisabled(io.home, "plugins", name, false);
        io.stdout(`Removed ${name}.\n`);
        return 0;
      }
      case "enable":
      case "disable": {
        if (name === undefined) throw new ExtensionCommandError(`syn plugin ${verb} <name>`);
        await setExtensionDisabled(io.home, "plugins", name, verb === "disable");
        io.stdout(`${name} is ${verb === "disable" ? "off" : "on"} for Synorch.\n`);
        return 0;
      }
      case "marketplace": {
        const action = name ?? "list";
        if (action === "add") {
          if (extra === undefined) throw new ExtensionCommandError("syn plugin marketplace add <git-url|path>");
          const added = await addMarketplace(extra, options);
          io.stdout(`Added marketplace ${added.marketplace.name} (${added.plugins.length} plugin${added.plugins.length === 1 ? "" : "s"}: ${added.plugins.join(", ") || "none"}).\nInstall one: syn plugin install <name>@${added.marketplace.name}\n`);
          return 0;
        }
        if (action === "remove") {
          if (extra === undefined) throw new ExtensionCommandError("syn plugin marketplace remove <name>");
          if (!(await removeMarketplace(io.home, extra))) throw new ExtensionCommandError(`No marketplace ${extra}.`);
          io.stdout(`Removed marketplace ${extra}.\n`);
          return 0;
        }
        if (action === "list") {
          const store = await readPluginStore(io.home);
          if (store.marketplaces.length === 0) io.stdout("No marketplaces. Add one: syn plugin marketplace add <git-url|path>\n");
          for (const market of store.marketplaces) {
            const plugins = await marketplacePlugins(market.dir);
            io.stdout(`${market.name} · ${market.source}\n${plugins.map((plugin) => `  ${plugin.name}${plugin.description === "" ? "" : ` — ${oneLine(plugin.description, 90)}`}`).join("\n")}\n`);
          }
          return 0;
        }
        throw new ExtensionCommandError(`Unknown marketplace action: ${action}. Expected add, list or remove.`);
      }
      default:
        throw new ExtensionCommandError(`Unknown plugin sub-command: ${verb}. Expected list, install, remove, enable, disable or marketplace.`);
    }
  } catch (error) {
    if (error instanceof ExtensionCommandError || error instanceof PluginError) {
      io.stderr(`Error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function previewLines(staged: StagedPlugin): string[] {
  const contents = staged.contents;
  return [`Plugin ${contents.name}${contents.version === undefined ? "" : ` ${contents.version}`} (${staged.source})`, ...(contents.description === "" ? [] : [`  ${oneLine(contents.description, 100)}`]), ...describeContents(contents).map((line) => `  ${line}`)];
}

// ---- in-session commands -------------------------------------------------------------------------

export interface ExtensionSlashHost {
  readonly extensions: Extensions;
  readonly home: string;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sep: string;
  print(lines: readonly string[]): void;
  /** The K5 choice modal (or its text fallback); undefined answer on Esc. */
  choose(question: ChoiceQuestion): Promise<ChoiceAnswer | undefined>;
  /** After a change: refresh the palette and the MCP servers. */
  changed(): Promise<void>;
}

/** `/skills [list | show <name> | enable <name> | disable <name>]`. */
export async function runSkillsSlash(host: ExtensionSlashHost, argument: string): Promise<void> {
  const [verb = "list", name] = argument.trim().split(/\s+/).filter((word) => word !== "");
  const extensions = host.extensions;
  if (verb === "list") {
    host.print([...describeSkills(extensions.statuses(), host.sep), ...extensions.problems().map((problem) => `warning: ${problem}`), `/<name> [args] runs one ${host.sep} /skills show|enable|disable <name> ${host.sep} /plugins`]);
    return;
  }
  if (name === undefined) {
    host.print([`/skills ${verb} <name>`]);
    return;
  }
  if (verb === "show") {
    host.print(describeSkill(name, extensions.statuses()));
    return;
  }
  if (verb === "enable" || verb === "disable") {
    const known = extensions.statuses().some((status) => status.item.name === name);
    if (!known) {
      host.print([`No skill or command ${name}; /skills lists them.`]);
      return;
    }
    const settings = await setExtensionDisabled(host.home, "skills", name, verb === "disable");
    await extensions.reload(settings);
    await host.changed();
    host.print([`${name} is ${verb === "disable" ? "off" : "on"} (saved in your user config).`]);
    return;
  }
  host.print(["/skills [list | show <name> | enable <name> | disable <name>]"]);
}

/** `/plugins [list | install <spec> | remove <name> | enable <name> | disable <name>]`. */
export async function runPluginsSlash(host: ExtensionSlashHost, argument: string): Promise<void> {
  const [verb = "list", name] = argument.trim().split(/\s+/).filter((word) => word !== "");
  const extensions = host.extensions;
  const options = { home: host.home, cwd: host.workspaceRoot, env: host.env, ...(extensions.claudeHome === undefined ? {} : { claudeHome: extensions.claudeHome }) };
  switch (verb) {
    case "list":
      host.print([...describePlugins(extensions.state().plugins, host.sep), `/plugins install <path|git-url|name@marketplace> ${host.sep} /plugins enable|disable|remove <name>`]);
      return;
    case "install": {
      if (name === undefined) {
        host.print(["/plugins install <path|git-url|name@marketplace>"]);
        return;
      }
      host.print([`Fetching ${name}…`]);
      let staged: StagedPlugin;
      try {
        staged = await stagePlugin(name, options);
      } catch (error) {
        host.print([`Not installed: ${error instanceof Error ? error.message : String(error)}`]);
        return;
      }
      const answer = await host.choose({
        question: `Install plugin ${staged.contents.name}?`,
        header: "Plugin",
        context: previewLines(staged),
        options: [
          { label: "Install and enable", description: "its skills, commands and MCP servers become available", recommended: true },
          { label: "Install, keep it off", description: "/plugins enable turns it on later" },
          { label: "Cancel", description: "nothing is installed" },
        ],
        allowOther: false,
        escapeLabel: "cancel",
        tone: "neutral",
      });
      const index = answer?.kind === "selected" ? answer.indices[0] : undefined;
      if (index !== 0 && index !== 1) {
        await staged.discard();
        host.print(["Not installed."]);
        return;
      }
      const record = await staged.commit();
      const settings = await setExtensionDisabled(host.home, "plugins", record.name, index === 1);
      await extensions.reload(settings);
      await host.changed();
      host.print([`Installed ${record.name}${index === 1 ? " (off)" : ""}.`]);
      return;
    }
    case "remove":
    case "uninstall": {
      if (name === undefined) {
        host.print(["/plugins remove <name>"]);
        return;
      }
      const removed = await removePlugin(host.home, name);
      if (removed === undefined) {
        host.print([`${name} is not a Synorch plugin; a Claude plugin is turned off with /plugins disable <name@marketplace>.`]);
        return;
      }
      const settings = await setExtensionDisabled(host.home, "plugins", name, false);
      await extensions.reload(settings);
      await host.changed();
      host.print([`Removed ${name}.`]);
      return;
    }
    case "enable":
    case "disable": {
      if (name === undefined) {
        host.print([`/plugins ${verb} <name>`]);
        return;
      }
      if (!extensions.state().plugins.some((plugin) => plugin.key === name)) {
        host.print([`No plugin ${name}; /plugins lists them.`]);
        return;
      }
      const settings = await setExtensionDisabled(host.home, "plugins", name, verb === "disable");
      await extensions.reload(settings);
      await host.changed();
      host.print([`${name} is ${verb === "disable" ? "off" : "on"} for Synorch.`]);
      return;
    }
    default:
      host.print(["/plugins [list | install <spec> | remove <name> | enable <name> | disable <name>]"]);
  }
}
