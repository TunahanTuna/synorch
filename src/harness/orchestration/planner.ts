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
  type TaskModelTier,
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
  /** K1.7: messages the user sent running workers directly since the last orchestrator turn (`to <key>: text`). */
  readonly workerMessages?: readonly string[];
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
  /**
   * Criteria of the task with their evidence *after resolution* (ADR-18, F10): `resolved`,
   * `unresolved` (with the reason) or `missing`; `evidenced` is `evidence === "resolved"`.
   */
  readonly criteria: readonly {
    readonly id: string;
    readonly statement: string;
    readonly evidenced: boolean;
    readonly evidence?: "resolved" | "unresolved" | "missing";
    readonly reason?: string | undefined;
    readonly capabilityNote: string | undefined;
  }[];
  /** Verification problems that remained after the in-session repairs (a completed report that did not verify). */
  readonly problems?: readonly string[];
  /**
   * Verification commands that could not run for a plan-caused reason (refused, not runnable,
   * program not found); they never went to a worker repair. `verificationOnly`: they are the only
   * problems left, so `accept` (waiving them) is possible even for a writing task.
   */
  readonly planCaused?: readonly string[];
  readonly verificationOnly?: boolean;
  /**
   * A verified writing task whose review_revisions budget is spent (the review still did not
   * accept, no blocker finding): `accept` integrates the change with the findings as notes.
   */
  readonly reviewOverride?: boolean;
  /** What the review said, when the triage follows a review (per-task or integration). */
  readonly reviewNote?: string;
  /** The task's owned paths (where a replacement check script must live). */
  readonly ownedPaths?: readonly string[];
  /** The harness-run verification commands and their outcome. */
  readonly harnessChecks?: readonly string[];
  /** K1.7: messages the user sent running workers directly since the last orchestrator turn. */
  readonly workerMessages?: readonly string[];
  readonly summary: string;
  readonly skippedChecks: readonly string[];
  readonly unresolvedRisks: readonly string[];
  /** Whether `accept` is possible (read-only task that changed nothing). */
  readonly acceptable: boolean;
  /**
   * The writing task changed these owned paths and nothing verified or reviewed them yet: `review`
   * sends the change to harness verification and independent review (preferred over `fail`).
   */
  readonly reviewablePaths?: readonly string[];
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

function evidenceLabel(criterion: TriageInput["criteria"][number]): string {
  const status = criterion.evidence ?? (criterion.evidenced ? "resolved" : "missing");
  return status === "unresolved" ? `unresolved: ${criterion.reason ?? "the pointers do not resolve"}` : status;
}

