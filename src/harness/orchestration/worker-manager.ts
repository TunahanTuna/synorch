import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  completionPacketSchema,
  createId,
  DEFAULT_ORCHESTRATION_BUDGETS,
  digestOf,
  findStaleSources,
  formatEvidenceCorrection,
  HarnessError,
  packetDigest,
  ProviderFailure,
  REPORT_CORRECTION_ROUNDS,
  REPORT_TOOL_NAMES,
  reviewPacketSchema,
  taskContextPacketSchema,
  type AgentDriver,
  type AttemptHandle,
  type AttemptId,
  type BlobRef,
  type BlobStore,
  type CompletionPacket,
  type Digest,
  type DispatchOptions,
  type EffectivePolicy,
  type EventStore,
  type EvidenceProblem,
  type EvidenceRef,
  type EvidenceResolution,
  type HarnessEvidence,
  type HarnessVerification,
  type HarnessVerificationStatus,
  type ModelRoute,
  type ModelRouter,
  type OrchestrationBudgets,
  type PolicyEngine,
  type PolicyMode,
  type ProcessTermination,
  type ProjectId,
  type RepairCounts,
  type RepairKind,
  type ReportToolName,
  type ReviewOutcome,
  type ReviewPacket,
  type ReviewReportInput,
  type RunId,
  type SandboxReport,
  type SessionEvent,
  type SessionId,
  type SessionStore,
  type TaskContextPacket,
  type TaskId,
  type TaskReportInput,
  type ToolResult,
  type TurnInput,
  type TurnOutcome,
  type VerificationCommandClass,
  type WorkerManager,
  type WorkerRole,
  type WorkspaceDigestReader,
  INLINE_SOURCE_MAX_BYTES,
  INLINE_SOURCES_MAX_TOTAL_BYTES,
  workspaceDigest,
} from "../contracts/index.ts";
import { buildAttemptLog, readEvents, type AttemptLog } from "./attempt-log.ts";
import type { BudgetTracker } from "./budget.ts";
import {
  readClaim,
  REVIEWER_REPORT_INSTRUCTIONS,
  reviewerClaimSchema,
  WORKER_REPORT_INSTRUCTIONS,
  workerClaimSchema,
  type ClaimResult,
  type WorkerClaim,
} from "./claims.ts";
import { REPORT_RECORDED, type ReportSlot } from "./delegation.ts";
import {
  commandArgv,
  commandsFromLog,
  evidenceCandidates,
  evidenceProblems,
  INDEPENDENT_EVIDENCE_HINT,
  isPlanCausedVerification,
  isIndependentReviewEvidence,
  provingVerification,
  resolveCompletionEvidence,
  resolvePointer,
  unresolvedPointer,
  verifyCompletion,
  verifyReview,
  type CompletionVerification,
  type CompletionVerificationOptions,
  type EvidenceIndex,
} from "./evidence.ts";
import type { ChangeSet, OrchestratedWorkspace, OrchestrationIsolationProvider } from "./isolation.ts";
import { matchesAny, normalizeWorkspacePath } from "./paths.ts";
import { createWorkspaceDigestReader, resolveOnDiskPath } from "./workspace-digest.ts";
import {
  COMPLETION_MEDIA_TYPE,
  createWorkspaceSourceReader,
  currentDigests,
  PACKET_MEDIA_TYPE,
  REVIEW_MEDIA_TYPE,
  type RunRecorder,
  type SourceDigestReader,
} from "./recorder.ts";

/**
 * Worker attempts. Each attempt gets its own session (so its context contains its packet and its
 * own turns, never another attempt's transcript), its own isolated workspace and an effective
 * policy computed for its role and scope. The completion packet is assembled by the harness:
 * identity, the real diff, the pinned artifact, the tool call ids, the commands that ran and the
 * result of the packet's verification commands (run by the harness itself after the worker's turn,
 * ADR-18) come from the log and the workspace; only the narrative and the evidence pointers come
 * from the worker's claim. A report whose evidence is incomplete, or whose harness verification
 * failed, is repaired in the same session with the same workspace (`attempt/repair_requested`).
 */

export interface RunScope {
  readonly runId: RunId;
  readonly mode: PolicyMode;
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
  readonly recorder: RunRecorder;
  /** Per-task budgets of the run (ADR-18 D2); `evidence_repairs` bounds the in-session repairs. */
  readonly budgets?: OrchestrationBudgets;
  /** Steps before its limit at which an attempt is told to finish and report (`StepFloors.finishWarning`). */
  readonly finishWarning?: number;
}

/** Default distance (steps) of the finish-now message from an attempt's step limit. */
export const DEFAULT_FINISH_WARNING = 3;

/** The runtime message an attempt gets when it is `steps` steps from its limit without a report. */
export function renderFinishNowMessage(tool: string, steps: number): string {
  const what = tool === REPORT_TOOL_NAMES.review ? "your verdicts so far (unverifiable where you could not check)" : "what you have (status partial if work remains)";
  return `Harness: ${steps} step(s) left before the step limit. Finish now: call \`${tool}\` with ${what}, citing the [#n] refs you already have. Do not start new work.`;
}

/** The message of the forced report-only turn (the limit was hit without a report). */
export function renderReportOnlyMessage(tool: string): string {
  return `Harness: the step limit is reached. This is a report-only turn: \`${tool}\` is the only tool available. Call it now with what you have; anything unfinished goes into the report (status partial, or verdict unverifiable).`;
}

/** One verification command the harness runs in an attempt workspace (ADR-18 D1). */
export interface VerificationRequest {
  readonly command: string;
  readonly argv: readonly [string, ...string[]];
  readonly workspaceRoot: string;
  readonly policy: EffectivePolicy;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly role: WorkerRole;
  readonly signal: AbortSignal;
  /**
   * The attempt session's log. The runner invokes `exec` through the tool gateway as a system
   * call (review R4), so the run leaves the same `tool/*` audit trail as any tool call; the attempt
   * log never counts system calls as the worker's evidence.
   */
  readonly events?: EventStore | undefined;
}

export interface VerificationResult {
  readonly status: HarnessVerificationStatus;
  /** How the runner classified the argv (`classifyVerificationCommand`); absent = unclassified. */
  readonly commandClass?: VerificationCommandClass | undefined;
  /** How the process ended; absent when it was not started (`not-run`). */
  readonly termination?: ProcessTermination | undefined;
  readonly exitCode: number | null;
  /** Redacted stdout+stderr. */
  readonly output: string;
  readonly durationMs: number;
  /** Why the command was not run (policy, sandbox, trust). */
  readonly reason?: string | undefined;
}

/**
 * Runs one verification command through the same policy (the packet's `verification_commands`
 * allowlist, workspace trust) and sandbox as the worker's `exec`; wired by the composition root.
 */
export type VerificationRunner = (request: VerificationRequest) => Promise<VerificationResult>;

export interface WorkerManagerDependencies {
  readonly run: RunScope;
  readonly sessions: SessionStore;
  readonly blobs: BlobStore;
  readonly router: ModelRouter;
  readonly policy: PolicyEngine;
  readonly isolation: OrchestrationIsolationProvider;
  readonly createDriver: (events: EventStore) => AgentDriver;
  readonly sandbox: SandboxReport;
  readonly userConfig?: unknown;
  readonly workspaceConfig?: unknown;
  readonly sources?: SourceDigestReader;
  readonly budget?: BudgetTracker;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  /** Runs the packet's verification commands after the worker's turn; without it there is no harness verification. */
  readonly verification?: VerificationRunner;
  /** Where attempts register the in-call evidence check of their report tool. */
  readonly reports?: ReportSlot;
}

export interface AttemptRecord {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  /** The packet as dispatched (sources re-digested in the attempt workspace when it offers `digest`). */
  readonly packet: TaskContextPacket;
  readonly route: ModelRoute;
  readonly sessionId: SessionId;
  readonly workspace: OrchestratedWorkspace;
  readonly policy: EffectivePolicy;
  changeSet: ChangeSet | undefined;
  log: AttemptLog | undefined;
  completion: CompletionPacket | undefined;
  outcome: TurnOutcome | undefined;
  /** Why the attempt's turn failed, when the cause is the provider or a tool (exit code 4). */
  failure: AttemptFailure | undefined;
  /**
   * Sources that changed while the attempt ran (the harness, not the worker, set `needs_context`).
   * Undefined when the sources held; a worker-claimed `needs_context` is triaged instead.
   */
  stale: readonly string[] | undefined;
  /** What the harness computed for the attempt (verification runs, the pinned diff). */
  harness: HarnessEvidence | undefined;
  readonly repairs: { report_corrections: number; evidence_repairs: number; verification_repairs: number };
  /** The notes of the task's last delta, rendered into this attempt's task message. */
  readonly notes: readonly string[];
}

export type AttemptFailure = "provider_failed" | "tool_failed";

/**
 * Classifies a failed turn from its own log: a provider error (a non-cancelled
 * `model/response_failed`, or a `ProviderFailure` thrown by credential resolution) or a tool whose
 * execution broke the turn. A turn that ended normally, or was cancelled, has no failure cause.
 */
export function classifyAttemptFailure(outcome: TurnOutcome | undefined, error: unknown, events: readonly SessionEvent[]): AttemptFailure | undefined {
  if (error === undefined && outcome?.outcome !== "failed") return undefined;
  if (error instanceof ProviderFailure) return error.error.code === "cancelled" ? undefined : "provider_failed";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === "model/response_failed") return event.data.error.code === "cancelled" ? undefined : "provider_failed";
    if (event.type === "tool/execution_started" || event.type === "tool/interrupted") return error === undefined ? undefined : "tool_failed";
    if (event.type === "tool/result_recorded") return error !== undefined ? "tool_failed" : undefined;
    if (event.type === "model/response_settled") return undefined;
  }
  return undefined;
}

