import {
  deltaTaskPacketSchema,
  digestSchema,
  pathPatternsOverlap,
  packetDigest,
  planDigest,
  planSchema,
  taskContextPacketSchema,
  type DeltaTaskPacket,
  type Digest,
  type EvidenceRef,
  type Plan,
  type PlanId,
  type PlanTask,
  type RunId,
  type TaskContextPacket,
  type TaskId,
} from "../contracts/index.ts";
import { roleCapabilityIssues } from "./capabilities.ts";
import { isLiteralPattern, matchesAny } from "./paths.ts";

/**
 * Plan validation and packet compilation. The orchestrator never hands a worker its transcript:
 * everything a worker learns arrives through a schema-checked packet compiled here from the
 * approved plan, the task and evidence-backed facts.
 */

export type PlanValidation =
  /** `notes`: what validation changed in the candidate (cross-task criteria moved to the integration review). */
  | { readonly ok: true; readonly plan: Plan; readonly digest: Digest; readonly notes?: readonly string[] }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface PlanExpectations {
  readonly runId: RunId;
  readonly planId: PlanId;
  readonly version: number;
}

/**
 * `planSchema`, the identity the coordinator expects (a plan for another run is rejected) and the
 * role capability rules (`roleCapabilityIssues`: e.g. no verification command on an explorer).
 */
