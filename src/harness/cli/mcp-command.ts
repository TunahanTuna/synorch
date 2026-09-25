import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, isMap, parseDocument } from "yaml";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import { createToolRegistry } from "../tools/index.ts";
import { createCredentialStore } from "../auth/index.ts";
import {
  createMcpOAuthStore,
  MCP_SERVER_NAME_PATTERN,
  McpManager,
  mcpConfigSchema,
  mcpServerEntrySchema,
  type McpServerEntry,
  type McpServerStatus,
} from "../mcp/index.ts";
import { workspaceIdentity } from "../policy/index.ts";
import { openBrowser } from "../tui/open-browser.ts";
import { CONFIG_FILE, loadRuntimeConfig, validateUserConfigText, type ConfigDiscoveryOptions } from "./config.ts";
import { standaloneExtensions } from "./extensions-command.ts";
import { isProjectFolder } from "./project-scope.ts";

/**
 * K3 `syn mcp` and `/mcp`: list the configured MCP servers with their state and tools, add or
 * remove one (user configuration by default, `--scope project` for the repository's
 * `.synorch/config.yaml`), approve or revoke a project server, enable or disable a server, and test
 * that one starts and lists its tools. Playwright in one line:
 *
 *   syn mcp add playwright -- npx @playwright/mcp@latest
 */

export const MCP_SUBCOMMANDS = ["list", "add", "remove", "approve", "revoke", "enable", "disable", "test", "tools", "reconnect", "login", "logout"] as const;

export const MCP_HELP = `syn mcp — external MCP servers (tools for every provider, under Synorch's policy)

Usage:
  syn mcp [list] [--json]              Servers, where each is declared, state and trust.
  syn mcp add <name> [options] -- <command> [args...]
                                       Add a stdio server, e.g.
                                       syn mcp add playwright -- npx @playwright/mcp@latest
  syn mcp add <name> <url> [options]   Add a streamable HTTP server (--transport sse for SSE).
  syn mcp remove <name> [--scope user|project]
  syn mcp approve <name>               Allow a project server (.synorch/config.yaml or .mcp.json)
                                       to run in this workspace; bound to its exact definition.
  syn mcp revoke <name>                Withdraw that approval.
  syn mcp enable|disable <name>        Turn a user server on or off (saved).
  syn mcp test <name>                  Start the server once and list its tools.
  syn mcp login <name>                 Sign in to a remote server that asks for it (OAuth in the
                                       browser; tokens go to Synorch's credential store).
  syn mcp logout <name>                Forget that sign-in.

Add options:
  --scope user|project                 user (default): <synorch home>/config.yaml;
                                       project: <workspace>/.synorch/config.yaml (approved for you).
  --env KEY=VALUE                      Environment for a stdio server (repeatable; \${VAR} expands).
  --header "Name: value"               HTTP header (repeatable; \${VAR} expands).
  --transport stdio|http|sse           Normally inferred (a URL means http).
  --trust full|read-only               full (default): tools may change things; ask mode prompts,
                                       auto/full run them, plan refuses. read-only: tools only
                                       read; they never prompt and reviewers may use them.
  --startup lazy|session               lazy (default): start at first use once the tool list is
                                       known; session: start with every session.

In a session, /mcp lists servers and tools; /mcp <name> shows one in detail;
/mcp reconnect|enable|disable|approve|login|logout <name>. A remote server can also take an
API key as a header instead of signing in (--header "Authorization: Bearer \${KEY}").
Tools reach the model as mcp__<server>__<tool>; results are untrusted data. Server stderr is
logged under <synorch home>/logs/mcp/. Claude Code routes (native mode) run the servers
themselves through --mcp-config.
`;

export class McpCommandError extends Error {}

export interface McpCommandIO {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly discovery?: ConfigDiscoveryOptions;
  /** Tests: Claude's home for plugin servers (null reads none). */
  readonly claudeHome?: string | null;
  readonly signal?: AbortSignal;
}

interface AddRequest {
  readonly name: string;
  readonly scope: "user" | "project";
  readonly entry: McpServerEntry;
}

