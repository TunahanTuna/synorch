import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYNORCH_VERSION } from "../../../domain/product.ts";
import {
  modelStreamEventSchema,
  providerIdSchema,
  ProviderFailure,
  type AgentBackendAdapter,
  type ApprovalBridge,
  type BackendBridges,
  type BackendProbe,
  type BackendSession,
  type BackendSessionOptions,
  type BackendTurnInput,
  type ModelStreamEvent,
  type PermissionMode,
  type ProviderCapabilities,
  type ProviderError,
  type ReasoningEffort,
  type ToolBridge,
  type ToolDescriptor,
} from "../../contracts/index.ts";
import { MessagesMapper } from "../anthropic-messages.ts";
import { anthropicWireModelId } from "../catalog.ts";
import { StreamAssembler, usageOf } from "../assembler.ts";
import { numberField, providerError, record, stringField } from "../errors.ts";
import { McpToolServer, MCP_SERVER_NAME, PERMISSION_TOOL_NAME, serveMcpConnection } from "./mcp-server.ts";
import {
  claudeInputSummary,
  claudeLineCounts,
  claudePermissionMode,
  claudeResultSummary,
  isClaudeWebTool,
  toolResultText,
  type ClaudeCodeMode,
  type ClaudePermissionMode,
} from "./native.ts";
import { bridgeEnvironment, findOnPath, runCaptured, spawnBackend, terminate, type ExecutableSpec } from "./process.ts";

/** Claude sees Synorch MCP tools as `mcp__synorch__<name>`; anything else in `backend_init.tools` is a built-in. */
export const CLAUDE_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/** Lowest `claude` version the bridge is written against; the flags are re-verified against the installed CLI. */
export const CLAUDE_CODE_MINIMUM_VERSION = "2.0.0";
const CALL_ID_WAIT_MS = 500;
export const CLAUDE_LOGIN_HINT ="Run `claude`, then `/login`, to sign in with your own Claude subscription.";

export interface ClaudeCodeAdapterOptions {
  /** The bridge is experimental and opt-in (ADR-05): sessions refuse to start unless this is true. */
  readonly experimental: boolean;
  readonly executable?: ExecutableSpec;
  /** Environment used to locate and probe `claude`; stripped of `BRIDGE_STRIPPED_ENV` before use. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly interruptGraceMs?: number;
  /**
   * SEC-M2: a turn is refused unless `system/init` reports the subscription login
   * (`auth_source: subscription`). Only an explicit user-config opt-in
   * (`allow_non_subscription_auth: true` on the `claude-code` adapter) accepts other sources.
   */
  readonly allowNonSubscriptionAuth?: boolean;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly tempRoot?: string;
  /**
   * `native` (owner revision 2026-09-24): Claude runs its full built-in toolset, its permission
   * prompts go to Synorch's approval broker, and its tool use is observed for audit. `restricted`:
   * every built-in disabled, only Synorch MCP tools (the original bridge). The runtime passes the
   * user configuration's `claude_code.mode` (default native); a directly built adapter defaults to
   * `restricted` so the original bridge contract stays the API default.
   */
  readonly mode?: ClaudeCodeMode;
  /** The session's current Synorch permission mode, read at every process start (native mode). */
  readonly permissionMode?: () => PermissionMode | undefined;
  /** Fires when a native WebSearch/WebFetch result arrives (K4.1 web-content taint). */
  readonly onWebContentRead?: () => void;
  /**
   * K3 (native mode): the user's external MCP servers in Claude's `--mcp-config` format, read at
   * session start. Claude runs them itself next to the Synorch relay (no double proxy); the relay
   * then leaves Synorch's own `mcp__*` registry tools out of its list.
   */
  readonly mcpServers?: () => Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface ClaudeArgsInput {
  readonly mcpConfigPath: string;
  readonly systemPromptPath: string;
  readonly modelId: string;
  readonly maxTurns: number;
  readonly sessionId: string;
  readonly resume: boolean;
  /** Native mode: full built-in toolset, Claude's permission mode, and the one workspace root. */
  readonly native?: { readonly permissionMode: ClaudePermissionMode; readonly addDir: string };
  /** K6: `--effort low|medium|high|xhigh|max` (verified with `claude --help`, 2.1.282); `ultra` is sent as `max`. */
  readonly effort?: ReasoningEffort;
  /** K3: extra `--allowedTools` entries (external MCP servers allowed without Claude asking, e.g. `mcp__playwright`). */
  readonly allowedTools?: readonly string[];
}

/**
 * `claude -p` in bidirectional stream-json mode. Restricted: every built-in tool disabled, only the
 * Synorch MCP server loaded and user/project settings (hooks, CLAUDE.md, `.mcp.json`) excluded.
 * Native: Claude's full built-in toolset, its permission mode mapped from Synorch's, the user's own
 * Claude settings (never project/local settings a repository could plant), `--add-dir` for the one
 * workspace root, and still only the Synorch MCP server. `--bare` is deliberately absent: it
 * disables the subscription login (research: cli-bridges §1.2).
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const native = input.native;
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(native === undefined ? ["--tools", ""] : ["--permission-mode", native.permissionMode, "--add-dir", native.addDir]),
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    [`${CLAUDE_TOOL_PREFIX}*`, ...(input.allowedTools ?? [])].join(","),
    "--permission-prompt-tool",
    `${CLAUDE_TOOL_PREFIX}${PERMISSION_TOOL_NAME}`,
    "--setting-sources",
    native === undefined ? "" : "user",
    "--system-prompt-file",
    input.systemPromptPath,
    "--model",
    anthropicWireModelId(input.modelId),
    ...(input.effort === undefined ? [] : ["--effort", input.effort === "ultra" ? "max" : input.effort]),
    ...(input.resume ? ["--resume", input.sessionId] : ["--session-id", input.sessionId]),
    "--max-turns",
    String(input.maxTurns),
  ];
}

const API_KEY_SOURCES = new Set(["user", "project", "org", "temporary", "ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

/**
 * `system/init.apiKeySource` → the auth source shown to the user. Claude Code logged in with a
 * claude.ai subscription reports `none` (verified on 2.1.281): no API key is in use, and the bridge
 * strips every key/token variable, so `none` and `oauth` mean the subscription login.
 */
export function authSourceOf(apiKeySource: string | undefined): "subscription" | "api-key" | "unknown" {
  if (apiKeySource === "none" || apiKeySource === "oauth") return "subscription";
  if (apiKeySource === undefined) return "unknown";
  if (API_KEY_SOURCES.has(apiKeySource) || /key|helper|token/i.test(apiKeySource)) return "api-key";
  return "unknown";
}

function relayScriptPath(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `mcp-relay${path.extname(self)}`);
}

