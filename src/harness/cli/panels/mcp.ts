import { open } from "node:fs/promises";
import type { PanelAction, PanelBadge, PanelBlock, PanelItem, PanelPage, PanelView } from "../../contracts/index.ts";
import { documentPage, groupedViews } from "../../contracts/index.ts";
import type { McpServerStatus } from "../../mcp/index.ts";
import { runMcpSlash, type McpSlashHost } from "../mcp-command.ts";
import { captured, openFile, outcome, plural } from "./common.ts";

/**
 * `/mcp` as a panel: servers (by where they are declared) → a server's page (state, transport,
 * trust, the log tail, its tools) → a tool (description and input schema). Reconnect, enable,
 * disable, sign in / out and approve run the `/mcp` sub-commands.
 */

export interface McpPanelHost extends McpSlashHost {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function mcpBadge(state: McpServerStatus["state"]): PanelBadge {
  switch (state) {
    case "connected":
      return { label: "connected", tone: "success" };
    case "idle":
      return { label: "ready", tone: "muted" };
    case "starting":
      return { label: "starting", tone: "accent" };
    case "failed":
      return { label: "failed", tone: "error" };
    case "disabled":
      return { label: "off", tone: "muted" };
    case "needs-approval":
      return { label: "needs trust", tone: "warning" };
    case "needs-auth":
      return { label: "needs sign-in", tone: "warning" };
  }
}

const LOG_TAIL_BYTES = 8 * 1024;

async function logTail(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (size > length) lines.shift();
    return lines.slice(-40).join("\n").trimEnd();
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function serverActions(host: McpPanelHost, entry: McpServerStatus): PanelAction[] {
  const run = async (verb: string) => outcome(await captured((print) => runMcpSlash({ ...host, print }, `${verb} ${entry.name}`)), (line) => host.print([line]));
  const actions: PanelAction[] = [];
  if (entry.state === "needs-approval") actions.push({ key: "a", label: "approve", confirm: `Run the repository's MCP server ${entry.name} here?`, run: () => run("approve") });
  if (entry.state === "needs-auth") actions.push({ key: "l", label: "sign in", run: () => run("login") });
  if (entry.state !== "disabled" && entry.state !== "needs-approval") actions.push({ key: "r", label: "reconnect", run: () => run("reconnect") });
  actions.push(entry.state === "disabled" ? { key: "e", label: "enable", run: () => run("enable") } : { key: "d", label: "disable", run: () => run("disable") });
  if (entry.transport !== "stdio") actions.push({ key: "x", label: "sign out", run: () => run("logout") });
  actions.push({ key: "o", label: "open log", run: async () => ({ message: await openFile(entry.logFile, host.env) }) });
  return actions;
}

function toolPage(server: string, tool: { readonly name: string; readonly description: string | undefined; readonly inputSchema: Record<string, unknown>; readonly annotations: Readonly<Record<string, unknown>> | undefined }): PanelPage {
  const blocks: PanelBlock[] = [
    { kind: "fields", rows: [{ label: "tool", value: tool.name }, { label: "server", value: server }, { label: "model sees", value: `mcp__${server}__${tool.name}` }] },
    { kind: "markdown", text: tool.description === undefined || tool.description.trim() === "" ? "_no description_" : tool.description },
    { kind: "heading", text: "Input schema" },
    { kind: "code", text: JSON.stringify(tool.inputSchema, null, 2) ?? "{}" },
  ];
  if (tool.annotations !== undefined && Object.keys(tool.annotations).length > 0) blocks.push({ kind: "heading", text: "Annotations" }, { kind: "code", text: JSON.stringify(tool.annotations, null, 2) ?? "" });
  return documentPage(tool.name, blocks);
}

/** One server: overview with the log tail, then its tools. */
export async function mcpServerPage(host: McpPanelHost, entry: McpServerStatus): Promise<PanelPage> {
  const rows = [
    { label: "state", value: mcpBadge(entry.state).label, tone: mcpBadge(entry.state).tone },
    { label: "declared", value: `${entry.source} (${entry.file})` },
    { label: "runs", value: `${entry.transport} ${entry.target}` },
    { label: "trust", value: entry.trust === "read-only" ? "read-only: tools only read, they never prompt" : "full: tools may change things (ask mode prompts)" },
    { label: "startup", value: entry.startup === "session" ? "with every session" : "lazy: at first use" },
    ...(entry.error === undefined ? [] : [{ label: "problem", value: entry.error, tone: "error" as const }]),
    ...(entry.detail === undefined || entry.detail === entry.error ? [] : [{ label: "details", value: entry.detail.slice(0, 2000) }]),
    ...(entry.missingVariables.length === 0 ? [] : [{ label: "unset", value: entry.missingVariables.join(", "), tone: "warning" as const }]),
    { label: "log", value: entry.logFile },
  ];
  const tail = await logTail(entry.logFile);
  const blocks: PanelBlock[] = [{ kind: "fields", rows }, { kind: "heading", text: "Log (latest lines)" }, tail === undefined || tail === "" ? { kind: "text", text: "no log yet", tone: "muted" } : { kind: "code", text: tail }];
  const infos = host.manager.serverTools(entry.name);
  const tools: PanelItem[] =
    infos.length > 0
      ? infos.map((tool) => ({ id: tool.name, label: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), open: () => toolPage(entry.name, tool) }))
      : entry.tools.map((name) => ({ id: name, label: name, description: "connect the server to see its description and schema", open: () => documentPage(name, [{ kind: "text", text: `${name}: the server is not connected; press r to reconnect for its description and schema.`, tone: "muted" }]) }));
  const views: PanelView[] = [
    { kind: "document", label: "Overview", blocks },
    { kind: "list", label: "Tools", items: tools, empty: entry.state === "connected" ? "the server lists no tools" : "no tools known yet: the server starts at first use (r reconnects now)" },
  ];
  return {
    title: entry.name,
    subtitle: `${entry.transport} ${host.sep} ${entry.source} ${host.sep} ${plural(entry.tools.length, "tool")}`,
    views,
    actions: serverActions(host, entry),
    reload: async () => {
      const fresh = host.manager.status().find((candidate) => candidate.name === entry.name);
      return fresh === undefined ? documentPage(entry.name, [{ kind: "text", text: "no longer configured", tone: "muted" }]) : mcpServerPage(host, fresh);
    },
  };
}

export function mcpServerItem(host: McpPanelHost, entry: McpServerStatus): PanelItem {
  return {
    id: entry.name,
    label: entry.name,
    meta: entry.transport,
    badges: [mcpBadge(entry.state)],
    description: entry.state === "failed" && entry.error !== undefined ? entry.error : `${entry.tools.length > 0 ? `${plural(entry.tools.length, "tool")} ${host.sep} ` : ""}${entry.target}`,
    search: entry.source,
    open: () => mcpServerPage(host, entry),
    actions: serverActions(host, entry),
  };
}

/** The `/mcp` root page. */
export function mcpPanel(host: McpPanelHost): PanelPage {
  const status = host.manager.status();
  const problems = host.manager.problems;
  const views: PanelView[] = groupedViews(status, (entry) => mcpServerItem(host, entry), (entry) => (entry.source === "mcp.json" ? "project" : entry.source === "claude-plugin" ? "plugin" : entry.source), [["user", "User"], ["project", "Project"], ["plugin", "Plugins"]], { empty: "No MCP servers configured. Add one: syn mcp add playwright -- npx @playwright/mcp@latest" });
  if (problems.length > 0) views.push({ kind: "document", label: `Problems ${problems.length}`, blocks: [{ kind: "text", text: problems.map((problem) => `${problem.file}: ${problem.message}`).join("\n"), tone: "warning" }] });
  const connected = status.filter((entry) => entry.state === "connected").length;
  return {
    title: "MCP servers",
    crumb: "MCP",
    subtitle: `${plural(status.length, "server")} ${host.sep} ${connected} connected ${host.sep} tools reach the model as mcp__<server>__<tool>`,
    views,
    reload: () => mcpPanel(host),
  };
}
