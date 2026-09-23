import { z } from "zod";
import {
  evidenceRefSchema,
  modelTierSchema,
  nonEmptyTextSchema,
  READ_ONLY_ROLES,
  riskClassSchema,
  timestampSchema,
  workerRoleSchema,
  type WorkerRole,
} from "./common.ts";
import { digestOf, digestSchema, SOURCE_DIGEST_SCHEMES, type Digest } from "./digest.ts";
import { evidenceResolutionSchema, harnessEvidenceSchema, repairCountsSchema } from "./evidence.ts";
import {
  acceptanceCriterionIdSchema,
  attemptIdSchema,
  modelIdSchema,
  planIdSchema,
  providerIdSchema,
  runIdSchema,
  taskIdSchema,
} from "./ids.ts";
import {
  isReservedWritePattern,
  isWholeWorkspacePattern,
  pathPatternSchema,
  pathPatternsOverlap,
} from "./paths.ts";

/**
 * Orchestration packets: Plan, Task Context Packet v2 (full and delta), Completion Packet and
 * Review Packet. They are the only language between the orchestrator and workers; raw parent
 * transcripts are never handed down. Every packet is digested with `digestOf` and the digest is
 * what events, approvals and freshness checks refer to.
 */

const taskKeySchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "task key must be kebab-case").max(80);

const acceptanceCriterionSchema = z.strictObject({
  id: acceptanceCriterionIdSchema,
  statement: nonEmptyTextSchema,
});

const scopeSchema = z.strictObject({
  owned_paths: z.array(pathPatternSchema),
  read_paths: z.array(pathPatternSchema),
  forbidden_paths: z.array(pathPatternSchema),
});

type Issue = { readonly path: (string | number)[]; readonly message: string };

function checkWriteScope(role: WorkerRole | "orchestrator", owned: readonly string[], forbidden: readonly string[], base: (string | number)[]): Issue[] {
  const issues: Issue[] = [];
  if ((READ_ONLY_ROLES as readonly string[]).includes(role) && owned.length > 0) {
    issues.push({ path: [...base, "owned_paths"], message: `${role} is read-only and cannot own paths` });
  }
  for (const [index, pattern] of owned.entries()) {
    if (isWholeWorkspacePattern(pattern)) {
      issues.push({ path: [...base, "owned_paths", index], message: "owning the whole workspace is not allowed" });
    }
    if (isReservedWritePattern(pattern)) {
      issues.push({ path: [...base, "owned_paths", index], message: "reserved paths (.git, .synorch) cannot be owned" });
    }
    for (const blocked of forbidden) {
      if (pathPatternsOverlap(pattern, blocked)) {
        issues.push({ path: [...base, "owned_paths", index], message: `owned path overlaps forbidden path ${blocked}` });
      }
    }
  }
  return issues;
}

function checkUniqueCriteria(criteria: readonly { readonly id: string }[], base: (string | number)[]): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const [index, criterion] of criteria.entries()) {
    if (seen.has(criterion.id)) issues.push({ path: [...base, index, "id"], message: `duplicate criterion ${criterion.id}` });
    seen.add(criterion.id);
  }
  return issues;
}