/**
 * `claude-code`: drives the user's own installed and logged-in Claude Code. Synorch never sees,
 * stores or reads its credentials; tools reach Synorch only through the MCP bridge.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): AgentBackendAdapter {
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;
  const probeEnv = bridgeEnvironment(options.env ?? process.env, {}, platform);
  const providerId = providerIdSchema.parse("anthropic");
  const native = options.mode === "native";

  async function locate(): Promise<ExecutableSpec | undefined> {
    if (options.executable !== undefined) return options.executable;
    const found = await findOnPath("claude", probeEnv, platform);
    return found === undefined ? undefined : { command: found };
  }

  async function probe(signal: AbortSignal): Promise<BackendProbe> {
    const executable = await locate();
    const base = { minimumVersion: CLAUDE_CODE_MINIMUM_VERSION, authSource: "unknown" as const, loginHint: CLAUDE_LOGIN_HINT };
    if (executable === undefined) return { ...base, installed: false, executable: undefined, version: undefined };
    try {
      const result = await runCaptured(executable, ["--version"], { cwd: process.cwd(), env: probeEnv, timeoutMs: 15_000, signal });
      const version = /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
      return { ...base, installed: result.code === 0, executable: executable.command, version };
    } catch {
      return { ...base, installed: false, executable: executable.command, version: undefined };
    }
  }

  return {
    kind: "agent-backend",
    adapterId: "claude-code",
    providerId,
    authMethod: "cli-bridge",
    nativeTools: native,
    probe,
    async discoverCapabilities(signal): Promise<ProviderCapabilities> {
      const probed = await probe(signal);
      return {
        schema_version: 1,
        provider_id: providerId,
        adapter_id: "claude-code",
        adapter_kind: "agent-backend",
        auth_method: "cli-bridge",
        auth_status: probed.installed ? "unknown" : "disconnected",
        billing: "unknown",
        quota_visibility: "none",
        loop_owner: "backend",
        tool_channel: "mcp",
        policy_status: "unclear",
        models: [],
        probed_at: now().toISOString(),
        source: "probe",
      };
    },
    async startSession(sessionOptions, signal) {
      if (!options.experimental) {
        throw new ProviderFailure(
          providerError("bridge_unavailable", "the Claude Code bridge is experimental; enable it explicitly before starting a session"),
        );
      }
      const executable = await locate();
      if (executable === undefined) {
        throw new ProviderFailure(providerError("bridge_unavailable", "claude executable not found on PATH"));
      }
      if (signal.aborted) throw new ProviderFailure(providerError("cancelled", "session start aborted"));
      return ClaudeCodeSession.start(executable, sessionOptions, {
        platform,
        interruptGraceMs: options.interruptGraceMs ?? 5_000,
        allowNonSubscriptionAuth: options.allowNonSubscriptionAuth === true,
        tempRoot: options.tempRoot ?? os.tmpdir(),
        native,
        permissionMode: options.permissionMode ?? (() => undefined),
        onWebContentRead: options.onWebContentRead ?? (() => undefined),
        mcpServers: native ? (options.mcpServers?.() ?? {}) : {},
      });
    },
    async health(signal) {
      const probed = await probe(signal);
      return probed.installed
        ? { state: "ok", checked_at: now().toISOString(), detail: `claude ${probed.version ?? "unknown version"}` }
        : { state: "down", checked_at: now().toISOString(), detail: "claude executable not found or not runnable" };
    },
  };
}

type Incoming =
  | { readonly kind: "message"; readonly message: Record<string, unknown> }
  | { readonly kind: "exit"; readonly code: number | null; readonly spawnError: string | undefined };

class Inbox {
  private readonly items: Incoming[] = [];
  private waiter: ((item: Incoming) => void) | undefined;

  public push(item: Incoming): void {
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  public next(): Promise<Incoming> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

interface ActiveTurn {
  readonly tools: ToolBridge;
  readonly approvals: ApprovalBridge;
  readonly observe: BackendBridges["observe"];
  readonly signal: AbortSignal;
}

interface SessionConfig {
  readonly platform: NodeJS.Platform;
  readonly interruptGraceMs: number;
  readonly tempRoot: string;
  readonly allowNonSubscriptionAuth: boolean;
  readonly native: boolean;
  readonly permissionMode: () => PermissionMode | undefined;
  readonly onWebContentRead: () => void;
  /** External MCP servers Claude runs itself (native mode only; empty otherwise). */
  readonly mcpServers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** sun_path holds 104 bytes on macOS and 108 on Linux, including the terminating NUL. */
