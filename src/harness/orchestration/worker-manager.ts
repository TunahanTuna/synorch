import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  completionPacketSchema,
  createId,
  digestOf,
  findStaleSources,
  HarnessError,
  packetDigest,
  ProviderFailure,
  REPORT_TOOL_NAMES,
  reviewPacketSchema,
  sha256,
  taskContextPacketSchema,
  type AgentDriver,
  type AttemptHandle,
  type AttemptId,
  type BlobStore,
  type CompletionPacket,
  type Digest,
  type EffectivePolicy,
  type EventStore,
  type ModelRoute,
  type ModelRouter,
  type PolicyEngine,
  type PolicyMode,
  type ProjectId,
  type DispatchOptions,
  type ReviewOutcome,
  type RunId,
  type SandboxReport,
  type SessionEvent,
  type SessionId,
  type SessionStore,
  type TaskContextPacket,
  type TaskId,
  type TurnOutcome,
  type WorkerManager,
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
import { verifyCompletion, verifyReview, type CompletionVerification, type EvidenceIndex } from "./evidence.ts";
import type { ChangeSet, OrchestratedWorkspace, OrchestrationIsolationProvider } from "./isolation.ts";
import { matchesAny, normalizeWorkspacePath } from "./paths.ts";
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
 * identity, the real diff, the pinned artifact and the tool call ids come from the log and the
 * workspace; only the narrative and the evidence pointers come from the worker's claim.
 */

export interface RunScope {
  readonly runId: RunId;
  readonly mode: PolicyMode;
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
  readonly recorder: RunRecorder;
}

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
}

export interface AttemptRecord {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
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

/** The contract `WorkerManager` plus the coordinator's own verification and integration steps. */
export interface OrchestrationWorkerManager extends WorkerManager {
  attempt(attemptId: AttemptId): AttemptRecord | undefined;
  verify(attemptId: AttemptId): Promise<CompletionVerification>;
  integrate(attemptId: AttemptId, expectedArtifact: Digest, signal: AbortSignal): Promise<void>;
  revert(attemptId: AttemptId, signal: AbortSignal): Promise<readonly string[]>;
  dispose(attemptId: AttemptId): Promise<void>;
}

const REVIEW_BRIEF_CONTENT_LIMIT = 48 * 1024;

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

async function fileDigestIn(root: string, relative: string): Promise<Digest | undefined> {
  const normalized = normalizeWorkspacePath(relative);
  if (normalized === undefined || normalized === ".") return undefined;
  const file = path.join(root, ...normalized.split("/"));
  try {
    if (!(await lstat(file)).isFile()) return undefined;
    return sha256(await readFile(file));
  } catch {
    return undefined;
  }
}

export function renderWorkerMessage(packet: TaskContextPacket): string {
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
    "If the packet is insufficient or a cited source changed, stop and report status needs_context.",
    WORKER_REPORT_INSTRUCTIONS,
  ].join("\n\n");
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
  return [
    `Independent review of attempt ${target.attemptId} for task ${target.taskId}.`,
    `The artifact under review is pinned at ${changeSet.artifactDigest}. Your workspace is that artifact, read-only.`,
    "You receive the worker's completion packet and the changed files, not the worker's conversation. Verify every acceptance criterion yourself with your own tool calls.",
    `Worker completion packet:\n\`\`\`json\n${canonicalJson(completion)}\n\`\`\``,
    `Changed files (${changeSet.changes.length}):\n${files.join("\n\n") || "[no file changes]"}`,
    REVIEWER_REPORT_INSTRUCTIONS,
  ].join("\n\n");
}

interface Execution {
  readonly outcome: TurnOutcome | undefined;
  readonly error: unknown;
  readonly log: AttemptLog;
}