function report(context: z.RefinementCtx, issues: readonly Issue[]): void {
  for (const issue of issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
}

export const planTaskSchema = z.strictObject({
  key: taskKeySchema,
  role: workerRoleSchema,
  objective: nonEmptyTextSchema,
  depends_on: z.array(taskKeySchema),
  owned_paths: z.array(pathPatternSchema),
  read_paths: z.array(pathPatternSchema),
  risk: riskClassSchema,
  model_tier: modelTierSchema,
  acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
  verification: z.array(z.string().min(1)),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

/** The part of a plan the orchestrator model authors; identity fields are always set by the harness. */
const planProposalShape = {
  goal: nonEmptyTextSchema,
  risk: riskClassSchema,
  scope: z.array(pathPatternSchema).min(1),
  tasks: z.array(planTaskSchema).min(1),
  expected_external_effects: z.array(z.string().min(1)),
  verification: z.array(z.string().min(1)),
  budget: z.strictObject({
    max_wall_time_seconds: z.int().positive(),
    max_steps: z.int().positive(),
    max_cost_usd: z.number().positive().optional(),
  }),
  assumptions: z.array(z.string().min(1)),
};

/**
 * Input of the `plan_propose` tool. Structural only: DAG, ownership and overlap rules are checked
 * by `planSchema` once the harness adds `schema_version`, `plan_id`, `run_id`, `version`, `created_at`.
 */
export const planProposalSchema = z.strictObject(planProposalShape);
export type PlanProposal = z.infer<typeof planProposalSchema>;

export const planSchema = z
  .strictObject({
    schema_version: z.literal(1),
    plan_id: planIdSchema,
    run_id: runIdSchema,
    version: z.int().min(1),
    ...planProposalShape,
    created_at: timestampSchema,
  })
  .superRefine((plan, context) => {
    const keys = new Map(plan.tasks.map((task, index) => [task.key, index]));
    if (keys.size !== plan.tasks.length) {
      context.addIssue({ code: "custom", path: ["tasks"], message: "task keys must be unique" });
    }
    for (const [index, task] of plan.tasks.entries()) {
      report(context, checkWriteScope(task.role, task.owned_paths, [], ["tasks", index]));
      report(context, checkUniqueCriteria(task.acceptance_criteria, ["tasks", index, "acceptance_criteria"]));
      for (const dependency of task.depends_on) {
        if (!keys.has(dependency)) {
          context.addIssue({ code: "custom", path: ["tasks", index, "depends_on"], message: `unknown dependency ${dependency}` });
        }
      }
    }
    const cycle = findCycle(plan.tasks);
    if (cycle !== undefined) {
      context.addIssue({ code: "custom", path: ["tasks"], message: `dependency cycle: ${cycle.join(" -> ")}` });
      return;
    }
    const reach = transitiveDependencies(plan.tasks);
    for (let left = 0; left < plan.tasks.length; left += 1) {
      for (let right = left + 1; right < plan.tasks.length; right += 1) {
        const a = plan.tasks[left];
        const b = plan.tasks[right];
        if (a === undefined || b === undefined) continue;
        const ordered = reach.get(a.key)?.has(b.key) === true || reach.get(b.key)?.has(a.key) === true;
        if (ordered) continue;
        const clash = a.owned_paths.find((pattern) => b.owned_paths.some((other) => pathPatternsOverlap(pattern, other)));
        if (clash !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["tasks", right, "owned_paths"],
            message: `tasks ${a.key} and ${b.key} can run in parallel but both own ${clash}; add a dependency or split ownership`,
          });
        }
      }
    }
  });
export type Plan = z.infer<typeof planSchema>;

function findCycle(tasks: readonly PlanTask[]): string[] | undefined {
  const edges = new Map(tasks.map((task) => [task.key, task.depends_on]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    if (state.get(key) === "done") return undefined;
    if (state.get(key) === "visiting") return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, "visiting");
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state.set(key, "done");
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.key);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function transitiveDependencies(tasks: readonly PlanTask[]): Map<string, Set<string>> {
  const edges = new Map(tasks.map((task) => [task.key, task.depends_on]));
  const memo = new Map<string, Set<string>>();
  const collect = (key: string): Set<string> => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const result = new Set<string>();
    memo.set(key, result);
    for (const dependency of edges.get(key) ?? []) {
      result.add(dependency);
      for (const inherited of collect(dependency)) result.add(inherited);
    }
    return result;
  };
  for (const task of tasks) collect(task.key);
  return memo;
}

export function planDigest(plan: Plan): Digest {
  return digestOf(plan);
}

const knownFactSchema = z.strictObject({
  statement: nonEmptyTextSchema,
  source: pathPatternSchema,
  source_digest: digestSchema,
  confidence: z.enum(["verified", "inferred"]),
});

export const TASK_PACKET_SCHEMA_VERSION = 2 as const;

/** Per-file and total caps for read_paths contents inlined into a packet (ADR-20). */
export const INLINE_SOURCE_MAX_BYTES = 8 * 1024;
export const INLINE_SOURCES_MAX_TOTAL_BYTES = 32 * 1024;

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/**
 * A small read_paths file inlined into the packet so the worker need not read it again. `digest`
 * is the source's digest (same scheme as `context.sources`); `truncated` content is a prefix.
 */
const inlineSourceSchema = z.strictObject({
  path: pathPatternSchema,
  digest: digestSchema,
  content: z.string().refine((text) => utf8Length(text) <= INLINE_SOURCE_MAX_BYTES, `inline content is at most ${INLINE_SOURCE_MAX_BYTES} bytes`),
  truncated: z.boolean(),
});

export const taskContextPacketSchema = z
  .strictObject({
    schema_version: z.literal(TASK_PACKET_SCHEMA_VERSION),
    kind: z.literal("full"),
    task_id: taskIdSchema,
    parent_task_id: taskIdSchema.optional(),
    run_id: runIdSchema,
    plan_id: planIdSchema,
    plan_version: z.int().min(1),
    plan_digest: digestSchema,
    role: workerRoleSchema,
    model_tier: modelTierSchema,
    risk: riskClassSchema,
    write_mode: z.enum(["read-only", "owned-paths", "rca-only"]),
    isolation: z.enum(["worktree", "scoped-dir", "shared-read-only"]),
    objective: nonEmptyTextSchema,
    why: z.strictObject({ user_goal: nonEmptyTextSchema, plan_reference: z.string().min(1).optional() }),
    scope: scopeSchema,
    known_facts: z.array(knownFactSchema),
    decisions: z.array(nonEmptyTextSchema),
    relevant_symbols: z.array(z.strictObject({ file: pathPatternSchema, symbols: z.array(z.string().min(1)).min(1) })),
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
    verification: z.strictObject({ commands: z.array(z.string().min(1)) }),
    non_goals: z.array(nonEmptyTextSchema),
    open_questions: z.array(nonEmptyTextSchema),
    stop_conditions: z.array(nonEmptyTextSchema),
    limits: z.strictObject({
      max_steps: z.int().positive().max(500),
      max_wall_time_seconds: z.int().positive().max(86_400),
      max_tool_calls: z.int().positive().max(5_000).optional(),
      max_cost_usd: z.number().positive().optional(),
    }),
    context: z.strictObject({
      created_at: timestampSchema,
      project_snapshot: digestSchema.optional(),
      sources: z.array(z.strictObject({ path: pathPatternSchema, digest: digestSchema })),
      /**
       * How `sources` and `known_facts` digests were computed (ADR-19). `workspace-raw-v1`: raw bytes
       * in the attempt's own workspace after isolation, so they are valid write preconditions there.
       * Absent means `text-lf-v1` (pre-ADR-19 packets); readers compare with the same scheme.
       */
      digest_scheme: z.enum(SOURCE_DIGEST_SCHEMES).optional(),
      /** Small read_paths contents inlined for the worker (ADR-20); each one is a listed source. */
      inline_sources: z.array(inlineSourceSchema).max(32).optional(),
    }),
    expected_report: z.array(z.string().min(1)).min(1),
  })
  .superRefine((packet, context) => {
    report(context, checkWriteScope(packet.role, packet.scope.owned_paths, packet.scope.forbidden_paths, ["scope"]));
    report(context, checkUniqueCriteria(packet.acceptance_criteria, ["acceptance_criteria"]));
    const writes = packet.scope.owned_paths.length > 0;
    if (writes !== (packet.write_mode === "owned-paths")) {
      context.addIssue({ code: "custom", path: ["write_mode"], message: "write_mode owned-paths is required exactly when owned_paths is non-empty" });
    }
    if (packet.write_mode === "rca-only" && packet.role !== "debugger") {
      context.addIssue({ code: "custom", path: ["write_mode"], message: "rca-only applies to debugger packets" });
    }
    if (writes && packet.isolation === "shared-read-only") {
      context.addIssue({ code: "custom", path: ["isolation"], message: "a writing worker needs worktree or scoped-dir isolation" });
    }
    if (packet.risk === "high-risk" && writes && packet.isolation !== "worktree") {
      context.addIssue({ code: "custom", path: ["isolation"], message: "high-risk writing tasks require worktree isolation" });
    }
    const sourced = new Set(packet.context.sources.map((source) => `${source.path}\u0000${source.digest}`));
    for (const [index, fact] of packet.known_facts.entries()) {
      if (!sourced.has(`${fact.source}\u0000${fact.source_digest}`)) {
        context.addIssue({
          code: "custom",
          path: ["known_facts", index, "source_digest"],
          message: "every known fact must cite a source listed in context.sources with the same digest",
        });
      }
    }
    let inlined = 0;
    for (const [index, inline] of (packet.context.inline_sources ?? []).entries()) {
      inlined += utf8Length(inline.content);
      if (!sourced.has(`${inline.path}\u0000${inline.digest}`)) {
        context.addIssue({
          code: "custom",
          path: ["context", "inline_sources", index, "digest"],
          message: "an inlined source must be listed in context.sources with the same digest",
        });
      }
    }
    if (inlined > INLINE_SOURCES_MAX_TOTAL_BYTES) {
      context.addIssue({ code: "custom", path: ["context", "inline_sources"], message: `inlined sources exceed ${INLINE_SOURCES_MAX_TOTAL_BYTES} bytes in total` });
    }
  });
export type TaskContextPacket = z.infer<typeof taskContextPacketSchema>;

/**
 * Follow-up to the same task. It can add criteria, evidence and facts; it can never touch scope,
 * role, limits or write mode, so a delta cannot widen authority. Widening needs a new full packet.
 */
export const deltaTaskPacketSchema = z
  .strictObject({
    schema_version: z.literal(TASK_PACKET_SCHEMA_VERSION),
    kind: z.literal("delta"),
    task_id: taskIdSchema,
    extends_digest: digestSchema,
    plan_digest: digestSchema,
    created_at: timestampSchema,
    delta: z.strictObject({
      new_acceptance_criteria: z.array(acceptanceCriterionSchema),
      new_known_facts: z.array(knownFactSchema),
      new_evidence: z.array(evidenceRefSchema),
      notes: z.array(nonEmptyTextSchema),
    }),
  })
  .superRefine((packet, context) => {
    report(context, checkUniqueCriteria(packet.delta.new_acceptance_criteria, ["delta", "new_acceptance_criteria"]));
    const d = packet.delta;
    if (d.new_acceptance_criteria.length + d.new_known_facts.length + d.new_evidence.length + d.notes.length === 0) {
      context.addIssue({ code: "custom", path: ["delta"], message: "a delta packet must change something" });
    }
  });
export type DeltaTaskPacket = z.infer<typeof deltaTaskPacketSchema>;

export const anyTaskPacketSchema = z.discriminatedUnion("kind", [taskContextPacketSchema, deltaTaskPacketSchema]);
export type AnyTaskPacket = z.infer<typeof anyTaskPacketSchema>;

export const COMPLETION_STATUSES = ["completed", "partial", "failed", "blocked", "needs_context"] as const;

export const completionPacketSchema = z
  .strictObject({
    schema_version: z.literal(TASK_PACKET_SCHEMA_VERSION),
    task_id: taskIdSchema,
    attempt_id: attemptIdSchema,
    packet_digest: digestSchema,
    status: z.enum(COMPLETION_STATUSES),
    summary: nonEmptyTextSchema,
    changed_paths: z.array(
      z.strictObject({ path: pathPatternSchema, before: digestSchema.nullable(), after: digestSchema.nullable() }),
    ),
    artifact_digest: digestSchema.optional(),
    tool_call_ids: z.array(z.string().min(1)),
    acceptance_evidence: z.array(
      z.strictObject({ criterion_id: acceptanceCriterionIdSchema, evidence: z.array(evidenceRefSchema).min(1) }),
    ),
    commands_run: z.array(
      z.strictObject({ command: z.string().min(1), exit_code: z.int(), evidence: evidenceRefSchema }),
    ),
    decisions_made: z.array(nonEmptyTextSchema),
    skipped_checks: z.array(z.strictObject({ check: z.string().min(1), reason: nonEmptyTextSchema })),
    unresolved_risks: z.array(nonEmptyTextSchema),
    recommended_context_updates: z.array(nonEmptyTextSchema),
    root_cause: z.string().min(1).optional(),
    /** Facts the harness computed itself after the worker's turn (ADR-18): verification runs, the diff. */
    harness_evidence: harnessEvidenceSchema.optional(),
    /** How every model-written pointer resolved (or why it did not), after the correction round. */
    evidence_resolution: z.array(evidenceResolutionSchema).max(200).optional(),
    repairs: repairCountsSchema.optional(),
  })
  .superRefine((packet, context) => {
    const harnessRefs = new Set([
      ...(packet.harness_evidence?.verification ?? []).map((record) => `${record.evidence.kind}\u0000${record.evidence.ref}`),
      ...(packet.harness_evidence?.diff === undefined ? [] : [`${packet.harness_evidence.diff.evidence.kind}\u0000${packet.harness_evidence.diff.evidence.ref}`]),
    ]);
    for (const [index, entry] of packet.acceptance_evidence.entries()) {
      for (const [position, evidence] of entry.evidence.entries()) {
        if (evidence.produced_by === "harness" && !harnessRefs.has(`${evidence.kind}\u0000${evidence.ref}`)) {
          context.addIssue({
            code: "custom",
            path: ["acceptance_evidence", index, "evidence", position],
            message: "harness evidence must be one of the records in harness_evidence",
          });
        }
      }
    }
    const diff = packet.harness_evidence?.diff;
    if (diff !== undefined) {
      if (diff.evidence.ref !== packet.artifact_digest) {
        context.addIssue({ code: "custom", path: ["harness_evidence", "diff", "evidence", "ref"], message: "the harness diff points at the pinned artifact digest" });
      }
      const reported = new Set(packet.changed_paths.map((change) => change.path));
      if (diff.changed_paths.length !== reported.size || diff.changed_paths.some((path) => !reported.has(path))) {
        context.addIssue({ code: "custom", path: ["harness_evidence", "diff", "changed_paths"], message: "the harness diff lists exactly the changed paths" });
      }
    }
    for (const [index, change] of packet.changed_paths.entries()) {
      if (isReservedWritePattern(change.path)) {
        context.addIssue({ code: "custom", path: ["changed_paths", index, "path"], message: "reserved path reported as changed" });
      }
      if (change.before === null && change.after === null) {
        context.addIssue({ code: "custom", path: ["changed_paths", index], message: "a change needs a before or after digest" });
      }
    }
    if (packet.changed_paths.length > 0 && packet.artifact_digest === undefined) {
      context.addIssue({ code: "custom", path: ["artifact_digest"], message: "changed paths require a pinned artifact (diff) digest" });
    }
    if (packet.status === "completed" && packet.acceptance_evidence.length === 0) {
      context.addIssue({ code: "custom", path: ["acceptance_evidence"], message: "completed requires evidence per acceptance criterion" });
    }
    for (const [index, entry] of packet.acceptance_evidence.entries()) {
      if (entry.evidence.some((evidence) => evidence.produced_by === "reviewer")) {
        context.addIssue({ code: "custom", path: ["acceptance_evidence", index], message: "a worker cannot cite reviewer evidence" });
      }
    }
  });
export type CompletionPacket = z.infer<typeof completionPacketSchema>;

export const FINDING_SEVERITIES = ["blocker", "major", "minor", "info"] as const;

/**
 * Evidence that can carry a met verdict on its own (ADR-09 as amended by ADR-18 and review R1):
 * what the reviewer produced itself, or a harness verification run. The pinned diff
 * (`harness-diff`) only shows that a change exists and is supporting evidence; the worker's claim
 * never counts. Orchestration additionally requires the run to have passed and to prove the
 * criterion (`verificationProves`), which the packet alone cannot show.
 */
function isIndependentKind(evidence: { readonly kind: string; readonly produced_by: string }): boolean {
  return evidence.produced_by === "reviewer" || evidence.kind === "harness-verification";
}
export const REVIEW_DECISIONS = ["accept", "revise", "block"] as const;

const reviewCriterionSchema = z.strictObject({
  criterion_id: acceptanceCriterionIdSchema,
  verdict: z.enum(["met", "not_met", "unverifiable"]),
  evidence: z.array(evidenceRefSchema),
  note: z.string().optional(),
});

const reviewFindingSchema = z.strictObject({
  id: z.string().regex(/^F-[1-9]\d*$/, "must be F-<n>"),
  severity: z.enum(FINDING_SEVERITIES),
  summary: nonEmptyTextSchema,
  path: pathPatternSchema.optional(),
  line: z.int().positive().optional(),
  reproduction: z.string().min(1).optional(),
  recommendation: z.string().min(1).optional(),
});

export const reviewPacketSchema = z
  .strictObject({
    schema_version: z.literal(TASK_PACKET_SCHEMA_VERSION),
    task_id: taskIdSchema,
    reviewed_attempt_id: attemptIdSchema,
    reviewer_attempt_id: attemptIdSchema,
    completion_digest: digestSchema,
    reviewed_artifact_digest: digestSchema,
    reviewer_route: z.strictObject({ provider_id: providerIdSchema, model_id: modelIdSchema }),
    independence: z.strictObject({
      separate_context: z.literal(true),
      same_provider: z.boolean(),
      same_model: z.boolean(),
    }),
    criteria: z.array(reviewCriterionSchema).min(1),
    findings: z.array(reviewFindingSchema),
    decision: z.enum(REVIEW_DECISIONS),
    /** How the reviewer's pointers resolved after its correction round (ADR-18). */
    evidence_resolution: z.array(evidenceResolutionSchema).max(200).optional(),
    repairs: repairCountsSchema.pick({ report_corrections: true }).optional(),
  })
  .superRefine((review, context) => {
    if (review.reviewed_attempt_id === review.reviewer_attempt_id) {
      context.addIssue({ code: "custom", path: ["reviewer_attempt_id"], message: "an attempt cannot review itself" });
    }
    report(context, checkUniqueCriteria(review.criteria.map((criterion) => ({ id: criterion.criterion_id })), ["criteria"]));
    for (const [index, criterion] of review.criteria.entries()) {
      if (criterion.verdict === "met" && !criterion.evidence.some(isIndependentKind)) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "evidence"],
          message: "a met verdict needs evidence the reviewer produced itself or a harness verification run (harness-diff alone is not enough)",
        });
      }
    }
    if (review.decision === "accept") {
      if (review.criteria.some((criterion) => criterion.verdict !== "met")) {
        context.addIssue({ code: "custom", path: ["decision"], message: "accept requires every criterion met" });
      }
      if (review.findings.some((finding) => finding.severity === "blocker")) {
        context.addIssue({ code: "custom", path: ["decision"], message: "accept is impossible with a blocker finding" });
      }
    }
  });
