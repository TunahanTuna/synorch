import {
  deltaTaskPacketSchema,
  digestSchema,
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

/**
 * Plan validation and packet compilation. The orchestrator never hands a worker its transcript:
 * everything a worker learns arrives through a schema-checked packet compiled here from the
 * approved plan, the task and evidence-backed facts.
 */

export type PlanValidation =
  | { readonly ok: true; readonly plan: Plan; readonly digest: Digest }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface PlanExpectations {
  readonly runId: RunId;
  readonly planId: PlanId;
  readonly version: number;
}

/** `planSchema` plus the identity the coordinator expects; a plan for another run is rejected. */
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
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plan, digest: planDigest(plan) };
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

/** Compiles the full v2 packet for one plan task; the schema re-validates every authority rule. */
export function compileTaskPacket(input: CompilePacketInput): TaskContextPacket {
  const { plan, task } = input;
  const perTaskSteps = Math.max(1, Math.min(500, Math.floor(plan.budget.max_steps / plan.tasks.length) || 1));
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
    scope: { owned_paths: task.owned_paths, read_paths: task.read_paths, forbidden_paths: input.forbiddenPaths },
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
 * The effective packet a worker sees after a delta. Scope, role, limits and write mode are carried
 * over verbatim from the base, so a delta can never widen authority.
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
    decisions: [
      ...base.decisions,
      ...delta.delta.notes.map((note) => `Revision note: ${note}`),
      ...delta.delta.new_evidence.map((evidence) => `Address evidence ${evidence.kind}:${evidence.ref} (${evidence.produced_by})`),
    ],
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
}

/**
 * A fresh packet for the independent reviewer (ADR-09): read-only, pinned to the artifact digest
 * through `context.project_snapshot`, carrying the criteria but never the implementer transcript.
 */
export function compileReviewerPacket(input: ReviewerPacketInput): TaskContextPacket {
  const impl = input.implementation;
  const criteria = [...impl.acceptance_criteria];
  for (const extra of input.extraCriteria) {
    if (!criteria.some((criterion) => criterion.id === extra.id)) criteria.push(extra);
  }
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
      read_paths: [...impl.scope.owned_paths, ...impl.scope.read_paths],
      forbidden_paths: impl.scope.forbidden_paths,
    },
    known_facts: [],
    decisions: [`The artifact under review is pinned at ${input.artifactDigest}; it must not change during review.`],
    relevant_symbols: impl.relevant_symbols,
    acceptance_criteria: criteria,
    verification: impl.verification,
    non_goals: ["Modifying the artifact under review"],
    open_questions: [],
    stop_conditions: ["The artifact changes during review"],
    limits: impl.limits,
    context: { created_at: input.createdAt, project_snapshot: digestSchema.parse(input.artifactDigest), sources: [] },
    expected_report: ["criteria", "findings", "decision"],
  });
}