const UNIX_SOCKET_PATH_LIMIT = 100;

class ClaudeCodeSession implements BackendSession {
  public readonly backendSessionId: string;
  private readonly executable: ExecutableSpec;
  private readonly options: BackendSessionOptions;
  private readonly config: SessionConfig;
  private readonly directory: string;
  private readonly socketDirectory: string | undefined;
  private readonly server: Server;
  private readonly serverAbort = new AbortController();
  private readonly sockets = new Set<Socket>();
  private readonly mcpConfigPath: string;
  private readonly systemPromptPath: string;
  private resume: boolean;
  private child: ChildProcess | undefined;
  private inbox = new Inbox();
  private stderrTail = "";
  private active: ActiveTurn | undefined;
  private readonly pendingCallIds = new Map<string, string[]>();
  private readonly knownCallIds = new Set<string>();
  private closed = false;

  private constructor(
    executable: ExecutableSpec,
    options: BackendSessionOptions,
    config: SessionConfig,
    directory: string,
    server: Server,
    socketDirectory: string | undefined,
  ) {
    this.executable = executable;
    this.options = options;
    this.config = config;
    this.directory = directory;
    this.socketDirectory = socketDirectory;
    this.server = server;
    this.backendSessionId = options.resumeBackendSessionId ?? randomUUID();
    this.resume = options.resumeBackendSessionId !== undefined;
    this.mcpConfigPath = path.join(directory, "mcp.json");
    this.systemPromptPath = path.join(directory, "system-prompt.txt");
  }