export function validatePlan(candidate: unknown, expected: PlanExpectations): PlanValidation {
  const parsed = planSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    };
  }
  const plan = parsed.data;
  const issues: string[] = [];
  if (plan.run_id !== expected.runId) issues.push(`run_id: expected ${expected.runId}`);
  if (plan.plan_id !== expected.planId) issues.push(`plan_id: expected ${expected.planId}`);
  if (plan.version !== expected.version) issues.push(`version: expected ${expected.version}`);
  issues.push(...roleCapabilityIssues(plan));
  if (issues.length > 0) return { ok: false, issues };
  const placement = placeCrossTaskCriteria(plan);
  if (placement.issues.length > 0) return { ok: false, issues: placement.issues };
  if (placement.notes.length === 0) return { ok: true, plan, digest: planDigest(plan) };
  const moved = planSchema.safeParse(placement.plan);
  if (!moved.success) return { ok: false, issues: moved.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`) };
  return { ok: true, plan: moved.data, digest: planDigest(moved.data), notes: placement.notes };
}

/**
 * A reviewer task with two or more dependencies is the plan's integration review: it runs as its
 * own reviewer attempt after its dependencies completed and were integrated, over the combined
 * workspace, and checks only its own (cross-task) criteria. A reviewer task with one dependency
 * configures that task's mandatory independent review instead (its criteria join that review).
 * Every writing task above trivial keeps its own per-task review either way (ADR-09); the two never
 * check the same criteria.
 */
export function isIntegrationReview(task: Pick<PlanTask, "role" | "depends_on">): boolean {
  return task.role === "reviewer" && task.depends_on.length >= 2;
}

/** Paths nobody reads through a workspace-wide read scope: git internals, the Synorch control dir, env files. */
export const WORKSPACE_READ_EXCLUSIONS: readonly string[] = [".git/**", ".synorch/**", "**/.env", "**/.env.*"];

/** Explorers and reviewers read the whole workspace (read-only); their write scope stays empty. */
export function workspaceReadScope(paths: readonly string[]): string[] {
  return [...new Set([...paths, "**"])];
}

/** The exclusions join `forbidden`, except one overlapping a path the reviewed task owns (a reviewer must read what it reviews). */
function withReadExclusions(forbidden: readonly string[], owned: readonly string[] = []): string[] {
  const exclusions = WORKSPACE_READ_EXCLUSIONS.filter((exclusion) => !owned.some((pattern) => pathPatternsOverlap(pattern, exclusion)));
  return [...new Set([...forbidden, ...exclusions])];
}

const PATH_TOKEN = /[\w@./\\-]+/g;

/** File-like tokens of a criterion statement (`src/a.ts`, `add.test.mjs`), normalized to forward slashes. */
function pathTokens(statement: string): string[] {
  const tokens = (statement.match(PATH_TOKEN) ?? []).map((token) =>
    token
      .replaceAll("\\", "/")
      .replace(/^(?:\.\/)+/, "")
      .replace(/[.,;:]+$/, ""),
  );
  return [...new Set(tokens.filter((token) => token.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(token)))];
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** Whether `token` names a file `task` owns: a match of its owned patterns, or the basename of a literal owned path. */
function ownsToken(task: PlanTask, token: string): boolean {
  if (matchesAny(token, task.owned_paths)) return true;
  const lowered = token.toLowerCase();
  return task.owned_paths.some((pattern) => isLiteralPattern(pattern) && basename(pattern).includes(".") && basename(pattern).toLowerCase() === lowered);
}

function transitiveDependencies(plan: Plan, key: string): Set<string> {
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
  const seen = new Set<string>();
  const stack = [...(byKey.get(key)?.depends_on ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byKey.get(next)?.depends_on ?? []));
  }
  return seen;
}

export interface CriteriaPlacement {
  readonly plan: Plan;
  readonly notes: readonly string[];
  readonly issues: readonly string[];
}

/**
 * Per-task criteria must be checkable from that task's artifact plus workspace reads (live run
 * 01M381W6: criteria about other tasks' files reached each per-task review, every reviewer found
 * them unverifiable, and nothing was integrated). A criterion of a writing task that names a file
 * owned by another task it does not depend on belongs to the integration review: it is moved to
 * the integration reviewer task that depends (transitively) on both, with a note in the plan's
 * assumptions. Without such a reviewer, or when the task would keep no criterion of its own, the
 * plan is rejected with what to change.
 */
export function placeCrossTaskCriteria(plan: Plan): CriteriaPlacement {
  const notes: string[] = [];
  const issues: string[] = [];
  const reviewers = plan.tasks.filter(isIntegrationReview).map((task) => ({ task, covers: transitiveDependencies(plan, task.key), added: [] as { id: string; statement: string }[] }));
  const kept = new Map<string, { id: string; statement: string }[]>();
  for (const task of plan.tasks) {
    if (task.owned_paths.length === 0) continue;
    const dependencies = transitiveDependencies(plan, task.key);
    const others = plan.tasks.filter((other) => other.key !== task.key && other.owned_paths.length > 0 && !dependencies.has(other.key));
    if (others.length === 0) continue;
    const remaining: { id: string; statement: string }[] = [];
    const moving: { criterion: { id: string; statement: string }; owners: string[]; token: string }[] = [];
    for (const criterion of task.acceptance_criteria) {
      const hit = pathTokens(criterion.statement)
        .filter((token) => !ownsToken(task, token))
        .map((token) => ({ token, owners: others.filter((other) => ownsToken(other, token)).map((other) => other.key) }))
        .find((entry) => entry.owners.length > 0);
      if (hit === undefined) remaining.push(criterion);
      else moving.push({ criterion, owners: hit.owners, token: hit.token });
    }
    if (moving.length === 0) continue;
    for (const { criterion, owners, token } of moving) {
      const target = reviewers.find((reviewer) => reviewer.covers.has(task.key) && owners.every((owner) => reviewer.covers.has(owner)));
      const why = `${task.key} ${criterion.id} names ${token}, owned by ${owners.join(", ")}, which ${task.key} does not depend on`;
      if (target === undefined) {
        issues.push(
          `${why}: its own review cannot check another task's work. Put the criterion on an integration reviewer task (role reviewer, depends_on [${[task.key, ...owners].join(", ")}]) or make ${task.key} depend on ${owners.join(", ")}`,
        );
        continue;
      }
      if (remaining.length === 0) {
        issues.push(`${why}; moved to the integration review ${target.task.key}, ${task.key} would keep no criterion of its own: give it one checkable from its own files`);
        continue;
      }
      const used = [...target.task.acceptance_criteria, ...target.added].map((entry) => Number(entry.id.slice(3)));
      const id = `AC-${Math.max(0, ...used) + 1}`;
      target.added.push({ id, statement: `(from ${task.key}) ${criterion.statement}` });
      notes.push(`Moved ${task.key} ${criterion.id} to the integration review ${target.task.key} as ${id}: it names ${token}, owned by ${owners.join(", ")}.`);
    }
    kept.set(task.key, remaining);
  }
  if (issues.length > 0 || notes.length === 0) return { plan, notes: [], issues };
  const added = new Map(reviewers.map((reviewer) => [reviewer.task.key, reviewer.added]));
  const tasks = plan.tasks.map((task) => ({
    ...task,
    acceptance_criteria: [...(kept.get(task.key) ?? task.acceptance_criteria), ...(added.get(task.key) ?? [])],
  }));
  return { plan: { ...plan, tasks, assumptions: [...plan.assumptions, ...notes] }, notes, issues };
}

export interface PacketSource {
  readonly path: string;
  readonly digest: Digest;
}

