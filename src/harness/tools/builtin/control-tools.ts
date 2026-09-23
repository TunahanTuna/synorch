import { z } from "zod";
import {
  AGENT_ROLES,
  memoryIdSchema,
  planProposalSchema,
  PROPOSAL_KINDS,
  REPORT_TOOL_NAMES,
  reviewReportInputSchema,
  taskIdSchema,
  taskReportInputSchema,
  taskTriageInputSchema,
  type PlanProposal,
  type ReviewReportInput,
  type TaskReportInput,
  type TaskTriageInput,
  type Tool,
  type ToolExecutionContext,
  type ToolResult,
} from "../../contracts/index.ts";
import { messageOf } from "./read-tools.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, okResult } from "./shared.ts";

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

/** The orchestrator's decision on a worker's report (triage consultation only): `taskTriageInputSchema`. */
export { TRIAGE_DECISIONS, type TaskTriageInput } from "../../contracts/index.ts";
const taskTriageInput = taskTriageInputSchema;

const loadSkillInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
});
export type LoadSkillInput = z.infer<typeof loadSkillInput>;

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
  readonly taskTriage?: ControlCallback<TaskTriageInput>;
  /** Serves a catalog skill allowed for the caller's role; `.ai/skills/**` is never widened into a task's read scope. */
  readonly loadSkill?: ControlCallback<LoadSkillInput>;
  readonly memoryPropose?: ControlCallback<MemoryProposeInput>;
  /**
   * Report tools: the recorded, validated call in the attempt log is the report orchestration reads.
   * Orchestration binds `taskReport`/`reviewReport` to resolve the evidence inside the call and
   * reject it with an actionable `invalid_arguments` (ADR-18); without a callback the call is
   * acknowledged. `task_report`, `review_report`, `plan_propose` and `task_triage` end the turn
   * when they succeed (`ends_turn`, ADR-20).
   */
  readonly taskReport?: ControlCallback<TaskReportInput>;
  readonly reviewReport?: ControlCallback<ReviewReportInput>;
  readonly planPropose?: ControlCallback<PlanProposal>;
}

const REPORT_RECORDED = "report recorded; end your turn now";

export function createControlTools(callbacks: ControlCallbacks): Tool[] {
  return [
    controlTool(
      REPORT_TOOL_NAMES.task,
      "End the attempt: status, summary, evidence per criterion (ref \"#n\" = the [#n] before a tool result, produced_by worker). Call it last.",
      ["explorer", "implementer", "debugger"],
      taskReportInputSchema,
      callbacks.taskReport,
      "acknowledge",
      true,
    ),
    controlTool(
      REPORT_TOOL_NAMES.review,
      "End the review: verdict per criterion, findings, accept|revise|block. met needs your own \"#n\" (produced_by reviewer) or a passed harness-verification not marked [supporting only]. Call it last.",
      ["reviewer"],
      reviewReportInputSchema,
      callbacks.reviewReport,
      "acknowledge",
      true,
    ),
    controlTool(
      REPORT_TOOL_NAMES.plan,
      "Propose the run plan as a task DAG; the harness validates ownership, dependencies and scope and tells you what to fix.",
      ["orchestrator"],
      planProposalSchema,
      callbacks.planPropose,
      "acknowledge",
      true,
    ),
    controlTool(
      "ask_user",
      "Ask the user a question and wait for the answer. Unavailable in headless runs.",
      ["orchestrator"],
      askUserInput,
      callbacks.askUser,
      "approval_unavailable",
    ),
    controlTool(
      "task_spawn",
      "Add a follow-up task to the running plan: `packet` is one plan task (key, role, objective, depends_on, owned_paths, read_paths, risk, model_tier, acceptance_criteria, verification). DAG, ownership and budget are validated; it runs only after the revised plan is approved.",
      ["orchestrator"],
      taskSpawnInput,
      callbacks.taskSpawn,
    ),
    controlTool("task_status", "Report the state of one task, or of every task in the run.", ["orchestrator"], taskStatusInput, callbacks.taskStatus),
    controlTool(
      "task_triage",
      "Decide a worker's report while the harness consults you: accept (read-only tasks only; waive_criteria lists criteria the role could not meet, they go to dependent tasks as notes; for plan-caused verification problems it waives the commands that could not run), retry (guidance reaches the next attempt; with verification = replacement commands for a plan-caused verification problem) or fail.",
      ["orchestrator"],
      taskTriageInput,
      callbacks.taskTriage,
      "execution_failed",
      true,
    ),
    controlTool(
      "load_skill",
      "Load the full instructions of a skill from your role's skill catalog by name (read-only). Skills are served by the runtime; never read .ai/skills files directly.",
      [...AGENT_ROLES],
      loadSkillInput,
      callbacks.loadSkill,
    ),
    controlTool("memory_propose", "Propose a memory note, relation or status change; persistence is decided by the memory module.", [...AGENT_ROLES], memoryProposeInput, callbacks.memoryPropose),
  ] as Tool[];
}

function controlTool<Input>(
  name: string,
  description: string,
  roles: readonly (typeof AGENT_ROLES)[number][],
  input: z.ZodType<Input>,
  callback: ControlCallback<Input> | undefined,
  missing: "approval_unavailable" | "execution_failed" | "acknowledge" = "execution_failed",
  endsTurn = false,
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
    ...(endsTurn ? { ends_turn: true } : {}),
  });
  return defineTool(metadata, input, {
    async normalize(value, context) {
      return actionOf(metadata, value, context);
    },
    async execute(value, context) {
      if (callback === undefined) {
        return missing === "acknowledge" ? okResult(REPORT_RECORDED) : errorResult(missing, `${name} is not available in this runtime`);
      }
      try {
        return await callback(value, context);
      } catch (error: unknown) {
        return errorResult("execution_failed", messageOf(error));
      }
    },
  });
}