export function createWorkerManager(deps: WorkerManagerDependencies): OrchestrationWorkerManager {
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const sources = deps.sources ?? createWorkspaceSourceReader(deps.run.workspaceRoot);
  const recorder = deps.run.recorder;
  const records = new Map<AttemptId, AttemptRecord>();
  const handles = new Map<AttemptId, AttemptHandle>();
  const controllers = new Map<AttemptId, AbortController>();
  const pendingStores = new Map<AttemptId, EventStore>();

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

  const prepare = async (
    packet: TaskContextPacket,
    signal: AbortSignal,
    options: DispatchOptions | undefined,
    readRoot: string | undefined,
  ): Promise<{ record: AttemptRecord; controller: AbortController }> => {
    const valid = taskContextPacketSchema.parse(packet);
    await gate(valid, false);
    const attemptId = createId("attempt");
    const decision = options?.route ?? (await deps.router.resolve({ tier: valid.model_tier, role: valid.role }, signal));
    await recorder.record("route/decided", { decision }, { taskId: valid.task_id, attemptId, actor: { kind: "system" } });
    const workspace = await deps.isolation.create(valid, attemptId, signal, readRoot === undefined ? undefined : { readRoot });
    if (options?.seedArtifact !== undefined) await deps.isolation.seed(workspace, options.seedArtifact, signal);
    const policy = deps.policy.compute({
      mode: deps.run.mode,
      role: valid.role,
      runId: deps.run.runId,
      taskId: valid.task_id,
      workspaceRoot: workspace.root,
      taskScope: {
        owned: valid.write_mode === "owned-paths" ? valid.scope.owned_paths : [],
        read: valid.scope.read_paths,
        forbidden: valid.scope.forbidden_paths,
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
    };
    records.set(attemptId, record);
    const controller = linkSignals(signal);
    controllers.set(attemptId, controller);
    pendingStores.set(attemptId, events);
    return { record, controller };
  };

  const execute = async (record: AttemptRecord, userMessage: string, controller: AbortController): Promise<Execution> => {
    const events = pendingStores.get(record.attemptId);
    if (events === undefined) throw harnessError("internal", `attempt ${record.attemptId} has no session`);
    const timer = setTimeout(
      () => controller.abort(new Error("wall-time limit reached")),
      record.packet.limits.max_wall_time_seconds * 1000,
    );
    timer.unref?.();
    let outcome: TurnOutcome | undefined;
    let error: unknown;
    try {
      outcome = await deps.createDriver(events).runTurn(
        {
          sessionId: record.sessionId,
          runId: deps.run.runId,
          taskId: record.taskId,
          attemptId: record.attemptId,
          role: record.packet.role,
          route: record.route,
          policy: record.policy,
          packet: record.packet,
          userMessage,
          trigger: "dispatch",
          maxSteps: record.packet.limits.max_steps,
        },
        controller.signal,
      );
    } catch (caught) {
      error = caught;
    } finally {
      clearTimeout(timer);
    }
    const recorded = await readEvents(events);
    const log = await buildAttemptLog(record.sessionId, recorded, deps.blobs);
    await events.close().catch(() => undefined);
    pendingStores.delete(record.attemptId);
    controllers.delete(record.attemptId);
    deps.budget?.recordToolCalls(log.toolCalls.size);
    record.log = log;
    record.outcome = outcome;
    record.failure = classifyAttemptFailure(outcome, error, recorded);
    return { outcome, error, log };
  };

  const finished = new Set<AttemptId>();

  const failUnfinished = async (record: AttemptRecord, error: unknown): Promise<void> => {
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

  const indexFor = (record: AttemptRecord, artifact: ChangeSet | undefined, root: string): EvidenceIndex => ({
    log: record.log ?? { sessionId: record.sessionId, toolCalls: new Map(), eventTypes: new Map(), compactionBlobs: new Set(), finalAssistantText: undefined, assistantTexts: [], reports: [] },
    artifactDigest: artifact?.artifactDigest,
    changedPaths: artifact?.changes.map((change) => change.path) ?? [],
    fileDigest: (relative) => fileDigestIn(root, relative),
  });

  const assemble = (
    record: AttemptRecord,
    execution: Execution,
    changeSet: ChangeSet,
    claimResult: ClaimResult<WorkerClaim>,
    stale: readonly string[] | undefined,
    cancelledReason: string | undefined,
  ): CompletionPacket => {
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
    const workerEvidence = (claim?.acceptance_evidence ?? [])
      .map((entry) => ({ criterion_id: entry.criterion_id, evidence: entry.evidence.filter((evidence) => evidence.produced_by !== "reviewer") }))
      .filter((entry) => entry.evidence.length > 0);
    if (claim !== undefined && workerEvidence.length < claim.acceptance_evidence.length) {
      notes.push("evidence attributed to a reviewer was removed: a worker cannot cite reviewer evidence");
    }
    if (status === "completed" && workerEvidence.length === 0) {
      status = "partial";
      notes.push("completed was claimed without evidence");
    }
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
      acceptance_evidence: workerEvidence,
      commands_run: (claim?.commands_run ?? []).filter((command) => command.evidence.produced_by !== "reviewer"),
      decisions_made: claim?.decisions_made ?? [],
      skipped_checks: claim?.skipped_checks ?? [],
      unresolved_risks: [...(claim?.unresolved_risks ?? []), ...(notes.length > 0 && status !== "completed" ? notes : [])],
      recommended_context_updates: claim?.recommended_context_updates ?? [],
      ...(claim?.root_cause === undefined ? {} : { root_cause: claim.root_cause }),
    };
    const parsed = completionPacketSchema.safeParse(base);
    if (parsed.success) return parsed.data;
    return completionPacketSchema.parse({
      ...base,
      status: status === "completed" ? "partial" : status,
      summary: `${base.summary} | completion rejected by schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`.slice(0, 4000),
      changed_paths: base.changed_paths.filter((change) => normalizeWorkspacePath(change.path) !== undefined),
    });
  };

  const complete = async (record: AttemptRecord, controller: AbortController): Promise<CompletionPacket> => {
    const execution = await execute(record, renderWorkerMessage(record.packet), controller);
    const changeSet = await record.workspace.changeSet(new AbortController().signal);
    record.changeSet = changeSet;
    let stale: readonly string[] | undefined;
    if (execution.outcome?.outcome !== "cancelled") {
      try {
        await gate(record.packet, true);
      } catch (error) {
        if (error instanceof StaleInFlight) stale = error.paths;
        else throw error;
      }
    }
    const cancelledReason = controller.signal.aborted ? String((controller.signal.reason as Error | undefined)?.message ?? controller.signal.reason) : undefined;
    const completion = assemble(record, execution, changeSet, readClaim(workerClaimSchema, execution.log, REPORT_TOOL_NAMES.task), stale, cancelledReason);
    record.completion = completion;
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
        const execution = await execute(record, renderReviewBrief(target, completion, pinned), controller);
        await finishAttempt(record, execution, controller.signal.aborted);
        const claim = readClaim(reviewerClaimSchema, execution.log, REPORT_TOOL_NAMES.review);
        if (!claim.ok) return { attemptId: record.attemptId, review: undefined, verification: { decision: "invalid", problems: claim.problems } };
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
          criteria: claim.claim.criteria,
          findings: claim.claim.findings,
          decision: claim.claim.decision,
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
        const verification = await verifyReview(review, target.packet, completion, {
          worker: indexFor(target, pinned, target.workspace.root),
          reviewer: indexFor(record, pinned, target.workspace.root),
        });
        return { attemptId: record.attemptId, review, verification };
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
    running() {
      return [...handles.values()];
    },
    attempt(attemptId) {
      return records.get(attemptId);
    },
    async verify(attemptId) {
      const record = records.get(attemptId);
      if (record?.completion === undefined || record.changeSet === undefined) {
        return { decision: "reject", problems: [`attempt ${attemptId} has no completion`], unevidenced: [] };
      }
      return verifyCompletion(record.packet, record.completion, indexFor(record, record.changeSet, record.workspace.root), platform);
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
  };
  return manager;
}

class StaleInFlight extends Error {
  public readonly paths: readonly string[];

  public constructor(paths: readonly string[]) {
    super(`sources changed: ${paths.join(", ")}`);
    this.name = "StaleInFlight";
    this.paths = paths;
  }
}