export interface CompilePacketInput {
  readonly plan: Plan;
  readonly planDigest: Digest;
  readonly task: PlanTask;
  readonly taskId: TaskId;
  readonly createdAt: string;
  readonly sources: readonly PacketSource[];
  readonly findings: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly preferWorktree: boolean;
  /** The worker step floor (`StepFloors.worker`); `MIN_TASK_STEPS` when absent. */
  readonly stepFloor?: number;
}

export const EXPECTED_REPORT = [
  "summary",
  "acceptance_evidence",
  "commands_run",
  "decisions_made",
  "skipped_checks",
  "unresolved_risks",
] as const;

function isolationFor(task: PlanTask, preferWorktree: boolean): TaskContextPacket["isolation"] {
  if (task.owned_paths.length === 0) return "shared-read-only";
  if (task.risk === "high-risk" || preferWorktree) return "worktree";
  return "scoped-dir";
}

function writeModeFor(task: PlanTask): TaskContextPacket["write_mode"] {
  if (task.owned_paths.length > 0) return "owned-paths";
  return task.role === "debugger" ? "rca-only" : "read-only";
}

function uniqueSources(sources: readonly PacketSource[]): PacketSource[] {
  const seen = new Map<string, PacketSource>();
  for (const source of sources) seen.set(source.path, source);
  return [...seen.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Lower bound of a task's step limit: a real model spends several steps on reads, the change, the check and the report (F13). */
export const MIN_TASK_STEPS = 25;

/** Lower bound of an independent reviewer's step limit: reads, its own checks and the report (live run 01M37V2J). */
export const MIN_REVIEWER_STEPS = 25;

/**
 * Guaranteed step floors per attempt (live run 01M37V2J: the plan's `max_steps: 10` was the whole
 * run's step budget, the implementer's repairs used it up and both reviewer attempts ended
 * `budget_exceeded` without a report). `worker` bounds implementer/debugger/explorer attempts,
 * `reviewer` the independent review; `finishWarning` is how many steps before its limit an attempt
 * is told to finish and report.
 */
export interface StepFloors {
  readonly worker: number;
  readonly reviewer: number;
  readonly finishWarning: number;
}

export const DEFAULT_STEP_FLOORS: StepFloors = { worker: MIN_TASK_STEPS, reviewer: MIN_REVIEWER_STEPS, finishWarning: 3 };

/**
 * A task's share of the plan's step budget (F13): divided among the tasks that dispatch an attempt
 * (reviewer plan tasks never do; they configure the review of their dependencies), never below the
 * worker floor (`MIN_TASK_STEPS` by default).
 */
export function perTaskStepLimit(plan: Pick<Plan, "budget" | "tasks">, floor: number = MIN_TASK_STEPS): number {
  const dispatching = Math.max(1, plan.tasks.filter((task) => task.role !== "reviewer").length);
  return Math.max(floor, Math.min(500, Math.floor(plan.budget.max_steps / dispatching)));
}

/** The reviewer's step limit: never below the reviewer floor, nor below the implementation's own limit. */
export function reviewerStepLimit(taskSteps: number, floors: StepFloors = DEFAULT_STEP_FLOORS): number {
  return Math.min(500, Math.max(floors.reviewer, taskSteps));
}

/**
 * The run's step budget. The plan's `max_steps` is the orchestrator's estimate; it is never less
 * than what the run guarantees: every dispatching task's step limit plus, for a task that needs an
 * independent review (risk above trivial), the reviewer's. Attempts beyond that (retries,
 * revisions) draw from whatever is left.
 */
export function runStepLimit(plan: Pick<Plan, "budget" | "tasks">, floors: StepFloors = DEFAULT_STEP_FLOORS): number {
  const taskSteps = perTaskStepLimit(plan, floors.worker);
  const guaranteed = plan.tasks
    .filter((task) => task.role !== "reviewer")
    .reduce((sum, task) => sum + taskSteps + (task.risk === "trivial" ? 0 : reviewerStepLimit(taskSteps, floors)), 0);
  const integration = plan.tasks.filter(isIntegrationReview).length * reviewerStepLimit(taskSteps, floors);
  return Math.max(plan.budget.max_steps, guaranteed + integration);
}

/** Compiles the full v2 packet for one plan task; the schema re-validates every authority rule. */
export function compileTaskPacket(input: CompilePacketInput): TaskContextPacket {
  const { plan, task } = input;
  const perTaskSteps = perTaskStepLimit(plan, input.stepFloor ?? MIN_TASK_STEPS);
  const reader = task.owned_paths.length === 0 && (task.role === "explorer" || task.role === "reviewer");
  const stopConditions = [
    "A change outside owned_paths is required",
    "A cited source changed since the packet was created",
    "The acceptance criteria cannot be met without widening scope",
  ];
  return taskContextPacketSchema.parse({
    schema_version: 2,
    kind: "full",
    task_id: input.taskId,
    run_id: plan.run_id,
    plan_id: plan.plan_id,
    plan_version: plan.version,
    plan_digest: input.planDigest,
    role: task.role,
    model_tier: task.model_tier,
    risk: task.risk,
    write_mode: writeModeFor(task),
    isolation: isolationFor(task, input.preferWorktree),
    objective: task.objective,
    why: { user_goal: plan.goal, plan_reference: `${plan.plan_id}@${plan.version}#${task.key}` },
    scope: reader
      ? { owned_paths: [], read_paths: workspaceReadScope(task.read_paths), forbidden_paths: withReadExclusions(input.forbiddenPaths) }
      : { owned_paths: task.owned_paths, read_paths: task.read_paths, forbidden_paths: input.forbiddenPaths },
    known_facts: [],
    decisions: [...plan.assumptions.map((assumption) => `Assumption: ${assumption}`), ...input.findings],
    relevant_symbols: [],
    acceptance_criteria: task.acceptance_criteria,
    verification: { commands: task.verification },
    non_goals: [],
    open_questions: [],
    stop_conditions: stopConditions,
    limits: {
      max_steps: perTaskSteps,
      max_wall_time_seconds: Math.max(1, Math.min(86_400, plan.budget.max_wall_time_seconds)),
    },
    context: { created_at: input.createdAt, sources: uniqueSources(input.sources) },
    expected_report: [...EXPECTED_REPORT, ...(task.role === "debugger" ? ["root_cause"] : [])],
  });
}

/**
 * Re-packages a packet after its sources changed: digests are refreshed and every fact that cited
 * a changed source is dropped (and named as an open question), because it may no longer hold.
 */
export function refreshPacketSources(
  packet: TaskContextPacket,
  current: ReadonlyMap<string, Digest | undefined>,
  createdAt: string,
): TaskContextPacket {
  const changed = new Set(
    packet.context.sources.filter((source) => current.get(source.path) !== source.digest).map((source) => source.path),
  );
  const sources = packet.context.sources.flatMap((source) => {
    const digest = current.get(source.path);
    return digest === undefined ? [] : [{ path: source.path, digest }];
  });
  const dropped = packet.known_facts.filter((fact) => changed.has(fact.source));
  return taskContextPacketSchema.parse({
    ...packet,
    known_facts: packet.known_facts.filter((fact) => !changed.has(fact.source)),
    open_questions: [
      ...packet.open_questions,
      ...dropped.map((fact) => `Re-verify (source ${fact.source} changed): ${fact.statement}`),
    ],
    context: { ...packet.context, created_at: createdAt, sources },
  });
}

export interface DeltaInput {
  readonly base: TaskContextPacket;
  readonly createdAt: string;
  readonly notes: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly newCriteria: readonly { readonly id: string; readonly statement: string }[];
}

export function createDeltaPacket(input: DeltaInput): DeltaTaskPacket {
  return deltaTaskPacketSchema.parse({
    schema_version: 2,
    kind: "delta",
    task_id: input.base.task_id,
    extends_digest: packetDigest(input.base),
    plan_digest: input.base.plan_digest,
    created_at: input.createdAt,
    delta: {
      new_acceptance_criteria: input.newCriteria,
      new_known_facts: [],
      new_evidence: input.evidence,
      notes: input.notes.length > 0 ? input.notes : ["Follow-up requested by the orchestrator"],
    },
  });
}

export class DeltaMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DeltaMismatchError";
  }
}