  public static async start(executable: ExecutableSpec, options: BackendSessionOptions, config: SessionConfig): Promise<ClaudeCodeSession> {
    const directory = await mkdtemp(path.join(config.tempRoot, "synorch-claude-"));
    await chmod(directory, 0o700).catch(() => undefined);
    const token = randomBytes(32).toString("hex");
    let socketDirectory: string | undefined;
    let endpoint =
      config.platform === "win32"
        ? `\\\\.\\pipe\\synorch-mcp-${randomBytes(12).toString("hex")}`
        : path.join(directory, "mcp.sock");
    if (config.platform !== "win32" && Buffer.byteLength(endpoint) > UNIX_SOCKET_PATH_LIMIT) {
      // A long TMPDIR (macOS /var/folders/..., a nested temp root) overflows sun_path: only the socket moves to /tmp.
      socketDirectory = await mkdtemp(path.join("/tmp", "syn-mcp-"));
      await chmod(socketDirectory, 0o700).catch(() => undefined);
      endpoint = path.join(socketDirectory, "mcp.sock");
    }
    const server = createServer();
    const session = new ClaudeCodeSession(executable, options, config, directory, server, socketDirectory);
    const mcp = new McpToolServer(
      {
        list: () => session.visibleTools(),
        call: (call, signal) => session.callTool(call.name, call.arguments, call.rpcId, signal),
        permission: (toolName, input, signal) => session.permission(toolName, input, signal),
      },
      SYNORCH_VERSION,
    );
    server.on("connection", (socket) => {
      session.sockets.add(socket);
      socket.once("close", () => session.sockets.delete(socket));
      serveMcpConnection(socket, mcp, token, session.serverAbort.signal);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const external = Object.fromEntries(Object.entries(config.mcpServers).filter(([name]) => name !== MCP_SERVER_NAME));
      const mcpConfig = {
        mcpServers: {
          ...external,
          [MCP_SERVER_NAME]: {
            type: "stdio",
            command: process.execPath,
            args: [relayScriptPath()],
            env: { SYNORCH_MCP_ENDPOINT: endpoint, SYNORCH_MCP_TOKEN: token },
          },
        },
      };
      await writeFile(session.mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
      await writeFile(session.systemPromptPath, options.systemPrompt, { mode: 0o600 });
    } catch (error: unknown) {
      await session.close();
      throw new ProviderFailure(providerError("bridge_unavailable", `could not prepare the MCP bridge: ${error instanceof Error ? error.message : String(error)}`));
    }
    return session;
  }

  /**
   * K3: external MCP servers run without Claude asking in auto and full (auto = autonomous, as in
   * the gateway); in ask its prompts reach Synorch's card, and plan refuses them there.
   */
  private externalAllowed(): string[] {
    const mode = this.config.permissionMode();
    if (mode !== "auto" && mode !== "full") return [];
    // Claude turns every character outside [A-Za-z0-9_-] of a server name into `_` in tool names (`plugin:exa:exa` → `mcp__plugin_exa_exa`).
    return Object.keys(this.config.mcpServers).filter((name) => name !== MCP_SERVER_NAME).map((name) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, "_")}`);
  }

  /** The relay's tool list: Synorch's registry, minus proxied MCP tools when Claude runs those servers itself. */
  private visibleTools(): readonly ToolDescriptor[] {
    const tools = this.active?.tools.list() ?? [];
    return Object.keys(this.config.mcpServers).length === 0 ? tools : tools.filter((tool) => !tool.name.startsWith("mcp__"));
  }

  public runTurn(input: BackendTurnInput, bridges: BackendBridges, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    return this.turn(input, bridges, signal);
  }

  private async *turn(
    input: BackendTurnInput,
    bridges: BackendBridges,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent> {
    const assembler = new StreamAssembler();
    const fail = (error: ProviderError): ModelStreamEvent => {
      const partial = assembler.partial();
      return partial === undefined ? { type: "error", error } : { type: "error", error, partial };
    };
    if (this.closed) {
      yield { type: "error", error: providerError("bridge_unavailable", "the backend session is closed") };
      return;
    }
    if (this.active !== undefined) {
      yield { type: "error", error: providerError("invalid_request", "a turn is already running in this backend session") };
      return;
    }
    const content = trailingUserContent(input, !this.resume);
    if (content === undefined) {
      yield { type: "error", error: providerError("invalid_request", "a backend turn needs a trailing user message") };
      return;
    }
    if (signal.aborted) {
      yield { type: "error", error: providerError("cancelled", "turn aborted before it started") };
      return;
    }

    this.active = { tools: bridges.tools, approvals: bridges.approvals, observe: bridges.observe, signal };
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void this.interrupt();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const spawned = this.ensureChild();
      if (spawned !== undefined) {
        yield { type: "error", error: spawned };
        return;
      }
      const start = modelStreamEventSchema.safeParse({ type: "start", request_id: input.requestId, route: input.route });
      if (!start.success) {
        yield { type: "error", error: providerError("invalid_request", "the turn input carries an invalid request id or route") };
        await this.stopChild();
        return;
      }
      yield start.data;
      this.child?.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);

      let initSent = false;
      let nextIndex = 0;
      let mapper: MessagesMapper | undefined;
      let sawStreamForCall = false;
      const native = this.config.native;
      /** Native mode: stream block indexes of the current message that are built-in tool uses (Claude runs them). */
      let skippedBlocks = new Set<number>();
      const nativeCalls = new Map<string, { readonly name: string; readonly input: Readonly<Record<string, unknown>> }>();

      while (true) {
        const incoming = await this.inbox.next();
        if (incoming.kind === "exit") {
          this.child = undefined;
          this.resume = true;
          if (aborted || signal.aborted) {
            yield fail(providerError("cancelled", "turn interrupted by user"));
          } else if (incoming.spawnError !== undefined) {
            yield fail(providerError("bridge_unavailable", `claude could not be started: ${incoming.spawnError}`));
          } else {
            yield fail(classifyBackendText(this.stderrTail, "stream_interrupted", `claude exited (code ${String(incoming.code)}) before the turn completed`));
          }
          return;
        }
        const message = incoming.message;
        const type = stringField(message, "type");
        const subtype = stringField(message, "subtype");

        if (type === "system" && subtype === "init") {
          if (initSent) continue;
          initSent = true;
          const tools = Array.isArray(message.tools) ? message.tools.filter((tool): tool is string => typeof tool === "string") : [];
          const foreign = tools.filter((tool) => !tool.startsWith(CLAUDE_TOOL_PREFIX));
          if (!native && foreign.length > 0) {
            yield fail(providerError("protocol_mismatch", `backend exposes built-in tools (${foreign.slice(0, 5).join(", ")}); the session was stopped`));
            await this.stopChild();
            return;
          }
          const authSource = authSourceOf(stringField(message, "apiKeySource"));
          if (authSource !== "subscription" && !this.config.allowNonSubscriptionAuth) {
            yield fail(
              providerError(
                "forbidden",
                `claude reported auth source ${authSource} (apiKeySource ${stringField(message, "apiKeySource") ?? "missing"}), not the subscription login; the turn was refused. ${CLAUDE_LOGIN_HINT} To accept other sources set allow_non_subscription_auth: true on the claude-code adapter in the user configuration.`,
              ),
            );
            await this.stopChild();
            return;
          }
          const init = modelStreamEventSchema.safeParse({
            type: "backend_init",
            backend_session_id: stringField(message, "session_id") ?? this.backendSessionId,
            model_id: stringField(message, "model") ?? this.options.modelId,
            auth_source: authSource,
            tools,
          });
          if (!init.success) {
            yield fail(providerError("protocol_mismatch", "backend init message is malformed"));
            await this.stopChild();
            return;
          }
          yield init.data;
          continue;
        }

        // Native mode: a subagent's (Task) own stream is Claude's business, not this conversation's.
        if (native && typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id !== "") continue;

        if (type === "user") {
          if (native) this.observeResults(message, nativeCalls);
          continue;
        }

        if (type === "stream_event") {
          const event = record(message.event);
          if (event === undefined) continue;
          const eventType = stringField(event, "type");
          if (eventType === "message_start" || mapper === undefined) {
            const base = nextIndex;
            mapper = new MessagesMapper(() => base, assembler);
            sawStreamForCall = true;
            skippedBlocks = new Set();
          }
          const block = record(event.content_block);
          const blockIndex = numberField(event, "index");
          if (native && blockIndex !== undefined && skippedBlocks.has(blockIndex)) continue;
          let payload = event;
          if (eventType === "content_block_start" && stringField(block, "type") === "tool_use") {
            const name = stringField(block, "name") ?? "";
            if (native && !name.startsWith(CLAUDE_TOOL_PREFIX)) {
              if (blockIndex !== undefined) skippedBlocks.add(blockIndex);
              continue;
            }
            if (!name.startsWith(CLAUDE_TOOL_PREFIX)) {
              yield fail(providerError("protocol_mismatch", `backend called a non-Synorch tool: ${name}`));
              await this.stopChild();
              return;
            }
            const stripped = name.slice(CLAUDE_TOOL_PREFIX.length);
            this.rememberCall(stripped, stringField(block, "id"));
            payload = { ...event, content_block: { ...block, name: stripped } };
          }
          for (const mapped of mapper.mapEvent(payload)) {
            if (mapped.type === "done" || mapped.type === "usage") continue;
            if ("index" in mapped) nextIndex = Math.max(nextIndex, mapped.index + 1);
            yield mapped;
            if (mapped.type === "error") {
              await this.stopChild();
              return;
            }
          }
          continue;
        }

        if (type === "assistant") {
          const content = Array.isArray(record(message.message)?.content) ? (record(message.message)?.content as unknown[]) : [];
          if (native) this.observeCalls(content, nativeCalls);
          if (!sawStreamForCall) {
            for (const [offset, raw] of content.entries()) {
              const block = record(raw);
              const index = nextIndex + offset;
              const blockType = stringField(block, "type");
              if (blockType === "text") yield assembler.text(index, stringField(block, "text") ?? "");
              else if (blockType === "thinking") yield assembler.thinking(index, stringField(block, "thinking") ?? "");
              else if (blockType === "tool_use") {
                const name = stringField(block, "name") ?? "";
                if (native && !name.startsWith(CLAUDE_TOOL_PREFIX)) continue;
                if (!name.startsWith(CLAUDE_TOOL_PREFIX)) {
                  yield fail(providerError("protocol_mismatch", `backend called a non-Synorch tool: ${name}`));
                  await this.stopChild();
                  return;
                }
                const stripped = name.slice(CLAUDE_TOOL_PREFIX.length);
                const id = stringField(block, "id") ?? `toolu_${index}`;
                this.rememberCall(stripped, id);
                yield assembler.toolStart(index, id, stripped);
                const ended = assembler.toolEnd(index, JSON.stringify(record(block?.input) ?? {}));
                if (ended !== undefined && "type" in ended) yield ended;
              }
            }
            nextIndex += content.length;
          }
          mapper = undefined;
          sawStreamForCall = false;
          continue;
        }

        if (type === "result") {
          if (aborted || signal.aborted) {
            yield fail(providerError("cancelled", "turn interrupted by user"));
            await this.stopChild();
            return;
          }
          yield* this.finishTurn(message, assembler, fail, nextIndex);
          return;
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.active = undefined;
    }
  }

  private *finishTurn(
    message: Record<string, unknown>,
    assembler: StreamAssembler,
    fail: (error: ProviderError) => ModelStreamEvent,
    nextIndex: number,
  ): Generator<ModelStreamEvent> {
    const subtype = stringField(message, "subtype");
    const isError = message.is_error === true;
    const rawUsage = record(message.usage);
    const cost = numberField(message, "total_cost_usd");
    const usage = usageOf(
      {
        input_tokens: numberField(rawUsage, "input_tokens"),
        output_tokens: numberField(rawUsage, "output_tokens"),
        cache_read_tokens: numberField(rawUsage, "cache_read_input_tokens"),
        cache_write_tokens: numberField(rawUsage, "cache_creation_input_tokens"),
      },
      rawUsage === undefined ? "unknown" : "provider-reported",
    );
    const withCost = cost !== undefined && cost >= 0 ? { ...usage, cost_usd_estimate: cost } : usage;
    if (!isError && (subtype === "success" || subtype === "error_max_turns")) {
      const resultText = stringField(message, "result");
      if (resultText !== undefined && resultText !== "" && assembler.partial() === undefined) yield assembler.text(nextIndex, resultText);
      if (rawUsage !== undefined) yield { type: "usage", usage: withCost };
      yield { type: "done", stop_reason: subtype === "error_max_turns" ? "length" : "stop", message: assembler.message(), usage: withCost };
      return;
    }
    if (subtype === "error_max_turns") {
      if (rawUsage !== undefined) yield { type: "usage", usage: withCost };
      yield { type: "done", stop_reason: "length", message: assembler.message(), usage: withCost };
      return;
    }
    const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === "string") : [];
    const detail = [stringField(message, "result"), ...errors].filter((item): item is string => item !== undefined && item !== "").join("; ");
    yield fail(classifyBackendText(detail, "provider_internal", detail === "" ? `backend turn failed (${subtype ?? "unknown"})` : detail));
  }

  /** Native mode: a built-in tool_use (Claude runs it) becomes a `started` observation, never a Synorch call. */
  private observeCalls(content: readonly unknown[], calls: Map<string, { readonly name: string; readonly input: Readonly<Record<string, unknown>> }>): void {
    for (const raw of content) {
      const block = record(raw);
      if (stringField(block, "type") !== "tool_use") continue;
      const name = stringField(block, "name") ?? "";
      const id = stringField(block, "id");
      if (name === "" || name.startsWith(CLAUDE_TOOL_PREFIX) || id === undefined || calls.has(id)) continue;
      const input = record(block?.input) ?? {};
      calls.set(id, { name, input });
      this.emitObservation({ phase: "started", toolUseId: id, toolName: name, inputSummary: claudeInputSummary(name, input) });
    }
  }

  /** Native mode: `tool_result` blocks of built-in calls become `finished` observations; web results fire the taint hook. */
  private observeResults(message: Record<string, unknown>, calls: Map<string, { readonly name: string; readonly input: Readonly<Record<string, unknown>> }>): void {
    const content = record(message.message)?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = record(raw);
      if (stringField(block, "type") !== "tool_result") continue;
      const id = stringField(block, "tool_use_id");
      const call = id === undefined ? undefined : calls.get(id);
      if (id === undefined || call === undefined) continue;
      calls.delete(id);
      const isError = block?.is_error === true;
      const counts = isError ? undefined : claudeLineCounts(call.name, call.input);
      if (isClaudeWebTool(call.name) && !isError) {
        try {
          this.config.onWebContentRead();
        } catch {
          // A failing listener never breaks the turn.
        }
      }
      this.emitObservation({
        phase: "finished",
        toolUseId: id,
        toolName: call.name,
        inputSummary: claudeInputSummary(call.name, call.input),
        isError,
        resultSummary: claudeResultSummary(call.name, toolResultText(block?.content), isError),
        ...(counts === undefined ? {} : { linesAdded: counts.added, linesRemoved: counts.removed }),
      });
    }
  }

  private emitObservation(observation: Parameters<NonNullable<BackendBridges["observe"]>>[0]): void {
    try {
      this.active?.observe?.(observation);
    } catch {
      // Observation is audit and display only.
    }
  }

  private rememberCall(name: string, id: string | undefined): void {
    if (id === undefined || this.knownCallIds.has(id)) return;
    this.knownCallIds.add(id);
    const queue = this.pendingCallIds.get(name) ?? [];
    queue.push(id);
    this.pendingCallIds.set(name, queue);
  }

  /**
   * Records tool_use ids as soon as a line arrives, before the turn consumer reads it, so an MCP
   * `tools/call` (which carries no id) can be matched to the backend's `tool_use` id in FIFO order.
   */
  private observe(message: Record<string, unknown>): void {
    const blocks: unknown[] = [];
    if (stringField(message, "type") === "stream_event") {
      const event = record(message.event);
      if (stringField(event, "type") === "content_block_start") blocks.push(event?.content_block);
    } else if (stringField(message, "type") === "assistant") {
      const content = record(message.message)?.content;
      if (Array.isArray(content)) blocks.push(...content);
    }
    for (const raw of blocks) {
      const block = record(raw);
      const name = stringField(block, "name") ?? "";
      if (stringField(block, "type") === "tool_use" && name.startsWith(CLAUDE_TOOL_PREFIX)) {
        this.rememberCall(name.slice(CLAUDE_TOOL_PREFIX.length), stringField(block, "id"));
      }
    }
  }

  private async callId(name: string, rpcId: string, signal: AbortSignal): Promise<string> {
    for (let waited = 0; waited < CALL_ID_WAIT_MS && !signal.aborted; waited += 10) {
      const id = this.pendingCallIds.get(name)?.shift();
      if (id !== undefined) return id;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.pendingCallIds.get(name)?.shift() ?? `mcp_${rpcId}`;
  }

  private async callTool(name: string, args: Readonly<Record<string, unknown>>, rpcId: string, signal: AbortSignal) {
    const active = this.active;
    if (active === undefined) return { isError: true, text: "no Synorch turn is active" };
    const providerCallId = await this.callId(name, rpcId, AbortSignal.any([signal, active.signal]));
    const combined = AbortSignal.any([signal, active.signal]);
    return active.tools.call({ providerCallId, name, arguments: args }, combined);
  }

  private async permission(toolName: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal) {
    const active = this.active;
    const stripped = toolName.startsWith(CLAUDE_TOOL_PREFIX) ? toolName.slice(CLAUDE_TOOL_PREFIX.length) : undefined;
    if (active !== undefined && stripped === undefined && this.config.native && toolName !== "") {
      // Native mode: Claude's own permission prompt for a built-in goes to Synorch's approval broker.
      return active.approvals.decide(toolName, input, AbortSignal.any([signal, active.signal]));
    }
    if (active === undefined || stripped === undefined || !this.visibleTools().some((tool) => tool.name === stripped)) {
      return { allow: false, reason: "only Synorch bridge tools are permitted" };
    }
    return active.approvals.decide(toolName, input, AbortSignal.any([signal, active.signal]));
  }

  private ensureChild(): ProviderError | undefined {
    if (this.child !== undefined) return undefined;
    this.inbox = new Inbox();
    this.stderrTail = "";
    const args = buildClaudeArgs({
      mcpConfigPath: this.mcpConfigPath,
      systemPromptPath: this.systemPromptPath,
      modelId: this.options.modelId,
      maxTurns: this.options.maxTurns,
      sessionId: this.backendSessionId,
      resume: this.resume,
      ...(this.options.reasoningEffort === undefined ? {} : { effort: this.options.reasoningEffort }),
      ...(this.config.native ? { native: { permissionMode: claudePermissionMode(this.config.permissionMode()), addDir: this.options.cwd } } : {}),
      ...(this.externalAllowed().length === 0 ? {} : { allowedTools: this.externalAllowed() }),
    });
    let child: ChildProcess;
    try {
      child = spawnBackend(this.executable, args, {
        cwd: this.options.cwd,
        env: bridgeEnvironment(this.options.env, {}, this.config.platform),
        platform: this.config.platform,
      });
    } catch (error: unknown) {
      return providerError("bridge_unavailable", `claude could not be started: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.child = child;
    const inbox = this.inbox;
    let buffer = "";
    let spawnError: string | undefined;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") continue;
        try {
          const parsed = record(JSON.parse(line));
          if (parsed === undefined) continue;
          this.observe(parsed);
          inbox.push({ kind: "message", message: parsed });
        } catch {
          continue;
        }
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("close", (code) => {
      if (this.child === child) this.child = undefined;
      inbox.push({ kind: "exit", code, spawnError });
    });
    return undefined;
  }

  /** SIGINT first (the CLI finishes the turn cleanly), SIGTERM after the grace period. */
  public async interrupt(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        terminate(child, "SIGTERM", this.config.platform);
        setTimeout(resolve, 1_000).unref();
      }, this.config.interruptGraceMs);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      terminate(child, "SIGINT", this.config.platform);
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    this.resume = true;
    terminate(child, "SIGTERM", this.config.platform);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.interrupt();
    if (this.child !== undefined) terminate(this.child, "SIGTERM", this.config.platform);
    this.serverAbort.abort();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
    if (this.socketDirectory !== undefined) await rm(this.socketDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

type UserBlock = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string } };

