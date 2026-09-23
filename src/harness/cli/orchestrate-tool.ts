import { z } from "zod";
import {
  digestOf,
  normalizedActionSchema,
  toolMetadataSchema,
  type Tool,
  type ToolExecutionContext,
  type ToolResult,
} from "../contracts/index.ts";

/**
 * The session agent's `orchestrate` control tool (ADR-21 D2/D4, UI "workers"). It hands a large or
 * multi-part goal to the existing coordinator (planner → plan shown → approval → workers in their own
 * worktrees → harness verification → independent review → integration) and stays inside the turn
 * until the run ends; its result is the harness-built result block. The tool registry is built once
 * per runtime, so the conversation publishes its handler into a slot while it is open. Only the
 * `session` role sees or may call it; the coordinator itself never starts workers without a shown,
 * approved plan (autonomous: plan shown and `decided_by` recorded; ask: the human approves).
 */

export const ORCHESTRATE_TOOL = "orchestrate";

export const orchestrateInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4000),
  reason: z.string().trim().min(1).max(300),
  brief: z.string().trim().min(1).max(8000).optional(),
});
export type OrchestrateInput = z.infer<typeof orchestrateInputSchema>;

export type OrchestrateHandler = (input: OrchestrateInput, context: ToolExecutionContext) => Promise<ToolResult>;

export interface OrchestrateSlot {
  set(handler: OrchestrateHandler | undefined): void;
  current(): OrchestrateHandler | undefined;
}

export function createOrchestrateSlot(): OrchestrateSlot {
  let handler: OrchestrateHandler | undefined;
  return {
    set(next) {
      handler = next;
    },
    current: () => handler,
  };
}

const DESCRIPTION = [
  "Run a large or multi-part change with parallel workers: the harness plans it, shows the plan, runs workers in their own worktrees,",
  "verifies with the project's checks and has an independent reviewer accept the result before it is applied. Use it only when the work",
  "is big (about 5+ files, 2+ independent areas, high risk, or more than fits one context) or the user asks for workers/parallel work;",
  "otherwise do the work directly. goal: the outcome; reason: one sentence the user sees for why workers help; brief: decisions,",
  "constraints and the plan discussed so far. It runs until the workers finish and returns a result block to report from.",
].join(" ");

function errorResult(code: "execution_failed" | "policy_denied", message: string): ToolResult {
  return { status: "error", text: "", truncated: false, redactions: 0, error: { code, message: message.slice(0, 2000) } };
}

export function createOrchestrateTool(slot: OrchestrateSlot): Tool<OrchestrateInput> {
  const metadata = toolMetadataSchema.parse({
    name: ORCHESTRATE_TOOL,
    version: "1.0.0",
    description: DESCRIPTION,
    source: "builtin",
    effect: "control",
    effect_source: "builtin",
    idempotent: false,
    network: "none",
    output_limit_bytes: 64 * 1024,
    timeout_ms: 3_600_000,
    cancellable: true,
    concurrency: "sequential",
    visible_to: ["session"],
  });
  const inputSchema = z.toJSONSchema(orchestrateInputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    metadata,
    input: orchestrateInputSchema,
    descriptor: () => ({ name: metadata.name, description: metadata.description, input_schema: inputSchema }),
    async normalize(value, context) {
      return normalizedActionSchema.parse({
        tool_name: metadata.name,
        tool_version: metadata.version,
        effect: "control",
        role: context.role,
        task_id: context.taskId,
        args_digest: digestOf(value),
        paths: [],
        network_hosts: [],
        destructive: false,
      });
    },
    async execute(value, context) {
      if (context.role !== "session") return errorResult("policy_denied", "only the conversation agent starts workers");
      const handler = slot.current();
      if (handler === undefined) return errorResult("execution_failed", "workers are not available in this session (headless or no conversation is open)");
      try {
        return await handler(value, context);
      } catch (error) {
        return errorResult("execution_failed", error instanceof Error ? error.message : String(error));
      }
    },
  };
}
