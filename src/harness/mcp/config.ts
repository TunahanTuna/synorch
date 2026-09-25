import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AGENT_ROLES, agentRoleSchema, digestOf, type AgentRole, type Digest } from "../contracts/index.ts";

/**
 * K3 MCP client configuration. Servers come from three places:
 *
 *   user     `mcp.servers` in <synorch home>/config.yaml       (trusted: the user wrote it)
 *   project  `mcp.servers` in <workspace>/.synorch/config.yaml  (repository content: gated)
 *   project  `mcpServers` in <workspace>/.mcp.json              (the common format; gated)
 *
 * A repository layer may only narrow (SEC-C1), so a project server is never spawned until the user
 * approved exactly that definition once (`syn mcp approve <name>` or `/mcp approve <name>`); the
 * approval is bound to the definition's digest and lives in the user scope. A user server with the
 * same name wins over a project one.
 */

export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
export const MCP_TRUST_LEVELS = ["full", "read-only"] as const;
export type McpTrust = (typeof MCP_TRUST_LEVELS)[number];
export const MCP_STARTUP_MODES = ["lazy", "session"] as const;
export type McpStartup = (typeof MCP_STARTUP_MODES)[number];

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 60_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 120_000;

const stringMap = z.record(z.string().min(1).max(200), z.string().max(8000));

/** One server entry, Synorch YAML form (also accepts the `.mcp.json` keys: `type`, `command`, `url`…). */
export const mcpServerEntrySchema = z
  .strictObject({
    type: z.enum(["stdio", "http", "streamable-http", "sse"]).optional(),
    command: z.string().min(1).max(1000).optional(),
    args: z.array(z.string().max(8000)).max(256).optional(),
    env: stringMap.optional(),
    cwd: z.string().min(1).max(1000).optional(),
    url: z.string().min(1).max(2000).optional(),
    headers: stringMap.optional(),
    /** `full` (default): tools may change things (the `exec` effect); `read-only`: tools only read (the `read` effect). */
    trust: z.enum(MCP_TRUST_LEVELS).optional(),
    enabled: z.boolean().optional(),
    /** `lazy` (default): spawn on first use when the tool list is cached; `session`: connect when the session starts. */
    startup: z.enum(MCP_STARTUP_MODES).optional(),
    startup_timeout_ms: z.int().min(1000).max(600_000).optional(),
    timeout_ms: z.int().min(1000).max(3_600_000).optional(),
    /** Which agent roles see the server's tools (narrows the default by trust). */
    roles: z.array(agentRoleSchema).min(1).optional(),
    /** Free text kept for `.mcp.json` compatibility. */
    description: z.string().max(2000).optional(),
  })
  .superRefine((entry, context) => {
    const remote = entry.url !== undefined;
    if (remote === (entry.command !== undefined)) context.addIssue({ code: "custom", message: "a server needs exactly one of command (stdio) or url (http)" });
    if (entry.type === "stdio" && remote) context.addIssue({ code: "custom", path: ["type"], message: "type stdio needs command, not url" });
    if (entry.type !== undefined && entry.type !== "stdio" && !remote) context.addIssue({ code: "custom", path: ["type"], message: `type ${entry.type} needs url` });
  });
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

/** The `mcp` block of a Synorch config file. */
export const mcpConfigSchema = z.strictObject({
  startup: z.enum(MCP_STARTUP_MODES).optional(),
  servers: z.record(z.string().regex(MCP_SERVER_NAME_PATTERN, "server names are 1-32 letters, digits, - or _"), mcpServerEntrySchema).optional(),
});
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** `plugin`: a plugin the user installed with `syn plugin install`; `claude-plugin`: a plugin enabled in Claude Code (K7). */
export type McpSource = "user" | "project" | "mcp.json" | "plugin" | "claude-plugin";

/** A server as the client runs it: transport details with `${VAR}` expanded, policy hints resolved. */
export interface McpServerDefinition {
  readonly name: string;
  readonly source: McpSource;
  /** Where it was declared (for `syn mcp list`). */
  readonly file: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly command: string | undefined;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
  readonly url: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly trust: McpTrust;
  readonly enabled: boolean;
  readonly startup: McpStartup;
  readonly startupTimeoutMs: number;
  readonly timeoutMs: number;
  readonly roles: readonly AgentRole[];
  /** Digest of the definition as written (before expansion): project approvals bind to it. */
  readonly digest: Digest;
  /** Variables `${VAR}` referenced but not set (reported, expanded to ""). */
  readonly missingVariables: readonly string[];
  /** A `claude-plugin` server's name inside Claude Code (`plugin:<plugin>:<server>`, tools `mcp__plugin_<plugin>_<server>__*`). */
  readonly claudeName?: string;
}

/** Roles that see a server's tools by default: read-only servers reach every role but the orchestrator. */
export function defaultMcpRoles(trust: McpTrust): AgentRole[] {
  return trust === "read-only" ? ["session", "implementer", "debugger", "explorer", "reviewer"] : ["session", "implementer", "debugger"];
}

/** `${VAR}` and `${VAR:-default}` (the `.mcp.json` convention), from `environment`. */
export function expandVariables(text: string, environment: Readonly<Record<string, string | undefined>>, missing: Set<string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const value = environment[name];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return "";
  });
}

