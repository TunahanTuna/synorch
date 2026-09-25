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
export { bridgeEnvironment, findOnPath, type ExecutableSpec } from "./claude-code/process.ts";
export {
  CLAUDE_CODE_MODES,
  claudeInputSummary,
  claudePermissionMode,
  claudeToolEffect,
  DEFAULT_CLAUDE_CODE_MODE,
  type ClaudeCodeMode,
  type ClaudePermissionMode,
} from "./claude-code/native.ts";
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
  type HostedSearchObserved,
  type ResponsesAdapterOptions,
} from "./responses.ts";
export { RouteBlockedFailure, type ModelRouterConfig, type ProviderChangeProposal, type RouteBinding, type RouteRule } from "../contracts/index.ts";
export { createModelRouter, type ModelRouterOptions, type SessionModelRouter } from "./router.ts";
export { pickCrossProviderReviewer, REVIEW_CROSS_PROVIDER_MODES, type ReviewCrossProviderMode } from "./reviewer-route.ts";
export {
  anthropicWireModelId,
  badgeOf,
  buildModelCatalog,
  fetchCodexModels,
  KNOWN_ANTHROPIC_MODELS,
  KNOWN_OPENAI_MODELS,
  type CatalogBadge,
  type CatalogIdentity,
  type CatalogInput,
  type CatalogModel,
  type ListedModel,
} from "./catalog.ts";
export { clampEffort, isReasoningEffort, requestedEffort, resolveEffort, supportedEfforts, type EffortResolution, type EffortSources, type EffortTarget } from "./effort.ts";
export {
  createWebSearchRunner,
  KEYED_SEARCH_BACKENDS,
  SEARCH_KEY_ENV,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_SETUP_HINT,
  WebSearchError,
  type KeyedSearchBackend,
  type SearchAnswer,
  type WebSearchProvider,
  type WebSearchSources,
} from "./web-search.ts";
export { createScriptedAdapter, type ScriptedAdapterOptions, type ScriptedModelAdapter, type ScriptStep } from "./scripted.ts";
