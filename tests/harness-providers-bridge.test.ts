import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_STRIPPED_ENV,
  createId,
  modelIdSchema,
  providerCapabilitiesSchema,
  providerIdSchema,
  ProviderFailure,
  type ApprovalBridge,
  type BackendSessionOptions,
  type ModelRoute,
  type ModelStreamEvent,
  type ToolBridge,
  type ToolBridgeCall,
} from "../src/harness/contracts/index.ts";
import {
  bridgeEnvironment,
  buildClaudeArgs,
  checkStreamGrammar,
  collectStream,
  createClaudeCodeAdapter,
  createCodexAppServerAdapter,
  type ExecutableSpec,
} from "../src/harness/providers/index.ts";
import { McpToolServer } from "../src/harness/providers/claude-code/mcp-server.ts";
import { quoteForCmd } from "../src/harness/providers/claude-code/process.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/providers/fake-claude.mjs", import.meta.url));
const route: ModelRoute = {
  provider_id: providerIdSchema.parse("anthropic"),
  model_id: modelIdSchema.parse("opus-test"),
  adapter_id: "claude-code",
  adapter_kind: "agent-backend",
  auth_method: "cli-bridge",
  profile: "default",
};

function recordingBridge(): ToolBridge & { readonly calls: ToolBridgeCall[] } {
  const calls: ToolBridgeCall[] = [];
  return {
    serverName: "synorch",
    calls,
    list: () => [
      { name: "read_file", description: "Read a workspace file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ],
    async call(call) {
      calls.push(call);
      return { isError: false, text: `contents of ${String(call.arguments.path)}` };
    },
  };
}

const approvals: ApprovalBridge = {
  async decide(toolName) {
    return { allow: toolName.startsWith("mcp__synorch__"), reason: "gateway decides bridge tools" };
  },
};

async function withSession(
  scenario: string,
  body: (context: {
    readonly run: (text: string, signal?: AbortSignal, onEvent?: (event: ModelStreamEvent) => void) => Promise<ModelStreamEvent[]>;
    readonly report: () => Promise<Record<string, unknown>>;
    readonly bridge: ReturnType<typeof recordingBridge>;
  }) => Promise<void>,
  executable: ExecutableSpec = { command: process.execPath, args: [FAKE_CLAUDE] },
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-bridge-test-"));
  const reportPath = path.join(directory, "report.json");
  const adapter = createClaudeCodeAdapter({
    experimental: true,
    executable,
    interruptGraceMs: 2_000,
    tempRoot: directory,
  });
  const options: BackendSessionOptions = {
    cwd: directory,
    modelId: "opus-test",
    systemPrompt: "You are the Synorch implementer.",
    maxTurns: 8,
    resumeBackendSessionId: undefined,
    env: {
      ...bridgeEnvironment(process.env),
      ANTHROPIC_API_KEY: "sk-ant-should-never-reach-the-child",
      ANTHROPIC_AUTH_TOKEN: "token-should-never-reach-the-child",
      OPENAI_API_KEY: "sk-openai-should-never-reach-the-child",
      FAKE_CLAUDE_SCENARIO: scenario,
      FAKE_CLAUDE_REPORT: reportPath,
    },
  };
  const session = await adapter.startSession(options, new AbortController().signal);
  const bridge = recordingBridge();
  try {
    await body({
      bridge,
      report: async () => JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>,
      run: async (text, signal = new AbortController().signal, onEvent) => {
        const events: ModelStreamEvent[] = [];
        const stream = session.runTurn(
          { requestId: createId("request"), route, messages: [{ role: "user", content: [{ type: "text", text }] }] },
          { tools: bridge, approvals },
          signal,
        );
        for await (const event of stream) {
          events.push(event);
          onEvent?.(event);
        }
        assert.deepEqual(checkStreamGrammar(events), []);
        return events;
      },
    });
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("claude args disable built-ins, load only the Synorch MCP server and never use --bare", () => {
  const args = buildClaudeArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.txt", modelId: "opus", maxTurns: 3, sessionId: "abc", resume: false });
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at("--tools"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(at("--input-format"), "stream-json");
  assert.equal(at("--output-format"), "stream-json");
  assert.equal(at("--allowedTools"), "mcp__synorch__*");
  assert.equal(at("--setting-sources"), "");
  assert.equal(at("--session-id"), "abc");
  assert.ok(!args.includes("--bare"));
  const resumed = buildClaudeArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.txt", modelId: "opus", maxTurns: 3, sessionId: "abc", resume: true });
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "abc");
});

test("bridge environment strips every BRIDGE_STRIPPED_ENV name, case-insensitively on Windows", () => {
  const env = bridgeEnvironment({ PATH: "/bin", ANTHROPIC_API_KEY: "a", openai_api_key: "b", CODEX_API_KEY: "c", ANTHROPIC_AUTH_TOKEN: "d" }, {}, "win32");
  assert.deepEqual(env, { PATH: "/bin" });
  const posix = bridgeEnvironment({ PATH: "/bin", ANTHROPIC_API_KEY: "a", Anthropic_Api_Key: "kept-on-posix" }, {}, "linux");
  assert.deepEqual(posix, { PATH: "/bin", Anthropic_Api_Key: "kept-on-posix" });
  for (const name of BRIDGE_STRIPPED_ENV) assert.equal(bridgeEnvironment({ [name]: "x" }, {}, "linux")[name], undefined);
});

test("AC-5 bridge: API keys are stripped, MCP tool calls go through ToolBridge.call and the turn maps to the stream grammar", async () => {
  await withSession("tool", async ({ run, report, bridge }) => {
    const events = await run("please read src/a.ts");
    const facts = await report();
    assert.equal(facts.hasAnthropicKey, false, "ANTHROPIC_API_KEY must not reach the child");
    assert.equal(facts.hasAuthToken, false);
    assert.equal(facts.hasOpenAiKey, false);
    assert.ok(!(facts.argv as string[]).includes("--bare"));
    assert.deepEqual(facts.listedTools, ["read_file", "approve"]);

    assert.equal(bridge.calls.length, 1);
    assert.deepEqual(bridge.calls[0], { providerCallId: "toolu_fake_1", name: "read_file", arguments: { path: "src/a.ts" } });
    assert.deepEqual(facts.toolResult, { text: "contents of src/a.ts", isError: false });

    assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["start", "backend_init"]);
    const init = events[1];
    assert.ok(init?.type === "backend_init");
    assert.equal(init.auth_source, "subscription");
    assert.ok(init.tools.every((tool) => tool.startsWith("mcp__synorch__")));
    const toolStart = events.find((event) => event.type === "tool_call_start");
    assert.ok(toolStart?.type === "tool_call_start" && toolStart.name === "read_file");
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    assert.equal(done.stop_reason, "stop");
    assert.deepEqual(done.message.content, [
      { type: "tool_call", provider_call_id: "toolu_fake_1", name: "read_file", arguments: { path: "src/a.ts" } },
      { type: "text", text: "Read: contents of src/a.ts" },
    ]);
    assert.equal(done.usage?.input_tokens, 200);
    assert.equal(done.usage?.cost_usd_estimate, 0.0123);

    const second = await run("again");
    assert.equal(second.at(-1)?.type, "done", "the long-lived process serves a second turn");
    assert.equal(second[0]?.type, "start");
    assert.equal(bridge.calls[1]?.providerCallId, "toolu_fake_2");
  });
});

test("AC-5 negative: built-in tools in backend_init stop the session with protocol_mismatch", async () => {
  await withSession("builtin", async ({ run, bridge }) => {
    const events = await run("hi");
    const last = events.at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.error.code, "protocol_mismatch");
    assert.match(last.error.message, /Bash/);
    assert.ok(!events.some((event) => event.type === "backend_init"));
    assert.equal(bridge.calls.length, 0);
  });
});

test("bridge maps `Login expired` to auth_expired with a claude /login hint", async () => {
  await withSession("login-expired", async ({ run }) => {
    const last = (await run("hi")).at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.error.code, "auth_expired");
    assert.match(last.error.message, /claude \/login/);
  });
});

test("bridge abort interrupts the child and ends in error{cancelled} with partial text", async () => {
  await withSession("hang", async ({ run }) => {
    const controller = new AbortController();
    const events = await run("think", controller.signal, (event) => {
      if (event.type === "text_delta") controller.abort();
    });
    const last = events.at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.error.code, "cancelled");
    assert.deepEqual(last.partial?.content, [{ type: "text", text: "thinking about it" }]);
    assert.ok(!events.some((event) => event.type === "done"));
  });
});

