import {
  REPORT_TOOL_NAMES,
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

export interface Planner {
  propose(input: PlannerInput, signal: AbortSignal): Promise<unknown>;
}

export const PLAN_FORMAT = [
  `Call the \`${REPORT_TOOL_NAMES.plan}\` tool with the plan (if the tool is unavailable, reply with exactly one \`\`\`json block holding it):`,
  '{"goal": "...", "risk": "trivial|standard|high-risk", "scope": ["src/**"],',
  ' "tasks": [{"key": "kebab-key", "role": "explorer|implementer|debugger|reviewer", "objective": "...", "depends_on": [],',
  '   "owned_paths": [], "read_paths": [], "risk": "trivial|standard|high-risk", "model_tier": "complex_worker|fast_worker|orchestrator",',
  '   "acceptance_criteria": [{"id": "AC-1", "statement": "..."}], "verification": ["pnpm test"]}],',
  ' "expected_external_effects": [], "verification": [], "budget": {"max_wall_time_seconds": 1800, "max_steps": 100}, "assumptions": []}',
  "Rules: explorers and reviewers own no paths; two tasks without a dependency between them never own overlapping paths;",
  "nobody owns the whole workspace, .git or .synorch. You never implement anything yourself.",
].join("\n");

export function renderPlanningPrompt(input: PlannerInput): string {
  return [
    `Goal: ${input.goal}`,
    `Workspace: ${input.workspaceRoot} (policy mode ${input.mode}).`,
    "Plan the work as a task DAG for workers. Explore first when the codebase is unknown.",
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
  };
}
