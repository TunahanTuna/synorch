/** K7 — skills, markdown slash commands and plugins (Claude Code formats), from Synorch, the repository and Claude Code. */
export { CLAUDE_HOME_READABLE_DIRECTORIES, claudeHome, mayReadPath, mayReadReal, readClaudeEnabledPlugins } from "./claude-home.ts";
export { EXTENSION_SOURCES, createMergedSkillCatalog, itemBody, loadExtensions, pluginMcpServers, resolveItems, type ExtensionItem, type ExtensionSource, type ExtensionState, type ItemState, type ItemStatus, type PluginEntry } from "./catalog.ts";
export { createExtensions, type ExtensionSettings, type Extensions, type ExtensionsOptions } from "./controller.ts";
export { expandBody, metaOf, parseMarkdown, splitArguments, type MarkdownMeta } from "./markdown.ts";
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
