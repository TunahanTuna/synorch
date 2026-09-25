import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Tiny stdio MCP server for tests: `echo` returns its text, `add` sums two numbers, `fail` errors. */
const server = new Server({ name: "synorch-echo", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
    { name: "fail-now", description: "Always reports an error", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  switch (request.params.name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${String(args.text)}` }] };
    case "add":
      return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
    default:
      return { content: [{ type: "text", text: "this tool always fails" }], isError: true };
  }
});

process.stderr.write("echo server ready\n");
await server.connect(new StdioServerTransport());