/**
 * What a delta tells the next attempt beyond criteria and facts: its notes and the evidence to
 * address. They reach the worker in its task message (`renderWorkerMessage`), not as packet
 * decisions, so a retried packet does not grow with a copy of the delta (F19).
 */
export function deltaNotes(delta: DeltaTaskPacket): string[] {
  return [
    ...delta.delta.notes,
    ...delta.delta.new_evidence.map((evidence) => `Address evidence ${evidence.kind}:${evidence.ref} (${evidence.produced_by})`),
  ];
}

/**
 * The effective packet a worker sees after a delta. Scope, role, limits and write mode are carried
 * over verbatim from the base, so a delta can never widen authority. The delta's notes are not
 * copied into `decisions` (see `deltaNotes`).
 */
export function applyDelta(base: TaskContextPacket, delta: DeltaTaskPacket): TaskContextPacket {
  if (delta.task_id !== base.task_id) throw new DeltaMismatchError("delta targets another task");
  if (delta.extends_digest !== packetDigest(base)) throw new DeltaMismatchError("delta does not extend this packet");
  if (delta.plan_digest !== base.plan_digest) throw new DeltaMismatchError("delta belongs to another plan version");
  const existing = new Set(base.acceptance_criteria.map((criterion) => criterion.id));
  const added = delta.delta.new_acceptance_criteria.filter((criterion) => !existing.has(criterion.id));
  const sources = new Map(base.context.sources.map((source) => [source.path, source]));
  for (const fact of delta.delta.new_known_facts) sources.set(fact.source, { path: fact.source, digest: fact.source_digest });
  return taskContextPacketSchema.parse({
    ...base,
    known_facts: [...base.known_facts, ...delta.delta.new_known_facts],
    decisions: base.decisions,
    acceptance_criteria: [...base.acceptance_criteria, ...added],
    context: { ...base.context, created_at: delta.created_at, sources: [...sources.values()] },
  });
}