/** Dispatch options of the orchestration worker manager: the contract's, plus the notes of the task's last delta. */
export interface WorkerDispatchOptions extends DispatchOptions {
  /** What the previous attempt and the orchestrator hand this attempt; rendered into its task message. */
  readonly notes?: readonly string[];
  /**
   * An earlier attempt of the same task whose worktree this attempt reuses (reset to its base, then
   * seeded; ADR-19). The caller keeps ownership of both and disposes them when the task settles.
   */
  readonly reuseAttempt?: AttemptId;
}

/** A task whose integrated result the plan's integration review checks. */
export interface IntegratedDependency {
  readonly key: string;
  readonly taskId: TaskId;
  readonly summary: string;
  readonly paths: readonly string[];
  readonly notes: readonly string[];
}

/** The outcome of an integration review (no single pinned artifact, so no `ReviewPacket`). */
export interface IntegrationReviewOutcome {
  readonly attemptId: AttemptId;
  readonly decision: "accept" | "revise" | "block" | "invalid";
  readonly problems: readonly string[];
  readonly findings: ReviewReportInput["findings"];
}

export interface IntegrationReviewHandle {
  readonly attemptId: AttemptId;
  readonly result: Promise<IntegrationReviewOutcome>;
  cancel(reason: string): void;
}

/** The contract `WorkerManager` plus the coordinator's own verification and integration steps. */
export interface OrchestrationWorkerManager extends WorkerManager {
  dispatch(packet: TaskContextPacket, signal: AbortSignal, options?: WorkerDispatchOptions): Promise<AttemptHandle>;
  /**
   * The plan's integration review (`isIntegrationReview`): a reviewer attempt on the main workspace,
   * read-only, after its dependencies were integrated; it checks the reviewer task's own criteria
   * over the combined result, each `met` backed by the reviewer's own tool results.
   */
  dispatchIntegrationReview(packet: TaskContextPacket, dependencies: readonly IntegratedDependency[], signal: AbortSignal, options?: DispatchOptions): Promise<IntegrationReviewHandle>;
  attempt(attemptId: AttemptId): AttemptRecord | undefined;
  verify(attemptId: AttemptId, options?: CompletionVerificationOptions): Promise<CompletionVerification>;
  integrate(attemptId: AttemptId, expectedArtifact: Digest, signal: AbortSignal): Promise<void>;
  revert(attemptId: AttemptId, signal: AbortSignal): Promise<readonly string[]>;
  dispose(attemptId: AttemptId): Promise<void>;
  /**
   * K1.7 per-worker control. `steer` queues a user message for the attempt's driver (delivered at
   * its next step boundary); `pause` holds the attempt's next model step until `resume`; `cancel`
   * aborts it through the normal cancellation path. Each returns false when the attempt is not
   * running (unknown, or already finished).
   */
  steer(attemptId: AttemptId, text: string): boolean;
  pause(attemptId: AttemptId): boolean;
  resume(attemptId: AttemptId): boolean;
  cancel(attemptId: AttemptId, reason: string): boolean;
  /** The live control state of a running attempt; undefined once it finished. */
  live(attemptId: AttemptId): { readonly paused: boolean } | undefined;
}

/** K1.7: user control of one running attempt; `wall` is the running turn's wall-time timer (paused with the attempt). */
interface AttemptControl {
  paused: boolean;
  readonly steers: string[];
  wall: PausableTimer | undefined;
}

/** A one-shot timer whose clock stops while paused. */
class PausableTimer {
  #remaining: number;
  #startedAt = 0;
  #timer: NodeJS.Timeout | undefined;
  readonly #fire: () => void;

  public constructor(ms: number, fire: () => void, paused: boolean) {
    this.#remaining = ms;
    this.#fire = fire;
    if (!paused) this.resume();
  }

  public pause(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#remaining = Math.max(0, this.#remaining - (Date.now() - this.#startedAt));
  }