test("bridge permission tool denies anything that is not a Synorch bridge tool", async () => {
  await withSession("permission", async ({ run, report }) => {
    assert.equal((await run("check")).at(-1)?.type, "done");
    const facts = await report();
    assert.deepEqual(facts.permission, {
      denied: { behavior: "deny", message: "only Synorch bridge tools are permitted" },
      allowed: { behavior: "allow", updatedInput: { path: "a" } },
    });
    const mcp = facts.mcp as { method: string; result?: { serverInfo?: { name?: string } }; error?: { code?: number } }[];
    assert.equal(mcp[0]?.result?.serverInfo?.name, "synorch");
    assert.equal(mcp[1]?.error?.code, -32601);
  });
});

test("the bridge refuses to start without the experimental opt-in or without claude", async () => {
  const options: BackendSessionOptions = { cwd: os.tmpdir(), modelId: "m", systemPrompt: "", maxTurns: 1, resumeBackendSessionId: undefined, env: {} };
  const disabled = createClaudeCodeAdapter({ experimental: false, executable: { command: process.execPath, args: [FAKE_CLAUDE] } });
  await assert.rejects(disabled.startSession(options, new AbortController().signal), (error: unknown) => error instanceof ProviderFailure && error.error.code === "bridge_unavailable");
  const missing = createClaudeCodeAdapter({ experimental: true, env: { PATH: "" } });
  await assert.rejects(missing.startSession(options, new AbortController().signal), (error: unknown) => error instanceof ProviderFailure && error.error.code === "bridge_unavailable");
  const probe = await missing.probe(new AbortController().signal);
  assert.equal(probe.installed, false);
  const installed = await createClaudeCodeAdapter({ experimental: true, executable: { command: process.execPath, args: [FAKE_CLAUDE] } }).probe(new AbortController().signal);
  assert.equal(installed.installed, true);
  assert.equal(installed.version, "9.9.9");
  assert.equal(installed.authSource, "unknown");
  const capabilities = await disabled.discoverCapabilities(new AbortController().signal);
  assert.ok(providerCapabilitiesSchema.safeParse(capabilities).success);
  assert.equal(capabilities.tool_channel, "mcp");
  assert.equal(capabilities.policy_status, "unclear");
});

