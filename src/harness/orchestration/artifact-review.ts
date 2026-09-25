import { z } from "zod";
import {
  createId,
  deriveProjectId,
  digestOf,
  digestSchema,
  taskContextPacketSchema,
  type BlobStore,
  type Digest,
  type EventStore,
  type ModelRoute,
  type PolicyMode,
  type ReviewReportInput,
  type RouteDecision,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
  type SessionId,
  type SessionStore,
  type TaskContextPacket,
  type TaskModelTier,
  type TaskState,
} from "../contracts/index.ts";
import { createBudgetTracker } from "./budget.ts";
import type { WorkerFactory } from "./coordinator.ts";
import { WORKSPACE_READ_EXCLUSIONS } from "./plan.ts";
import { createRunRecorder, REVIEW_MEDIA_TYPE } from "./recorder.ts";
import type { PinnedReviewArtifact } from "./worker-manager.ts";

/**
 * `/review` as the ADR-09 independent review of a standalone artifact: the uncommitted workspace
 * diff, the staged diff, a commit or range, or what a worker run integrated. The caller pins the
 * artifact (digest of the full reviewed diff), a reviewer attempt in a fresh session checks it
 * read-only against fixed, proportional criteria (P0), the digest is recomputed afterwards, and the
 * judged report is recorded as a run of its own (`review/recorded`, visible in `/evidence`).
 */

export type ReviewTarget =
  | { readonly kind: "workspace" }
  | { readonly kind: "staged" }
  | { readonly kind: "commit"; readonly rev: string }
  | { readonly kind: "range"; readonly from: string; readonly to: string; readonly symmetric: boolean }
  | { readonly kind: "run"; readonly ref: string };

export interface ParsedReviewArgument {
  readonly target: ReviewTarget;
  /** Free text after the target: what the reviewer should look at especially. */
  readonly focus: string;
  /** `/review fix`: send the last review's findings to the agent. */
  readonly fix: boolean;
  /** `--json` (headless `syn review`). */
  readonly json: boolean;
}

const COMMIT_TOKEN = /^(?:HEAD|@|[0-9a-f]{7,40})(?:[~^]\d*)*$/i;
const RANGE_TOKEN = /^([^\s.][^\s]*?)?(\.\.\.?)([^\s.][^\s]*)?$/;
const RUN_TOKEN = /^run-\d+$/i;

/**
 * `/review [--staged | <commit> | <from>..<to> | run-<n>] [focus…]`. A token that does not look like
 * a target starts the focus text (`/review error handling` keeps working); `fix` alone is `/review fix`.
 */
export function parseReviewArgument(argument: string): ParsedReviewArgument {
  const tokens = argument.trim().split(/\s+/).filter((token) => token !== "");
  const json = tokens.includes("--json");
  const rest = tokens.filter((token) => token !== "--json");
  if (rest.length === 1 && rest[0]?.toLowerCase() === "fix") return { target: { kind: "workspace" }, focus: "", fix: true, json };
  let target: ReviewTarget = { kind: "workspace" };
  const first = rest[0];
  let consumed = 0;
  if (first !== undefined) {
    const range = first.includes("..") ? RANGE_TOKEN.exec(first) : null;
    if (first === "--staged" || first === "--cached") target = { kind: "staged" };
    else if (RUN_TOKEN.test(first)) target = { kind: "run", ref: first.toLowerCase() };
    else if (range !== null && (range[1] !== undefined || range[3] !== undefined)) target = { kind: "range", from: range[1] ?? "HEAD", to: range[3] ?? "HEAD", symmetric: range[2] === "..." };
    else if (COMMIT_TOKEN.test(first)) target = { kind: "commit", rev: first };
    if (target.kind !== "workspace") consumed = 1;
  }
  return { target, focus: rest.slice(consumed).join(" "), fix: false, json };
}

/** One line naming the target (`uncommitted changes`, `commit 1a2b3c4`, `HEAD~3..HEAD`). */
export function describeReviewTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case "workspace":
      return "uncommitted changes";
    case "staged":
      return "staged changes";
    case "commit":
      return `commit ${target.rev}`;
    case "range":
      return `${target.from}${target.symmetric ? "..." : ".."}${target.to}`;
    case "run":
      return `files integrated by ${target.ref}`;
  }
}