/**
 * The trailing user messages as stream-json content blocks: text, and images as base64 `image`
 * blocks (the driver fills `data` from the blob store right before the turn; K1.5-B).
 */
function trailingUserContent(input: BackendTurnInput, fresh = false): UserBlock[] | undefined {
  const blocks: UserBlock[] = [];
  let index = input.messages.length - 1;
  for (; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined || message.role !== "user") break;
    const own: UserBlock[] = [];
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    if (text !== "") own.push({ type: "text", text });
    for (const part of message.content) {
      if (part.type === "image" && part.data !== undefined) own.push({ type: "image", source: { type: "base64", media_type: part.blob.media_type, data: part.data } });
    }
    blocks.unshift(...own);
  }
  if (!blocks.some((block) => block.type === "text")) return undefined;
  const history = fresh ? priorTranscript(input.messages.slice(0, index + 1)) : undefined;
  return history === undefined ? blocks : [{ type: "text", text: history }, ...blocks];
}

const HISTORY_LIMIT = 60_000;

/**
 * A fresh Claude session (`--session-id`) knows nothing of the Synorch conversation so far: a
 * resumed Synorch session (`syn agent --resume`, the backend map is in memory only), a model
 * switch, or a switch from another provider. The earlier turns go in once, as a transcript block;
 * later steps `--resume` the Claude session and send only the new user message.
 */