export interface ReviewerPacketInput {
  readonly implementation: TaskContextPacket;
  readonly artifactDigest: Digest;
  readonly createdAt: string;
  readonly reviewerTier: TaskContextPacket["model_tier"] | undefined;
  readonly extraCriteria: readonly { readonly id: string; readonly statement: string }[];
  /** Extra verification commands (from reviewer plan tasks); exact commands the approved plan names. */
  readonly extraVerification?: readonly string[];
  /** Criteria the orchestrator waived for a read-only task in triage; they are not reviewed. */
  readonly waivedCriteria?: readonly string[];
  /** The reviewer's step limit (`reviewerStepLimit`); the implementation's limit when absent. */
  readonly maxSteps?: number;
  /** Harness notes for this review (e.g. a re-dispatch after a scope-limited verdict). */
  readonly notes?: readonly string[];
}

/**
 * A fresh packet for the independent reviewer (ADR-09): read-only, pinned to the artifact digest
 * through `context.project_snapshot`, carrying the criteria but never the implementer transcript.
 */
export function compileReviewerPacket(input: ReviewerPacketInput): TaskContextPacket {
  const impl = input.implementation;
  const waived = new Set(input.waivedCriteria ?? []);
  const criteria = impl.acceptance_criteria.filter((criterion) => !waived.has(criterion.id));
  for (const extra of input.extraCriteria) {
    if (!criteria.some((criterion) => criterion.id === extra.id)) criteria.push(extra);
  }
  const commands = [...new Set([...impl.verification.commands, ...(input.extraVerification ?? [])])];
  return taskContextPacketSchema.parse({
    schema_version: 2,
    kind: "full",
    task_id: impl.task_id,
    run_id: impl.run_id,
    plan_id: impl.plan_id,
    plan_version: impl.plan_version,
    plan_digest: impl.plan_digest,
    role: "reviewer",
    model_tier: input.reviewerTier ?? impl.model_tier,
    risk: impl.risk,
    write_mode: "read-only",
    isolation: "shared-read-only",
    objective: `Independently verify the pinned artifact for: ${impl.objective}`,
    why: impl.why,
    scope: {
      owned_paths: [],
      read_paths: workspaceReadScope([...impl.scope.owned_paths, ...impl.scope.read_paths]),
      forbidden_paths: withReadExclusions(impl.scope.forbidden_paths, impl.scope.owned_paths),
    },
    known_facts: [],
    decisions: [
      `The artifact under review is pinned at ${input.artifactDigest}; it must not change during review.`,
      "Read scope: the whole workspace, read-only (not only the changed files). Criteria about other tasks' files or the combined result belong to the plan's integration review, not to this review.",
      ...(input.notes ?? []),
    ],
    relevant_symbols: impl.relevant_symbols,
    acceptance_criteria: criteria,
    verification: { commands },
    non_goals: ["Modifying the artifact under review"],
    open_questions: [],
    stop_conditions: ["The artifact changes during review"],
    limits: { ...impl.limits, max_steps: input.maxSteps ?? impl.limits.max_steps },
    context: { created_at: input.createdAt, project_snapshot: digestSchema.parse(input.artifactDigest), sources: [] },
    expected_report: ["criteria", "findings", "decision"],
  });
}
