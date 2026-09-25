import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "../contracts/index.ts";
import { createMcpApprovalStore, type McpApprovalStore } from "./approvals.ts";
import { McpConnection, mcpLogFile, type McpToolInfo } from "./client.ts";
import { mergeServers, modelToolName, readMcpJson, type McpConfig, type McpConfigProblem, type McpServerDefinition } from "./config.ts";
import { createMcpTool } from "./tools.ts";

/**
 * K3 MCP client: the servers of one runtime. It resolves the configured servers (user, project,
 * `.mcp.json`), enforces the project approval gate, connects lazily or at session start, registers
 * each server's tools in the ToolRegistry as `mcp__<server>__<tool>` and removes them again when a
 * server is disabled or reconnected. Every server process ends with the session.
 */

export type McpServerState = "disabled" | "needs-approval" | "idle" | "starting" | "connected" | "failed";

export interface McpServerStatus {
  readonly name: string;
  readonly source: McpServerDefinition["source"];
  readonly file: string;
  readonly transport: McpServerDefinition["transport"];
  readonly target: string;
  readonly trust: McpServerDefinition["trust"];
  readonly startup: McpServerDefinition["startup"];
  readonly state: McpServerState;
  /** Model-visible tool names (registered now). */
  readonly tools: readonly string[];
  readonly error: string | undefined;
  readonly logFile: string;
  readonly missingVariables: readonly string[];
}

export interface McpManagerOptions {
  readonly home: string;
  readonly workspaceRoot: string;
  /** Canonical workspace root (the trust store's form): project approvals bind to it. */
  readonly workspaceKey: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly registry: ToolRegistry;
  readonly clientVersion: string;
  readonly user: { readonly config: McpConfig | undefined; readonly file: string };
  readonly project: { readonly config: McpConfig | undefined; readonly file: string };
  readonly platform?: NodeJS.Platform;
  /** An MCP result reached the model: untrusted content entered the turn. */
  readonly onUntrustedContent?: () => void;
  /** Secret-looking values from expanded env/headers join the gateway's redaction set. */
  readonly addRedaction?: (value: string) => void;
  readonly approvals?: McpApprovalStore;
}

interface ServerSlot {
  definition: McpServerDefinition;
  sessionDisabled: boolean;
  connection: McpConnection | undefined;
  connecting: Promise<McpConnection> | undefined;
  registered: string[];
  error: string | undefined;
}

const cacheSchema = z.strictObject({
  digest: z.string(),
  tools: z.array(z.strictObject({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()), annotations: z.record(z.string(), z.unknown()).optional() })),
});

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;

export class McpManager {
  private readonly options: McpManagerOptions;
  private readonly approvals: McpApprovalStore;
  private readonly logDirectory: string;
  private readonly cacheDirectory: string;
  private slots = new Map<string, ServerSlot>();
  private loadProblems: McpConfigProblem[] = [];
  private loaded = false;
  private closed = false;

  public constructor(options: McpManagerOptions) {
    this.options = options;
    this.approvals = options.approvals ?? createMcpApprovalStore(options.home);
    this.logDirectory = path.join(options.home, "logs", "mcp");
    this.cacheDirectory = path.join(options.home, "mcp", "cache");
  }

  /** Reads `.mcp.json` and resolves every server definition (no process is started). */
  public async load(): Promise<void> {
    const mcpJson = await readMcpJson(this.options.workspaceRoot, this.options.environment);
    const merged = mergeServers(this.options.user.config, this.options.user.file, this.options.project.config, this.options.project.file, mcpJson, this.options.environment, this.options.workspaceRoot);
    this.loadProblems = [...merged.problems];
    const next = new Map<string, ServerSlot>();
    for (const definition of merged.servers) {
      const previous = this.slots.get(definition.name);
      next.set(definition.name, previous !== undefined && previous.definition.digest === definition.digest ? { ...previous, definition } : { definition, sessionDisabled: false, connection: undefined, connecting: undefined, registered: [], error: undefined });
      for (const value of [...Object.entries(definition.env), ...Object.entries(definition.headers)]) {
        if (SECRET_NAME.test(value[0]) && value[1].length >= 8) this.options.addRedaction?.(value[1]);
      }
    }
    for (const [name, slot] of this.slots) if (next.get(name) !== slot) await this.stop(slot);
    this.slots = next;
    this.loaded = true;
  }

  public get problems(): readonly McpConfigProblem[] {
    return this.loadProblems;
  }

  public has(name: string): boolean {
    return this.slots.has(name);
  }

  public definitions(): readonly McpServerDefinition[] {
    return [...this.slots.values()].map((slot) => slot.definition);
  }