/** Parses `syn mcp add <name> [options] [-- command args | url]`. */
export function parseAddArguments(args: readonly string[]): AddRequest {
  const terminator = args.indexOf("--");
  const head = terminator === -1 ? [...args] : args.slice(0, terminator);
  const command = terminator === -1 ? [] : args.slice(terminator + 1);
  const positionals: string[] = [];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let scope: "user" | "project" = "user";
  let transport: string | undefined;
  let trust: string | undefined;
  let startup: string | undefined;
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index] ?? "";
    const value = (): string => {
      const next = head[index + 1];
      if (next === undefined) throw new McpCommandError(`${token} needs a value`);
      index += 1;
      return next;
    };
    if (token === "--scope" || token === "-s") {
      const chosen = value();
      if (chosen !== "user" && chosen !== "project") throw new McpCommandError(`--scope is user or project, not ${chosen}`);
      scope = chosen;
    } else if (token === "--env" || token === "-e") {
      const pair = value();
      const separator = pair.indexOf("=");
      if (separator <= 0) throw new McpCommandError(`--env expects KEY=VALUE, not ${pair}`);
      env[pair.slice(0, separator)] = pair.slice(separator + 1);
    } else if (token === "--header" || token === "-H") {
      const pair = value();
      const separator = pair.indexOf(":");
      if (separator <= 0) throw new McpCommandError(`--header expects "Name: value", not ${pair}`);
      headers[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    } else if (token === "--transport") transport = value();
    else if (token === "--trust") trust = value();
    else if (token === "--startup") startup = value();
    else if (token.startsWith("-")) throw new McpCommandError(`unknown option ${token} (syn mcp --help)`);
    else positionals.push(token);
  }
  const [name, url, ...extra] = positionals;
  if (name === undefined) throw new McpCommandError("syn mcp add needs a server name, e.g. syn mcp add playwright -- npx @playwright/mcp@latest");
  if (!MCP_SERVER_NAME_PATTERN.test(name)) throw new McpCommandError(`server names are 1-32 letters, digits, - or _ and start with a letter: ${name}`);
  if (extra.length > 0) throw new McpCommandError(`unexpected arguments: ${extra.join(" ")} (put the server command after --)`);
  if (url !== undefined && command.length > 0) throw new McpCommandError("give either a URL or a command after --, not both");
  if (url === undefined && command.length === 0) throw new McpCommandError("give the server command after -- (stdio) or a URL (http)");
  const raw: Record<string, unknown> = url === undefined ? { command: command[0], ...(command.length > 1 ? { args: command.slice(1) } : {}) } : { url, ...(transport === "sse" ? { type: "sse" } : {}) };
  if (transport === "stdio" && url !== undefined) throw new McpCommandError("--transport stdio needs a command after --");
  if (Object.keys(env).length > 0) raw.env = env;
  if (Object.keys(headers).length > 0) raw.headers = headers;
  if (trust !== undefined) raw.trust = trust;
  if (startup !== undefined) raw.startup = startup;
  const parsed = mcpServerEntrySchema.safeParse(raw);
  if (!parsed.success) throw new McpCommandError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "server"}: ${issue.message}`).join("; "));
  return { name, scope, entry: parsed.data };
}

function projectConfigPath(root: string): string {
  return path.join(root, ".synorch", CONFIG_FILE);
}

async function readDocument(file: string): Promise<Document> {
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch {
    text = undefined;
  }
  const document = text === undefined ? new Document({}) : parseDocument(text);
  if (document.errors.length > 0) throw new McpCommandError(`${file} is not valid YAML (${document.errors[0]?.message.split("\n")[0] ?? ""})`);
  if (!isMap(document.contents)) document.contents = document.createNode({}) as unknown as typeof document.contents;
  return document;
}

async function writeDocument(file: string, document: Document, scope: "user" | "project"): Promise<void> {
  const text = document.toString({ lineWidth: 0 });
  if (scope === "user") validateUserConfigText(text, file);
  else {
    const mcp = (document.toJS() as Record<string, unknown> | null)?.mcp;
    const parsed = mcpConfigSchema.safeParse(mcp ?? {});
    if (!parsed.success) throw new McpCommandError(`${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
}

