#!/usr/bin/env node
// Test double for the user's `claude` CLI (stream-json mode). It never contacts Anthropic: it acts as
// an MCP client of the Synorch relay named in --mcp-config and emits scripted stream-json lines.
// FAKE_CLAUDE_SCENARIO: tool | builtin | login-expired | hang | permission
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "tool";
const reportPath = process.env.FAKE_CLAUDE_REPORT;
const report = {
  argv,
  hasAnthropicKey: Object.keys(process.env).some((key) => key.toUpperCase() === "ANTHROPIC_API_KEY"),
  hasAuthToken: Object.keys(process.env).some((key) => key.toUpperCase() === "ANTHROPIC_AUTH_TOKEN"),
  hasOpenAiKey: Object.keys(process.env).some((key) => key.toUpperCase() === "OPENAI_API_KEY"),
  billingEnv: Object.keys(process.env).filter((key) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|AWS_BEARER_TOKEN_BEDROCK$)/i.test(key)),
  mcp: [],
  turns: 0,
};
const saveReport = () => {
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report));
};
saveReport();

const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? "fake-session";
const model = flag("--model") ?? "fake-model";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const config = JSON.parse(readFileSync(flag("--mcp-config"), "utf8"));
const server = config.mcpServers.synorch;
const relay = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
let relayBuffer = "";
let nextId = 1;
const pending = new Map();
relay.stdout.setEncoding("utf8").on("data", (chunk) => {
  relayBuffer += chunk;
  let newline = relayBuffer.indexOf("\n");
  while (newline !== -1) {
    const line = relayBuffer.slice(0, newline);
    relayBuffer = relayBuffer.slice(newline + 1);
    newline = relayBuffer.indexOf("\n");
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "9.9.9" } });
report.mcp.push({ method: "initialize", result: initialized.result });
relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const unknown = await rpc("resources/list", {});
report.mcp.push({ method: "resources/list", error: unknown.error });
saveReport();

let initSent = false;
let stdinBuffer = "";
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  stdinBuffer += chunk;
  let newline = stdinBuffer.indexOf("\n");
  while (newline !== -1) {
    const line = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    newline = stdinBuffer.indexOf("\n");
    if (line.trim() !== "") void onUser(JSON.parse(line));
  }
});

async function sendInit() {
  if (initSent) return;
  initSent = true;
  const listed = await rpc("tools/list", {});
  const tools = listed.result.tools.map((tool) => `mcp__synorch__${tool.name}`);
  report.listedTools = listed.result.tools.map((tool) => tool.name);
  saveReport();
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools: scenario === "builtin" ? ["Bash", "Read", ...tools] : tools,
    mcp_servers: [{ name: "synorch", status: "connected" }],
    apiKeySource: process.env.FAKE_CLAUDE_API_KEY_SOURCE ?? (process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none"),
  });
}

function streamText(text, id) {
  emit({ type: "stream_event", event: { type: "message_start", message: { id, usage: { input_tokens: 10, output_tokens: 1 } } } });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  emit({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
}

async function onUser(message) {
  report.turns += 1;
  report.lastUserText = message.message?.content?.[0]?.text;
  saveReport();
  await sendInit();
  if (scenario === "builtin") return;
  if (scenario === "login-expired") {
    emit({ type: "result", subtype: "success", is_error: true, result: "Login expired · Please run /login", session_id: sessionId });
    return;
  }
  if (scenario === "not-logged-in") {
    emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: sessionId });
    return;
  }
  if (scenario === "hang") {
    emit({ type: "stream_event", event: { type: "message_start", message: { id: "msg_hang" } } });
    emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "thinking about it" } } });
    return;
  }
  if (scenario === "permission") {
    const denied = await rpc("tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: "rm -rf /" } } });
    const allowed = await rpc("tools/call", { name: "approve", arguments: { tool_name: "mcp__synorch__read_file", input: { path: "a" } } });
    report.permission = { denied: JSON.parse(denied.result.content[0].text), allowed: JSON.parse(allowed.result.content[0].text) };
    saveReport();
    streamText("permissions checked", "msg_perm");
    emit({ type: "result", subtype: "success", is_error: false, result: "permissions checked", usage: { input_tokens: 1, output_tokens: 1 }, session_id: sessionId });
    return;
  }
  const toolId = `toolu_fake_${report.turns}`;
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "msg_tool", usage: { input_tokens: 100, output_tokens: 1 } } } });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: "mcp__synorch__read_file", input: {} } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"src/a.ts"}' } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } } });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  emit({ type: "assistant", message: { id: "msg_tool", role: "assistant", content: [{ type: "tool_use", id: toolId, name: "mcp__synorch__read_file", input: { path: "src/a.ts" } }] } });
  const called = await rpc("tools/call", { name: "read_file", arguments: { path: "src/a.ts" } });
  const resultText = called.result.content[0].text;
  report.toolResult = { text: resultText, isError: called.result.isError };
  saveReport();
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: resultText }] } });
  streamText(`Read: ${resultText}`, "msg_answer");
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `Read: ${resultText}`,
    usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.0123,
    session_id: sessionId,
  });
}