  public resume(): void {
    if (this.#timer !== undefined) return;
    this.#startedAt = Date.now();
    this.#timer = setTimeout(this.#fire, this.#remaining);
    this.#timer.unref?.();
  }

  public clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/** What the worker manager needs of a driver to pause it (the fixed driver implements it). */
interface PausableDriver {
  pause(): void;
  resume(): void;
}

function pausable(driver: AgentDriver | undefined): (AgentDriver & PausableDriver) | undefined {
  const candidate = driver as (AgentDriver & Partial<PausableDriver>) | undefined;
  return typeof candidate?.pause === "function" && typeof candidate.resume === "function" ? (candidate as AgentDriver & PausableDriver) : undefined;
}

const REVIEW_BRIEF_CONTENT_LIMIT = 48 * 1024;
const OUTPUT_EXCERPT_LIMIT = 4096;
const CORRECTABLE_STATUSES: ReadonlySet<string> = new Set(["completed", "partial"]);

function harnessError(code: "stale_packet" | "internal" | "review_blocked", message: string, ids?: Record<string, string>): HarnessError {
  return new HarnessError({
    code,
    message,
    ...(ids === undefined ? {} : { ids }),
    workspace_effect: "none",
    retry_safe: true,
  });
}

function linkSignals(outer: AbortSignal): AbortController {
  const controller = new AbortController();
  if (outer.aborted) controller.abort(outer.reason);
  else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
  return controller;
}


function excerpt(text: string): string {
  if (text.length <= OUTPUT_EXCERPT_LIMIT) return text;
  const half = Math.floor((OUTPUT_EXCERPT_LIMIT - 32) / 2);
  return `${text.slice(0, half)}\n[... ${text.length - 2 * half} characters ...]\n${text.slice(-half)}`;
}

function toolOk(text: string): ToolResult {
  return { status: "ok", text: text.slice(0, 16 * 1024), truncated: false, redactions: 0 };
}

function toolRejected(text: string, message: string): ToolResult {
  return { status: "error", text: text.slice(0, 16 * 1024), truncated: false, redactions: 0, error: { code: "invalid_arguments", message: message.slice(0, 2000) } };
}

export function renderWorkerMessage(packet: TaskContextPacket, notes: readonly string[] = []): string {
  const scope =
    packet.write_mode === "owned-paths"
      ? `You may change only: ${packet.scope.owned_paths.join(", ")}.`
      : packet.write_mode === "rca-only"
        ? "Root-cause analysis only: do not change files; report root_cause."
        : "Read-only: do not change files.";
  return [
    `Task ${packet.task_id} (${packet.role}): ${packet.objective}`,
    "Your task packet is in the system context; use it first and read only inside its scope.",
    scope,
    ...(notes.length === 0 ? [] : [`Notes for this attempt (from the previous attempt and the orchestrator):\n${notes.map((note) => `- ${note}`).join("\n")}`]),
    "If the packet is insufficient or a cited source changed, stop and report status needs_context.",
    WORKER_REPORT_INSTRUCTIONS,
  ].join("\n\n");
}

function statementsOf(packet: TaskContextPacket): ReadonlyMap<string, string> {
  return new Map(packet.acceptance_criteria.map((criterion) => [criterion.id, criterion.statement]));
}

/**
 * The harness records a reviewer may cite (ADR-18 amendment of ADR-09, review R1): a passed
 * build/test run (or one a criterion names) is independent evidence; a read-only or failed run and
 * the diff are supporting only.
 */
function harnessLines(harness: HarnessEvidence | undefined, packet: TaskContextPacket): string[] {
  if (harness === undefined) return [];
  const proving = new Set(provingVerification(packet, harness).map((record) => record.evidence.ref));
  return [
    ...harness.verification.map(
      (record) => `  ${record.evidence.ref} harness-verification "${record.command}" -> ${record.status}${record.exit_code === null ? "" : ` (exit ${record.exit_code})`}${proving.has(record.evidence.ref) ? "" : " [supporting only]"}`,
    ),
    ...(harness.diff === undefined ? [] : [`  ${harness.diff.evidence.ref} harness-diff (${harness.diff.changed_paths.join(", ")}) [supporting only]`]),
  ];
}

export function renderRepairMessage(kind: RepairKind, problems: readonly string[], log: AttemptLog, harness: HarnessEvidence | undefined): string {
  const verification = (harness?.verification ?? []).filter((record) => record.status !== "passed" && !isPlanCausedVerification(record));
  const lead =
    kind === "verification-repair"
      ? "The harness ran the packet's verification commands in your workspace after your turn, and they did not pass. Your workspace and changes are kept."
      : "The harness checked your report. Your workspace and changes are kept, but the report is incomplete.";
  const valid = evidenceCandidates(log).map((candidate) => `  #${candidate.ref} ${candidate.toolName} ${candidate.summary}`);
  return [
    lead,
    `Problems:\n${problems.slice(0, 20).map((problem) => `- ${problem}`).join("\n")}`,
    verification.length > 0 ? `Harness verification:\n${verification.map((record) => `- ${record.command}: ${record.status}${record.exit_code === null ? "" : ` (exit ${record.exit_code})`}${record.reason === undefined ? "" : ` - ${record.reason}`}`).join("\n")}` : "",
    valid.length > 0 ? `Valid evidence refs (cite as "#n"):\n${valid.join("\n")}` : "",
    kind === "verification-repair"
      ? `Fix the change inside your owned paths, run the failing command yourself to confirm, then call \`${REPORT_TOOL_NAMES.task}\` again with the complete report.`
      : `Fix only what is listed (cite valid refs, or run a missing check), do not redo finished work, then call \`${REPORT_TOOL_NAMES.task}\` again with the complete report.`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function renderReviewBrief(target: AttemptRecord, completion: CompletionPacket, changeSet: ChangeSet): string {
  let budget = REVIEW_BRIEF_CONTENT_LIMIT;
  const files: string[] = [];
  for (const change of changeSet.changes) {
    const content = changeSet.contents.get(change.path);
    const header = `--- ${change.path} (before ${change.before ?? "absent"}, after ${change.after ?? "deleted"})`;
    if (content === null || content === undefined) {
      files.push(`${header}\n[deleted]`);
      continue;
    }
    const text = content.toString("utf8");
    const shown = text.slice(0, Math.max(0, budget));
    budget -= shown.length;
    files.push(`${header}\n${shown}${shown.length < text.length ? "\n[truncated; read the file with your tools]" : ""}`);
  }
  const harness = harnessLines(completion.harness_evidence, target.packet);
  return [
    `Independent review of attempt ${target.attemptId} for task ${target.taskId}.`,
    `The artifact under review is pinned at ${changeSet.artifactDigest}. Your workspace is that artifact, read-only; you may read any file in it, not only the changed ones.`,
    "You receive the worker's completion packet and the changed files, not the worker's conversation. Verify every acceptance criterion yourself with your own tool calls.",
    `Worker completion packet:\n\`\`\`json\n${canonicalJson(completion)}\n\`\`\``,
    harness.length > 0 ? `Harness records (computed by the harness, independent of the worker; cite with produced_by: harness):\n${harness.join("\n")}` : "",
    `Changed files (${changeSet.changes.length}):\n${files.join("\n\n") || "[no file changes]"}`,
    REVIEWER_REPORT_INSTRUCTIONS,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function renderIntegrationReviewBrief(packet: TaskContextPacket, dependencies: readonly IntegratedDependency[]): string {
  const tasks = dependencies.map((dependency) =>
    [
      `- ${dependency.key} (${dependency.taskId}): ${dependency.summary.slice(0, 600)}`,
      `  integrated: ${dependency.paths.join(", ") || "no file changes"}`,
      ...dependency.notes.slice(0, 5).map((note) => `  note: ${note.slice(0, 400)}`),
    ].join("\n"),
  );
  const criteria = packet.acceptance_criteria.map((criterion) => `- ${criterion.id}: ${criterion.statement}`);
  return [
    `Integration review for task ${packet.task_id}: ${packet.objective}`,
    "Every task below passed its own verification and independent review and is integrated into the workspace. Your workspace is the combined result, read-only; read any file you need.",
    `Integrated tasks:\n${tasks.join("\n")}`,
    `Check only these criteria, each with your own tool calls (read the files; run ${packet.verification.commands.length > 0 ? `the verification commands ${packet.verification.commands.join("; ")}` : "a check when a criterion needs one"}):\n${criteria.join("\n")}`,
    REVIEWER_REPORT_INSTRUCTIONS,
  ].join("\n\n");
}

interface Execution {
  readonly outcome: TurnOutcome | undefined;
  readonly error: unknown;
  readonly log: AttemptLog;
}

function emptyLog(sessionId: SessionId): AttemptLog {
  return { sessionId, toolCalls: new Map(), eventTypes: new Map(), compactionBlobs: new Set(), finalAssistantText: undefined, assistantTexts: [], reports: [], ordinals: new Map() };
}

/** The one workspace digest (ADR-19) of files in an attempt root: the isolation's reader, or raw bytes read here. */
function readerFor(workspace: OrchestratedWorkspace, platform: NodeJS.Platform): WorkspaceDigestReader {
  return workspace.digest ?? createWorkspaceDigestReader(workspace.root, { platform });
}

/**
 * Small read_paths files inlined into the packet (ADR-20, F19), read in the attempt workspace so
 * their digests are valid write preconditions there: each at most `INLINE_SOURCE_MAX_BYTES`, all
 * together at most `INLINE_SOURCES_MAX_TOTAL_BYTES`, only valid UTF-8 text, never truncated.
 */
async function inlineSources(
  packet: TaskContextPacket,
  workspace: OrchestratedWorkspace,
  sources: readonly { readonly path: string; readonly digest: Digest }[],
  platform: NodeJS.Platform,
): Promise<{ path: string; digest: Digest; content: string; truncated: boolean }[]> {
  const inline: { path: string; digest: Digest; content: string; truncated: boolean }[] = [];
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const source of sources) {
    if (!packet.scope.read_paths.includes(source.path) || inline.length >= 32) continue;
    const normalized = normalizeWorkspacePath(source.path);
    if (normalized === undefined || normalized === ".") continue;
    let bytes: Uint8Array;
    try {
      const onDisk = await resolveOnDiskPath(workspace.root, normalized, platform);
      if (onDisk === undefined) continue;
      bytes = await readFile(path.join(workspace.root, ...onDisk.split("/")));
    } catch {
      continue;
    }
    if (bytes.byteLength > INLINE_SOURCE_MAX_BYTES || total + bytes.byteLength > INLINE_SOURCES_MAX_TOTAL_BYTES || workspaceDigest(bytes) !== source.digest) continue;
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      continue;
    }
    total += bytes.byteLength;
    inline.push({ path: source.path, digest: source.digest, content, truncated: false });
  }
  return inline;
}

/** Paths the attempt's tools reported as changed (for in-call file evidence, before the real diff exists). */
function loggedChanges(log: AttemptLog): string[] {
  return [...new Set([...log.toolCalls.values()].flatMap((call) => (call.state === "succeeded" ? call.changedPaths ?? [] : [])))];
}

export function createWorkerManager(deps: WorkerManagerDependencies): OrchestrationWorkerManager {
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const sources = deps.sources ?? createWorkspaceSourceReader(deps.run.workspaceRoot);
  const recorder = deps.run.recorder;
  const budgets = deps.run.budgets ?? DEFAULT_ORCHESTRATION_BUDGETS;
  const records = new Map<AttemptId, AttemptRecord>();
  const handles = new Map<AttemptId, AttemptHandle>();
  const controllers = new Map<AttemptId, AbortController>();
  // One driver per attempt: a backend-owned loop (Claude Code bridge) keeps its session across the
  // attempt's follow-up turns (finish-now, report-only, corrections) instead of starting cold (K1.5).
  const drivers = new Map<AttemptId, AgentDriver>();
  /** K1.7: user control of each running attempt; applied to its driver when the driver is created. */
  const controls = new Map<AttemptId, AttemptControl>();
  const pendingStores = new Map<AttemptId, EventStore>();
  /** Packets as the coordinator issued them (main-tree digests): the in-flight freshness gate compares against these. */
  const baselines = new Map<AttemptId, TaskContextPacket>();
  const unregister = new Map<AttemptId, () => void>();
  const countedCalls = new Map<AttemptId, number>();
  /** In-session repairs spent per task (shared by evidence and verification repairs, ADR-18 D2). */
  const repairsUsed = new Map<TaskId, number>();

  deps.budget?.onCancel((exceeded) => {
    for (const controller of controllers.values()) controller.abort(new Error(`budget ${exceeded.metric} exceeded`));
  });

  const gate = async (packet: TaskContextPacket, inFlight: boolean): Promise<void> => {
    const current = await currentDigests(packet.context.sources.map((source) => source.path), sources);
    const stale = findStaleSources(packet, current).filter(
      (source) => !inFlight || !matchesAny(source.path, packet.scope.owned_paths, platform),
    );
    for (const source of stale) {
      await recorder.record(
        "context/source_changed",
        { task_id: packet.task_id, path: source.path, expected: source.expected, actual: source.actual ?? null },
        { taskId: packet.task_id, actor: { kind: "system" } },
      );
    }
    if (stale.length > 0 && !inFlight) {
      throw harnessError("stale_packet", `packet sources changed: ${stale.map((source) => source.path).join(", ")}`, {
        task_id: packet.task_id,
      });
    }
    if (stale.length > 0) throw new StaleInFlight(stale.map((source) => source.path));
  };

  /**
   * ADR-19: once the workspace exists, packet sources are digested in *that* root with the one
   * workspace scheme, so a digest the worker reads from its packet is a valid write precondition.
   */
  const inWorkspace = async (packet: TaskContextPacket, workspace: OrchestratedWorkspace, signal: AbortSignal): Promise<TaskContextPacket> => {
    const digest = readerFor(workspace, platform);
    if (packet.context.digest_scheme === "workspace-raw-v1" || packet.context.sources.length === 0) return packet;
    const remapped = new Map<string, Digest>();
    const next: { path: string; digest: Digest }[] = [];
    for (const source of packet.context.sources) {
      const value = await digest(source.path, signal);
      if (value === undefined) continue;
      next.push({ path: source.path, digest: value });
      remapped.set(`${source.path}\u0000${source.digest}`, value);
    }
    const facts = packet.known_facts.flatMap((fact) => {
      const value = remapped.get(`${fact.source}\u0000${fact.source_digest}`);
      return value === undefined ? [] : [{ ...fact, source_digest: value }];
    });
    const inline = await inlineSources(packet, workspace, next, platform);
    return taskContextPacketSchema.parse({
      ...packet,
      known_facts: facts,
      context: {
        ...packet.context,
        sources: next,
        digest_scheme: "workspace-raw-v1",
        ...(inline.length === 0 ? {} : { inline_sources: inline }),
      },
    });
  };

  const prepare = async (
    packet: TaskContextPacket,
    signal: AbortSignal,
    options: DispatchOptions | undefined,
    readRoot: string | undefined,
  ): Promise<{ record: AttemptRecord; controller: AbortController }> => {
    const issued = taskContextPacketSchema.parse(packet);
    await gate(issued, false);
    const attemptId = createId("attempt");
    const decision = options?.route ?? (await deps.router.resolve({ tier: issued.model_tier, role: issued.role }, signal));
    await recorder.record("route/decided", { decision }, { taskId: issued.task_id, attemptId, actor: { kind: "system" } });
    const overlay = [...new Set([...issued.scope.read_paths, ...issued.context.sources.map((source) => source.path)])].filter((candidate) => !matchesAny(candidate, issued.scope.owned_paths, platform));
    const previous = (options as WorkerDispatchOptions | undefined)?.reuseAttempt;
    const reuse = previous === undefined ? undefined : records.get(previous);
    const workspace = await deps.isolation.create(issued, attemptId, signal, {
      ...(readRoot === undefined ? {} : { readRoot }),
      ...(overlay.length === 0 ? {} : { overlay }),
      ...(reuse === undefined || reuse.taskId !== issued.task_id ? {} : { reuse: reuse.workspace }),
    });
    if (options?.seedArtifact !== undefined) await deps.isolation.seed(workspace, options.seedArtifact, signal);
    const valid = await inWorkspace(issued, workspace, signal);
    const policy = deps.policy.compute({
      mode: deps.run.mode,
      role: valid.role,
      runId: deps.run.runId,
      taskId: valid.task_id,
      workspaceRoot: workspace.root,
      taskScope: {
        owned: valid.write_mode === "owned-paths" ? valid.scope.owned_paths : [],
        read: valid.scope.read_paths,
        // ADR-19: linked dependency directories are never touched through file tools (the policy has
        // no write-only forbid, and a path through the link resolves outside the workspace anyway,
        // `link-escape`); only processes a build or test runs read them. While links exist, commands
        // that install, add, remove or update dependencies are denied (`dependency_links`).
        forbidden: [...valid.scope.forbidden_paths, ...(workspace.dependencyLinks ?? [])],
        verification_commands: valid.verification.commands,
        ...(workspace.dependencyLinks === undefined || workspace.dependencyLinks.length === 0 ? {} : { dependency_links: [...workspace.dependencyLinks] }),
      },
      userConfig: deps.userConfig,
      workspaceConfig: deps.workspaceConfig,
      sandbox: deps.sandbox,
      grants: [],
    });
    await recorder.record("policy/snapshot", { policy, digest: digestOf(policy) }, { taskId: valid.task_id, attemptId, actor: { kind: "policy" } });
    const events = await deps.sessions.create({
      session_id: createId("session"),
      project_id: deps.run.projectId,
      workspace_root: workspace.root,
      created_at: now().toISOString(),
      title: `${valid.role} attempt ${attemptId}`,
    });
    const blob = await recorder.putJson(valid, PACKET_MEDIA_TYPE);
    await recorder.record(
      "task/packet_issued",
      { task_id: valid.task_id, kind: "full", packet_digest: packetDigest(valid), blob },
      { taskId: valid.task_id, attemptId },
    );
    await recorder.record(
      "attempt/started",
      {
        attempt_id: attemptId,
        task_id: valid.task_id,
        role: valid.role,
        route: decision.route,
        packet_digest: packetDigest(valid),
        isolation: {
          mode: workspace.mode,
          path: workspace.root,
          ...(workspace.baseCommit === undefined ? {} : { base_commit: workspace.baseCommit }),
          ...(workspace.reused === true ? { reused: true } : {}),
          ...(workspace.fallback === undefined ? {} : { fallback: workspace.fallback }),
          ...(workspace.overlaid === undefined || workspace.overlaid.length === 0 ? {} : { overlaid: [...workspace.overlaid] }),
          ...(workspace.dependencyLinks === undefined || workspace.dependencyLinks.length === 0 ? {} : { dependency_links: [...workspace.dependencyLinks] }),
          ...(workspace.submodules === undefined || workspace.submodules.length === 0 ? {} : { submodules: [...workspace.submodules] }),
        },
        session_id: events.sessionId,
      },
      { taskId: valid.task_id, attemptId },
    );
    const record: AttemptRecord = {
      attemptId,
      taskId: valid.task_id,
      packet: valid,
      route: decision.route,
      sessionId: events.sessionId,
      workspace,
      policy,
      changeSet: undefined,
      log: undefined,
      completion: undefined,
      outcome: undefined,
      failure: undefined,
      stale: undefined,
      harness: undefined,
      repairs: { report_corrections: 0, evidence_repairs: 0, verification_repairs: 0 },
      notes: (options as WorkerDispatchOptions | undefined)?.notes ?? [],
    };
    records.set(attemptId, record);
    baselines.set(attemptId, issued);
    const controller = linkSignals(signal);
    controllers.set(attemptId, controller);
    controls.set(attemptId, { paused: false, steers: [], wall: undefined });
    pendingStores.set(attemptId, events);
    return { record, controller };
  };

  const currentLog = async (record: AttemptRecord): Promise<AttemptLog> => {
    const events = pendingStores.get(record.attemptId);
    if (events === undefined) return record.log ?? emptyLog(record.sessionId);
    return buildAttemptLog(record.sessionId, await readEvents(events), deps.blobs);
  };

  const execute = async (
    record: AttemptRecord,
    userMessage: string,
    controller: AbortController,
    trigger: TurnInput["trigger"],
    options: { readonly maxSteps?: number; readonly reportOnly?: string } = {},
  ): Promise<Execution> => {
    const events = pendingStores.get(record.attemptId);
    if (events === undefined) throw harnessError("internal", `attempt ${record.attemptId} has no session`);
    const attemptControl = controls.get(record.attemptId);
    const timer = new PausableTimer(record.packet.limits.max_wall_time_seconds * 1000, () => controller.abort(new Error("wall-time limit reached")), attemptControl?.paused === true);
    if (attemptControl !== undefined) attemptControl.wall = timer;
    let outcome: TurnOutcome | undefined;
    let error: unknown;
    try {
      const input: TurnInput = {
        sessionId: record.sessionId,
        runId: deps.run.runId,
        taskId: record.taskId,
        attemptId: record.attemptId,
        role: record.packet.role,
        route: record.route,
        policy: record.policy,
        packet: record.packet,
        userMessage,
        trigger,
        maxSteps: options.maxSteps ?? record.packet.limits.max_steps,
        sources: readerFor(record.workspace, platform),
        ...(options.reportOnly === undefined ? {} : { reportOnly: options.reportOnly }),
      };
      let driver = drivers.get(record.attemptId);
      if (driver === undefined) {
        driver = deps.createDriver(events);
        drivers.set(record.attemptId, driver);
        const control = controls.get(record.attemptId);
        if (control !== undefined) {
          for (const text of control.steers.splice(0)) driver.steer(text);
          if (control.paused) pausable(driver)?.pause();
        }
      }
      outcome = await driver.runTurn(input, controller.signal);
    } catch (caught) {
      error = caught;
    } finally {
      timer.clear();
      if (attemptControl?.wall === timer) attemptControl.wall = undefined;
    }
    const recorded = await readEvents(events);
    const log = await buildAttemptLog(record.sessionId, recorded, deps.blobs);
    const counted = countedCalls.get(record.attemptId) ?? 0;
    deps.budget?.recordToolCalls(Math.max(0, log.toolCalls.size - counted));
    countedCalls.set(record.attemptId, log.toolCalls.size);
    record.log = log;
    record.outcome = outcome;
    record.failure = classifyAttemptFailure(outcome, error, recorded);
    return { outcome, error, log };
  };

  const reportsIn = (log: AttemptLog, tool: ReportToolName): number =>
    log.reports.filter((report) => report.name === tool && log.toolCalls.get(report.toolCallId)?.state === "succeeded").length;

  /** Steps the run budget still admits (undefined: no step limit). */
  const runStepsLeft = (): number | undefined => {
    const max = deps.budget?.limits().maxSteps;
    return max === undefined || deps.budget === undefined ? undefined : Math.max(0, max - deps.budget.usage().steps);
  };

  /**
   * One worker or reviewer turn that always ends with a chance to report (live run 01M37V2J: both
   * reviewers hit the step budget mid-review and left no report, so the task failed "no valid
   * review"). The turn runs until `finishWarning` steps before the attempt's limit (or what the run
   * budget still admits); if it stops there without a report, the harness tells the model to finish
   * now with the remaining steps; if the limit is then hit without a report, one forced report-only
   * turn follows (only the report tool is offered, and the run's step budget graces that request).
   */
  const executeBounded = async (record: AttemptRecord, userMessage: string, controller: AbortController, trigger: TurnInput["trigger"], tool: ReportToolName): Promise<Execution> => {
    const limit = record.packet.limits.max_steps;
    const warn = Math.max(0, Math.min(deps.run.finishWarning ?? DEFAULT_FINISH_WARNING, limit - 1));
    const before = reportsIn(await currentLog(record), tool);
    const reported = (execution: Execution): boolean => reportsIn(execution.log, tool) > before;
    const stopped = (execution: Execution): boolean => execution.error !== undefined || controller.signal.aborted || execution.outcome === undefined;
    const available = Math.min(limit, runStepsLeft() ?? limit);
    let execution: Execution;
    if (available > warn) {
      execution = await execute(record, userMessage, controller, trigger, { maxSteps: available - warn });
      if (warn > 0 && execution.outcome?.outcome === "max_steps" && !reported(execution) && !stopped(execution)) {
        const left = Math.min(warn, runStepsLeft() ?? warn);
        if (left > 0) execution = await execute(record, renderFinishNowMessage(tool, left), controller, "follow-up", { maxSteps: left });
      }
    } else {
      execution = await execute(record, `${userMessage}\n\n${renderFinishNowMessage(tool, Math.max(1, available))}`, controller, trigger, { maxSteps: Math.max(1, available) });
    }
    const exhausted = execution.outcome?.outcome === "max_steps" || execution.outcome?.outcome === "budget_exceeded";
    if (exhausted && !reported(execution) && !stopped(execution)) {
      execution = await execute(record, renderReportOnlyMessage(tool), controller, "follow-up", { maxSteps: 1, reportOnly: tool });
    }
    return execution;
  };

  const closeAttempt = async (record: AttemptRecord): Promise<void> => {
    unregister.get(record.attemptId)?.();
    unregister.delete(record.attemptId);
    const events = pendingStores.get(record.attemptId);
    pendingStores.delete(record.attemptId);
    controllers.delete(record.attemptId);
    controls.delete(record.attemptId);
    drivers.delete(record.attemptId);
    await events?.close().catch(() => undefined);
  };

  const finished = new Set<AttemptId>();

  const failUnfinished = async (record: AttemptRecord, error: unknown): Promise<void> => {
    await closeAttempt(record);
    if (finished.has(record.attemptId)) return;
    finished.add(record.attemptId);
    await recorder
      .record(
        "attempt/state_changed",
        { attempt_id: record.attemptId, from: "running", to: "failed", reason: `harness error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) },
        { taskId: record.taskId, attemptId: record.attemptId },
      )
      .catch(() => undefined);
  };

  const finishAttempt = async (record: AttemptRecord, execution: Execution, cancelled: boolean): Promise<void> => {
    finished.add(record.attemptId);
    const to = cancelled || execution.outcome?.outcome === "cancelled" ? "cancelled" : execution.error !== undefined || execution.outcome?.outcome === "failed" ? "failed" : "succeeded";
    const reason =
      execution.error !== undefined
        ? `driver error: ${execution.error instanceof Error ? execution.error.message : String(execution.error)}`.slice(0, 500)
        : `turn ${execution.outcome?.outcome ?? "ended"}`;
    await recorder.record(
      "attempt/state_changed",
      { attempt_id: record.attemptId, from: "running", to, reason },
      { taskId: record.taskId, attemptId: record.attemptId },
    );
  };

  const indexFor = (record: AttemptRecord, artifact: ChangeSet | undefined, root: string, log?: AttemptLog): EvidenceIndex => {
    const source = log ?? record.log ?? emptyLog(record.sessionId);
    return {
      log: source,
      artifactDigest: artifact?.artifactDigest,
      changedPaths: artifact?.changes.map((change) => change.path) ?? loggedChanges(source),
      fileDigest: (relative) => (root === record.workspace.root ? readerFor(record.workspace, platform) : createWorkspaceDigestReader(root, { platform }))(relative),
      harness: record.harness,
    };
  };

  /** ADR-18 D1: the harness runs the packet's verification commands itself and records each run. */
  const runHarnessVerification = async (record: AttemptRecord, changeSet: ChangeSet, signal: AbortSignal): Promise<HarnessEvidence> => {
    const diff =
      changeSet.changes.length === 0
        ? undefined
        : {
            evidence: { kind: "harness-diff" as const, ref: changeSet.artifactDigest, produced_by: "harness" as const },
            changed_paths: changeSet.changes.map((change) => change.path),
          };
    const runner = deps.verification;
    const verification: HarnessVerification[] = [];
    if (runner !== undefined) {
      for (const [position, command] of record.packet.verification.commands.slice(0, 100).entries()) {
        const started = Date.now();
        const argv = commandArgv(command);
        let result: VerificationResult;
        if (argv === undefined || argv.length === 0) {
          result = { status: "not-run", exitCode: null, output: "", durationMs: 0, reason: "the command uses shell syntax and cannot be run as a plain argv" };
        } else if (signal.aborted) {
          result = { status: "not-run", exitCode: null, output: "", durationMs: 0, reason: "the attempt was cancelled" };
        } else {
          try {
            result = await runner({
              command,
              argv: argv as [string, ...string[]],
              workspaceRoot: record.workspace.root,
              policy: record.policy,
              runId: deps.run.runId,
              taskId: record.taskId,
              attemptId: record.attemptId,
              role: record.packet.role,
              signal,
              events: pendingStores.get(record.attemptId),
            });
          } catch (error) {
            result = { status: "not-run", exitCode: null, output: "", durationMs: Date.now() - started, reason: `the harness could not run it: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
        const normalized = normalizeVerification(result);
        let outputBlob: BlobRef | undefined;
        if (normalized.output.length > OUTPUT_EXCERPT_LIMIT) {
          outputBlob = await deps.blobs.put(new Uint8Array(Buffer.from(normalized.output, "utf8")), "text/plain; charset=utf-8").catch(() => undefined);
        }
        const event = await recorder.record(
          "attempt/verification_ran",
          {
            attempt_id: record.attemptId,
            task_id: record.taskId,
            ordinal: position + 1,
            command: command.slice(0, 4000),
            ...(argv === undefined || argv.length === 0 ? {} : { argv: argv.slice(0, 256) }),
            ...(normalized.commandClass === undefined ? {} : { command_class: normalized.commandClass }),
            status: normalized.status,
            ...(normalized.termination === undefined ? {} : { termination: normalized.termination }),
            exit_code: normalized.exitCode,
            duration_ms: Math.max(0, Math.round(normalized.durationMs)),
            output_excerpt: excerpt(normalized.output),
            ...(outputBlob === undefined ? {} : { output_blob: outputBlob }),
            ...(changeSet.changes.length === 0 ? {} : { artifact_digest: changeSet.artifactDigest }),
            ...(normalized.reason === undefined ? {} : { reason: normalized.reason.slice(0, 500) }),
          },
          { taskId: record.taskId, attemptId: record.attemptId, actor: { kind: "system" } },
        );
        verification.push({
          ordinal: position + 1,
          command: command.slice(0, 4000),
          ...(normalized.commandClass === undefined ? {} : { command_class: normalized.commandClass }),
          status: normalized.status,
          ...(normalized.termination === undefined ? {} : { termination: normalized.termination }),
          exit_code: normalized.exitCode,
          ...(normalized.reason === undefined ? {} : { reason: normalized.reason.slice(0, 500) }),
          evidence: {
            kind: "harness-verification",
            ref: `${recorder.log.sessionId}#${event.seq}`,
            produced_by: "harness",
            ...(outputBlob === undefined ? {} : { digest: outputBlob.digest }),
          },
        });
      }
    }
    return { verification, ...(diff === undefined ? {} : { diff }) };
  };

  const assemble = async (
    record: AttemptRecord,
    execution: Execution,
    changeSet: ChangeSet,
    claimResult: ClaimResult<WorkerClaim>,
    stale: readonly string[] | undefined,
    cancelledReason: string | undefined,
  ): Promise<CompletionPacket> => {
    const claim = claimResult.ok ? claimResult.claim : undefined;
    const notes: string[] = [];
    let status: CompletionPacket["status"];
    if (stale !== undefined) {
      status = "needs_context";
      notes.push(`sources changed during the attempt: ${stale.join(", ")}`);
    } else if (cancelledReason !== undefined || execution.outcome?.outcome === "cancelled") {
      status = "failed";
      notes.push(`attempt cancelled: ${cancelledReason ?? "signal"}`);
    } else if (execution.error !== undefined || execution.outcome === undefined) {
      status = "failed";
      notes.push("the agent turn failed");
    } else if (execution.outcome.outcome === "awaiting_approval") {
      status = "blocked";
      notes.push("the attempt is waiting for an approval that was not granted");
    } else if (execution.outcome.outcome === "budget_exceeded" || execution.outcome.outcome === "failed") {
      status = "failed";
      notes.push(`turn ended ${execution.outcome.outcome}`);
    } else if (claim === undefined) {
      status = execution.outcome.outcome === "max_steps" ? "partial" : "failed";
      notes.push(`no valid completion claim: ${claimResult.ok ? "" : claimResult.problems.join("; ")}`);
    } else {
      status = claim.status;
      if (execution.outcome.outcome === "max_steps" && status === "completed") {
        status = "partial";
        notes.push("the step limit was reached");
      }
    }
    const claimed = (claim?.acceptance_evidence ?? [])
      .map((entry) => ({ criterion_id: entry.criterion_id, evidence: entry.evidence.filter((evidence) => evidence.produced_by !== "reviewer" && evidence.produced_by !== "harness") }))
      .filter((entry) => entry.evidence.length > 0);
    if (claim !== undefined && claimed.length < claim.acceptance_evidence.length) {
      notes.push("evidence attributed to a reviewer or the harness was removed: a worker cites only its own evidence");
    }
    const index = indexFor(record, changeSet, record.workspace.root, execution.log);
    const claimedCommands = (claim?.commands_run ?? []).filter((command) => command.evidence.produced_by === "worker");
    const resolved = await resolveCompletionEvidence(record.packet, claimed, claimedCommands, index, platform);
    if (status === "completed" && resolved.acceptanceEvidence.length === 0) {
      status = "partial";
      notes.push("completed was claimed without evidence");
    }
    if (resolved.substituted.length > 0) {
      notes.push(`the harness verification evidenced ${resolved.substituted.join(", ")} (the report's pointers did not resolve)`);
    }
    const logged = commandsFromLog(execution.log);
    const seen = new Set(logged.map((command) => command.evidence.ref));
    const fromClaim = claimedCommands.flatMap((command) => {
      const resolution = resolved.resolution.find((entry) => entry.criterion_id === undefined && entry.ref === command.evidence.ref.slice(0, 2000) && entry.status === "resolved");
      const id = resolution?.tool_call_id;
      const call = id === undefined ? undefined : execution.log.toolCalls.get(id);
      if (id === undefined || call === undefined || seen.has(id) || call.name !== "exec" || call.state !== "succeeded") return [];
      seen.add(id);
      return [{ command: command.command, exit_code: call.exitCode ?? 0, evidence: { kind: "tool-call" as const, ref: id, produced_by: "worker" as const } }];
    });
    const repairs: RepairCounts = { ...record.repairs };
    const base = {
      schema_version: 2 as const,
      task_id: record.taskId,
      attempt_id: record.attemptId,
      packet_digest: packetDigest(record.packet),
      status,
      summary: [claim?.summary ?? `Attempt ${record.attemptId} ended without a usable report.`, ...notes].join(" | ").slice(0, 4000),
      changed_paths: changeSet.changes.map((change) => ({ path: change.path, before: change.before, after: change.after })),
      artifact_digest: changeSet.artifactDigest,
      tool_call_ids: [...execution.log.toolCalls.keys()],
      acceptance_evidence: resolved.acceptanceEvidence,
      commands_run: [...logged, ...fromClaim],
      decisions_made: claim?.decisions_made ?? [],
      skipped_checks: claim?.skipped_checks ?? [],
      unresolved_risks: [...(claim?.unresolved_risks ?? []), ...(notes.length > 0 && status !== "completed" ? notes : [])],
      recommended_context_updates: claim?.recommended_context_updates ?? [],
      ...(claim?.root_cause === undefined ? {} : { root_cause: claim.root_cause }),
      ...(record.harness === undefined ? {} : { harness_evidence: record.harness }),
      ...(resolved.resolution.length === 0 ? {} : { evidence_resolution: resolved.resolution }),
      repairs,
    };
    const parsed = completionPacketSchema.safeParse(base);
    if (parsed.success) return parsed.data;
    const changed = base.changed_paths.filter((change) => normalizeWorkspacePath(change.path) !== undefined);
    return completionPacketSchema.parse({
      ...base,
      status: status === "completed" ? "partial" : status,
      summary: `${base.summary} | completion rejected by schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`.slice(0, 4000),
      changed_paths: changed,
      acceptance_evidence: claimed,
      commands_run: logged,
      harness_evidence: record.harness === undefined ? undefined : { verification: record.harness.verification },
      evidence_resolution: undefined,
    });
  };

  /**
   * The in-call check of `task_report` (ADR-18 D1): every pointer is resolved against the attempt
   * log while the model can still act on the answer. Unresolved pointers get one actionable
   * correction round; the second rejection is recorded and the report is accepted as it is.
   */
  const taskReportCheck = (record: AttemptRecord) => async (input: Readonly<Record<string, unknown>>): Promise<ToolResult> => {
    const report = input as unknown as TaskReportInput;
    if (!CORRECTABLE_STATUSES.has(report.status)) return toolOk(REPORT_RECORDED);
    const log = await currentLog(record);
    const index = indexFor(record, undefined, record.workspace.root, log);
    const known = new Set(record.packet.acceptance_criteria.map((criterion) => criterion.id));
    const resolutions: EvidenceResolution[] = [];
    const problems: EvidenceProblem[] = [];
    for (const entry of report.acceptance_evidence) {
      if (!known.has(entry.criterion_id)) {
        problems.push({ criterionId: entry.criterion_id, ref: entry.criterion_id, reason: `is not a criterion of this task (criteria: ${[...known].join(", ")})` });
        continue;
      }
      for (const evidence of entry.evidence) {
        resolutions.push(
          evidence.produced_by === "worker"
            ? await resolvePointer(evidence, index, entry.criterion_id)
            : unresolvedPointer(evidence, entry.criterion_id, "a worker cites only its own evidence (produced_by: worker)"),
        );
      }
    }
    const listed = new Set(report.acceptance_evidence.map((entry) => entry.criterion_id));
    if (report.status === "completed") {
      for (const id of known) if (!listed.has(id)) problems.push({ criterionId: id, ref: "(none)", reason: "has no evidence listed" });
    }
    problems.push(...evidenceProblems(resolutions));
    if (problems.length === 0) return toolOk(REPORT_RECORDED);
    if (record.repairs.report_corrections < REPORT_CORRECTION_ROUNDS) {
      record.repairs.report_corrections += 1;
      const text = formatEvidenceCorrection(problems, evidenceCandidates(log), REPORT_CORRECTION_ROUNDS - record.repairs.report_corrections);
      return toolRejected(text, `${problems.length} evidence problem(s) in the report; nothing was recorded. Correct the refs listed above and call ${REPORT_TOOL_NAMES.task} again.`);
    }
    return toolOk(`report recorded with ${problems.length} unresolved evidence pointer(s); the harness records them as they are. End your turn now.`);
  };

  const complete = async (record: AttemptRecord, controller: AbortController): Promise<CompletionPacket> => {
    unregister.set(record.attemptId, deps.reports?.register(record.attemptId, taskReportCheck(record)) ?? (() => undefined));
    let execution = await executeBounded(record, renderWorkerMessage(record.packet, record.notes), controller, "dispatch", REPORT_TOOL_NAMES.task);
    let completion: CompletionPacket;
    let cancelledReason: string | undefined;
    let rounds = 0;
    for (;;) {
      const changeSet = await record.workspace.changeSet(new AbortController().signal);
      record.changeSet = changeSet;
      let stale: readonly string[] | undefined;
      if (execution.outcome?.outcome !== "cancelled") {
        try {
          await gate(baselines.get(record.attemptId) ?? record.packet, true);
        } catch (error) {
          if (error instanceof StaleInFlight) stale = error.paths;
          else throw error;
        }
      }
      record.stale = stale;
      cancelledReason = controller.signal.aborted ? String((controller.signal.reason as Error | undefined)?.message ?? controller.signal.reason) : undefined;
      const claim = readClaim(workerClaimSchema, execution.log, REPORT_TOOL_NAMES.task);
      const turnEnded = execution.error === undefined && (execution.outcome?.outcome === "completed" || execution.outcome?.outcome === "max_steps");
      const claimedStatus = claim.ok ? claim.claim.status : undefined;
      const verifies = turnEnded && stale === undefined && cancelledReason === undefined && claimedStatus !== "needs_context" && claimedStatus !== "blocked" && claimedStatus !== "failed";
      record.harness = verifies ? await runHarnessVerification(record, changeSet, controller.signal) : undefined;
      completion = await assemble(record, execution, changeSet, claim, stale, cancelledReason);
      if (completion.status !== "completed" || stale !== undefined || cancelledReason !== undefined) break;
      const check = await verifyCompletion(record.packet, completion, indexFor(record, changeSet, record.workspace.root, execution.log), platform);
      if (check.decision !== "revise") break;
      // Plan-caused verification problems (a refused / unrunnable / missing command) are the
      // orchestrator's to decide (triage): the worker cannot change its plan, so they never cost a
      // repair round. Only what the worker can fix is sent back.
      const planProblems = new Set(check.planProblems ?? []);
      const workerProblems = check.problems.filter((problem) => !planProblems.has(problem));
      if (workerProblems.length === 0) break;
      const used = repairsUsed.get(record.taskId) ?? 0;
      if (used >= budgets.evidence_repairs) break;
      const kind: RepairKind = (check.failedVerification ?? []).length > 0 ? "verification-repair" : "evidence-repair";
      repairsUsed.set(record.taskId, used + 1);
      rounds += 1;
      if (kind === "verification-repair") record.repairs.verification_repairs += 1;
      else record.repairs.evidence_repairs += 1;
      const problems = workerProblems.slice(0, 50).map((problem) => problem.slice(0, 2000));
      await recorder.record(
        "attempt/repair_requested",
        { attempt_id: record.attemptId, task_id: record.taskId, kind, round: Math.min(rounds, budgets.evidence_repairs), budget: budgets.evidence_repairs, problems },
        { taskId: record.taskId, attemptId: record.attemptId, actor: { kind: "system" } },
      );
      execution = await executeBounded(record, renderRepairMessage(kind, problems, execution.log, record.harness), controller, "follow-up", REPORT_TOOL_NAMES.task);
    }
    record.completion = completion;
    await closeAttempt(record);
    await finishAttempt(record, execution, cancelledReason !== undefined);
    const blob = await recorder.putJson(completion, COMPLETION_MEDIA_TYPE);
    await recorder.record(
      "attempt/completion_recorded",
      { attempt_id: record.attemptId, task_id: record.taskId, status: completion.status, completion_digest: packetDigest(completion), blob },
      { taskId: record.taskId, attemptId: record.attemptId, actor: { kind: "worker", role: record.packet.role, attempt_id: record.attemptId } },
    );
    return completion;
  };

  const fallbackCompletion = (record: AttemptRecord, error: unknown): CompletionPacket =>
    completionPacketSchema.parse({
      schema_version: 2,
      task_id: record.taskId,
      attempt_id: record.attemptId,
      packet_digest: packetDigest(record.packet),
      status: "failed",
      summary: `attempt failed inside the harness: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
      changed_paths: [],
      tool_call_ids: [],
      acceptance_evidence: [],
      commands_run: [],
      decisions_made: [],
      skipped_checks: [],
      unresolved_risks: ["the attempt workspace may hold partial changes; it was not integrated"],
      recommended_context_updates: [],
    });

  /** Reviewer pointers resolve against the reviewer's attempt, harness pointers against the target's records. */
  const reviewIndexes = (target: AttemptRecord, reviewer: AttemptRecord, pinned: ChangeSet, completion: CompletionPacket, reviewerLog?: AttemptLog) => {
    const worker = { ...indexFor(target, pinned, target.workspace.root), harness: target.harness ?? completion.harness_evidence };
    const own = { ...indexFor(reviewer, pinned, target.workspace.root, reviewerLog), harness: worker.harness };
    return { worker, reviewer: own };
  };

  const resolveReviewPointer = async (evidence: EvidenceRef, criterionId: string, indexes: { readonly worker: EvidenceIndex; readonly reviewer: EvidenceIndex }): Promise<EvidenceResolution> => {
    if (evidence.produced_by === "reviewer") return resolvePointer(evidence, indexes.reviewer, criterionId);
    if (evidence.produced_by === "harness" || evidence.produced_by === "worker") return resolvePointer(evidence, indexes.worker, criterionId);
    return unresolvedPointer(evidence, criterionId, `${evidence.produced_by} evidence is not accepted in a review`);
  };

  /** The in-call check of `review_report`: reviewer pointers must resolve and every met verdict needs independent evidence. */
  const reviewReportCheck = (record: AttemptRecord, target: AttemptRecord, pinned: ChangeSet, completion: CompletionPacket) => async (input: Readonly<Record<string, unknown>>): Promise<ToolResult> => {
    const report = input as unknown as ReviewReportInput;
    const log = await currentLog(record);
    const indexes = reviewIndexes(target, record, pinned, completion, log);
    const problems: EvidenceProblem[] = [];
    const statements = statementsOf(target.packet);
    for (const criterion of report.criteria) {
      let independent = 0;
      for (const evidence of criterion.evidence) {
        const resolution = await resolveReviewPointer(evidence, criterion.criterion_id, indexes);
        if (resolution.status === "resolved" && isIndependentReviewEvidence(evidence, indexes.worker.harness, statements.get(criterion.criterion_id))) independent += 1;
        else if (resolution.status !== "resolved") problems.push({ criterionId: criterion.criterion_id, ref: evidence.ref.slice(0, 200), reason: resolution.reason ?? "does not resolve" });
      }
      if (criterion.verdict === "met" && independent === 0) {
        problems.push({ criterionId: criterion.criterion_id, ref: "(met)", reason: INDEPENDENT_EVIDENCE_HINT });
      }
    }
    if (problems.length === 0) return toolOk(REPORT_RECORDED);
    if (record.repairs.report_corrections < REPORT_CORRECTION_ROUNDS) {
      record.repairs.report_corrections += 1;
      const harness = harnessLines(indexes.worker.harness, target.packet);
      const text = [
        formatEvidenceCorrection(problems, evidenceCandidates(log), REPORT_CORRECTION_ROUNDS - record.repairs.report_corrections),
        harness.length > 0 ? `Harness records (kind harness-verification / harness-diff, produced_by: harness):\n${harness.join("\n")}` : "",
      ]
        .filter((part) => part !== "")
        .join("\n");
      return toolRejected(text, `${problems.length} evidence problem(s) in the review; nothing was recorded. Correct them as listed above and call ${REPORT_TOOL_NAMES.review} again.`);
    }
    return toolOk(`review recorded with ${problems.length} unresolved evidence problem(s); unresolved pointers are dropped and a met verdict without independent evidence counts as unverifiable. End your turn now.`);
  };

  const liveControl = (attemptId: AttemptId): AttemptControl | undefined =>
    controllers.has(attemptId) && !finished.has(attemptId) ? controls.get(attemptId) : undefined;

  const manager: OrchestrationWorkerManager = {
    async dispatch(packet, signal, options) {
      const { record, controller } = await prepare(packet, signal, options, undefined);
      const completion = complete(record, controller).catch(async (error: unknown) => {
        await failUnfinished(record, error);
        record.completion = fallbackCompletion(record, error);
        return record.completion;
      });
      const handle: AttemptHandle = {
        attemptId: record.attemptId,
        taskId: record.taskId,
        completion,
        cancel: (reason) => controller.abort(new Error(reason)),
      };
      handles.set(record.attemptId, handle);
      void completion.finally(() => handles.delete(record.attemptId));
      return handle;
    },
    async dispatchReview(packet, targetId, signal, options) {
      const target = records.get(targetId);
      if (target?.completion === undefined || target.changeSet === undefined) {
        throw harnessError("review_blocked", `attempt ${targetId} has no pinned completion to review`);
      }
      if (packet.role !== "reviewer" || packet.write_mode !== "read-only") {
        throw harnessError("review_blocked", "a review runs as a read-only reviewer packet");
      }
      const pinned = target.changeSet;
      const completion = target.completion;
      const { record, controller } = await prepare(packet, signal, options, target.workspace.root);
      const run = async (): Promise<ReviewOutcome> => {
        unregister.set(record.attemptId, deps.reports?.register(record.attemptId, reviewReportCheck(record, target, pinned, completion)) ?? (() => undefined));
        const execution = await executeBounded(record, renderReviewBrief(target, completion, pinned), controller, "dispatch", REPORT_TOOL_NAMES.review);
        await closeAttempt(record);
        await finishAttempt(record, execution, controller.signal.aborted);
        const claim = readClaim(reviewerClaimSchema, execution.log, REPORT_TOOL_NAMES.review);
        if (!claim.ok) return { attemptId: record.attemptId, review: undefined, verification: { decision: "invalid", problems: claim.problems } };
        // ADR-18: unresolved pointers are dropped (and recorded); a met verdict left without independent evidence is unverifiable.
        const indexes = reviewIndexes(target, record, pinned, completion, execution.log);
        const statements = statementsOf(target.packet);
        const resolution: EvidenceResolution[] = [];
        const downgraded: string[] = [];
        const criteria: ReviewPacket["criteria"] = [];
        for (const criterion of claim.claim.criteria) {
          const kept: EvidenceRef[] = [];
          for (const evidence of criterion.evidence) {
            const result = await resolveReviewPointer(evidence, criterion.criterion_id, indexes);
            resolution.push(result);
            if (result.status === "resolved") kept.push(evidence);
          }
          const independent = kept.some((evidence) => isIndependentReviewEvidence(evidence, indexes.worker.harness, statements.get(criterion.criterion_id)));
          if (criterion.verdict === "met" && !independent) {
            downgraded.push(criterion.criterion_id);
            criteria.push({ ...criterion, verdict: "unverifiable", evidence: kept, note: `${criterion.note === undefined ? "" : `${criterion.note} | `}harness: no independent evidence (own tool result or passed build/test verification; harness-diff alone is not enough)` });
          } else criteria.push({ ...criterion, evidence: kept });
        }
        const decision = claim.claim.decision === "accept" && downgraded.length > 0 ? "revise" : claim.claim.decision;
        const candidate = {
          schema_version: 2 as const,
          task_id: target.taskId,
          reviewed_attempt_id: target.attemptId,
          reviewer_attempt_id: record.attemptId,
          completion_digest: packetDigest(completion),
          reviewed_artifact_digest: pinned.artifactDigest,
          reviewer_route: { provider_id: record.route.provider_id, model_id: record.route.model_id },
          independence: {
            separate_context: true as const,
            same_provider: record.route.provider_id === target.route.provider_id,
            same_model: record.route.provider_id === target.route.provider_id && record.route.model_id === target.route.model_id,
          },
          criteria,
          findings: claim.claim.findings,
          decision,
          ...(resolution.length === 0 ? {} : { evidence_resolution: resolution.slice(0, 200) }),
          repairs: { report_corrections: record.repairs.report_corrections },
        };
        const parsed = reviewPacketSchema.safeParse(candidate);
        if (!parsed.success) {
          return {
            attemptId: record.attemptId,
            review: undefined,
            verification: { decision: "invalid", problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
          };
        }
        const review = parsed.data;
        const blob = await recorder.putJson(review, REVIEW_MEDIA_TYPE);
        await recorder.record(
          "review/recorded",
          { task_id: target.taskId, reviewer_attempt_id: record.attemptId, review_digest: packetDigest(review), decision: review.decision, blob },
          { taskId: target.taskId, attemptId: record.attemptId, actor: { kind: "worker", role: "reviewer", attempt_id: record.attemptId } },
        );
        const after = await target.workspace.changeSet(new AbortController().signal);
        if (after.artifactDigest !== pinned.artifactDigest) {
          return { attemptId: record.attemptId, review, verification: { decision: "invalid", problems: ["the artifact changed during review"] } };
        }
        // Judged against the criteria the reviewer was given: the implementation's, minus waived ones, plus reviewer-task extras.
        const verification = await verifyReview(review, record.packet, completion, indexes);
        return { attemptId: record.attemptId, review, verification: { decision: verification.decision, problems: verification.problems } };
      };
      const result = run().catch(async (error: unknown): Promise<ReviewOutcome> => {
        await failUnfinished(record, error);
        return {
          attemptId: record.attemptId,
          review: undefined,
          verification: { decision: "invalid", problems: [`review failed inside the harness: ${error instanceof Error ? error.message : String(error)}`] },
        };
      });
      return { attemptId: record.attemptId, result, cancel: (reason) => controller.abort(new Error(reason)) };
    },
    async dispatchIntegrationReview(packet, dependencies, signal, options) {
      if (packet.role !== "reviewer" || packet.write_mode !== "read-only") {
        throw harnessError("review_blocked", "an integration review runs as a read-only reviewer packet");
      }
      const { record, controller } = await prepare(packet, signal, options, undefined);
      const statements = statementsOf(record.packet);
      /** Only the reviewer's own resolved tool results count: there is no worker artifact or harness run to cite. */
      const judge = async (log: AttemptLog, criteria: ReviewReportInput["criteria"]) => {
        const index = indexFor(record, undefined, record.workspace.root, log);
        const problems: EvidenceProblem[] = [];
        const judged: ReviewReportInput["criteria"] = [];
        for (const criterion of criteria) {
          const kept: EvidenceRef[] = [];
          for (const evidence of criterion.evidence) {
            const resolution = evidence.produced_by === "reviewer" ? await resolvePointer(evidence, index, criterion.criterion_id) : unresolvedPointer(evidence, criterion.criterion_id, "an integration review cites only its own tool results (produced_by: reviewer)");
            if (resolution.status === "resolved" && isIndependentReviewEvidence(evidence, undefined, statements.get(criterion.criterion_id))) kept.push(evidence);
            else problems.push({ criterionId: criterion.criterion_id, ref: evidence.ref.slice(0, 200), reason: resolution.reason ?? "does not resolve" });
          }
          if (criterion.verdict === "met" && kept.length === 0) {
            problems.push({ criterionId: criterion.criterion_id, ref: "(met)", reason: INDEPENDENT_EVIDENCE_HINT });
            judged.push({ ...criterion, verdict: "unverifiable", evidence: kept });
          } else judged.push({ ...criterion, evidence: kept });
        }
        return { problems, judged };
      };
      const check = async (input: Readonly<Record<string, unknown>>): Promise<ToolResult> => {
        const report = input as unknown as ReviewReportInput;
        const { problems } = await judge(await currentLog(record), report.criteria);
        if (problems.length === 0) return toolOk(REPORT_RECORDED);
        if (record.repairs.report_corrections < REPORT_CORRECTION_ROUNDS) {
          record.repairs.report_corrections += 1;
          const text = formatEvidenceCorrection(problems, evidenceCandidates(await currentLog(record)), REPORT_CORRECTION_ROUNDS - record.repairs.report_corrections);
          return toolRejected(text, `${problems.length} evidence problem(s) in the review; nothing was recorded. Correct them as listed above and call ${REPORT_TOOL_NAMES.review} again.`);
        }
        return toolOk(`review recorded with ${problems.length} unresolved evidence problem(s); a met verdict without your own evidence counts as unverifiable. End your turn now.`);
      };
      const run = async (): Promise<IntegrationReviewOutcome> => {
        unregister.set(record.attemptId, deps.reports?.register(record.attemptId, check) ?? (() => undefined));
        const execution = await executeBounded(record, renderIntegrationReviewBrief(record.packet, dependencies), controller, "dispatch", REPORT_TOOL_NAMES.review);
        await closeAttempt(record);
        await finishAttempt(record, execution, controller.signal.aborted);
        const claim = readClaim(reviewerClaimSchema, execution.log, REPORT_TOOL_NAMES.review);
        if (!claim.ok) return { attemptId: record.attemptId, decision: "invalid", problems: claim.problems, findings: [] };
        const { judged } = await judge(execution.log, claim.claim.criteria);
        const problems: string[] = [];
        for (const criterion of record.packet.acceptance_criteria) {
          const verdict = judged.find((candidate) => candidate.criterion_id === criterion.id);
          if (verdict === undefined) problems.push(`${criterion.id} was not assessed`);
          else if (verdict.verdict !== "met") problems.push(`${criterion.id} is ${verdict.verdict}${verdict.note === undefined ? "" : `: ${verdict.note.slice(0, 300)}`}`);
        }
        const blocker = claim.claim.findings.some((finding) => finding.severity === "blocker");
        const decision = claim.claim.decision === "block" ? "block" : claim.claim.decision === "revise" || problems.length > 0 || blocker ? "revise" : "accept";
        const review = {
          kind: "integration-review",
          task_id: record.taskId,
          reviewer_attempt_id: record.attemptId,
          reviewer_route: { provider_id: record.route.provider_id, model_id: record.route.model_id },
          dependencies: dependencies.map((dependency) => ({ key: dependency.key, task_id: dependency.taskId, paths: dependency.paths })),
          criteria: judged,
          findings: claim.claim.findings,
          decision,
        };
        const blob = await recorder.putJson(review, REVIEW_MEDIA_TYPE);
        await recorder.record(
          "review/recorded",
          { task_id: record.taskId, reviewer_attempt_id: record.attemptId, review_digest: digestOf(review), decision, blob },
          { taskId: record.taskId, attemptId: record.attemptId, actor: { kind: "worker", role: "reviewer", attempt_id: record.attemptId } },
        );
        return {
          attemptId: record.attemptId,
          decision,
          problems: [...problems, ...claim.claim.findings.map((finding) => `${finding.id} (${finding.severity}): ${finding.summary}`)],
          findings: claim.claim.findings,
        };
      };
      const result = run().catch(async (error: unknown): Promise<IntegrationReviewOutcome> => {
        await failUnfinished(record, error);
        return { attemptId: record.attemptId, decision: "invalid", problems: [`integration review failed inside the harness: ${error instanceof Error ? error.message : String(error)}`], findings: [] };
      });
      return { attemptId: record.attemptId, result, cancel: (reason) => controller.abort(new Error(reason)) };
    },
    running() {
      return [...handles.values()];
    },
    attempt(attemptId) {
      return records.get(attemptId);
    },
    async verify(attemptId, options) {
      const record = records.get(attemptId);
      if (record?.completion === undefined || record.changeSet === undefined) {
        return { decision: "reject", problems: [`attempt ${attemptId} has no completion`], unevidenced: [] };
      }
      return verifyCompletion(record.packet, record.completion, indexFor(record, record.changeSet, record.workspace.root), platform, options);
    },
    async integrate(attemptId, expectedArtifact, signal) {
      const record = records.get(attemptId);
      if (record === undefined) throw harnessError("internal", `unknown attempt ${attemptId}`);
      await deps.isolation.integrate(record.workspace, expectedArtifact, signal);
      await recorder.record(
        "task/integrated",
        {
          task_id: record.taskId,
          attempt_id: record.attemptId,
          artifact_digest: expectedArtifact,
          paths: (record.changeSet?.changes ?? []).flatMap((change) => {
            const normalized = normalizeWorkspacePath(change.path);
            return normalized === undefined ? [] : [normalized];
          }),
        },
        { taskId: record.taskId, attemptId: record.attemptId, actor: { kind: "orchestrator", role: "orchestrator" } },
      );
    },
    async revert(attemptId, signal) {
      const record = records.get(attemptId);
      if (record === undefined || record.workspace.mode !== "scoped-dir") return [];
      return record.workspace.revert(signal);
    },
    async dispose(attemptId) {
      const record = records.get(attemptId);
      if (record !== undefined) await record.workspace.dispose();
    },
    steer(attemptId, text) {
      const control = liveControl(attemptId);
      if (control === undefined || text.trim() === "") return false;
      const driver = drivers.get(attemptId);
      if (driver === undefined) control.steers.push(text);
      else driver.steer(text);
      return true;
    },
    pause(attemptId) {
      const control = liveControl(attemptId);
      if (control === undefined) return false;
      control.paused = true;
      pausable(drivers.get(attemptId))?.pause();
      control.wall?.pause();
      return true;
    },
    resume(attemptId) {
      const control = liveControl(attemptId);
      if (control === undefined) return false;
      control.paused = false;
      pausable(drivers.get(attemptId))?.resume();
      control.wall?.resume();
      return true;
    },
    cancel(attemptId, reason) {
      const controller = liveControl(attemptId) === undefined ? undefined : controllers.get(attemptId);
      if (controller === undefined) return false;
      // A paused driver wakes on abort; the attempt then ends through the normal cancellation path.
      controller.abort(new Error(reason));
      return true;
    },
    live(attemptId) {
      const control = liveControl(attemptId);
      return control === undefined ? undefined : { paused: control.paused };
    },
  };
  return manager;
}

/** Enforces the contract's outcome rules on a runner result (passed means exited 0; not-run has a reason and no exit code). */
function normalizeVerification(result: VerificationResult): VerificationResult {
  if (result.termination === undefined || result.status === "not-run") {
    return { status: "not-run", exitCode: null, output: result.output, durationMs: result.durationMs, reason: result.reason ?? "the harness did not start the command", ...(result.commandClass === undefined ? {} : { commandClass: result.commandClass }) };
  }
  const passed = result.termination === "exited" && result.exitCode === 0;
  return { status: passed ? "passed" : "failed", termination: result.termination, exitCode: result.exitCode, output: result.output, durationMs: result.durationMs, ...(result.commandClass === undefined ? {} : { commandClass: result.commandClass }) };
}

class StaleInFlight extends Error {
  public readonly paths: readonly string[];

  public constructor(paths: readonly string[]) {
    super(`sources changed: ${paths.join(", ")}`);
    this.name = "StaleInFlight";
    this.paths = paths;
  }
}
