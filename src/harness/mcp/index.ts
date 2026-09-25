/** K3 — MCP client: external MCP servers (stdio, streamable HTTP) as gateway-governed tools. */
export { createMcpApprovalStore, MCP_APPROVALS_FILE, type McpApprovalStore } from "./approvals.ts";
export { McpConnection, mcpLogFile, type McpCallResult, type McpToolInfo } from "./client.ts";
export {
  defaultMcpRoles,
  expandVariables,
  MCP_SERVER_NAME_PATTERN,
  MCP_STARTUP_MODES,
  MCP_TRUST_LEVELS,
  mcpConfigSchema,
  mcpServerEntrySchema,
  mergeServers,
  modelToolName,
  parseMcpServerEntry,
  readMcpJson,
  toDefinition,
  type McpConfig,
  type McpServerDefinition,
  type McpServerEntry,
  type McpSource,
  type McpTrust,
} from "./config.ts";
export { friendlyFailure, isAuthFailure, McpStartError, type McpFailureKind } from "./errors.ts";
export { McpManager, type McpManagerOptions, type McpServerState, type McpServerStatus } from "./manager.ts";
export { createMcpOAuthStore, loginMcpServer, mcpOAuthRef, McpSignInRequiredError, type McpLoginDependencies, type McpOAuthRecord, type McpOAuthStore } from "./oauth.ts";
export { createMcpTool, modelSchema, untrustedMcpEnvelope } from "./tools.ts";