/** Adds (or replaces) a server in the chosen scope's config file; returns the file written. */
export async function addMcpServer(home: string, root: string, request: AddRequest): Promise<string> {
  const file = request.scope === "user" ? path.join(home, CONFIG_FILE) : projectConfigPath(root);
  const document = await readDocument(file);
  document.setIn(["mcp", "servers", request.name], document.createNode(request.entry));
  await writeDocument(file, document, request.scope);
  return file;
}

export async function removeMcpServer(home: string, root: string, name: string, scope: "user" | "project"): Promise<string | undefined> {
  const file = scope === "user" ? path.join(home, CONFIG_FILE) : projectConfigPath(root);
  const document = await readDocument(file);
  if (!document.hasIn(["mcp", "servers", name])) return undefined;
  document.deleteIn(["mcp", "servers", name]);
  await writeDocument(file, document, scope);
  return file;
}

/** Persists `enabled` for a user server; undefined when the user configuration has no such server. */
export async function setUserMcpEnabled(home: string, name: string, enabled: boolean): Promise<string | undefined> {
  const file = path.join(home, CONFIG_FILE);
  const document = await readDocument(file);
  if (!document.hasIn(["mcp", "servers", name])) return undefined;
  if (enabled) document.deleteIn(["mcp", "servers", name, "enabled"]);
  else document.setIn(["mcp", "servers", name, "enabled"], false);
  await writeDocument(file, document, "user");
  return file;
}

const STATE_LABEL: Readonly<Record<McpServerStatus["state"], string>> = {
  connected: "connected",
  idle: "ready (starts at first use)",
  starting: "starting",
  failed: "failed",
  disabled: "disabled",
  "needs-approval": "needs approval",
  "needs-auth": "needs sign-in",
};

/** Lines describing each server (shared by `syn mcp list` and `/mcp`). */
export function describeServers(status: readonly McpServerStatus[], options: { readonly tools?: boolean; readonly sep?: string; readonly slash?: boolean } = {}): string[] {
  const sep = options.sep ?? "·";
  if (status.length === 0) return ["No MCP servers configured. Add one: syn mcp add playwright -- npx @playwright/mcp@latest"];
  const lines: string[] = [];
  for (const entry of status) {
    const tools = entry.tools.length === 0 ? "" : ` ${sep} ${entry.tools.length} tool${entry.tools.length === 1 ? "" : "s"}`;
    lines.push(`${entry.name} ${sep} ${STATE_LABEL[entry.state]}${tools} ${sep} ${entry.transport} ${entry.target} ${sep} ${entry.source}${entry.trust === "read-only" ? ` ${sep} read-only` : ""}`);
    if (entry.error !== undefined && entry.state === "failed") lines.push(`  ${entry.error} ${sep} details: ${options.slash === true ? `/mcp ${entry.name}` : entry.logFile}`);
    if (entry.state === "needs-auth") lines.push(`  sign in with: ${options.slash === true ? "/mcp" : "syn mcp"} login ${entry.name} (or configure an API key header)`);
    if (entry.state === "needs-approval") lines.push(`  declared by the repository (${entry.file}); run it here with: ${options.tools === true ? "/mcp" : "syn mcp"} approve ${entry.name}`);
    if (entry.missingVariables.length > 0) lines.push(`  unset variables: ${entry.missingVariables.join(", ")}`);
    if (options.tools === true && entry.tools.length > 0) lines.push(`  ${entry.tools.join(", ")}`);
  }
  return lines;
}

