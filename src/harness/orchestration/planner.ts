import {
  REPORT_TOOL_NAMES,
  renderRoleCapabilityTable,
  type AgentDriver,
  type BlobStore,
  type EffectivePolicy,
  type EventStore,
  type ModelRoute,
  type PlanId,
  type PolicyMode,
  type RunId,
  type SessionId,
} from "../contracts/index.ts";
import { buildAttemptLog, latestReport, readEvents } from "./attempt-log.ts";
import { extractJsonBlock } from "./claims.ts";

/**
 * Plan production. The coordinator only needs a candidate; `validatePlan` decides whether it is a
 * plan. The model planner runs one orchestrator turn in the run session and reads the plan from the
 * last succeeded `plan_propose` call (fallback: the final message's JSON block); identity fields
 * (ids, version, timestamp) are always set by the harness.
 */

export interface PlannerInput {
  readonly runId: RunId;
  readonly planId: PlanId;
  readonly version: number;
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly mode: PolicyMode;
  readonly createdAt: string;
  /** Validation problems of the previous candidate and queued steering, newest last. */
  readonly feedback: readonly string[];
  readonly route: ModelRoute;
  readonly policy: EffectivePolicy;
  readonly events: EventStore;
  readonly sessionId: SessionId;
}

export interface ConsultInput {
  readonly runId: RunId;
  readonly goal: string;
  readonly planVersion: number;
  /** Steering the user queued since the plan was approved, oldest first. */
  readonly steering: readonly string[];
  /** One line per task of the active plan with its current state. */
  readonly tasks: readonly string[];
  readonly route: ModelRoute;
  readonly policy: EffectivePolicy;
  readonly events: EventStore;
  readonly sessionId: SessionId;
}

export interface TriageInput {
  readonly runId: RunId;
  readonly goal: string;
  readonly planVersion: number;
  /** The triaged task: key, id, role, risk and write mode. */
  readonly task: { readonly key: string; readonly taskId: string; readonly role: string; readonly risk: string; readonly writeMode: string };
  readonly attempt: number;
  readonly status: string;
  /** Criteria of the task, each marked with whether the report evidenced it. */
  readonly criteria: readonly { readonly id: string; readonly statement: string; readonly evidenced: boolean; readonly capabilityNote: string | undefined }[];
  readonly summary: string;
  readonly skippedChecks: readonly string[];
  readonly unresolvedRisks: readonly string[];
  /** Whether `accept` is possible (read-only task that changed nothing). */
  readonly acceptable: boolean;
  readonly retriesLeft: number;
  readonly tasks: readonly string[];
  readonly route: ModelRoute;
  readonly policy: EffectivePolicy;
  readonly events: EventStore;
  readonly sessionId: SessionId;
}

export interface Planner {
  propose(input: PlannerInput, signal: AbortSignal): Promise<unknown>;
  /**
   * Mid-run consultation at a safe boundary (after user steering): one orchestrator turn that may
   * call `task_status` and `task_spawn`. Whatever it adds reaches workers only through a new,
   * approved plan revision. Optional: a planner without it re-versions the plan with the steering.
   */
  consult?(input: ConsultInput, signal: AbortSignal): Promise<void>;
  /**
   * Triage of a worker's `partial` or `needs_context` report (never retried blindly): one
   * orchestrator turn that decides with `task_triage` (accept findings of a read-only task, retry
   * with guidance, or fail) and may add follow-up tasks with `task_spawn`. Optional: without it the
   * harness retries once with the report in the delta packet.
   */
  triage?(input: TriageInput, signal: AbortSignal): Promise<void>;
}

