/** I2 — ModelAdapter / AgentBackendAdapter implementations and the model router. */
export type { AgentBackendAdapter, ModelAdapter, ModelRouter } from "../contracts/index.ts";
export {
  ANTHROPIC_API_BASE_URL,
  ANTHROPIC_VERSION,
  createAnthropicMessagesAdapter,
  type AnthropicMessagesOptions,
} from "./anthropic-messages.ts";
export { streamAuthenticated } from "./authenticated-stream.ts";
export {
  authSourceOf,
  buildClaudeArgs,
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_TOOL_PREFIX,
  createClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from "./claude-code/adapter.ts";
export { bridgeEnvironment, type ExecutableSpec } from "./claude-code/process.ts";
export { createCodexAppServerAdapter } from "./codex-app-server.ts";
export { classifyHttpError, providerError } from "./errors.ts";
export { checkStreamGrammar, collectStream } from "./grammar.ts";
export type { FetchLike } from "./http-stream.ts";
export {
  CHATGPT_CODEX_BASE_URL,
  createOpenAIChatGPTAdapter,
  createOpenAIResponsesAdapter,
  OPENAI_API_BASE_URL,
  parseCodexQuota,
  SYNORCH_ORIGINATOR,
  type ResponsesAdapterOptions,
} from "./responses.ts";
export { RouteBlockedFailure, type ModelRouterConfig, type ProviderChangeProposal, type RouteBinding, type RouteRule } from "../contracts/index.ts";
export { createModelRouter, type ModelRouterOptions } from "./router.ts";
export { createScriptedAdapter, type ScriptedAdapterOptions, type ScriptedModelAdapter, type ScriptStep } from "./scripted.ts";