export function renderTriagePrompt(input: TriageInput): string {
  const criteria = input.criteria.map(
    (criterion) => `- ${criterion.id} [${evidenceLabel(criterion)}]: ${criterion.statement}${criterion.capabilityNote === undefined ? "" : ` (harness note: ${criterion.capabilityNote})`}`,
  );
  const problems = input.problems ?? [];
  const checks = input.harnessChecks ?? [];
  const planCaused = input.planCaused ?? [];
  const acceptLine = input.reviewOverride === true
    ? "- accept: the harness verification passed and the review found no blocker; the change is integrated with the review findings recorded as notes. Choose it only when the remaining findings do not matter for the goal."
    : input.acceptable
    ? "- accept: the findings are sufficient; list in waive_criteria the criteria this role could not meet (they are handed to dependent tasks as notes); every other criterion must be evidenced."
    : input.verificationOnly === true
      ? "- accept: the change goes to independent review without the commands that could not run (they are waived and noted); choose it when the reviewer can still check the criteria."
      : "- accept is not possible: this task writes files, so it completes only through verification and independent review.";
  return [
    `Worker report needs your decision (plan v${input.planVersion}, goal: ${input.goal}).`,
    `Task ${input.task.key} ${input.task.taskId} (${input.task.role}, ${input.task.risk}, ${input.task.writeMode}), attempt ${input.attempt}, reported ${input.status}${problems.length > 0 ? " but did not pass verification after its in-session repairs" : ""}.`,
    `Summary: ${input.summary}`,
    input.reviewNote === undefined ? "" : `Review: ${input.reviewNote}`,
    `Acceptance criteria (evidence as the harness resolved it):\n${criteria.join("\n")}`,
    checks.length > 0 ? `Harness-run verification:\n${checks.map((line) => `- ${line}`).join("\n")}` : "",
    problems.length > 0 ? `Verification problems:\n${problems.slice(0, 10).map((line) => `- ${line}`).join("\n")}` : "",
    planCaused.length > 0
      ? `Plan-caused (the plan's verification could not run; the worker cannot fix this and was not asked to):\n${planCaused.map((command) => `- ${command}`).join("\n")}\nTo replace them, call task_triage with decision retry and verification = the whole replacement list: plain argv commands (no shell syntax, no inline interpreter code) such as \`node <check script inside ${(input.ownedPaths ?? []).join(", ") || "the owned paths"}>\` or the project's test runner; the plan is revised and a new attempt continues from the current change.`
      : "",
    input.skippedChecks.length > 0 ? `Skipped checks:\n${input.skippedChecks.map((line) => `- ${line}`).join("\n")}` : "",
    input.unresolvedRisks.length > 0 ? `Unresolved:\n${input.unresolvedRisks.map((line) => `- ${line}`).join("\n")}` : "",
    renderWorkerMessages(input.workerMessages),
    `Tasks:\n${input.tasks.map((line) => `- ${line}`).join("\n")}`,
    [
      `Call task_triage exactly once for task ${input.task.key}:`,
      acceptLine,
      `- retry: one more attempt (${input.retriesLeft} left) with your guidance; only when a new attempt can succeed.`,
      ...((input.reviewablePaths ?? []).length > 0
        ? [`- review: the worker produced ${(input.reviewablePaths ?? []).join(", ")}; send it to harness verification and independent review with the worker's caveats as notes (the reviewer decides). Prefer this over fail when the change may already meet the criteria; a check the worker invented and the sandbox refused is not a reason to fail.`]
        : []),
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
    renderWorkerMessages(input.workerMessages),
    `Tasks:\n${input.tasks.map((line) => `- ${line}`).join("\n")}`,
    "Tasks that have not started yet will receive this steering through a revised plan. If the steering needs extra work, call task_spawn with one plan task per follow-up (same fields as a plan_propose task); use task_status to inspect tasks. You never implement anything yourself. End your turn when done.",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** K1.7: the user's direct messages to workers, so the orchestrator knows what its workers were told. */
export function renderWorkerMessages(messages: readonly string[] | undefined): string {
  if (messages === undefined || messages.length === 0) return "";
  return `The user messaged running workers directly (they received these at their next step; take them into account):\n${messages.slice(-20).map((line) => `- ${line}`).join("\n")}`;
}

export const PLAN_FORMAT = [
  // ADR-20 / F19: the plan's shape is the plan_propose tool schema; repeating a JSON template here re-bills it on every request.
  `Call the \`${REPORT_TOOL_NAMES.plan}\` tool once with the whole plan; its schema lists every field (if the tool is unavailable, reply with exactly one \`\`\`json block holding the same object).`,
  "Rules: explorers and reviewers own no paths; two tasks without a dependency between them never own overlapping paths;",
  "nobody owns the whole workspace, .git or .synorch. An explorer runs no commands: its verification is empty and its criteria are about what to find by reading;",
  "put commands on the implementer that owns the change. A reviewer task depends on the standard/high-risk task(s) it reviews; with several dependencies it is the integration review of their combined result.",
  "A task's criteria must be checkable from its own files; criteria about other tasks' files or the combined result go on the integration reviewer task. You never implement anything yourself.",
  "Optional per-task effort: low for trivial or mechanical tasks (renames, boilerplate, small edits), high for hard debugging or design; omit it otherwise. The user's own effort settings override it.",
].join("\n");

export function renderPlanningPrompt(input: PlannerInput, projectHint?: string): string {
  return [
    `Goal: ${input.goal}`,
    `Workspace: ${input.workspaceRoot} (policy mode ${input.mode}).`,
    projectHint ?? "",
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
  /** The detected project's real commands (zero-config profile), so plan verification uses existing scripts. */
  readonly projectHint?: () => string | undefined;
  /** K7: the plugin agents a task may name as `agent` (one line each), or undefined when there are none. */
  readonly personaHint?: () => string | undefined;
  /** K7: a named agent's model hint as a task tier; it replaces the task's tier (the user's routes for that tier still decide). */
  readonly personaTier?: (agent: string) => TaskModelTier | undefined;
}

/** K7: a task naming a plugin agent with a model hint runs on the hinted tier. */
function applyPersonaTiers(raw: Record<string, unknown>, tierOf: ((agent: string) => TaskModelTier | undefined) | undefined): Record<string, unknown> {
  if (tierOf === undefined || !Array.isArray(raw.tasks)) return raw;
  const tasks = raw.tasks.map((task: unknown) => {
    if (typeof task !== "object" || task === null) return task;
    const record = task as Record<string, unknown>;
    const tier = typeof record.agent === "string" ? tierOf(record.agent) : undefined;
    return tier === undefined ? record : { ...record, model_tier: tier };
  });
  return { ...raw, tasks };
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
          userMessage: renderPlanningPrompt(input, [deps.projectHint?.(), deps.personaHint?.()].filter((part): part is string => part !== undefined && part !== "").join("\n\n") || undefined),
          trigger: "orchestrator",
          maxSteps: deps.maxSteps ?? 20,
        },
        signal,
      );
      const log = await buildAttemptLog(input.sessionId, await readEvents(input.events), deps.blobs);
      const raw = latestReport(log, REPORT_TOOL_NAMES.plan) ?? extractJsonBlock(log.finalAssistantText ?? "");
      if (typeof raw !== "object" || raw === null) return raw;
      return {
        ...applyPersonaTiers(raw as Record<string, unknown>, deps.personaTier),
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