/** `/mcp <name>`: one server in detail, the raw failure included (never on the first screen). */
export function describeServer(entry: McpServerStatus | undefined, sep: string): string[] {
  if (entry === undefined) return ["No such MCP server; /mcp lists them."];
  const lines = [
    `${entry.name} ${sep} ${STATE_LABEL[entry.state]}`,
    `  where     ${entry.source} (${entry.file})`,
    `  runs      ${entry.transport} ${entry.target}`,
    `  trust     ${entry.trust} ${sep} startup ${entry.startup}`,
    `  tools     ${entry.tools.length === 0 ? "none registered yet" : entry.tools.join(", ")}`,
  ];
  if (entry.error !== undefined) lines.push(`  problem   ${entry.error}`);
  if (entry.detail !== undefined && entry.detail !== entry.error) lines.push(`  details   ${entry.detail.replace(/\s+/g, " ").slice(0, 600)}`);
  if (entry.missingVariables.length > 0) lines.push(`  unset     ${entry.missingVariables.join(", ")}`);
  lines.push(`  log       ${entry.logFile}`);
  if (entry.state === "needs-auth") lines.push(`  next      /mcp login ${entry.name} (or an API key header: syn mcp add ${entry.name} <url> --header "Authorization: Bearer \${KEY}")`);
  else if (entry.state === "failed") lines.push(`  next      /mcp reconnect ${entry.name}`);
  else if (entry.state === "needs-approval") lines.push(`  next      /mcp approve ${entry.name}`);
  return lines;
}

async function managerFor(io: McpCommandIO, root: string, withPlugins = false): Promise<McpManager> {
  const config = await loadRuntimeConfig(io.home, root, [], { platform: io.platform, ...(io.discovery ?? {}) });
  const extensions = withPlugins ? await standaloneExtensions({ ...io, ...(io.claudeHome === undefined ? {} : { claudeHome: io.claudeHome }) }, root).catch(() => undefined) : undefined;
  const manager = new McpManager({
    home: io.home,
    workspaceRoot: root,
    workspaceKey: workspaceIdentity(root, io.platform).root,
    environment: io.env,
    registry: createToolRegistry({ builtins: false }),
    clientVersion: SYNORCH_VERSION,
    user: { config: config.mcp.user, file: config.mcp.userFile },
    project: { config: config.mcp.project, file: config.mcp.projectFile },
    platform: io.platform,
    oauth: createMcpOAuthStore(() => createCredentialStore(io.home, { env: io.env })),
    projectScope: isProjectFolder(root, io.env.HOME ?? io.env.USERPROFILE ?? os.homedir(), io.platform),
    ...(extensions === undefined ? {} : { plugins: () => extensions.mcpServers() }),
  });
  await manager.load();
  return manager;
}