export function toDefinition(
  name: string,
  entry: McpServerEntry,
  source: McpSource,
  file: string,
  environment: Readonly<Record<string, string | undefined>>,
  defaults: { readonly startup?: McpStartup | undefined; readonly baseDir?: string | undefined } = {},
): McpServerDefinition {
  const missing = new Set<string>();
  const expand = (text: string): string => expandVariables(text, environment, missing);
  const expandMap = (map: Readonly<Record<string, string>> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(map ?? {}).map(([key, value]) => [key, expand(value)]));
  const trust = entry.trust ?? "full";
  const transport = entry.url === undefined ? "stdio" : entry.type === "sse" ? "sse" : "http";
  const cwd = entry.cwd === undefined ? undefined : path.resolve(defaults.baseDir ?? process.cwd(), expand(entry.cwd));
  const allowed = defaultMcpRoles(trust);
  const roles = entry.roles === undefined ? allowed : entry.roles.filter((role) => (AGENT_ROLES as readonly string[]).includes(role));
  return {
    name,
    source,
    file,
    transport,
    command: entry.command === undefined ? undefined : expand(entry.command),
    args: (entry.args ?? []).map(expand),
    env: expandMap(entry.env),
    cwd,
    url: entry.url === undefined ? undefined : expand(entry.url),
    headers: expandMap(entry.headers),
    trust,
    enabled: entry.enabled ?? true,
    startup: entry.startup ?? defaults.startup ?? "lazy",
    startupTimeoutMs: entry.startup_timeout_ms ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    timeoutMs: entry.timeout_ms ?? DEFAULT_MCP_TOOL_TIMEOUT_MS,
    roles,
    digest: digestOf({ name, type: entry.type, command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd, url: entry.url, headers: entry.headers }),
    missingVariables: [...missing],
  };
}

export interface McpConfigProblem {
  readonly file: string;
  readonly message: string;
}

export interface McpDiscovery {
  readonly servers: readonly McpServerDefinition[];
  readonly problems: readonly McpConfigProblem[];
}

const mcpJsonSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });

/** Reads `<root>/.mcp.json` leniently: each valid server is kept, each invalid one reported. */
export async function readMcpJson(root: string, environment: Readonly<Record<string, string | undefined>>): Promise<McpDiscovery> {
  const file = path.join(root, ".mcp.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { servers: [], problems: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { servers: [], problems: [{ file, message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const parsed = mcpJsonSchema.safeParse(raw);
  if (!parsed.success) return { servers: [], problems: [{ file, message: "expected {\"mcpServers\": {...}}" }] };
  const servers: McpServerDefinition[] = [];
  const problems: McpConfigProblem[] = [];
  for (const [name, value] of Object.entries(parsed.data.mcpServers ?? {})) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      problems.push({ file, message: `server ${name}: names are 1-32 letters, digits, - or _` });
      continue;
    }
    const entry = mcpServerEntrySchema.safeParse(stripUnknown(value));
    if (!entry.success) {
      problems.push({ file, message: `server ${name}: ${entry.error.issues.map((issue) => issue.message).join("; ")}` });
      continue;
    }
    servers.push(toDefinition(name, entry.data, "mcp.json", file, environment, { baseDir: root }));
  }
  return { servers, problems };
}

/** One `.mcp.json`-style server entry (unknown keys dropped): the entry, or the reason it is invalid. */
export function parseMcpServerEntry(value: unknown): { readonly entry: McpServerEntry } | { readonly error: string } {
  const parsed = mcpServerEntrySchema.safeParse(stripUnknown(value));
  return parsed.success ? { entry: parsed.data } : { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/** `.mcp.json` entries written for other clients may carry keys Synorch does not know; they are dropped. */
function stripUnknown(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const known = new Set(["type", "command", "args", "env", "cwd", "url", "headers", "trust", "enabled", "startup", "startup_timeout_ms", "timeout_ms", "roles", "description"]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => known.has(key)));
}

/** Every configured server: user entries first (they win a name clash), then plugin servers (K7), project and `.mcp.json`. */
export function mergeServers(
  user: McpConfig | undefined,
  userFile: string,
  project: McpConfig | undefined,
  projectFile: string,
  mcpJson: McpDiscovery,
  environment: Readonly<Record<string, string | undefined>>,
  workspaceRoot: string,
  plugins: readonly McpServerDefinition[] = [],
): McpDiscovery {
  const byName = new Map<string, McpServerDefinition>();
  const add = (definition: McpServerDefinition): void => {
    if (!byName.has(definition.name)) byName.set(definition.name, definition);
  };
  for (const [name, entry] of Object.entries(user?.servers ?? {})) add(toDefinition(name, entry, "user", userFile, environment, { startup: user?.startup, baseDir: workspaceRoot }));
  for (const definition of plugins) add(definition);
  for (const [name, entry] of Object.entries(project?.servers ?? {})) add(toDefinition(name, entry, "project", projectFile, environment, { startup: project?.startup, baseDir: workspaceRoot }));
  for (const definition of mcpJson.servers) add(definition);
  return { servers: [...byName.values()], problems: mcpJson.problems };
}

/** A tool name as the model sees it: `mcp__<server>__<tool>`, snake case, at most 64 characters. */
export function modelToolName(server: string, tool: string): string {
  const clean = (text: string): string => text.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
  const name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length <= 64) return name;
  const suffix = digestOf(`${server}/${tool}`).slice(-6);
  return `${name.slice(0, 57)}_${suffix}`;
}
