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
 * worktrees → harness verification → independent review → integration). K3 (UX-GATE-02): in an
 * interactive session the run goes to the background and the tool returns at once with a run id; the
 * conversation stays open and the run's result block reaches the agent as a completion notice.
 * `wait: true` (and every headless session) stays inside the turn until the run ends and returns the
 * result block. `run_status`, `run_steer` and `run_cancel` inspect and control runs. The tool registry is built once
 * per runtime, so the conversation publishes its handler into a slot while it is open. Only the
 * `session` role sees or may call it; the coordinator itself never starts workers without a shown,
 * approved plan (autonomous: plan shown and `decided_by` recorded; ask: the human approves).
 */

export const ORCHESTRATE_TOOL = "orchestrate";

export const orchestrateInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4000),
  reason: z.string().trim().min(1).max(300),
  brief: z.string().trim().min(1).max(8000).optional(),
  wait: z.boolean().optional(),
});
export type OrchestrateInput = z.infer<typeof orchestrateInputSchema>;

export type OrchestrateHandler = (input: OrchestrateInput, context: ToolExecutionContext) => Promise<ToolResult>;

export const RUN_STATUS_TOOL = "run_status";
export const RUN_STEER_TOOL = "run_steer";
export const RUN_CANCEL_TOOL = "run_cancel";

const runRef = z.string().trim().min(1).max(80).optional();
export const runStatusInputSchema = z.strictObject({
  run: runRef,
  wait: z.boolean().optional(),
  timeout_seconds: z.int().min(1).max(3600).optional(),
});
export const runSteerInputSchema = z.strictObject({ message: z.string().trim().min(1).max(4000), run: runRef, task: z.string().trim().min(1).max(120).optional() });
export const runCancelInputSchema = z.strictObject({ run: runRef, task: z.string().trim().min(1).max(120).optional() });
export type RunStatusInput = z.infer<typeof runStatusInputSchema>;
export type RunSteerInput = z.infer<typeof runSteerInputSchema>;
export type RunCancelInput = z.infer<typeof runCancelInputSchema>;

/** K3: the open conversation's handlers for inspecting and controlling its worker runs. */
export interface RunControlHandlers {
  status(input: RunStatusInput, context: ToolExecutionContext): Promise<ToolResult>;
  steer(input: RunSteerInput, context: ToolExecutionContext): Promise<ToolResult>;
  cancel(input: RunCancelInput, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface OrchestrateSlot {
  set(handler: OrchestrateHandler | undefined): void;
  current(): OrchestrateHandler | undefined;
  setControl(control: RunControlHandlers | undefined): void;
  control(): RunControlHandlers | undefined;
}

export function createOrchestrateSlot(): OrchestrateSlot {
  let handler: OrchestrateHandler | undefined;
  let control: RunControlHandlers | undefined;
  return {
    set(next) {
      handler = next;
    },
    current: () => handler,
    setControl(next) {
      control = next;
    },
    control: () => control,
  };
}

const DESCRIPTION = [
  "Run a large or multi-part change with parallel workers: the harness plans it, shows the plan, runs workers in their own worktrees,",
  "verifies with the project's checks and, where the change warrants it, has an independent reviewer accept the result before it is applied.",
  "Call it directly (no separate approval turn first): the harness shows the plan and handles approval for the permission mode.",
  "goal: the outcome; reason: one sentence the user sees for why workers help; brief: decisions,",
  "constraints and the plan discussed so far. In an interactive session the run goes to the background: the tool returns at once with a run id,",
  "you keep talking with the user (answer questions, make small unrelated edits), and when the run ends you receive a notice with its result block to report from.",
  "wait: true blocks until the workers finish and returns the result block (only when you cannot continue without it).",
  "run_status shows progress (wait: true waits for the end), run_steer messages the orchestrator or one task, run_cancel stops it.",
].join(" ");

function errorResult(code: "execution_failed" | "policy_denied", message: string): ToolResult {
  return { status: "error", text: "", truncated: false, redactions: 0, error: { code, message: message.slice(0, 2000) } };
}

function sessionControlTool<T extends Record<string, unknown>>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  run: (control: RunControlHandlers, value: T, context: ToolExecutionContext) => Promise<ToolResult>,
  slot: OrchestrateSlot,
  timeoutMs: number,
): Tool<T> {
  const metadata = toolMetadataSchema.parse({
    name,
    version: "1.0.0",
    description,
    source: "builtin",
    effect: "control",
    effect_source: "builtin",
    idempotent: false,
    network: "none",
    output_limit_bytes: 32 * 1024,
    timeout_ms: timeoutMs,
    cancellable: true,
    concurrency: "sequential",
    visible_to: ["session"],
  });
  const inputSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    metadata,
    input: schema,
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
      if (context.role !== "session") return errorResult("policy_denied", "only the conversation agent controls worker runs");
      const control = slot.control();
      if (control === undefined) return errorResult("execution_failed", "no worker runs in this session (headless or no conversation is open)");
      try {
        return await run(control, value, context);
      } catch (error) {
        return errorResult("execution_failed", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** K3: `run_status`, `run_steer`, `run_cancel` for the conversation agent (session role only). */
export function createRunControlTools(slot: OrchestrateSlot): readonly Tool<never>[] {
  return [
    sessionControlTool(
      RUN_STATUS_TOOL,
      "Status of a worker run started with orchestrate: phase, tasks with state, activity and owned paths, and the result block once it ended. run: the run id (default: the active or last run). wait: true blocks until the run ends (timeout_seconds, default 600) and returns its result block.",
      runStatusInputSchema,
      (control, value, context) => control.status(value, context),
      slot,
      3_700_000,
    ),
    sessionControlTool(
      RUN_STEER_TOOL,
      "Send a message to a running worker run: without task it goes to the orchestrator (applied at the next safe point, may re-plan); with task (the board key) it goes to that worker at its next step. Use it to relay the user's corrections.",
      runSteerInputSchema,
      (control, value, context) => control.steer(value, context),
      slot,
      60_000,
    ),
    sessionControlTool(
      RUN_CANCEL_TOOL,
      "Stop a worker run (or only one task with task: the board key). Integrated work stays; unintegrated work is discarded. Only when the user asks or the run is clearly wrong.",
      runCancelInputSchema,
      (control, value, context) => control.cancel(value, context),
      slot,
      60_000,
    ),
  ] as unknown as readonly Tool<never>[];
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
    // The run budget (max_wall_time_seconds, steps, cost) bounds an orchestration; Esc cancels it. This is only a 24 h backstop.
    timeout_ms: 86_400_000,
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
