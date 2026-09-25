/** I3 — built-in tools, registry, ToolGateway pipeline, SandboxRunner backends. */
export type { SandboxRunner, Tool, ToolGateway, ToolRegistry } from "../contracts/index.ts";
export {
  createControlTools,
  type AskUserInput,
  type ControlCallbacks,
  type MemoryProposeInput,
  type TaskSpawnInput,
  type LoadSkillInput,
  type TaskStatusInput,
  type TaskTriageInput,
  TRIAGE_DECISIONS,
} from "./builtin/control-tools.ts";
export type { CommandClassifierHint, CommandScopeHint } from "./builtin/process-tools.ts";
export { childEnvironment, INHERITED_ENV_ALLOWLIST, isBlockedEnvName } from "./environment.ts";
export { createToolGateway, type ToolGatewayDependencies, type ToolHookCall, type ToolHooks } from "./gateway.ts";
export { boundText, createRedactor, INLINE_OUTPUT_LIMIT_BYTES, REDACTED, type Redactor } from "./redaction.ts";
export { createToolRegistry, type ToolRegistryOptions } from "./registry.ts";
export { createWebFetchTool, type WebFetchToolOptions } from "./builtin/web-fetch.ts";
export { egressFindings, untrustedEnvelope } from "./builtin/web-common.ts";
export { htmlToMarkdown } from "./builtin/web-html.ts";
export { blockedAddressReason, blockedHostnameReason, safeFetch, WebFetchRefused, type Resolver, type SafeFetchOptions } from "./builtin/web-net.ts";
export { createWebSearchTool, type WebSearchAnswer, type WebSearchResultItem, type WebSearchRunner } from "./builtin/web-search.ts";
export { createWebSession, DEFAULT_WEB_DOMAINS, normalizeDomain, robotsAllows, WEB_DOMAINS_FILE, type WebSession } from "./builtin/web-state.ts";
export { BackgroundProcessManager, describeProcess, formatElapsedShort, type BackgroundProcessInfo } from "./builtin/process-bg.ts";
export { todoSummary, TODO_STATUSES, type TodoStatus } from "./builtin/todo.ts";
export { isImageBlob } from "./builtin/read-media.ts";
export { createSandboxRunner, probeSandbox, sandboxedArgv, type SandboxProbeOptions } from "./sandbox.ts";
export { resolveWorkspacePath, ToolScopeViolation, type ResolvedWorkspacePath } from "./workspace-path.ts";