  /** Project servers waiting for the user's one-time approval. */
  public pendingApprovals(): readonly McpServerDefinition[] {
    return [...this.slots.values()].filter((slot) => slot.definition.enabled && this.needsApproval(slot.definition)).map((slot) => slot.definition);
  }

  /**
   * Session start: every enabled, approved server either connects now (`startup: session`, or no
   * cached tool list yet) or registers its cached tools and connects at first use. Never throws;
   * failures are kept for `/mcp`. Resolves when every eager connection settled.
   */
  public async startSession(): Promise<void> {
    if (!this.loaded) await this.load();
    const eager: Promise<unknown>[] = [];
    for (const slot of this.slots.values()) {
      if (!this.usable(slot)) continue;
      const cached = slot.definition.startup === "lazy" ? this.readCache(slot.definition) : undefined;
      if (cached !== undefined) {
        this.register(slot, cached);
        continue;
      }
      eager.push(this.connect(slot).catch(() => undefined));
    }
    await Promise.all(eager);
  }

  public status(): McpServerStatus[] {
    return [...this.slots.values()].map((slot) => {
      const definition = slot.definition;
      return {
        name: definition.name,
        source: definition.source,
        file: definition.file,
        transport: definition.transport,
        target: definition.transport === "stdio" ? [definition.command ?? "", ...definition.args].join(" ") : (definition.url ?? ""),
        trust: definition.trust,
        startup: definition.startup,
        state: this.stateOf(slot),
        tools: [...slot.registered],
        error: slot.error,
        logFile: mcpLogFile(this.logDirectory, definition.name),
        missingVariables: definition.missingVariables,
      };
    });
  }

  /** The server's tools as the server names them (connected servers only). */
  public serverTools(name: string): readonly McpToolInfo[] {
    return this.slots.get(name)?.connection?.tools ?? [];
  }

