import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolExecutionContext } from "../src/harness/contracts/index.ts";
import { expandVariables, McpManager, mcpConfigSchema, modelToolName, readMcpJson, toDefinition } from "../src/harness/mcp/index.ts";
import { createToolRegistry } from "../src/harness/tools/index.ts";

const ECHO_SERVER = fileURLToPath(new URL("./fixtures/mcp/echo-server.ts", import.meta.url));

test("mcp config: YAML block, .mcp.json import, variables and tool names", async () => {
  const parsed = mcpConfigSchema.parse({
    servers: {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, trust: "read-only" },
    },
  });
  assert.equal(Object.keys(parsed.servers ?? {}).length, 2);
  assert.throws(() => mcpConfigSchema.parse({ servers: { bad: { command: "x", url: "https://x" } } }));
  assert.throws(() => mcpConfigSchema.parse({ servers: { "1bad": { command: "x" } } }));

  const missing = new Set<string>();
  assert.equal(expandVariables("a ${A} ${B:-dflt} ${C}", { A: "1" }, missing), "a 1 dflt ");
  assert.deepEqual([...missing], ["C"]);
  assert.equal(modelToolName("my-server", "Browser.Navigate"), "mcp__my_server__browser_navigate");
  assert.ok(modelToolName("s", "x".repeat(80)).length <= 64);

  const root = await mkdtemp(path.join(os.tmpdir(), "syn-mcp-json-"));
  try {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node", args: ["s.js"], env: { K: "${HOME_X:-v}" } }, remote: { type: "http", url: "https://example.com/mcp" }, broken: { type: "http" } } }),
    );
    const found = await readMcpJson(root, {});
    assert.deepEqual(found.servers.map((server) => `${server.name}:${server.transport}:${server.source}`), ["local:stdio:mcp.json", "remote:http:mcp.json"]);
    assert.equal(found.servers[0]?.env.K, "v");
    assert.equal(found.problems.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mcp client: a stdio fixture server's tools run through the registry; project servers need approval", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "syn-mcp-home-"));
  const registry = createToolRegistry({ builtins: false });
  let untrusted = 0;
  const server = { command: process.execPath, args: [ECHO_SERVER], startup: "session" as const };
  const manager = new McpManager({
    home,
    workspaceRoot: home,
    workspaceKey: home,
    environment: process.env,
    registry,
    clientVersion: "test",
    user: { config: { servers: { echo: server } }, file: "user.yaml" },
    project: { config: { servers: { proj: { ...server, trust: "read-only" } } }, file: "project.yaml" },
    onUntrustedContent: () => {
      untrusted += 1;
    },
  });
  try {
    await manager.startSession();
    const status = new Map(manager.status().map((entry) => [entry.name, entry]));
    assert.equal(status.get("echo")?.state, "connected", status.get("echo")?.error);
    assert.deepEqual([...(status.get("echo")?.tools ?? [])].sort(), ["mcp__echo__add", "mcp__echo__echo", "mcp__echo__fail_now"]);
    assert.equal(status.get("proj")?.state, "needs-approval");
    assert.equal(registry.get("mcp__proj__echo"), undefined);

    const tool = registry.get("mcp__echo__echo");
    assert.ok(tool !== undefined);
    assert.equal(tool.metadata.effect, "exec");
    assert.equal(tool.metadata.source, "mcp");
    assert.equal(tool.descriptor().input_schema.type, "object");
    const context = { signal: new AbortController().signal, blobs: { put: async () => assert.fail("no blob expected") }, role: "session" } as unknown as ToolExecutionContext;
    const result = await tool.execute({ text: "hi" }, context);
    assert.equal(result.status, "ok");
    assert.match(result.text, /<untrusted_mcp_content server="echo" tool="echo">\necho: hi/);
    assert.equal(untrusted, 1);
    const failed = await registry.get("mcp__echo__fail_now")?.execute({}, context);
    assert.equal(failed?.status, "error");

    assert.equal(await manager.approve("proj"), true);
    assert.equal(manager.status().find((entry) => entry.name === "proj")?.state, "connected");
    assert.equal(registry.get("mcp__proj__add")?.metadata.effect, "read");
    assert.ok(registry.get("mcp__proj__add")?.metadata.visible_to.includes("reviewer"));

    await manager.setEnabled("echo", false);
    assert.equal(registry.get("mcp__echo__echo"), undefined);
    assert.deepEqual(Object.keys(manager.claudeServers()), ["proj"]);
  } finally {
    await manager.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("claude native: servers of Claude-enabled plugins are passed under Claude's own name (strict-mcp-config skips them)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "syn-mcp-claude-plugin-"));
  const plugin = { ...toDefinition("exa", { type: "http", url: "https://mcp.example.com/mcp" }, "claude-plugin", "plugin.json", {}), claudeName: "plugin:exa:exa" };
  const manager = new McpManager({
    home,
    workspaceRoot: home,
    workspaceKey: home,
    environment: {},
    registry: createToolRegistry({ builtins: false }),
    clientVersion: "test",
    user: { config: { servers: { mine: { type: "http", url: "https://mine.example.com/mcp" } } }, file: "user.yaml" },
    project: { config: undefined, file: "project.yaml" },
    plugins: () => [plugin],
  });
  try {
    await manager.load();
    const servers = manager.claudeServers();
    assert.deepEqual(Object.keys(servers).sort(), ["mine", "plugin:exa:exa"]);
    assert.equal(servers["plugin:exa:exa"]?.url, "https://mcp.example.com/mcp");
  } finally {
    await manager.close();
    await rm(home, { recursive: true, force: true });
  }
});