export function renderTriagePrompt(input: TriageInput): string {
  const criteria = input.criteria.map(
    (criterion) => `- ${criterion.id} [${criterion.evidenced ? "evidenced" : "NOT evidenced"}]: ${criterion.statement}${criterion.capabilityNote === undefined ? "" : ` (harness note: ${criterion.capabilityNote})`}`,
  );
  return [
    `Worker report needs your decision (plan v${input.planVersion}, goal: ${input.goal}).`,
    `Task ${input.task.key} ${input.task.taskId} (${input.task.role}, ${input.task.risk}, ${input.task.writeMode}), attempt ${input.attempt}, reported ${input.status}.`,
    `Summary: ${input.summary}`,
    `Acceptance criteria:\n${criteria.join("\n")}`,
    input.skippedChecks.length > 0 ? `Skipped checks:\n${input.skippedChecks.map((line) => `- ${line}`).join("\n")}` : "",
    input.unresolvedRisks.length > 0 ? `Unresolved:\n${input.unresolvedRisks.map((line) => `- ${line}`).join("\n")}` : "",
    `Tasks:\n${input.tasks.map((line) => `- ${line}`).join("\n")}`,
    [
      `Call task_triage exactly once for task ${input.task.key}:`,
      input.acceptable
        ? "- accept: the findings are sufficient; list in waive_criteria the criteria this role could not meet (they are handed to dependent tasks as notes); every other criterion must be evidenced."
        : "- accept is not possible: this task writes files, so it completes only through verification and independent review.",
      `- retry: one more attempt (${input.retriesLeft} left) with your guidance; only when a new attempt can succeed.`,
      "- fail: stop this task (its dependents are cancelled); add replacement work with task_spawn if the goal still needs it.",
      "You never implement anything yourself. Do not ask the user. End your turn after deciding.",
    ].join("\n"),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function renderConsultPrompt(input: ConsultInput): string {
  return [
    `The user steered the running plan v${input.planVersion} for: ${input.goal}`,
    `User steering (newest last):\n${input.steering.map((line) => `- ${line}`).join("\n")}`,
    `Tasks:\n${input.tasks.map((line) => `- ${line}`).join("\n")}`,
    "Tasks that have not started yet will receive this steering through a revised plan. If the steering needs extra work, call task_spawn with one plan task per follow-up (same fields as a plan_propose task); use task_status to inspect tasks. You never implement anything yourself. End your turn when done.",
  ].join("\n\n");
}

export const PLAN_FORMAT = [
  `Call the \`${REPORT_TOOL_NAMES.plan}\` tool with the plan (if the tool is unavailable, reply with exactly one \`\`\`json block holding it):`,
  '{"goal": "...", "risk": "trivial|standard|high-risk", "scope": ["src/**"],',
  ' "tasks": [{"key": "kebab-key", "role": "explorer|implementer|debugger|reviewer", "objective": "...", "depends_on": [],',
  '   "owned_paths": [], "read_paths": [], "risk": "trivial|standard|high-risk", "model_tier": "complex_worker|fast_worker|orchestrator",',
  '   "acceptance_criteria": [{"id": "AC-1", "statement": "..."}], "verification": ["pnpm test"]}],',
  ' "expected_external_effects": [], "verification": [], "budget": {"max_wall_time_seconds": 1800, "max_steps": 100}, "assumptions": []}',
  "Rules: explorers and reviewers own no paths; two tasks without a dependency between them never own overlapping paths;",
  "nobody owns the whole workspace, .git or .synorch. An explorer runs no commands: its verification is empty and its criteria are about what to find by reading;",
  "put commands on the implementer that owns the change. A reviewer task depends on the standard/high-risk task(s) it reviews. You never implement anything yourself.",
].join("\n");

export function renderPlanningPrompt(input: PlannerInput): string {
  return [
    `Goal: ${input.goal}`,
    `Workspace: ${input.workspaceRoot} (policy mode ${input.mode}).`,
    "Plan the work as a task DAG for workers. Explore first when the codebase is unknown; for a small, well-located change an explorer is optional.",
    renderRoleCapabilityTable(),
    PLAN_FORMAT,
    input.feedback.length > 0 ? `Fix these problems from the previous attempt:\n${input.feedback.map((line) => `- ${line}`).join("\n")}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export interface ModelPlannerDependencies {
  readonly createDriver: (events: EventStore) => AgentDriver;
  readonly blobs: BlobStore;
  readonly maxSteps?: number;
}

export function createModelPlanner(deps: ModelPlannerDependencies): Planner {
  return {
    async propose(input, signal) {
      await deps.createDriver(input.events).runTurn(
        {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: undefined,
          attemptId: undefined,
          role: "orchestrator",
          route: input.route,
          policy: input.policy,
          packet: undefined,
          userMessage: renderPlanningPrompt(input),
          trigger: "orchestrator",
          maxSteps: deps.maxSteps ?? 20,
        },
        signal,
      );
      const log = await buildAttemptLog(input.sessionId, await readEvents(input.events), deps.blobs);
      const raw = latestReport(log, REPORT_TOOL_NAMES.plan) ?? extractJsonBlock(log.finalAssistantText ?? "");
      if (typeof raw !== "object" || raw === null) return raw;
      return {
        ...(raw as Record<string, unknown>),
        schema_version: 1,
        plan_id: input.planId,
        run_id: input.runId,
        version: input.version,
        created_at: input.createdAt,
      };
    },
    async triage(input, signal) {
      await deps.createDriver(input.events).runTurn(
        {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: undefined,
          attemptId: undefined,
          role: "orchestrator",
          route: input.route,
          policy: input.policy,
          packet: undefined,
          userMessage: renderTriagePrompt(input),
          trigger: "orchestrator",
          maxSteps: deps.maxSteps ?? 20,
        },
        signal,
      );
    },
    async consult(input, signal) {
      await deps.createDriver(input.events).runTurn(
        {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: undefined,
          attemptId: undefined,
          role: "orchestrator",
          route: input.route,
          policy: input.policy,
          packet: undefined,
          userMessage: renderConsultPrompt(input),
          trigger: "steer",
          maxSteps: deps.maxSteps ?? 20,
        },
        signal,
      );
    },
  };
}