  /** The live connection for a tool call: connects (or reconnects after a crash) on demand. */
  public async connection(name: string, signal?: AbortSignal): Promise<McpConnection> {
    const slot = this.slots.get(name);
    if (slot === undefined) throw new Error(`no MCP server named ${name}`);
    if (!slot.definition.enabled || slot.sessionDisabled) throw new Error(`${name} is disabled (/mcp enable ${name})`);
    if (this.needsApproval(slot.definition)) throw new Error(`${name} is a project server that has not been approved (/mcp approve ${name})`);
    if (slot.connection !== undefined && !slot.connection.isClosed) return slot.connection;
    const pending = this.connect(slot);
    if (signal === undefined) return pending;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error("cancelled"));
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    ]);
  }

  public async reconnect(name: string): Promise<McpServerStatus | undefined> {
    const slot = this.slots.get(name);
    if (slot === undefined) return undefined;
    await this.stop(slot);
    slot.error = undefined;
    if (this.usable(slot)) await this.connect(slot).catch(() => undefined);
    return this.status().find((entry) => entry.name === name);
  }

  /** Session-scoped enable/disable (the CLI also persists it for user servers). */
  public async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const slot = this.slots.get(name);
    if (slot === undefined) return false;
    slot.sessionDisabled = !enabled;
    if (!enabled) {
      await this.stop(slot);
      return true;
    }
    if (!slot.definition.enabled) slot.definition = { ...slot.definition, enabled: true };
    if (this.usable(slot) && slot.registered.length === 0) await this.connect(slot).catch(() => undefined);
    return true;
  }

  /** Approves a project server's current definition for this workspace (user scope) and starts it. */
  public async approve(name: string, start = true): Promise<boolean> {
    const slot = this.slots.get(name);
    if (slot === undefined || slot.definition.source === "user") return false;
    await this.approvals.approve(this.options.workspaceKey, name, slot.definition.digest);
    if (start && this.usable(slot) && !this.closed) await this.connect(slot).catch(() => undefined);
    return true;
  }

  public async revoke(name: string): Promise<boolean> {
    const slot = this.slots.get(name);
    const removed = await this.approvals.revoke(this.options.workspaceKey, name);
    if (slot !== undefined) await this.stop(slot);
    return removed;
  }

  /**
   * Claude Code native mode: the servers Claude should run itself (`--mcp-config`), in Claude's
   * format; only enabled and approved ones. Claude's own permission prompts reach Synorch's broker.
   */
  public claudeServers(): Record<string, Record<string, unknown>> {
    const servers: Record<string, Record<string, unknown>> = {};
    for (const slot of this.slots.values()) {
      if (!this.usable(slot)) continue;
      const definition = slot.definition;
      servers[definition.name] =
        definition.transport === "stdio"
          ? { type: "stdio", command: definition.command, args: [...definition.args], env: { ...definition.env } }
          : { type: definition.transport, url: definition.url, headers: { ...definition.headers } };
    }
    return servers;
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.slots.values()].map((slot) => this.stop(slot, false)));
  }

  public killAllSync(): void {
    for (const slot of this.slots.values()) slot.connection?.killSync();
  }

  private needsApproval(definition: McpServerDefinition): boolean {
    return definition.source !== "user" && !this.approvals.isApproved(this.options.workspaceKey, definition.name, definition.digest);
  }

  private usable(slot: ServerSlot): boolean {
    return slot.definition.enabled && !slot.sessionDisabled && !this.needsApproval(slot.definition);
  }

  private stateOf(slot: ServerSlot): McpServerState {
    if (!slot.definition.enabled || slot.sessionDisabled) return "disabled";
    if (this.needsApproval(slot.definition)) return "needs-approval";
    if (slot.connecting !== undefined) return "starting";
    if (slot.connection !== undefined && !slot.connection.isClosed) return "connected";
    if (slot.error !== undefined) return "failed";
    return "idle";
  }

  private connect(slot: ServerSlot): Promise<McpConnection> {
    if (this.closed) return Promise.reject(new Error("the session is closing"));
    if (slot.connecting !== undefined) return slot.connecting;
    const definition = slot.definition;
    const attempt = McpConnection.connect(definition, {
      workspaceRoot: this.options.workspaceRoot,
      logDirectory: this.logDirectory,
      clientVersion: this.options.clientVersion,
      environment: this.options.environment,
      ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
    }).then(
      async (connection) => {
        slot.connecting = undefined;
        if (this.closed || slot.definition !== definition || slot.sessionDisabled) {
          await connection.close();
          throw new Error(`${definition.name} was stopped while it started`);
        }
        slot.connection = connection;
        slot.error = undefined;
        connection.onClose((reason) => {
          if (slot.connection === connection) slot.error = `stopped: ${reason}${connection.lastStderr.trim() === "" ? "" : ` (${connection.lastStderr.trim().split(/\r?\n/).at(-1)?.slice(0, 300) ?? ""})`}`;
        });
        this.register(slot, connection.tools);
        void this.writeCache(definition, connection.tools);
        return connection;
      },
      (error: unknown) => {
        slot.connecting = undefined;
        slot.error = error instanceof Error ? error.message : String(error);
        throw error;
      },
    );
    slot.connecting = attempt;
    return attempt;
  }

  private register(slot: ServerSlot, tools: readonly McpToolInfo[]): void {
    const registry = this.options.registry;
    const wanted = new Map<string, McpToolInfo>();
    for (const tool of tools) {
      const name = modelToolName(slot.definition.name, tool.name);
      if (!wanted.has(name)) wanted.set(name, tool);
    }
    for (const name of slot.registered) registry.unregister?.(name);
    slot.registered = [];
    for (const [name, tool] of wanted) {
      if (registry.get(name) !== undefined) continue;
      try {
        registry.register(createMcpTool(slot.definition, tool, name, { connection: (server, signal) => this.connection(server, signal), onUntrustedContent: () => this.options.onUntrustedContent?.() }) as never);
        slot.registered.push(name);
      } catch {
        continue;
      }
    }
  }

  private async stop(slot: ServerSlot, wait = true): Promise<void> {
    // A start in flight settles first, so its connection is closed here instead of leaking (at
    // session close it is not awaited: the closed flag makes the start close its own connection).
    if (wait) await slot.connecting?.catch(() => undefined);
    for (const name of slot.registered) this.options.registry.unregister?.(name);
    slot.registered = [];
    const connection = slot.connection;
    slot.connection = undefined;
    await connection?.close().catch(() => undefined);
  }

  private cacheFile(definition: McpServerDefinition): string {
    return path.join(this.cacheDirectory, `${definition.name}.json`);
  }

  private readCache(definition: McpServerDefinition): McpToolInfo[] | undefined {
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(this.cacheFile(definition), "utf8")));
      if (!parsed.success || parsed.data.digest !== definition.digest || parsed.data.tools.length === 0) return undefined;
      return parsed.data.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));
    } catch {
      return undefined;
    }
  }

  private async writeCache(definition: McpServerDefinition, tools: readonly McpToolInfo[]): Promise<void> {
    try {
      await mkdir(this.cacheDirectory, { recursive: true });
      const data = { digest: definition.digest, tools: tools.map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema, ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }) })) };
      await writeFile(this.cacheFile(definition), JSON.stringify(data), "utf8");
    } catch {
      // The cache is a convenience.
    }
  }
}
