import path from "node:path";
import type { TaskModelTier, WorkerRole } from "../../contracts/index.ts";
import { readMarkdownFile } from "./markdown.ts";

/**
 * K7 plugin agents in Claude Code's subagent format: `agents/<name>.md` with frontmatter `name`,
 * `description`, `tools` (comma list; absent = every tool), `model` (`sonnet`, `opus`, `haiku`,
 * `inherit` or a model id) and the system prompt as body. Synorch uses them as orchestration worker
 * personas: the orchestrator may put `agent: "<plugin>:<name>"` on a plan task, the body is layered
 * as extra instructions on the task's worker role, and the model hint picks a task tier (the
 * user's routes for that tier still decide the actual model).
 */

export interface AgentRef {
  /** The agent's own name (frontmatter `name`, else the file name). */
  readonly name: string;
  readonly description: string;
  /** Claude tool names; empty = inherits every tool. */
  readonly tools: readonly string[];
  readonly model: string | undefined;
  readonly body: string;
  readonly file: string;
}

export interface PluginAgent extends AgentRef {
  /** Invocation name `<plugin>:<name>`. */
  readonly id: string;
  readonly plugin: string;
  readonly origin: "synorch" | "claude";
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PERSONA_INSTRUCTIONS_LIMIT = 8 * 1024;

export async function readAgentFile(file: string): Promise<AgentRef | undefined> {
  const document = await readMarkdownFile(file);
  if (document === undefined) return undefined;
  const data = document.data;
  const name = typeof data.name === "string" && AGENT_NAME.test(data.name.trim()) ? data.name.trim() : path.basename(file).replace(/\.md$/i, "");
  if (!AGENT_NAME.test(name)) return undefined;
  const tools = Array.isArray(data.tools) ? data.tools.filter((tool): tool is string => typeof tool === "string") : typeof data.tools === "string" ? data.tools.split(",") : [];
  return {
    name,
    description: typeof data.description === "string" ? data.description.trim() : "",
    tools: tools.map((tool) => tool.trim()).filter((tool) => tool !== ""),
    model: typeof data.model === "string" && data.model.trim() !== "" ? data.model.trim() : undefined,
    body: document.body,
    file,
  };
}

/** Claude tools that change files or run commands; an agent without any of them is read-only. */
const WRITING_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "PowerShell"]);

export function isReadOnlyAgent(agent: Pick<AgentRef, "tools">): boolean {
  return agent.tools.length > 0 && agent.tools.every((tool) => !WRITING_TOOLS.has(tool.replace(/\(.*$/, "").trim()));
}

/** The worker role a persona layers on: implementer, or reviewer/explorer for a read-only agent. */
export function personaBaseRole(agent: Pick<AgentRef, "tools" | "name" | "description">): WorkerRole {
  if (!isReadOnlyAgent(agent)) return "implementer";
  return /review|audit|critic|check/i.test(`${agent.name} ${agent.description}`) ? "reviewer" : "explorer";
}

/** Claude's model aliases → Synorch task tiers; `inherit`, unknown ids and no hint keep the orchestrator's tier. */
export function personaModelTier(model: string | undefined): TaskModelTier | undefined {
  const value = model?.toLowerCase() ?? "";
  if (value.includes("haiku")) return "fast_worker";
  if (value.includes("opus") || value.includes("sonnet")) return "complex_worker";
  return undefined;
}

export interface PersonaCatalog {
  list(): readonly PluginAgent[];
  find(id: string): PluginAgent | undefined;
}

export function createPersonaCatalog(agents: () => readonly PluginAgent[]): PersonaCatalog {
  return {
    list: agents,
    find: (id) => {
      const all = agents();
      return all.find((agent) => agent.id === id) ?? all.find((agent) => agent.id.toLowerCase() === id.toLowerCase()) ?? all.find((agent) => agent.name === id);
    },
  };
}

/** The orchestrator's view of the available personas (one line each), or undefined when none. */
export function renderPersonaHint(agents: readonly PluginAgent[]): string | undefined {
  if (agents.length === 0) return undefined;
  const lines = agents.slice(0, 40).map((agent) => {
    const tier = personaModelTier(agent.model);
    const description = agent.description.replace(/\s+/g, " ").slice(0, 200);
    return `- ${agent.id} (base role ${personaBaseRole(agent)}${tier === undefined ? "" : `, model_tier ${tier}`}): ${description}`;
  });
  return [
    "Plugin agents (optional worker personas): set a task's `agent` to one of these ids when its specialty fits the task; its instructions are layered on the task's role. Keep the role the listed base role (an agent without write tools reads only).",
    ...lines,
  ].join("\n");
}
