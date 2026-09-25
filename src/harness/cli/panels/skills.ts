import { readFile } from "node:fs/promises";
import type { PanelAction, PanelBadge, PanelBlock, PanelField, PanelItem, PanelPage, PanelView } from "../../contracts/index.ts";
import { groupedViews } from "../../contracts/index.ts";
import { runSkillsSlash, type ExtensionSlashHost } from "../extensions-command.ts";
import { parseMarkdown, type ExtensionItem, type ItemStatus } from "../extensions/index.ts";
import { captured, folderItems, openFile, outcome, plural } from "./common.ts";

/**
 * `/skills` as a panel: every skill and markdown command by source (tabs), each drillable to its
 * detail (frontmatter, where it comes from, the whole SKILL.md rendered, the files of its folder).
 * Enable / disable / invoke / open act in place; enable and disable run `/skills enable|disable`.
 */

export const SOURCE_TABS: readonly (readonly [string, string])[] = [
  ["project", "Project"],
  ["user", "User"],
  ["plugin", "Plugins"],
  ["claude", "Claude"],
  ["builtin", "Built-in"],
];

export function stateBadge(status: ItemStatus): PanelBadge {
  switch (status.state) {
    case "active":
      return { label: "on", tone: "success" };
    case "disabled":
      return { label: "off", tone: "muted" };
    case "needs-trust":
      return { label: "needs trust", tone: "warning" };
    case "shadowed":
      return { label: "shadowed", tone: "muted" };
  }
}

function stateText(status: ItemStatus): string {
  if (status.state === "shadowed") return `shadowed by the ${status.shadowedBy?.source ?? "other"} ${status.item.kind} of the same name`;
  return status.state === "active" ? "on" : status.state === "disabled" ? "off (turned off in your user config)" : "needs trust: repository content, /trust activates it";
}

function slashName(entry: ExtensionItem): string {
  return entry.kind === "command" ? `/${entry.name}` : entry.name;
}

function itemId(entry: ExtensionItem): string {
  return `${entry.source}:${entry.kind}:${entry.name}`;
}

/** Actions of one skill or command: enable / disable, invoke, open. */
function skillActions(host: ExtensionSlashHost, status: ItemStatus): PanelAction[] {
  const entry = status.item;
  const toggle = async (verb: "enable" | "disable") => outcome(await captured((print) => runSkillsSlash({ ...host, print }, `${verb} ${entry.name}`)), (line) => host.print([line]));
  const actions: PanelAction[] = [];
  if (status.state === "disabled") actions.push({ key: "e", label: "enable", run: () => toggle("enable") });
  else actions.push({ key: "d", label: "disable", run: () => toggle("disable") });
  if (status.state === "active" && entry.meta.userInvocable) actions.push({ key: "i", label: "invoke", run: () => ({ editorText: `/${entry.name} ` }) });
  const file = entry.file;
  if (file !== undefined) actions.push({ key: "o", label: "open file", run: async () => ({ message: await openFile(file, host.env) }) });
  return actions;
}

/** The skill's own text without its frontmatter. */
async function bodyOf(host: ExtensionSlashHost, entry: ExtensionItem): Promise<string | undefined> {
  let text: string | undefined;
  if (entry.file !== undefined) text = await readFile(entry.file, "utf8").catch(() => undefined);
  else if (entry.content !== undefined) text = entry.content;
  else if (entry.canonical) text = await host.extensions.skills.load(entry.name).catch(() => undefined);
  return text === undefined ? undefined : parseMarkdown(text).body;
}

