import type { PanelAction, PanelBadge, PanelBlock, PanelItem, PanelPage, PanelView } from "../../contracts/index.ts";
import { documentPage, groupedViews } from "../../contracts/index.ts";
import { runPluginsSlash, type ExtensionSlashHost } from "../extensions-command.ts";
import type { PluginEntry } from "../extensions/index.ts";
import { captured, openFile, outcome, plural } from "./common.ts";
import { skillItem } from "./skills.ts";

/**
 * `/plugins` as a panel: plugins (Synorch and Claude Code) → a plugin's page (manifest, then its
 * skills, commands, MCP servers, agents and hooks as tabs, each drillable) → the item. Install,
 * enable, disable and remove run the `/plugins` sub-commands.
 */

function pluginBadges(plugin: PluginEntry): PanelBadge[] {
  if (plugin.enabled) return [{ label: "on", tone: "success" }];
  if (plugin.shadowed) return [{ label: "shadowed", tone: "muted" }];
  return [{ label: plugin.offReason === "claude" ? "off in Claude" : "off", tone: "muted" }];
}

function stateText(plugin: PluginEntry): string {
  return plugin.enabled ? "on" : plugin.shadowed ? "shadowed by the Synorch plugin of the same name" : plugin.offReason === "claude" ? "disabled in Claude Code" : "off in Synorch";
}

function pluginActions(host: ExtensionSlashHost, plugin: PluginEntry): PanelAction[] {
  const run = async (argument: string, back = false) => outcome(await captured((print) => runPluginsSlash({ ...host, print }, argument)), (line) => host.print([line]), back ? { back: true } : {});
  const actions: PanelAction[] = [plugin.enabled ? { key: "d", label: "disable", run: () => run(`disable ${plugin.key}`) } : { key: "e", label: "enable", run: () => run(`enable ${plugin.key}`) }];
  if (plugin.origin === "synorch") actions.push({ key: "x", label: "remove", confirm: `Remove the plugin ${plugin.key}? Its files are deleted.`, run: () => run(`remove ${plugin.key}`, true) });
  actions.push({ key: "o", label: "open folder", run: async () => ({ message: await openFile(plugin.contents.root, host.env) }) });
  return actions;
}

function installAction(host: ExtensionSlashHost): PanelAction {
  return {
    key: "i",
    label: "install",
    input: { prompt: "Plugin to install (path, git URL or name@marketplace)" },
    run: async (spec) => outcome(await captured((print) => runPluginsSlash({ ...host, print }, `install ${spec ?? ""}`)), (line) => host.print([line])),
  };
}

function rawItem(id: string, label: string, blocks: readonly PanelBlock[], description?: string): PanelItem {
  return { id, label, ...(description === undefined ? {} : { description }), open: () => documentPage(label, blocks) };
}