const GENERATED_PATHS: readonly RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json)$/i,
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.svelte-kit|target|__pycache__|\.synorch|\.cache)\//i,
  /\.(min\.js|min\.css|map|snap|tsbuildinfo|pyc)$/i,
  /(^|\/)[^/]*\.generated\.[^/]+$/i,
  /(_pb2\.py|\.pb\.go|\.g\.dart|\.designer\.cs)$/i,
];

/** Generated artifacts (lockfiles, build output, snapshots, minified or generated sources): never reviewed, never a finding (P0). */
export function isGeneratedPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return GENERATED_PATHS.some((pattern) => pattern.test(normalized));
}

/** The fixed review criteria (ADR-09 packet criteria), in card order. */
export const REVIEW_CRITERIA = [
  { id: "AC-1", name: "correctness", statement: "Correctness: the change does what it evidently intends, without logic, edge-case, error-handling or security bugs." },
  { id: "AC-2", name: "scope", statement: "Scope: the change stays within its evident purpose (no unrelated edits, leftover debug code or unintended behaviour changes)." },
  { id: "AC-3", name: "tests", statement: "Tests/verification: changed behaviour is covered by tests or a stated verification, and existing tests are not weakened or removed without reason." },
  { id: "AC-4", name: "risks", statement: "Risks: no unflagged risky effect (data loss, breaking API/CLI/config changes, secrets, destructive commands, performance cliffs)." },
] as const;

export interface ArtifactReviewPacketInput {
  readonly runId: RunId;
  readonly taskId: TaskContextPacket["task_id"];
  readonly planId: TaskContextPacket["plan_id"];
  readonly artifactDigest: Digest;
  readonly label: string;
  readonly focus: string;
  readonly tier: TaskModelTier;
  readonly createdAt: string;
  readonly maxSteps?: number;
}

export const ARTIFACT_REVIEW_MAX_STEPS = 40;

/** The reviewer's fresh packet (ADR-09): read-only, pinned to the artifact digest, the fixed criteria, no conversation. */
export function compileArtifactReviewPacket(input: ArtifactReviewPacketInput): TaskContextPacket {
  return taskContextPacketSchema.parse({
    schema_version: 2,
    kind: "full",
    task_id: input.taskId,
    run_id: input.runId,
    plan_id: input.planId,
    plan_version: 1,
    plan_digest: digestOf({ artifact_review: input.label, artifact: input.artifactDigest }),
    role: "reviewer",
    model_tier: input.tier,
    risk: "standard",
    write_mode: "read-only",
    isolation: "shared-read-only",
    objective: `Independently review ${input.label} (pinned artifact ${input.artifactDigest})`,
    why: { user_goal: `The user asked for an independent review of ${input.label}${input.focus === "" ? "" : ` (focus: ${input.focus})`}` },
    scope: { owned_paths: [], read_paths: ["**"], forbidden_paths: [...WORKSPACE_READ_EXCLUSIONS] },
    known_facts: [],
    decisions: [
      `The artifact under review is pinned at ${input.artifactDigest}; it must not change during review.`,
      "Proportional review (P0): report what matters for correctness, scope, tests and risk. Never raise findings about formatting, naming taste or generated files (lockfiles, build output, snapshots, minified or generated sources); a clean change is accepted with no findings.",
      ...(input.focus === "" ? [] : [`The user asks you to pay special attention to: ${input.focus}`]),
    ],
    relevant_symbols: [],
    acceptance_criteria: REVIEW_CRITERIA.map((criterion) => ({ id: criterion.id, statement: criterion.statement })),
    verification: { commands: [] },
    non_goals: ["Modifying the workspace", "Cosmetic or style findings", "Findings about generated files"],
    open_questions: [],
    stop_conditions: ["The artifact changes during review"],
    limits: { max_steps: input.maxSteps ?? ARTIFACT_REVIEW_MAX_STEPS, max_wall_time_seconds: 1800 },
    context: { created_at: input.createdAt, project_snapshot: digestSchema.parse(input.artifactDigest), sources: [] },
    expected_report: ["criteria", "findings", "decision"],
  });
}

export interface ReviewDiffInput {
  readonly label: string;
  readonly digest: Digest;
  /** The diff text as shown (bounded). */
  readonly diff: string;
  readonly truncated: boolean;
  readonly changedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly focus: string;
}