/** `syn mcp …`; returns the exit code. */
export async function mcpCommand(args: readonly string[], target: string | undefined, json: boolean, io: McpCommandIO): Promise<number> {
  const root = path.resolve(io.cwd, target ?? ".");
  const [subcommand = "list", ...rest] = args;
  try {
    switch (subcommand) {
      case "list": {
        const manager = await managerFor(io, root);
        const status = manager.status();
        if (json) io.stdout(`${JSON.stringify({ servers: status, problems: manager.problems }, null, 2)}\n`);
        else {
          io.stdout(`${describeServers(status).join("\n")}\n`);
          for (const problem of manager.problems) io.stderr(`warning: ${problem.file}: ${problem.message}\n`);
        }
        return 0;
      }
      case "add": {
        const request = parseAddArguments(rest);
        const file = await addMcpServer(io.home, root, request);
        io.stdout(`Added MCP server ${request.name} to ${file}\n`);
        if (request.scope === "project") {
          const manager = await managerFor(io, root);
          await manager.approve(request.name, false);
          io.stdout(`Approved ${request.name} for this workspace (you added it).\n`);
        }
        io.stdout(`Its tools appear in the next session as mcp__${request.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}__<tool>. Check it now: syn mcp test ${request.name}\n`);
        return 0;
      }
      case "remove": {
        const name = rest.find((token) => !token.startsWith("-"));
        const scopeIndex = rest.indexOf("--scope");
        const scope = scopeIndex === -1 ? undefined : rest[scopeIndex + 1];
        if (name === undefined) throw new McpCommandError("syn mcp remove needs a server name");
        if (scope !== undefined && scope !== "user" && scope !== "project") throw new McpCommandError(`--scope is user or project, not ${scope}`);
        const scopes: ("user" | "project")[] = scope === undefined ? ["user", "project"] : [scope];
        for (const candidate of scopes) {
          const file = await removeMcpServer(io.home, root, name, candidate);
          if (file !== undefined) {
            io.stdout(`Removed MCP server ${name} from ${file}\n`);
            return 0;
          }
        }
        io.stderr(`No MCP server ${name} in the ${scopes.join(" or ")} configuration${scope === undefined ? " (a .mcp.json entry is edited in that file)" : ""}.\n`);
        return 1;
      }
      case "approve":
      case "revoke": {
        const name = rest[0];
        if (name === undefined) throw new McpCommandError(`syn mcp ${subcommand} needs a server name`);
        const manager = await managerFor(io, root);
        const definition = manager.definitions().find((entry) => entry.name === name);
        if (definition === undefined) throw new McpCommandError(`no MCP server named ${name}`);
        if (definition.source === "user") {
          io.stdout(`${name} is in your user configuration; it needs no approval.\n`);
          return 0;
        }
        if (subcommand === "approve") {
          await manager.approve(name, false);
          io.stdout(`Approved ${name} (${definition.transport} ${definition.command ?? definition.url ?? ""}) for ${root}. A changed definition needs a new approval.\n`);
        } else {
          const removed = await manager.revoke(name);
          io.stdout(removed ? `Revoked the approval of ${name}.\n` : `${name} was not approved.\n`);
        }
        return 0;
      }
      case "login":
      case "logout": {
        const name = rest[0];
        if (name === undefined) throw new McpCommandError(`syn mcp ${subcommand} needs a server name`);
        const manager = await managerFor(io, root, true);
        try {
          if (!manager.has(name)) throw new McpCommandError(`no MCP server named ${name}`);
          if (subcommand === "logout") {
            io.stdout((await manager.logout(name)) ? `Signed out of ${name}.\n` : `${name} had no stored sign-in.\n`);
            return 0;
          }
          const status = await manager.login(name, {
            openBrowser: (url) => openBrowser(url, { platform: io.platform, env: io.env }),
            notify: (line) => io.stdout(`${line}\n`),
            signal: io.signal ?? new AbortController().signal,
          });
          io.stdout(status?.state === "connected" ? `Signed in to ${name}; ${status.tools.length} tool(s).\n` : `Signed in to ${name}${status?.error === undefined ? "" : `, but it did not start: ${status.error}`}.\n`);
          return status?.state === "connected" ? 0 : 4;
        } catch (error: unknown) {
          if (error instanceof McpCommandError) throw error;
          io.stderr(`Sign-in to ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
          return 4;
        } finally {
          await manager.close();
        }
      }
      case "enable":
      case "disable": {
        const name = rest[0];
        if (name === undefined) throw new McpCommandError(`syn mcp ${subcommand} needs a server name`);
        const file = await setUserMcpEnabled(io.home, name, subcommand === "enable");
        if (file === undefined) {
          io.stderr(`No MCP server ${name} in your user configuration. Project servers are turned off with syn mcp revoke ${name}.\n`);
          return 1;
        }
        io.stdout(`${subcommand === "enable" ? "Enabled" : "Disabled"} ${name} (${file}).\n`);
        return 0;
      }
      case "test":
      case "tools": {
        const name = rest[0];
        if (name === undefined) throw new McpCommandError(`syn mcp ${subcommand} needs a server name`);
        const manager = await managerFor(io, root, true);
        try {
          if (!manager.has(name)) throw new McpCommandError(`no MCP server named ${name}`);
          const connection = await manager.connection(name);
          io.stdout(`${name}: connected${connection.serverVersion === undefined ? "" : ` (server ${connection.serverVersion})`}; ${connection.tools.length} tool(s)\n`);
          for (const tool of connection.tools) io.stdout(`  ${tool.name}${tool.description === undefined ? "" : ` — ${tool.description.split("\n")[0]?.slice(0, 100) ?? ""}`}\n`);
          return 0;
        } catch (error: unknown) {
          io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
          return 4;
        } finally {
          await manager.close();
        }
      }
      default:
        throw new McpCommandError(`unknown sub-command ${subcommand}; expected ${MCP_SUBCOMMANDS.join(", ")}`);
    }
  } catch (error: unknown) {
    if (!(error instanceof McpCommandError)) throw error;
    io.stderr(`Error: ${error.message}\nRun \`syn mcp --help\` for usage.\n`);
    return 2;
  }
}

export interface McpSlashHost {
  readonly manager: McpManager;
  readonly home: string;
  readonly sep: string;
  print(lines: readonly string[]): void;
  /** Opens the system browser for `/mcp login`. */
  openBrowser?(url: string): Promise<boolean>;
  readonly signal?: AbortSignal;
}

/** `/mcp [list | <name> | tools [name] | reconnect | enable | disable | approve | revoke | login | logout <name>]`. */
export async function runMcpSlash(host: McpSlashHost, argument: string): Promise<void> {
  const [verb = "list", name] = argument.trim().split(/\s+/).filter((word) => word !== "");
  const manager = host.manager;
  const need = (): string | undefined => {
    if (name === undefined || !manager.has(name)) {
      host.print([name === undefined ? `/mcp ${verb} <name>` : `No MCP server ${name}; /mcp lists them.`]);
      return undefined;
    }
    return name;
  };
  switch (verb) {
    case "list":
    case "status":
      host.print([...describeServers(manager.status(), { sep: host.sep, slash: true }).map((line) => line.replace(/details: \S+$/, "details: /mcp <name>")), ...manager.problems.map((problem) => `warning: ${problem.file}: ${problem.message}`), `/mcp <name> details ${host.sep} /mcp tools [name] ${host.sep} /mcp reconnect|enable|disable|approve|login|logout <name>`]);
      return;
    case "tools": {
      const status = manager.status().filter((entry) => name === undefined || entry.name === name);
      host.print(describeServers(status, { tools: true, sep: host.sep }));
      return;
    }
    case "reconnect": {
      const target = need();
      if (target === undefined) return;
      host.print([`Reconnecting ${target}…`]);
      const status = await manager.reconnect(target);
      host.print(describeServers(status === undefined ? [] : [status], { sep: host.sep }));
      return;
    }
    case "enable":
    case "disable": {
      const target = need();
      if (target === undefined) return;
      await manager.setEnabled(target, verb === "enable");
      const saved = await setUserMcpEnabled(host.home, target, verb === "enable").catch(() => undefined);
      host.print([`${verb === "enable" ? "Enabled" : "Disabled"} ${target}${saved === undefined ? " for this session" : " (saved)"}.`]);
      return;
    }
    case "approve": {
      const target = need();
      if (target === undefined) return;
      const approved = await manager.approve(target);
      host.print(approved ? describeServers(manager.status().filter((entry) => entry.name === target), { sep: host.sep }) : [`${target} is a user server; it needs no approval.`]);
      return;
    }
    case "login": {
      const target = need();
      if (target === undefined) return;
      try {
        const status = await manager.login(target, {
          openBrowser: host.openBrowser ?? (async () => false),
          notify: (line) => host.print([line]),
          signal: host.signal ?? new AbortController().signal,
        });
        host.print(status?.state === "connected" ? [`Signed in to ${target} ${host.sep} ${status.tools.length} tool${status.tools.length === 1 ? "" : "s"}`] : describeServers(status === undefined ? [] : [status], { sep: host.sep, slash: true }));
      } catch (error: unknown) {
        host.print([`Sign-in to ${target} did not finish: ${error instanceof Error ? error.message : String(error)}`]);
      }
      return;
    }
    case "logout": {
      const target = need();
      if (target === undefined) return;
      host.print([(await manager.logout(target)) ? `Signed out of ${target}.` : `${target} had no stored sign-in.`]);
      return;
    }
    case "revoke": {
      const target = need();
      if (target === undefined) return;
      const removed = await manager.revoke(target);
      host.print([removed ? `Revoked ${target}; it stays stopped until approved again.` : `${target} was not approved.`]);
      return;
    }
    default:
      if (manager.has(verb)) {
        host.print(describeServer(manager.status().find((entry) => entry.name === verb), host.sep));
        return;
      }
      host.print([`Unknown /mcp ${verb}; try /mcp, /mcp <name>, /mcp tools, /mcp reconnect|login <name>, /mcp enable|disable <name>, /mcp approve <name>`]);
  }
}
