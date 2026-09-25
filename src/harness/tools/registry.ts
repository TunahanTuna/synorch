import {
  toolMetadataSchema,
  type AgentRole,
  type EffectivePolicy,
  type Tool,
  type ToolDescriptor,
  type ToolRegistry,
} from "../contracts/index.ts";
import { createControlTools, type ControlCallbacks } from "./builtin/control-tools.ts";
import { createExecTool, createGitDiffTool, createGitStatusTool, type CommandClassifierHint } from "./builtin/process-tools.ts";
import { createGlobTool } from "./builtin/glob.ts";
import { BackgroundProcessManager, createProcessTools } from "./builtin/process-bg.ts";
import { createTodoTool } from "./builtin/todo.ts";
import { createListDirTool, createReadFileTool, createSearchTool } from "./builtin/read-tools.ts";
import { createApplyPatchTool, createWriteFileTool } from "./builtin/write-tools.ts";
import { createWebFetchTool } from "./builtin/web-fetch.ts";
import type { SafeFetchOptions } from "./builtin/web-net.ts";
import { createWebSearchTool, type WebSearchRunner } from "./builtin/web-search.ts";
import type { WebSession } from "./builtin/web-state.ts";

export interface ToolRegistryOptions {
  /** Register the v1 built-in tools (default true). */
  readonly builtins?: boolean;
  /** Parent environment that child-process allowlists read from (default `process.env`). */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly classifyCommand?: CommandClassifierHint;
  readonly control?: ControlCallbacks;
  /** K4.1: registers `web_search` (over the injected backends) and `web_fetch`. */
  readonly web?: { readonly session: WebSession; readonly search: WebSearchRunner; readonly transport?: SafeFetchOptions };
  /** K4.2: the session's background processes (a private manager when absent). */
  readonly processes?: BackgroundProcessManager;
}

/** The v1 registry: built-in tools plus anything registered later; every tool's metadata is validated. */
export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const tools = new Map<string, Tool>();
  const registry: ToolRegistry = {
    register(tool: Tool): void {
      toolMetadataSchema.parse(tool.metadata);
      if (tools.has(tool.metadata.name)) throw new Error(`tool ${tool.metadata.name} is already registered`);
      tools.set(tool.metadata.name, tool);
    },
    unregister: (name) => tools.delete(name),
    get: (name) => tools.get(name),
    visibleTo(role: AgentRole, policy: EffectivePolicy): readonly ToolDescriptor[] {
      return [...tools.values()]
        .filter((tool) => tool.metadata.visible_to.includes(role) && policy.effects[tool.metadata.effect] !== "deny")
        .map((tool) => tool.descriptor());
    },
  };
  if (options.builtins ?? true) {
    const background = options.processes ?? new BackgroundProcessManager();
    const environment = options.environment ?? process.env;
    const processOptions = { environment, classifyCommand: options.classifyCommand, background };
    const builtins: Tool[] = [
      createReadFileTool() as Tool,
      createSearchTool() as Tool,
      createListDirTool() as Tool,
      createGitStatusTool(processOptions) as Tool,
      createGitDiffTool(processOptions) as Tool,
      createApplyPatchTool() as Tool,
      createWriteFileTool() as Tool,
      createExecTool(processOptions) as Tool,
      ...createProcessTools(background),
      createGlobTool({ environment }) as Tool,
      createTodoTool() as Tool,
      ...createControlTools(options.control ?? {}),
    ];
    const web = options.web;
    if (web !== undefined) {
      builtins.push(createWebSearchTool({ session: web.session, environment, search: web.search }) as Tool);
      builtins.push(createWebFetchTool({ session: web.session, environment, ...(web.transport === undefined ? {} : { transport: web.transport }) }) as Tool);
    }
    for (const tool of builtins) registry.register(tool);
  }
  return registry;
}
