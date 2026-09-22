import { connect } from "node:net";

/**
 * Stdio MCP entry point that `claude` spawns from the generated `--mcp-config`. It only relays
 * bytes between its stdio and the Synorch process's local socket (after sending the session
 * token); the MCP server itself, and every tool decision, lives in the Synorch process.
 */
function main(): void {
  const endpoint = process.env.SYNORCH_MCP_ENDPOINT;
  const token = process.env.SYNORCH_MCP_TOKEN;
  if (endpoint === undefined || endpoint === "" || token === undefined || token === "") {
    process.stderr.write("synorch mcp relay: missing endpoint or token\n");
    process.exit(2);
  }
  const socket = connect(endpoint, () => {
    socket.write(`${token}\n`);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on("error", (error) => {
    process.stderr.write(`synorch mcp relay: ${error.message}\n`);
    process.exit(1);
  });
  socket.on("close", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
}

main();
