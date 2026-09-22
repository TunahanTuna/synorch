import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import type { ToolBridgeCall, ToolBridgeResult, ToolDescriptor } from "../../contracts/index.ts";

/** MCP protocol revisions this server answers with; the client's requested one is echoed when known. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_SERVER_NAME = "synorch";
/** Name of the internal permission-prompt tool (`--permission-prompt-tool mcp__synorch__approve`). */
export const PERMISSION_TOOL_NAME = "approve";

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

export interface McpToolHost {
  list(): readonly ToolDescriptor[];
  call(call: ToolBridgeCall & { readonly rpcId: string }, signal: AbortSignal): Promise<ToolBridgeResult>;
  permission(toolName: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ readonly allow: boolean; readonly reason: string }>;
}

type JsonRpcId = string | number | null;

/**
 * A minimal MCP server over newline-delimited JSON-RPC 2.0: `initialize`, `ping`, `tools/list` and
 * `tools/call`. Every tool call is delegated to the host, which routes it into the ToolBridge (and
 * from there the ToolGateway); the server itself executes nothing.
 */
export class McpToolServer {
  private readonly host: McpToolHost;
  private readonly version: string;

  public constructor(host: McpToolHost, version: string) {
    this.host = host;
    this.version = version;
  }

  /** Handles one line; returns the response line, or `undefined` for notifications. */
  public async handle(line: string, signal: AbortSignal): Promise<string | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.error(null, JSONRPC_PARSE_ERROR, "parse error");
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return this.error(null, JSONRPC_INVALID_REQUEST, "invalid request");
    }
    const request = message as { id?: unknown; method?: unknown; params?: unknown };
    const hasId = "id" in request && (typeof request.id === "string" || typeof request.id === "number");
    const id: JsonRpcId = hasId ? (request.id as string | number) : null;
    if (typeof request.method !== "string") {
      return hasId ? this.error(id, JSONRPC_INVALID_REQUEST, "missing method") : undefined;
    }
    if (!hasId) return undefined;
    const params = typeof request.params === "object" && request.params !== null ? (request.params as Record<string, unknown>) : {};
    switch (request.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
        const protocolVersion =
          requested !== undefined && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        return this.result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: this.version },
        });
      }
      case "ping":
        return this.result(id, {});
      case "tools/list":
        return this.result(id, { tools: this.tools() });
      case "tools/call":
        return this.call(id, params, signal);
      default:
        return this.error(id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${request.method}`);
    }
  }

  private tools(): unknown[] {
    const listed = this.host
      .list()
      .filter((tool) => tool.name !== PERMISSION_TOOL_NAME)
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema }));
    listed.push({
      name: PERMISSION_TOOL_NAME,
      description: "Synorch permission decision for backend permission prompts. Not a task tool.",
      inputSchema: {
        type: "object",
        properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
        required: ["tool_name"],
      },
    });
    return listed;
  }

  private async call(id: JsonRpcId, params: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) {
      return this.error(id, JSONRPC_INVALID_PARAMS, "tools/call needs a name and an object of arguments");
    }
    const input = args as Record<string, unknown>;
    if (name === PERMISSION_TOOL_NAME) {
      const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
      const toolInput = typeof input.input === "object" && input.input !== null ? (input.input as Record<string, unknown>) : {};
      let decision: { readonly allow: boolean; readonly reason: string };
      try {
        decision = await this.host.permission(toolName, toolInput, signal);
      } catch (error: unknown) {
        decision = { allow: false, reason: error instanceof Error ? error.message : "permission check failed" };
      }
      const payload = decision.allow ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: decision.reason };
      return this.result(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false });
    }
    if (!this.host.list().some((tool) => tool.name === name)) {
      return this.result(id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
    }
    let result: ToolBridgeResult;
    try {
      result = await this.host.call({ providerCallId: "", name, arguments: input, rpcId: String(id) }, signal);
    } catch (error: unknown) {
      result = { isError: true, text: error instanceof Error ? error.message : "tool call failed" };
    }
    return this.result(id, { content: [{ type: "text", text: result.text }], isError: result.isError });
  }

  private result(id: JsonRpcId, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  private error(id: JsonRpcId, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

/**
 * Serves one relay connection: the first line must be the session token (compared in constant
 * time); afterwards every line is a JSON-RPC message. Requests are answered concurrently.
 */
export function serveMcpConnection(socket: Socket, server: McpToolServer, token: string, signal: AbortSignal): void {
  let buffer = "";
  let authenticated = false;
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!authenticated) {
        if (!sameToken(line, token)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        continue;
      }
      if (line.trim() === "") continue;
      void server.handle(line, signal).then((response) => {
        if (response !== undefined && !socket.destroyed) socket.write(`${response}\n`);
      });
    }
  });
}

function sameToken(candidate: string, token: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