export function priorTranscript(messages: readonly BackendTurnInput["messages"][number][]): string | undefined {
  const lines: string[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim() !== "") lines.push(`${message.role === "assistant" ? "Assistant" : "User"}: ${part.text.trim()}`);
      else if (part.type === "tool_call") lines.push(`Assistant called ${part.name} ${JSON.stringify(part.arguments).slice(0, 300)}`);
      else if (part.type === "tool_result") lines.push(`${part.is_error ? "Tool error" : "Tool result"}: ${part.text.replace(/\s+/g, " ").trim().slice(0, 500)}`);
      else if (part.type === "image") lines.push("User: [an image was attached earlier]");
    }
  }
  if (lines.length === 0) return undefined;
  let text = lines.join("\n");
  if (text.length > HISTORY_LIMIT) text = `[earlier turns omitted]\n${text.slice(-HISTORY_LIMIT)}`;
  return `<conversation_so_far>\nThe earlier turns of this conversation (recorded by Synorch; continue from them, do not repeat them):\n${text}\n</conversation_so_far>`;
}

/** Recognizes `Login expired · Please run /login` and rate/billing failures in backend output. */
export function classifyBackendText(text: string, fallback: ProviderError["code"], message: string): ProviderError {
  if (/login expired|not logged in|please run \/login|authentication_failed|oauth_org_not_allowed|invalid api key/i.test(text)) {
    return providerError("auth_expired", `${message}. ${CLAUDE_LOGIN_HINT}`);
  }
  if (/rate[_ ]limit|overloaded/i.test(text)) return providerError("rate_limited", message);
  if (/billing_error|out of extra usage|usage limit/i.test(text)) return providerError("quota_exhausted", message);
  return providerError(fallback, message);
}
