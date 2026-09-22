import { z } from "zod";
import { AGENT_ROLES, memoryIdSchema, PROPOSAL_KINDS, taskIdSchema, type Tool, type ToolExecutionContext, type ToolResult } from "../../contracts/index.ts";
import { messageOf } from "./read-tools.ts";
import { actionOf, builtinMetadata, defineTool, errorResult } from "./shared.ts";

const askUserInput = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
});
export type AskUserInput = z.infer<typeof askUserInput>;

/** The packet itself is validated by orchestration (I4) against `taskContextPacketSchema`. */
const taskSpawnInput = z.strictObject({
  packet: z.record(z.string(), z.unknown()),
});
export type TaskSpawnInput = z.infer<typeof taskSpawnInput>;

const taskStatusInput = z.strictObject({
  task_id: taskIdSchema.optional(),
});
export type TaskStatusInput = z.infer<typeof taskStatusInput>;

/** A proposal only; the memory module (I6) decides and persists (`memoryProposalSchema`). */
const memoryProposeInput = z.strictObject({
  kind: z.enum(PROPOSAL_KINDS),
  target: memoryIdSchema.optional(),
  rationale: z.string().trim().min(1).max(2000),
  content: z.record(z.string(), z.unknown()),
});
export type MemoryProposeInput = z.infer<typeof memoryProposeInput>;

type ControlCallback<Input> = (input: Input, context: ToolExecutionContext) => Promise<ToolResult>;

/**
 * Behaviour of control tools lives in the modules that own it (orchestration, memory, the
 * interactive renderer); this module only defines them and routes them through the gateway.
 */
export interface ControlCallbacks {
  readonly askUser?: ControlCallback<AskUserInput>;
  readonly taskSpawn?: ControlCallback<TaskSpawnInput>;
  readonly taskStatus?: ControlCallback<TaskStatusInput>;
  readonly memoryPropose?: ControlCallback<MemoryProposeInput>;
}

export function createControlTools(callbacks: ControlCallbacks): Tool[] {
  return [
    controlTool(
      "ask_user",
      "Ask the user a question and wait for the answer. Unavailable in headless runs.",
      ["orchestrator"],
      askUserInput,
      callbacks.askUser,
      "approval_unavailable",
    ),
    controlTool("task_spawn", "Dispatch a task from a task context packet (schema, DAG and ownership are validated).", ["orchestrator"], taskSpawnInput, callbacks.taskSpawn),
    controlTool("task_status", "Report the state of one task, or of every task in the run.", ["orchestrator"], taskStatusInput, callbacks.taskStatus),
    controlTool("memory_propose", "Propose a memory note, relation or status change; persistence is decided by the memory module.", [...AGENT_ROLES], memoryProposeInput, callbacks.memoryPropose),
  ] as Tool[];
}

function controlTool<Input>(
  name: string,
  description: string,
  roles: readonly (typeof AGENT_ROLES)[number][],
  input: z.ZodType<Input>,
  callback: ControlCallback<Input> | undefined,
  missingCode: "approval_unavailable" | "execution_failed" = "execution_failed",
): Tool<Input> {
  const metadata = builtinMetadata({
    name,
    description,
    effect: "control",
    idempotent: false,
    network: "none",
    output_limit_bytes: 64 * 1024,
    timeout_ms: name === "ask_user" ? 3_600_000 : 60_000,
    cancellable: true,
    concurrency: "sequential",
    visible_to: [...roles],
  });
  return defineTool(metadata, input, {
    async normalize(value, context) {
      return actionOf(metadata, value, context);
    },
    async execute(value, context) {
      if (callback === undefined) return errorResult(missingCode, `${name} is not available in this runtime`);
      try {
        return await callback(value, context);
      } catch (error: unknown) {
        return errorResult("execution_failed", messageOf(error));
      }
    },
  });
}