/** The reviewer's first message: what is pinned, how to judge (proportional), and the diff. */
export function renderArtifactReviewBrief(input: ReviewDiffInput): string {
  return [
    `Independent review (ADR-09) of ${input.label}. You did not write this change and you have no conversation history.`,
    `The artifact under review is pinned at ${input.digest}: the diff below, applied in the workspace as it is now. The workspace is read-only for you; read any file you need, not only the changed ones.`,
    `Criteria:\n${REVIEW_CRITERIA.map((criterion) => `- ${criterion.id} ${criterion.statement}`).join("\n")}`,
    "Be proportional: a finding must matter for correctness, scope, tests or risk. No findings about formatting, naming taste or generated files. Severity: blocker (must not ship: broken build, data loss, security hole), major (a real bug, or changed behaviour without any test), minor (worth fixing, not blocking), info. Give every finding a workspace path and line, what is wrong and a recommendation.",
    "Decision: accept when there is no blocker or major finding; revise when there are fixable problems; block when the change must not proceed as it is.",
    ...(input.focus === "" ? [] : [`The user asks you to focus on: ${input.focus}`]),
    ...(input.excludedPaths.length === 0 ? [] : [`Generated files left out of the review: ${input.excludedPaths.slice(0, 20).join(", ")}${input.excludedPaths.length > 20 ? ", …" : ""}`]),
    `Changed files (${input.changedPaths.length}): ${input.changedPaths.slice(0, 60).join(", ")}${input.changedPaths.length > 60 ? ", …" : ""}`,
    `Diff${input.truncated ? " (truncated: read the files with your tools for the rest)" : ""}:\n\`\`\`diff\n${input.diff}\n\`\`\``,
  ].join("\n\n");
}

export type ReviewVerdict = "approve" | "changes_requested" | "blocked";
type Finding = ReviewReportInput["findings"][number];
type Criterion = ReviewReportInput["criteria"][number];

/**
 * The card's verdict from the reviewer's decision, findings and judged criteria (P0 proportional):
 * `block` or a blocker finding blocks; a major finding or a criterion `not_met` requests changes; a
 * `revise` with only minor/info findings is an approval with notes; `unverifiable` alone never fails.
 */
export function mapReviewVerdict(decision: ReviewReportInput["decision"], findings: readonly Finding[], criteria: readonly Pick<Criterion, "verdict">[]): ReviewVerdict {
  if (decision === "block" || findings.some((finding) => finding.severity === "blocker")) return "blocked";
  if (findings.some((finding) => finding.severity === "major") || criteria.some((criterion) => criterion.verdict === "not_met")) return "changes_requested";
  return "approve";
}

/** `review/recorded.decision` for a verdict. */
export function verdictDecision(verdict: ReviewVerdict): "accept" | "revise" | "block" {
  return verdict === "approve" ? "accept" : verdict === "changes_requested" ? "revise" : "block";
}

export type ArtifactReviewStatus = "reviewed" | "artifact_changed" | "no_report" | "cancelled" | "failed";

/** The structured result: the card, `/evidence`, `--json` and the "Fix these?" follow-up read this. */
export interface ArtifactReviewResult {
  readonly kind: "artifact-review";
  readonly runId: string;
  readonly sessionId: string;
  readonly reviewerAttemptId: string | undefined;
  readonly reviewerSessionId: string | undefined;
  readonly target: string;
  readonly targetKind: ReviewTarget["kind"];
  readonly artifactDigest: string;
  readonly changedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly reviewer: { readonly provider_id: string; readonly model_id: string };
  /** Undefined when the implementer's provider is unknown (a review outside a conversation). */
  readonly sameProvider: boolean | undefined;
  readonly status: ArtifactReviewStatus;
  readonly verdict: ReviewVerdict | undefined;
  readonly criteria: readonly { readonly id: string; readonly name: string; readonly verdict: Criterion["verdict"]; readonly note?: string; readonly evidence: readonly string[] }[];
  readonly findings: readonly Finding[];
  /** Every resolved evidence ref the verdicts rest on (`tool-call #3`). */
  readonly evidence: readonly string[];
  readonly problems: readonly string[];
}

