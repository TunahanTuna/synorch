#!/usr/bin/env node
// Test double for the user's `claude` CLI acting as a Synorch *worker* (K1.5 cross-provider e2e).
// It never contacts Anthropic: it is an MCP client of the Synorch relay named in --mcp-config, writes
// one file through `write_file` and reports through `task_report`, both as MCP tool calls, exactly
// like Claude Code would with `--tools ""` and only the synorch MCP server loaded.
// Env: FAKE_WORKER_PATH, FAKE_WORKER_CONTENT, FAKE_WORKER_REPORT (JSON log for assertions).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const reportPath = process.env.FAKE_WORKER_REPORT;
const report = { argv, turns: 0, tools: [], calls: [] };
const save = () => {
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report));
};
save();

const sessionId = flag("--session-id") ?? flag("--resume") ?? "fake-session";
const model = flag("--model") ?? "fake-model";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const config = JSON.parse(readFileSync(flag("--mcp-config"), "utf8"));
const server = config.mcpServers.synorch;
const relay = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 1;
const pending = new Map();
relay.stdout.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
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
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude-worker", version: "9.9.9" } });
relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
let stdin = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  stdin += chunk;
  let newline = stdin.indexOf("\n");
  while (newline !== -1) {
    const line = stdin.slice(0, newline);
    stdin = stdin.slice(newline + 1);
    newline = stdin.indexOf("\n");
    if (line.trim() !== "") void onUser(JSON.parse(line));
  }
});

async function toolCall(id, name, args) {
  emit({ type: "assistant", message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name: `mcp__synorch__${name}`, input: args }] } });
  const answer = await rpc("tools/call", { name, arguments: args });
  const text = answer.result?.content?.[0]?.text ?? "";
  report.calls.push({ name, isError: answer.result?.isError === true, text: text.slice(0, 400) });
  save();
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  return answer;
}

async function onUser(message) {
  report.turns += 1;
  report.lastUser = message.message?.content?.map((block) => block.type) ?? [];
  const listed = await rpc("tools/list", {});
  const tools = listed.result.tools.map((tool) => tool.name);
  report.tools = tools;
  save();
  emit({ type: "system", subtype: "init", session_id: sessionId, model, tools: tools.map((name) => `mcp__synorch__${name}`), mcp_servers: [{ name: "synorch", status: "connected" }], apiKeySource: "none" });

  if (tools.includes("task_report") && report.turns === 1) {
    const target = process.env.FAKE_WORKER_PATH ?? "README.md";
    const content = process.env.FAKE_WORKER_CONTENT ?? "fixed\n";
    const current = readFileSync(path.join(process.cwd(), target));
    const digest = `sha256:${createHash("sha256").update(current).digest("hex")}`;
    await toolCall("toolu_write_1", "write_file", { path: target, content, expected_digest: digest });
    await toolCall("toolu_report_1", "task_report", {
      status: "completed",
      summary: "fixed through the Claude Code bridge",
      acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "tool-call", ref: "toolu_write_1", produced_by: "worker" }] }],
    });
  } else if (tools.includes("task_report")) {
    await toolCall(`toolu_report_${report.turns}`, "task_report", {
      status: "completed",
      summary: "fixed through the Claude Code bridge",
      acceptance_evidence: [{ criterion_id: "AC-1", evidence: [{ kind: "tool-call", ref: "toolu_write_1", produced_by: "worker" }] }],
    });
  }
  emit({ type: "assistant", message: { id: `msg_done_${report.turns}`, role: "assistant", content: [{ type: "text", text: "done" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 120, output_tokens: 20 }, total_cost_usd: 0.01, session_id: sessionId });
}