test("MCP server answers initialize, tools/list, tools/call and rejects unknown or malformed input", async () => {
  const calls: string[] = [];
  const server = new McpToolServer(
    {
      list: () => [{ name: "read_file", description: "d", input_schema: { type: "object" } }],
      call: async (call) => {
        calls.push(call.name);
        return { isError: false, text: "ok" };
      },
      permission: async () => ({ allow: false, reason: "no" }),
    },
    "0.0.0",
  );
  const signal = new AbortController().signal;
  const parse = (line: string | undefined) => JSON.parse(line ?? "null") as { id: unknown; result?: Record<string, unknown>; error?: { code: number } };
  const init = parse(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }), signal));
  assert.equal(init.result?.protocolVersion, "2024-11-05");
  const future = parse(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }), signal));
  assert.equal(future.result?.protocolVersion, "2025-06-18");
  assert.equal(await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal), undefined);
  const list = parse(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), signal));
  assert.deepEqual((list.result?.tools as { name: string }[]).map((tool) => tool.name), ["read_file", "approve"]);
  const call = parse(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: "x" } } }), signal));
  assert.deepEqual(call.result, { content: [{ type: "text", text: "ok" }], isError: false });
  const unknownTool = parse(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "exec", arguments: {} } }), signal));
  assert.equal(unknownTool.result?.isError, true);
  assert.deepEqual(calls, ["read_file"]);
  assert.equal(parse(await server.handle("{not json", signal)).error?.code, -32700);
  assert.equal(parse(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "sampling/createMessage" }), signal)).error?.code, -32601);
  assert.equal(parse(await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: 3 } }), signal)).error?.code, -32602);
});

test("cmd.exe quoting keeps metacharacters literal and refuses unquotable input", () => {
  assert.equal(quoteForCmd(""), '""');
  assert.equal(quoteForCmd("mcp__synorch__*"), '"mcp__synorch__*"');
  assert.equal(quoteForCmd("C:\\Program Files\\a&b"), '"C:\\Program Files\\a&b"');
  for (const unsafe of ['a"b', "%PATH%", "a\nb"]) assert.throws(() => quoteForCmd(unsafe));
});

test("an npm-style claude.cmd shim is launched through cmd.exe with an empty --tools value intact", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-cmd-shim-"));
  try {
    const shim = path.join(directory, "claude.cmd");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
    const probe = await createClaudeCodeAdapter({ experimental: true, executable: { command: shim } }).probe(new AbortController().signal);
    assert.equal(probe.version, "9.9.9");
    await withSession(
      "tool",
      async ({ run, report, bridge }) => {
        assert.equal((await run("read it")).at(-1)?.type, "done");
        const argv = (await report()).argv as string[];
        assert.equal(argv[argv.indexOf("--tools") + 1], "");
        assert.equal(argv[argv.indexOf("--allowedTools") + 1], "mcp__synorch__*");
        assert.equal(bridge.calls.length, 1);
      },
      { command: shim },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codex-app-server is a seam only and never spawns anything", async () => {
  const adapter = createCodexAppServerAdapter();
  assert.equal((await adapter.probe(new AbortController().signal)).installed, false);
  assert.ok(providerCapabilitiesSchema.safeParse(await adapter.discoverCapabilities(new AbortController().signal)).success);
  const options: BackendSessionOptions = { cwd: os.tmpdir(), modelId: "m", systemPrompt: "", maxTurns: 1, resumeBackendSessionId: undefined, env: {} };
  await assert.rejects(adapter.startSession(options, new AbortController().signal), ProviderFailure);
  const result = await collectStream((async function* () {})());
  assert.equal(result.threw, undefined);
});