/** The `review/recorded` blob of an artifact review (read back by `/evidence`). */
export const artifactReviewRecordSchema = z.looseObject({
  kind: z.literal("artifact-review"),
  target: z.string(),
  artifactDigest: z.string(),
  reviewer: z.looseObject({ provider_id: z.string(), model_id: z.string() }),
  status: z.string(),
  verdict: z.enum(["approve", "changes_requested", "blocked"]).optional(),
  criteria: z.array(z.looseObject({ id: z.string(), name: z.string(), verdict: z.enum(["met", "not_met", "unverifiable"]), note: z.string().optional(), evidence: z.array(z.string()) })),
  findings: z.array(z.looseObject({ id: z.string(), severity: z.string(), summary: z.string(), path: z.string().optional(), line: z.number().optional(), recommendation: z.string().optional() })),
  changedPaths: z.array(z.string()),
  evidence: z.array(z.string()),
});

export interface ArtifactReviewRequest {
  readonly workspaceRoot: string;
  readonly policyMode: PolicyMode;
  readonly headless: boolean;
  readonly target: ReviewTarget;
  readonly label: string;
  readonly focus: string;
  readonly tier: TaskModelTier;
  /** The reviewer route, decided (cross-provider routing) by the caller. */
  readonly route: RouteDecision;
  /** The implementer's route when known (the conversation's): the independence flags compare against it. */
  readonly implementer?: Pick<ModelRoute, "provider_id" | "model_id"> | undefined;
  readonly changedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly artifact: PinnedReviewArtifact;
}

export interface ArtifactReviewDependencies {
  readonly sessions: SessionStore;
  readonly blobs: BlobStore;
  readonly createWorkers: WorkerFactory;
  readonly emit?: (event: SessionEvent) => void;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
}

function observed(store: EventStore, emit: ((event: SessionEvent) => void) | undefined): EventStore {
  if (emit === undefined) return store;
  return {
    get sessionId() {
      return store.sessionId;
    },
    get lastSeq() {
      return store.lastSeq;
    },
    async append(draft: SessionEventDraft) {
      const event = await store.append(draft);
      emit(event);
      return event;
    },
    read: (fromSeq, toSeq) => store.read(fromSeq, toSeq),
    close: () => store.close(),
  };
}

/** The run goal of an artifact review; `/runs` and `/evidence` show it. */
export function artifactReviewGoal(label: string, focus: string): string {
  return `review: ${label}${focus === "" ? "" : ` (focus: ${focus})`}`.slice(0, 300);
}

/**
 * Runs one artifact review as its own run: `run/created`, one reviewer task, the reviewer attempt
 * (worker manager, fresh session, read-only), `review/recorded` with the structured result.
 * Never rejects; a harness failure is a `failed` result.
 */