export type ReviewPacket = z.infer<typeof reviewPacketSchema>;

/**
 * Structured report tools (control effect). A worker ends its attempt with `task_report`, a
 * reviewer with `review_report`, the orchestrator proposes a plan with `plan_propose`. The gateway
 * validates the input against these schemas (the model gets `invalid_arguments` back and can retry)
 * and records the call; orchestration reads the arguments of the last *succeeded* report call from
 * the attempt log. A report is a claim: identity, changed paths, the artifact digest and tool call
 * ids are always computed by the harness, and every evidence pointer is verified against the log.
 */
export const REPORT_TOOL_NAMES = { task: "task_report", review: "review_report", plan: "plan_propose" } as const;
export type ReportToolName = (typeof REPORT_TOOL_NAMES)[keyof typeof REPORT_TOOL_NAMES];

/**
 * The evidence pointer as the report tools show it to the model: defined once (`$defs/evidence`
 * in the tool's JSON schema) instead of repeated per use; `digest` stays optional (ADR-20).
 */
const reportEvidenceSchema = evidenceRefSchema.meta({ id: "evidence" });

export const taskReportInputSchema = z.strictObject({
  status: z.enum(COMPLETION_STATUSES),
  summary: nonEmptyTextSchema,
  acceptance_evidence: z
    .array(z.strictObject({ criterion_id: acceptanceCriterionIdSchema, evidence: z.array(reportEvidenceSchema).min(1) }))
    .default([]),
  commands_run: z.array(z.strictObject({ command: z.string().min(1), exit_code: z.int(), evidence: reportEvidenceSchema })).default([]),
  decisions_made: z.array(nonEmptyTextSchema).default([]),
  skipped_checks: z.array(z.strictObject({ check: z.string().min(1), reason: nonEmptyTextSchema })).default([]),
  unresolved_risks: z.array(nonEmptyTextSchema).default([]),
  recommended_context_updates: z.array(nonEmptyTextSchema).default([]),
  root_cause: z.string().min(1).optional(),
});
export type TaskReportInput = z.infer<typeof taskReportInputSchema>;

export const reviewReportInputSchema = z.strictObject({
  criteria: z.array(reviewCriterionSchema.extend({ evidence: z.array(reportEvidenceSchema) })).min(1),
  findings: z.array(reviewFindingSchema).default([]),
  decision: z.enum(REVIEW_DECISIONS),
});
export type ReviewReportInput = z.infer<typeof reviewReportInputSchema>;

export function packetDigest(packet: AnyTaskPacket | CompletionPacket | ReviewPacket): Digest {
  return digestOf(packet);
}

/**
 * Freshness gate for dispatch: every cited source must still hash to the digest in the packet.
 * `current` maps workspace-relative paths to their present digests (undefined = missing), computed
 * with the packet's `context.digest_scheme` in the workspace the packet was computed against (the
 * attempt workspace for `workspace-raw-v1`, ADR-19).
 */
export function findStaleSources(
  packet: TaskContextPacket,
  current: ReadonlyMap<string, Digest | undefined>,
): readonly { readonly path: string; readonly expected: Digest; readonly actual: Digest | undefined }[] {
  return packet.context.sources
    .filter((source) => current.get(source.path) !== source.digest)
    .map((source) => ({ path: source.path, expected: source.digest, actual: current.get(source.path) }));
}