/** One plugin: manifest, then a tab per kind of content. */
export function pluginPage(host: ExtensionSlashHost, plugin: PluginEntry): PanelPage {
  const contents = plugin.contents;
  const statuses = host.extensions.statuses();
  const statusOf = (name: string, kind: "skill" | "command") => statuses.find((status) => status.item.kind === kind && status.item.name === `${contents.name}:${name}` && status.item.plugin === plugin.key);
  const manifest: PanelBlock[] = [
    {
      kind: "fields",
      rows: [
        { label: "plugin", value: plugin.key },
        { label: "state", value: stateText(plugin), tone: plugin.enabled ? "success" : "muted" },
        { label: "origin", value: plugin.origin === "claude" ? "Claude Code (read in place, never changed)" : "Synorch" },
        ...(contents.version === undefined ? [] : [{ label: "version", value: contents.version }]),
        { label: "from", value: plugin.detail },
        { label: "folder", value: contents.root },
        { label: "description", value: contents.description === "" ? "(none)" : contents.description },
        { label: "contains", value: [plural(contents.skills.length, "skill"), plural(contents.commands.length, "command"), plural(Object.keys(contents.mcpServers).length, "MCP server"), plural(contents.agents.length, "agent"), plural(contents.hooks.length, "hook")].join(", ") },
      ],
    },
  ];
  if (contents.problems.length > 0) manifest.push({ kind: "text", text: contents.problems.map((problem) => `warning: ${problem}`).join("\n"), tone: "warning" });
  const views: PanelView[] = [{ kind: "document", label: "Manifest", blocks: manifest }];
  const skills = contents.skills.map((skill) => {
    const status = statusOf(skill.name, "skill");
    return status === undefined ? rawItem(`skill:${skill.name}`, skill.name, [{ kind: "fields", rows: [{ label: "file", value: skill.file }, { label: "description", value: skill.meta.description }] }], skill.meta.description) : skillItem(host, status);
  });
  const commands = contents.commands.map((command) => {
    const status = statusOf(command.name, "command");
    return status === undefined ? rawItem(`command:${command.name}`, `/${contents.name}:${command.name}`, [{ kind: "fields", rows: [{ label: "file", value: command.file ?? "(inline)" }, { label: "description", value: command.meta.description }] }], command.meta.description) : skillItem(host, status);
  });
  const servers = Object.entries(contents.mcpServers).map(([name, entry]) => rawItem(`mcp:${name}`, name, [{ kind: "fields", rows: [{ label: "server", value: name }, { label: "runs as", value: plugin.enabled ? "a plugin server (/mcp shows its state and tools)" : "nothing: the plugin is off" }] }, { kind: "heading", text: "Definition" }, { kind: "code", text: JSON.stringify(entry, null, 2) ?? "" }]));
  const agents = contents.agents.map((name) => rawItem(`agent:${name}`, name, [{ kind: "fields", rows: [{ label: "agent", value: name }, { label: "support", value: "listed only; Synorch does not run plugin agents yet" }] }]));
  const hooks = contents.hooks.map((name) => rawItem(`hook:${name}`, name, [{ kind: "fields", rows: [{ label: "hook", value: name }, { label: "support", value: "listed only; plugin hooks never run" }] }]));
  if (skills.length > 0) views.push({ kind: "list", label: "Skills", items: skills });
  if (commands.length > 0) views.push({ kind: "list", label: "Commands", items: commands });
  if (servers.length > 0) views.push({ kind: "list", label: "MCP servers", items: servers });
  if (agents.length > 0) views.push({ kind: "list", label: "Agents", items: agents });
  if (hooks.length > 0) views.push({ kind: "list", label: "Hooks", items: hooks });
  return {
    title: plugin.key,
    subtitle: `${plugin.origin} ${host.sep} ${stateText(plugin)}${contents.version === undefined ? "" : ` ${host.sep} ${contents.version}`}`,
    views,
    actions: pluginActions(host, plugin),
    reload: () => {
      const fresh = host.extensions.state().plugins.find((candidate) => candidate.key === plugin.key);
      return fresh === undefined ? documentPage(plugin.key, [{ kind: "text", text: "no longer installed", tone: "muted" }]) : pluginPage(host, fresh);
    },
  };
}

/** The `/plugins` root page. */
export function pluginsPanel(host: ExtensionSlashHost): PanelPage {
  const plugins = host.extensions.state().plugins;
  const item = (plugin: PluginEntry): PanelItem => ({
    id: plugin.key,
    label: plugin.key,
    ...(plugin.contents.version === undefined ? {} : { meta: plugin.contents.version }),
    badges: pluginBadges(plugin),
    description: plugin.contents.description === "" ? `${plural(plugin.contents.skills.length, "skill")}, ${plural(plugin.contents.commands.length, "command")}` : plugin.contents.description,
    open: () => pluginPage(host, plugin),
    actions: pluginActions(host, plugin),
  });
  return {
    title: "Plugins",
    subtitle: `${plural(plugins.length, "plugin")} ${host.sep} ${plugins.filter((plugin) => plugin.enabled).length} on ${host.sep} Claude Code plugin format`,
    views: groupedViews(plugins, item, (plugin) => plugin.origin, [["synorch", "Synorch"], ["claude", "Claude"]], { empty: "No plugins yet: press i to install one (path, git URL or name@marketplace)" }),
    actions: [installAction(host)],
    reload: () => pluginsPanel(host),
  };
}