export async function runArtifactReview(deps: ArtifactReviewDependencies, request: ArtifactReviewRequest, signal: AbortSignal): Promise<ArtifactReviewResult> {
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const runId: RunId = createId("run");
  const projectId = deriveProjectId(request.workspaceRoot, platform);
  const goal = artifactReviewGoal(request.label, request.focus);
  const log = observed(
    await deps.sessions.create({ session_id: createId("session"), project_id: projectId, workspace_root: request.workspaceRoot, created_at: now().toISOString(), title: goal.slice(0, 200) }),
    deps.emit,
  );
  const recorder = createRunRecorder(log, deps.blobs, runId);
  const taskId = createId("task");
  const planId = createId("plan");
  let taskState: TaskState = "draft";
  const moveTask = async (to: TaskState, reason: string): Promise<void> => {
    await recorder.record("task/state_changed", { task_id: taskId, from: taskState, to, reason: reason.slice(0, 500) }, { taskId });
    taskState = to;
  };
  const base = {
    kind: "artifact-review" as const,
    runId,
    sessionId: log.sessionId as string,
    target: request.label,
    targetKind: request.target.kind,
    artifactDigest: request.artifact.digest,
    changedPaths: request.changedPaths,
    excludedPaths: request.excludedPaths,
    reviewer: { provider_id: request.route.route.provider_id, model_id: request.route.route.model_id },
    sameProvider: request.implementer === undefined ? undefined : request.implementer.provider_id === request.route.route.provider_id,
  };
  let result: ArtifactReviewResult;
  try {
    await recorder.record("run/created", { goal, policy_mode: request.policyMode, headless: request.headless, budget: {} });
    await recorder.record("run/state_changed", { from: "created", to: "running", reason: "independent review started" });
    await recorder.record("task/created", { task_id: taskId, plan_id: planId, key: "review", role: "reviewer", depends_on: [], owned_paths: [], risk: "standard" }, { taskId });
    await moveTask("ready", "artifact pinned");
    const packet = compileArtifactReviewPacket({ runId, taskId, planId, artifactDigest: request.artifact.digest, label: request.label, focus: request.focus, tier: request.tier, createdAt: now().toISOString() });
    const budget = createBudgetTracker({ scope: "run", limits: { maxCostUsd: undefined, maxWallTimeSeconds: undefined, maxSteps: packet.limits.max_steps + 2, maxToolCalls: undefined } });
    const workers = deps.createWorkers({ runId, mode: request.policyMode, workspaceRoot: request.workspaceRoot, projectId, recorder }, budget);
    await moveTask("running", `independent review by ${base.reviewer.provider_id}/${base.reviewer.model_id}`);
    const handle = await workers.dispatchArtifactReview(packet, request.artifact, signal, { route: request.route });
    const outcome = await handle.result;
    await workers.dispose(handle.attemptId).catch(() => undefined);
    const reviewerSessionId = workers.attempt(handle.attemptId)?.sessionId;
    const report = outcome.report;
    const names = new Map<string, string>(REVIEW_CRITERIA.map((criterion) => [criterion.id, criterion.name]));
    const criteria = (report?.criteria ?? []).map((criterion) => ({
      id: criterion.criterion_id,
      name: names.get(criterion.criterion_id) ?? criterion.criterion_id,
      verdict: criterion.verdict,
      ...(criterion.note === undefined || criterion.note.trim() === "" ? {} : { note: criterion.note }),
      evidence: criterion.evidence.map((evidence) => `${evidence.kind} ${evidence.ref}`),
    }));
    const verdict = report === undefined ? undefined : mapReviewVerdict(report.decision, report.findings, report.criteria);
    const status: ArtifactReviewStatus = outcome.cancelled ? "cancelled" : report === undefined ? "no_report" : outcome.artifactChanged ? "artifact_changed" : "reviewed";
    result = {
      ...base,
      reviewerAttemptId: handle.attemptId,
      reviewerSessionId,
      status,
      verdict,
      criteria,
      findings: report?.findings ?? [],
      evidence: [...new Set(criteria.flatMap((criterion) => criterion.evidence))],
      problems: [...outcome.problems, ...(outcome.artifactChanged ? ["the artifact changed during review: the verdict applies to the pinned version only"] : [])],
    };
    if (report !== undefined && verdict !== undefined) {
      const blob = await recorder.putJson(result, REVIEW_MEDIA_TYPE);
      await recorder.record(
        "review/recorded",
        { task_id: taskId, reviewer_attempt_id: handle.attemptId, review_digest: digestOf(result), decision: verdictDecision(verdict), blob },
        { taskId, attemptId: handle.attemptId, actor: { kind: "worker", role: "reviewer", attempt_id: handle.attemptId } },
      );
    }
    if (status === "cancelled") await moveTask("cancelled", "review stopped");
    else if (report === undefined) await moveTask("failed", outcome.problems[0] ?? "the reviewer produced no valid report");
    else {
      await moveTask("verifying", "report judged");
      await moveTask("completed", status === "artifact_changed" ? "artifact changed during review" : `verdict: ${verdict ?? "none"}`);
    }
    const to = status === "cancelled" ? "cancelled" : status === "reviewed" || status === "artifact_changed" ? "completed" : "failed";
    await recorder.record("run/state_changed", { from: "running", to, reason: to === "completed" ? `review ${verdict ?? ""}`.trim() : status.replaceAll("_", " ") });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ...base, reviewerAttemptId: undefined, reviewerSessionId: undefined, status: signal.aborted ? "cancelled" : "failed", verdict: undefined, criteria: [], findings: [], evidence: [], problems: [message] };
    await recorder.record("run/state_changed", { from: "running", to: signal.aborted ? "cancelled" : "failed", reason: message.slice(0, 500) }).catch(() => undefined);
  } finally {
    await log.close().catch(() => undefined);
  }
  return result;
}

export interface ReviewCardGlyphs {
  readonly ok: string;
  readonly warn: string;
  readonly fail: string;
  readonly bullet: string;
  readonly sep: string;
}

