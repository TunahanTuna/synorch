/** K7 — skills, markdown slash commands and plugins (Claude Code formats), from Synorch, the repository and Claude Code. */
export { CLAUDE_HOME_READABLE_DIRECTORIES, claudeHome, mayReadPath, mayReadReal, readClaudeEnabledPlugins } from "./claude-home.ts";
export { EXTENSION_SOURCES, createMergedSkillCatalog, itemBody, loadExtensions, pluginMcpServers, resolveItems, type ExtensionItem, type ExtensionSource, type ExtensionState, type ItemState, type ItemStatus, type PluginEntry } from "./catalog.ts";
export { createExtensions, type ExtensionSettings, type Extensions, type ExtensionsOptions } from "./controller.ts";
export { expandBody, metaOf, parseMarkdown, splitArguments, type MarkdownMeta } from "./markdown.ts";
export { createPersonaCatalog, isReadOnlyAgent, personaBaseRole, personaModelTier, PERSONA_INSTRUCTIONS_LIMIT, readAgentFile, renderPersonaHint, type AgentRef, type PersonaCatalog, type PluginAgent } from "./agents.ts";
export {
  approveHooks,
  CLAUDE_TOOL_NAMES,
  claudeToolInput,
  claudeToolName,
  createHookEngine,
  describeHookConfig,
  HOOK_EVENTS,
  hookCount,
  hookDigest,
  hookSources,
  matcherMatches,
  parseHookConfig,
  readHookApprovals,
  revokeHooks,
  type HookConfig,
  type HookEngine,
  type HookEvent,
  type HookOutcome,
  type HookProcessRunner,
  type HookRunContext,
  type HookSource,
  type HookSourceState,
} from "./hooks.ts";
export { gatewayHooks, nativeToolPreHook } from "./tool-hooks.ts";
export {
  addMarketplace,
  defaultGitClone,
  describeContents,
  discoverClaudePlugins,
  gitUrlOf,
  marketplacePlugins,
  PluginError,
  pluginsHome,
  readPlugin,
  readPluginStore,
  removeMarketplace,
  removePlugin,
  scanCommands,
  scanSkills,
  stagePlugin,
  type GitClone,
  type InstalledPlugin,
  type PluginContents,
  type StagedPlugin,
} from "./plugins.ts";