function fields(status: ItemStatus, all: readonly ItemStatus[]): PanelField[] {
  const entry = status.item;
  const meta = entry.meta;
  const rows: PanelField[] = [
    { label: "kind", value: entry.kind },
    { label: "state", value: stateText(status), tone: status.state === "active" ? "success" : status.state === "needs-trust" ? "warning" : "muted" },
    { label: "source", value: `${entry.source}${entry.plugin === undefined ? "" : ` (plugin ${entry.plugin})`}` },
    { label: "path", value: entry.location },
    { label: "description", value: meta.description === "" ? "(none)" : meta.description },
  ];
  if (meta.whenToUse !== undefined) rows.push({ label: "when to use", value: meta.whenToUse });
  if (meta.argumentHint !== undefined) rows.push({ label: "arguments", value: meta.argumentHint });
  if (meta.allowedTools.length > 0) rows.push({ label: "allowed tools", value: `${meta.allowedTools.join(" ")} (informational: your permission mode decides)` });
  rows.push({ label: "model", value: meta.modelInvocable ? "loads it on its own when the task matches" : "only when you invoke it (disable-model-invocation)" });
  rows.push({ label: "palette", value: meta.userInvocable ? `/${entry.name}` : "hidden (user-invocable: false)" });
  if (entry.claudeNative) rows.push({ label: "Claude Code", value: "loads it itself on Claude routes (not duplicated there)" });
  const others = all.filter((other) => itemId(other.item) !== itemId(entry) && other.item.name.toLowerCase() === entry.name.toLowerCase());
  if (others.length > 0) rows.push({ label: "same name", value: others.map((other) => `${other.item.source} (${other.state})`).join(", ") });
  return rows;
}

/** One skill or command in detail: overview with the rendered body, then its folder's files. */
export async function skillPage(host: ExtensionSlashHost, status: ItemStatus): Promise<PanelPage> {
  const entry = status.item;
  const all = host.extensions.statuses();
  const body = await bodyOf(host, entry);
  const blocks: PanelBlock[] = [{ kind: "fields", rows: fields(status, all) }, { kind: "heading", text: entry.kind === "skill" ? "SKILL.md" : "Command" }, body === undefined ? { kind: "text", text: "cannot be read", tone: "warning" } : { kind: "markdown", text: body.trim() === "" ? "_(empty)_" : body }];
  const views: PanelView[] = [{ kind: "document", label: "Overview", blocks }];
  if (entry.dir !== undefined) {
    const items = await folderItems(entry.dir, host.env);
    views.push({ kind: "list", label: "Files", items, empty: "no files" });
  }
  const id = itemId(entry);
  return {
    title: slashName(entry),
    crumb: entry.name,
    subtitle: `${entry.kind} · ${entry.source} · ${stateBadge(status).label}`,
    views,
    actions: skillActions(host, status),
    reload: async () => {
      const fresh = host.extensions.statuses().find((candidate) => itemId(candidate.item) === id);
      return fresh === undefined ? { title: slashName(entry), crumb: entry.name, views: [{ kind: "document", label: "Overview", blocks: [{ kind: "text", text: "no longer installed", tone: "muted" }] }] } : skillPage(host, fresh);
    },
  };
}

export function skillItem(host: ExtensionSlashHost, status: ItemStatus): PanelItem {
  const entry = status.item;
  return {
    id: itemId(entry),
    label: slashName(entry),
    meta: entry.kind === "command" ? `${entry.source} cmd` : entry.source,
    badges: [stateBadge(status)],
    description: entry.meta.description,
    search: `${entry.meta.whenToUse ?? ""} ${entry.plugin ?? ""}`,
    open: () => skillPage(host, status),
    actions: skillActions(host, status),
  };
}

/** The `/skills` root page. */
export function skillsPanel(host: ExtensionSlashHost): PanelPage {
  const statuses = host.extensions.statuses();
  const problems = host.extensions.problems();
  const on = statuses.filter((status) => status.state === "active").length;
  const skills = statuses.filter((status) => status.item.kind === "skill").length;
  const views: PanelView[] = groupedViews(statuses, (status) => skillItem(host, status), (status) => status.item.source, SOURCE_TABS, { empty: "No skills or commands yet: add one under ~/.synorch/skills/<name>/SKILL.md" });
  if (problems.length > 0) views.push({ kind: "document", label: `Problems ${problems.length}`, blocks: [{ kind: "text", text: problems.join("\n"), tone: "warning" }] });
  return {
    title: "Skills",
    subtitle: `${plural(skills, "skill")} ${host.sep} ${plural(statuses.length - skills, "command")} ${host.sep} ${on} on ${host.sep} /<name> runs one`,
    views,
    reload: () => skillsPanel(host),
  };
}