const VERDICT_TEXT: Record<ReviewVerdict, string> = { approve: "approved", changes_requested: "changes requested", blocked: "blocked" };

function findingLocation(finding: Pick<Finding, "path" | "line">): string {
  return finding.path === undefined ? "" : `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
}

/** The structured review card as transcript lines (plain and TUI alike). */
export function renderReviewCard(result: ArtifactReviewResult, g: ReviewCardGlyphs): string[] {
  const head =
    result.verdict === undefined
      ? `${g.fail} Review ${g.sep} ${result.status === "cancelled" ? "stopped" : "no verdict"} ${g.sep} ${result.target}`
      : `${result.verdict === "approve" ? g.ok : result.verdict === "blocked" ? g.fail : g.warn} Review ${g.sep} ${VERDICT_TEXT[result.verdict]} ${g.sep} ${result.target} (${result.changedPaths.length} file${result.changedPaths.length === 1 ? "" : "s"})`;
  const provider = result.sameProvider === undefined ? "" : result.sameProvider ? ", same provider" : ", another provider";
  const lines = [head, `  Reviewer  ${result.reviewer.provider_id}/${result.reviewer.model_id} (fresh context${provider}, read-only)`];
  const pinned = `${result.artifactDigest.slice(0, 19)}…`;
  lines.push(`  Artifact  ${pinned} ${result.status === "artifact_changed" ? `${g.sep} ${g.warn} artifact changed during review: the verdict covers the pinned version; run /review again` : `${g.sep} unchanged during review`}`);
  if (result.excludedPaths.length > 0) lines.push(`  Skipped   ${result.excludedPaths.length} generated file${result.excludedPaths.length === 1 ? "" : "s"} (${result.excludedPaths.slice(0, 3).join(", ")}${result.excludedPaths.length > 3 ? ", …" : ""})`);
  if (result.criteria.length > 0) lines.push(`  Criteria  ${result.criteria.map((criterion) => `${criterion.name} ${criterion.verdict.replaceAll("_", " ")}`).join(` ${g.sep} `)}`);
  if (result.findings.length === 0 && result.verdict !== undefined) lines.push("  Findings  none");
  if (result.findings.length > 0) {
    lines.push(`  Findings  ${result.findings.length}`);
    for (const finding of result.findings) {
      const where = findingLocation(finding);
      lines.push(`    ${finding.severity.padEnd(7)} ${where === "" ? "" : `${where}  `}${finding.summary}`);
      if (finding.recommendation !== undefined) lines.push(`            ${g.bullet} ${finding.recommendation}`);
    }
  }
  if (result.evidence.length > 0) lines.push(`  Evidence  ${result.evidence.slice(0, 8).join(", ")}${result.evidence.length > 8 ? ", …" : ""} (reviewer's own tool calls) ${g.sep} /evidence`);
  for (const problem of result.problems.slice(0, 3)) lines.push(`  Note      ${problem}`);
  return lines;
}

/** Findings worth handing to the agent (`Fix these?`): everything but `info`. */
export function actionableFindings(result: ArtifactReviewResult): readonly Finding[] {
  return result.findings.filter((finding) => finding.severity !== "info");
}

/** The follow-up message the session agent receives when the user accepts "Fix these?". */
export function fixFollowUpMessage(result: ArtifactReviewResult, findings: readonly Finding[]): string {
  return [
    `An independent reviewer (${result.reviewer.provider_id}/${result.reviewer.model_id}, fresh context) reviewed ${result.target} (artifact ${result.artifactDigest.slice(0, 19)}…) and the user asks you to fix these findings:`,
    ...findings.map((finding, index) => {
      const where = findingLocation(finding);
      return `${index + 1}. [${finding.severity}] ${where === "" ? "" : `${where}: `}${finding.summary}${finding.recommendation === undefined ? "" : ` (recommendation: ${finding.recommendation})`}`;
    }),
    "Check each finding against the code first; fix the real ones, say which you skip and why, and run the relevant tests.",
  ].join("\n");
}

/** Session ids a review result points at (the review run and the reviewer's attempt). */
export function reviewSessionIds(result: ArtifactReviewResult): SessionId[] {
  return [result.sessionId, ...(result.reviewerSessionId === undefined ? [] : [result.reviewerSessionId])] as SessionId[];
}
