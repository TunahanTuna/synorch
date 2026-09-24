#!/usr/bin/env node
// Test double for `claude` in native mode (stream-json). It never contacts Anthropic: it acts as an
// MCP client of the Synorch relay named in --mcp-config, exposes built-in tools in system/init, asks
// the permission-prompt tool before "running" Bash, and emits native tool_use / tool_result lines.
// FAKE_CLAUDE_SCENARIO: native (default)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}

const reportPath = process.env.FAKE_CLAUDE_REPORT;
const report = { argv, turns: 0, permissions: [] };
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
const permissionTool = flag("--permission-prompt-tool") ?? "";
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

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "9.9.9" } });
relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

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
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools: ["Task", "Bash", "Edit", "Read", "WebFetch", "WebSearch", "TodoWrite", ...tools],
    mcp_servers: [{ name: "synorch", status: "connected" }],
    apiKeySource: "none",
  });
}

/** Asks Synorch through the permission-prompt tool exactly as Claude Code does; returns the parsed answer. */
async function ask(toolName, input, toolUseId) {
  const name = permissionTool.replace(/^mcp__synorch__/, "");
  const answer = await rpc("tools/call", { name, arguments: { tool_name: toolName, input, tool_use_id: toolUseId } });
  const parsed = JSON.parse(answer.result.content[0].text);
  report.permissions.push({ toolName, answer: parsed });
  saveReport();
  return parsed;
}

function streamToolUse(messageId, id, name, input) {
  emit({ type: "stream_event", event: { type: "message_start", message: { id: messageId, usage: { input_tokens: 10, output_tokens: 1 } } } });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Running the tests. " } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } } });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  emit({ type: "assistant", message: { id: messageId, role: "assistant", content: [{ type: "text", text: "Running the tests. " }, { type: "tool_use", id, name, input }] } });
}

async function onUser() {
  report.turns += 1;
  saveReport();
  await sendInit();

  // 1. Bash, streamed, after a permission prompt.
  const bashInput = { command: process.env.FAKE_CLAUDE_BASH ?? "pnpm test" };
  streamToolUse("msg_bash", "toolu_bash", "Bash", bashInput);
  const bash = await ask("Bash", bashInput, "toolu_bash");
  emit({
    type: "user",
    message: {
      role: "user",
      content: [
        bash.behavior === "allow"
          ? { type: "tool_result", tool_use_id: "toolu_bash", content: "> vitest\n\n Tests  12 passed (12)\n" }
          : { type: "tool_result", tool_use_id: "toolu_bash", content: `Permission denied: ${bash.message}`, is_error: true },
      ],
    },
  });

  // 2. WebFetch, non-streamed assistant message.
  emit({ type: "assistant", message: { id: "msg_fetch", role: "assistant", content: [{ type: "tool_use", id: "toolu_fetch", name: "WebFetch", input: { url: "https://example.com/docs/page", prompt: "summarize" } }] } });
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fetch", content: [{ type: "text", text: "Example docs summary" }] }] } });

  // 3. Edit.
  emit({ type: "assistant", message: { id: "msg_edit", role: "assistant", content: [{ type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: "src/x.ts", old_string: "a\n", new_string: "b\nc\nd\n" } }] } });
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_edit", content: "The file src/x.ts has been updated." }] } });

  // 4. A subagent's own chatter (parent_tool_use_id) is not this conversation's text.
  emit({ type: "assistant", parent_tool_use_id: "toolu_task", message: { id: "msg_sub", role: "assistant", content: [{ type: "text", text: "SUBAGENT TEXT" }] } });

  // 5. A Synorch MCP tool call still goes through the bridge.
  emit({ type: "assistant", message: { id: "msg_mcp", role: "assistant", content: [{ type: "tool_use", id: "toolu_mcp", name: "mcp__synorch__read_file", input: { path: "src/a.ts" } }] } });
  const called = await rpc("tools/call", { name: "read_file", arguments: { path: "src/a.ts" } });
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mcp", content: called.result.content[0].text }] } });

  emit({ type: "assistant", message: { id: "msg_done", role: "assistant", content: [{ type: "text", text: "All done." }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "All done.", usage: { input_tokens: 50, output_tokens: 20 }, total_cost_usd: 0.01, session_id: sessionId });
}
