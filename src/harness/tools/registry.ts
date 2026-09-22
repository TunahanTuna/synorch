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
import { createListDirTool, createReadFileTool, createSearchTool } from "./builtin/read-tools.ts";
import { createApplyPatchTool, createWriteFileTool } from "./builtin/write-tools.ts";

export interface ToolRegistryOptions {
  /** Register the v1 built-in tools (default true). */
  readonly builtins?: boolean;
  /** Parent environment that child-process allowlists read from (default `process.env`). */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly classifyCommand?: CommandClassifierHint;
  readonly control?: ControlCallbacks;
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
    get: (name) => tools.get(name),
    visibleTo(role: AgentRole, policy: EffectivePolicy): readonly ToolDescriptor[] {
      return [...tools.values()]
        .filter((tool) => tool.metadata.visible_to.includes(role) && policy.effects[tool.metadata.effect] !== "deny")
        .map((tool) => tool.descriptor());
    },
  };
  if (options.builtins ?? true) {
    const processOptions = { environment: options.environment ?? process.env, classifyCommand: options.classifyCommand };
    const builtins: Tool[] = [
      createReadFileTool() as Tool,
      createSearchTool() as Tool,
      createListDirTool() as Tool,
      createGitStatusTool(processOptions) as Tool,
      createGitDiffTool(processOptions) as Tool,
      createApplyPatchTool() as Tool,
      createWriteFileTool() as Tool,
      createExecTool(processOptions) as Tool,
      ...createControlTools(options.control ?? {}),
    ];
    for (const tool of builtins) registry.register(tool);
  }
  return registry;
}
