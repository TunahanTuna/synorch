import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerDefinition } from "./config.ts";

/**
 * One live connection to an MCP server through the official TypeScript SDK (stdio, streamable
 * HTTP, or legacy SSE). The server's stderr goes to a log file (`<logs>/<server>.log`), never to
 * the terminal; its last lines are kept for `/mcp` and error messages. The SDK is loaded on the
 * first connection only, so sessions without MCP servers never pay for it.
 */

export interface McpToolInfo {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Readonly<Record<string, unknown>> | undefined;
}

export interface McpContentPart {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly resource?: { readonly uri?: string; readonly text?: string; readonly mimeType?: string; readonly blob?: string };
}

export interface McpCallResult {
  readonly content: readonly McpContentPart[];
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

export interface McpConnectOptions {
  readonly workspaceRoot: string;
  readonly logDirectory: string;
  readonly clientVersion: string;
  /** Parent environment for extra pass-through variables (proxies, Windows shell basics). */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

/** Non-secret variables a spawned server commonly needs beyond the SDK's safe defaults. */
const EXTRA_PASSTHROUGH = ["PATHEXT", "ComSpec", "COMSPEC", "WINDIR", "SystemRoot", "ProgramData", "ProgramFiles(x86)", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "PLAYWRIGHT_BROWSERS_PATH", "DISPLAY", "WAYLAND_DISPLAY"];
const LOG_ROTATE_BYTES = 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

export class McpConnection {
  public readonly definition: McpServerDefinition;
  public tools: readonly McpToolInfo[] = [];
  public serverVersion: string | undefined;
  private readonly client: Client;
  private readonly transport: Transport;
  /** The stdio transport (pid, stderr), when the server is a local process. */
  private readonly stdio: StdioClientTransport | undefined;
  private readonly log: WriteStream | undefined;
  private readonly platform: NodeJS.Platform;
  private stderrTail = "";
  private closed = false;
  private disposed = false;
  private readonly closeListeners = new Set<(reason: string) => void>();

  private constructor(definition: McpServerDefinition, client: Client, transport: Transport, log: WriteStream | undefined, platform: NodeJS.Platform) {
    this.definition = definition;
    this.client = client;
    this.transport = transport;
    this.stdio = definition.transport === "stdio" ? (transport as StdioClientTransport) : undefined;
    this.log = log;
    this.platform = platform;
  }

  /** Connects, initializes and lists the tools; throws with the server's last stderr lines on failure. */
  public static async connect(definition: McpServerDefinition, options: McpConnectOptions): Promise<McpConnection> {
    const platform = options.platform ?? process.platform;
    const log = openLog(options.logDirectory, definition.name);
    log?.write(`\n--- ${new Date().toISOString()} connecting ${definition.name} (${definition.transport}) ---\n`);
    const transport = await createTransport(definition, options);
    const { Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new ClientClass({ name: "synorch", version: options.clientVersion }, { capabilities: {} });
    const connection = new McpConnection(definition, client, transport, log, platform);
    connection.stdio?.stderr?.on("data", (chunk: Buffer | string) => connection.noteStderr(String(chunk)));
    client.onclose = () => connection.markClosed("the server closed the connection");
    client.onerror = (error) => log?.write(`client error: ${error.message}\n`);
    const timeout = AbortSignal.timeout(definition.startupTimeoutMs);
    try {
      await client.connect(transport, { timeout: definition.startupTimeoutMs, signal: timeout });
      connection.serverVersion = client.getServerVersion()?.version;
      connection.tools = await connection.listAllTools(timeout);
    } catch (error: unknown) {
      const tail = connection.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
      await connection.close().catch(() => undefined);
      const message = timeout.aborted ? `did not start within ${Math.round(definition.startupTimeoutMs / 1000)} s` : error instanceof Error ? error.message : String(error);
      throw new Error(`${definition.name}: ${message}${tail === "" ? "" : ` (stderr: ${tail.slice(0, 500)})`}`);
    }
    log?.write(`connected; ${connection.tools.length} tool(s)\n`);
    return connection;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get lastStderr(): string {
    return this.stderrTail;
  }

  public onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public async callTool(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, timeoutMs: number): Promise<McpCallResult> {
    const result = await this.client.callTool({ name, arguments: { ...args } }, undefined, { signal, timeout: timeoutMs, resetTimeoutOnProgress: true });
    const content = Array.isArray(result.content) ? (result.content as McpContentPart[]) : [];
    const legacy = (result as { toolResult?: unknown }).toolResult;
    return {
      content: content.length === 0 && legacy !== undefined ? [{ type: "text", text: typeof legacy === "string" ? legacy : JSON.stringify(legacy) }] : content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    };
  }

  public async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pid = this.stdio?.pid ?? null;
    this.markClosed("closed by Synorch");
    // A Windows `npx` server runs under cmd.exe: end the whole tree, or node children outlive it.
    if (pid !== null && this.platform === "win32") await killTreeWindows(pid);
    await this.client.close().catch(() => undefined);
    this.log?.end();
  }

  /** Synchronous best effort for process exit handlers. */
  public killSync(): void {
    const pid = this.stdio?.pid ?? null;
    if (pid === null) return;
    try {
      if (this.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private async listAllTools(signal: AbortSignal): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.client.listTools(cursor === undefined ? {} : { cursor }, { signal, timeout: this.definition.startupTimeoutMs });
      for (const tool of result.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: tool.annotations as Record<string, unknown> | undefined,
        });
      }
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  }

  private noteStderr(text: string): void {
    this.log?.write(text);
    this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_TAIL_CHARS);
  }

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.log?.write(`closed: ${reason}\n`);
    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch {
        continue;
      }
    }
  }
}

async function createTransport(definition: McpServerDefinition, options: McpConnectOptions): Promise<Transport> {
  if (definition.transport === "stdio") {
    const { getDefaultEnvironment, StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const extra: Record<string, string> = {};
    for (const name of EXTRA_PASSTHROUGH) {
      const value = options.environment[name];
      if (value !== undefined && value !== "") extra[name] = value;
    }
    return new StdioClientTransport({
      command: definition.command ?? "",
      args: [...definition.args],
      env: { ...getDefaultEnvironment(), ...extra, ...definition.env },
      cwd: definition.cwd ?? options.workspaceRoot,
      stderr: "pipe",
    });
  }
  const url = new URL(definition.url ?? "");
  const requestInit: RequestInit = { headers: { ...definition.headers } };
  if (definition.transport === "sse") {
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    return new SSEClientTransport(url, { requestInit }) as Transport;
  }
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  return new StreamableHTTPClientTransport(url, { requestInit }) as Transport;
}

function openLog(directory: string, name: string): WriteStream | undefined {
  try {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${name}.log`);
    let flags = "a";
    try {
      if (statSync(file).size > LOG_ROTATE_BYTES) flags = "w";
    } catch {
      // New file.
    }
    const stream = createWriteStream(file, { flags, mode: 0o600 });
    stream.on("error", () => undefined);
    return stream;
  } catch {
    return undefined;
  }
}

function killTreeWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Where a server's stderr log lives. */
export function mcpLogFile(logDirectory: string, name: string): string {
  return path.join(logDirectory, `${name}.log`);
}
