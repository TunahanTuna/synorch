import {
  createId,
  deriveProjectId,
  digestOf,
  EXIT_CODES,
  exitCodeFor,
  HarnessError,
  isTerminalState,
  packetDigest,
  planTaskSchema,
  ProviderFailure,
  RouteBlockedFailure,
  validateTransition,
  type ApprovalBroker,
  type AttemptId,
  type BlobStore,
  type CompletionPacket,
  type Coordinator,
  type Digest,
  type EffectivePolicy,
  type EventStore,
  type ExitCode,
  type HarnessErrorCode,
  type ModelRouter,
  type Plan,
  type PlanTask,
  type PolicyEngine,
  type RenderEvent,
  type RouteDecision,
  type RunId,
  type RunOutcome,
  type RunRequest,
  type RunState,
  type SandboxReport,
  type SessionEvent,
  type SessionEventDraft,
  type SessionStore,
  type TaskContextPacket,
  type TaskId,
  type TaskState,
} from "../contracts/index.ts";
import { approvePlan, type PlanApprovalOutcome } from "./approval.ts";
import { readEvents } from "./attempt-log.ts";
import { createBudgetTracker, type BudgetGateSlot, type BudgetTracker } from "./budget.ts";
import { createControlPlaneWriter, type ControlPlaneWriter } from "./control-plane.ts";
import type { DelegationResult, DelegationSlot } from "./delegation.ts";
import { mayComplete, reviewRequired } from "./evidence.ts";
import { isLiteralPattern } from "./paths.ts";
import {
  applyDelta,
  compileReviewerPacket,
  compileTaskPacket,
  createDeltaPacket,
  refreshPacketSources,
  validatePlan,
  type PacketSource,
} from "./plan.ts";
import type { Planner } from "./planner.ts";
import {
  createRunRecorder,
  createWorkspaceSourceReader,
  currentDigests,
  PACKET_MEDIA_TYPE,
  type RunRecorder,
  type SourceDigestReader,
} from "./recorder.ts";
import { createDagScheduler, DEFAULT_CONCURRENCY, type ConcurrencyLimits, type DagScheduler } from "./scheduler.ts";
import type { OrchestrationWorkerManager, RunScope } from "./worker-manager.ts";

/**
 * The coordinator drives one run: plan -> approval -> task DAG -> worker attempts -> orchestrator
 * verification -> independent review -> integration -> final report. It never edits a product
 * file itself: product changes reach the workspace only through `integrate` of a verified (and,
 * above `trivial`, review-accepted) artifact, and its own writes go through the control-plane
 * writer under `.ai/tasks/**`.
 */

export type WorkerFactory = (scope: RunScope, budget: BudgetTracker) => OrchestrationWorkerManager;

export interface CoordinatorLimits {
  readonly concurrency: ConcurrencyLimits;
  readonly maxPlanAttempts: number;
  readonly maxRetries: number;
  readonly maxRevisions: number;
  readonly maxReviewAttempts: number;
  readonly maxRepackages: number;
  /** Follow-up tasks the orchestrator may add through `task_spawn` per run. */
  readonly maxSpawnedTasks: number;
}

export const DEFAULT_COORDINATOR_LIMITS: CoordinatorLimits = {
  concurrency: DEFAULT_CONCURRENCY,
  maxPlanAttempts: 2,
  maxRetries: 1,
  maxRevisions: 2,
  maxReviewAttempts: 2,
  maxRepackages: 2,
  maxSpawnedTasks: 4,
};

export interface CoordinatorDependencies {
  readonly sessions: SessionStore;
  readonly blobs: BlobStore;
  readonly router: ModelRouter;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalBroker;
  readonly planner: Planner;
  readonly sandbox: SandboxReport;
  readonly createWorkers: WorkerFactory;
  readonly budgetGate?: BudgetGateSlot;
  /** Where the active run publishes its `task_spawn`/`task_status` port for the tool registry. */
  readonly delegation?: DelegationSlot;
  /** Write `plan.json` and `report.md` under `.ai/tasks/<run-id>/` through the control-plane writer. */
  readonly ledger?: boolean;
  readonly limits?: Partial<CoordinatorLimits>;
  readonly preferWorktree?: boolean;
  readonly sources?: (workspaceRoot: string) => SourceDigestReader;
  readonly userConfig?: unknown;
  readonly workspaceConfig?: unknown;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly budgetTickMs?: number;
}

interface TaskEntry {
  readonly key: string;
  readonly taskId: TaskId;
  readonly plan: PlanTask;
  state: TaskState;
  route: RouteDecision | undefined;
  readonly attempts: AttemptId[];
  completion: CompletionPacket | undefined;
  integrated: readonly string[];
  summary: string;
  /** The error class of the task's last failure; it selects the run's exit code. */
  failure: HarnessErrorCode | undefined;
}

type TaskResult = "completed" | "failed";

const VERIFICATION_FAILURES: readonly HarnessErrorCode[] = ["verification_failed", "review_blocked", "stale_packet"];

/**
 * The exit code of a run whose tasks did not all complete (cli-and-jsonl.md §5): a verification
 * failure wins, then the first recorded cause (provider/tool → 4, policy → 6, ...); a task without
 * a recorded cause (e.g. cancelled because a dependency failed) counts as a verification failure.
 */
export function failedRunExitCode(causes: readonly (HarnessErrorCode | undefined)[]): ExitCode {
  const recorded = causes.filter((cause): cause is HarnessErrorCode => cause !== undefined);
  const verification = recorded.find((cause) => VERIFICATION_FAILURES.includes(cause));
  return exitCodeFor(verification ?? recorded[0] ?? "verification_failed");
}

function providerErrorCode(error: ProviderFailure): HarnessErrorCode {
  if (error.error.code === "unauthenticated") return "auth_required";
  if (error.error.code === "auth_expired") return "auth_expired";
  return error.error.code === "cancelled" ? "cancelled" : "provider_failed";
}

/** Why planning produced no plan, when the log shows a cause other than an invalid candidate. */
function planningFailure(events: readonly SessionEvent[], runId: RunId): HarnessErrorCode | undefined {
  const mine = events.filter((event) => event.run_id === runId);
  const askCalls = new Set(mine.flatMap((event) => (event.type === "tool/call_proposed" && event.data.tool_name === "ask_user" ? [event.data.tool_call_id] : [])));
  const unanswered = mine.some(
    (event) => event.type === "tool/result_recorded" && askCalls.has(event.data.tool_call_id) && event.data.result.error?.code === "approval_unavailable",
  );
  if (unanswered) return "approval_unavailable";
  for (let index = mine.length - 1; index >= 0; index -= 1) {
    const event = mine[index];
    if (event?.type === "model/response_settled") return undefined;
    if (event?.type === "model/response_failed") return event.data.error.code === "cancelled" ? undefined : "provider_failed";
  }
  return undefined;
}

function observe(store: EventStore, emit: (event: SessionEvent) => void): EventStore {
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

function minDefined(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

function errorCodeOf(error: unknown): HarnessErrorCode {
  if (error instanceof HarnessError) return error.info.code;
  if (error instanceof ProviderFailure) return providerErrorCode(error);
  return "internal";
}

export function createCoordinator(deps: CoordinatorDependencies): Coordinator {
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const limits: CoordinatorLimits = { ...DEFAULT_COORDINATOR_LIMITS, ...deps.limits };
  const listeners = new Set<(event: RenderEvent) => void>();
  const steering: string[] = [];
  let activeRecorder: RunRecorder | undefined;

  const fanOut = (event: RenderEvent): void => {
    for (const listener of listeners) {
      queueMicrotask(() => {
        try {
          listener(event);
        } catch {
          return;
        }
      });
    }
  };
  const notice = (level: "info" | "warning" | "error", message: string): void => fanOut({ kind: "notice", level, message });

  const run = async (request: RunRequest, signal: AbortSignal): Promise<RunOutcome> => {
    const runId: RunId = createId("run");
    const projectId = deriveProjectId(request.workspaceRoot, platform);
    const rawLog =
      request.resumeSessionId !== undefined
        ? await deps.sessions.openForWrite(request.resumeSessionId)
        : await deps.sessions.create({
            session_id: createId("session"),
            project_id: projectId,
            workspace_root: request.workspaceRoot,
            created_at: now().toISOString(),
            title: request.goal.slice(0, 200),
          });
    const log = observe(rawLog, (event) => fanOut({ kind: "session-event", event }));
    const recorder = createRunRecorder(log, deps.blobs, runId);
    activeRecorder = recorder;
    const sources = deps.sources?.(request.workspaceRoot) ?? createWorkspaceSourceReader(request.workspaceRoot);
    let runState: RunState = "created";
    const pendingRecords: Promise<unknown>[] = [];
    const moveRun = async (to: RunState, reason: string): Promise<void> => {
      const check = validateTransition("run", runState, to);
      if (!check.ok) throw new HarnessError({ code: "internal", message: check.message, workspace_effect: "unknown", retry_safe: false });
      await recorder.record("run/state_changed", { from: runState, to, reason });
      runState = to;
    };
    const finish = async (status: RunOutcome["status"], exitCode: ExitCode, summary: string, to: RunState): Promise<RunOutcome> => {
      if (!isTerminalState("run", runState)) await moveRun(to, summary.slice(0, 500));
      deps.budgetGate?.set(undefined);
      if (deps.delegation?.current()?.runId === runId) deps.delegation.set(undefined);
      await Promise.allSettled(pendingRecords);
      activeRecorder = undefined;
      await log.close().catch(() => undefined);
      return { runId, sessionId: log.sessionId, status, exitCode, summary };
    };

    try {
      await recorder.record("run/created", {
        goal: request.goal,
        policy_mode: request.policyMode,
        headless: request.headless,
        budget: {
          ...(request.budget.maxWallTimeSeconds === undefined ? {} : { max_wall_time_seconds: request.budget.maxWallTimeSeconds }),
          ...(request.budget.maxCostUsd === undefined ? {} : { max_cost_usd: request.budget.maxCostUsd }),
        },
      });
      await moveRun("running", "run started");

      const orchestratorPolicy: EffectivePolicy = deps.policy.compute({
        mode: request.policyMode,
        role: "orchestrator",
        runId,
        taskId: undefined,
        workspaceRoot: request.workspaceRoot,
        taskScope: { owned: [".ai/tasks/**"], read: ["**"], forbidden: [] },
        userConfig: deps.userConfig,
        workspaceConfig: deps.workspaceConfig,
        sandbox: deps.sandbox,
        grants: [],
      });
      await recorder.record("policy/snapshot", { policy: orchestratorPolicy, digest: digestOf(orchestratorPolicy) }, { actor: { kind: "policy" } });
      const ledger: ControlPlaneWriter | undefined = deps.ledger
        ? createControlPlaneWriter({ workspaceRoot: request.workspaceRoot, policy: orchestratorPolicy, engine: deps.policy })
        : undefined;
      const orchestratorRoute = await deps.router.resolve({ tier: "orchestrator", role: "orchestrator" }, signal);
      await recorder.record("route/decided", { decision: orchestratorRoute }, { actor: { kind: "system" } });

      const planId = createId("plan");
      let plan: Plan | undefined;
      let planDigestValue: Digest | undefined;
      const feedback: string[] = [];
      for (let attempt = 1; attempt <= limits.maxPlanAttempts && plan === undefined; attempt += 1) {
        if (signal.aborted) return await finish("cancelled", EXIT_CODES.cancelled, "cancelled while planning", "cancelled");
        const candidate = await deps.planner.propose(
          {
            runId,
            planId,
            version: 1,
            goal: request.goal,
            workspaceRoot: request.workspaceRoot,
            mode: request.policyMode,
            createdAt: now().toISOString(),
            feedback: [...feedback, ...steering.splice(0)],
            route: orchestratorRoute.route,
            policy: orchestratorPolicy,
            events: log,
            sessionId: log.sessionId,
          },
          signal,
        );
        const validation = validatePlan(candidate, { runId, planId, version: 1 });
        if (validation.ok) {
          plan = validation.plan;
          planDigestValue = validation.digest;
        } else {
          feedback.splice(0, feedback.length, ...validation.issues);
          notice("warning", `plan candidate ${attempt} rejected: ${validation.issues.slice(0, 5).join("; ")}`);
        }
      }
      if (plan === undefined || planDigestValue === undefined) {
        const cause = planningFailure(await readEvents(log), runId);
        const why =
          cause === "approval_unavailable"
            ? "the orchestrator needed an answer from the user, but ask_user is unavailable in this run"
            : cause === "provider_failed"
              ? "the orchestrator's model request failed"
              : feedback.slice(0, 5).join("; ");
        return await finish("failed", exitCodeFor(cause ?? "verification_failed"), `no valid plan: ${why}`, "failed");
      }
      await recorder.record("plan/proposed", { plan, digest: planDigestValue });

      const recordApproval = async (approval: PlanApprovalOutcome): Promise<void> => {
        await recorder.record("approval/requested", { request: approval.request }, { actor: { kind: "orchestrator", role: "orchestrator" } });
        await recorder.record("approval/decided", { decision: approval.decision }, {
          actor: approval.decision.decided_by === "user" ? { kind: "user" } : approval.decision.decided_by === "orchestrator" ? { kind: "orchestrator", role: "orchestrator" } : { kind: "system" },
        });
      };
      if (request.policyMode === "ask") await moveRun("waiting_for_approval", "plan approval requested");
      const approval = await approvePlan({ plan, digest: planDigestValue, mode: request.policyMode, broker: deps.approvals, now }, signal);
      await recordApproval(approval);
      if (!approval.approved) {
        await recorder.record("plan/state_changed", {
          plan_id: plan.plan_id,
          digest: planDigestValue,
          from: "proposed",
          to: "rejected",
          reason: `plan ${approval.decision.outcome} by ${approval.decision.decided_by}`,
          approval_id: approval.request.approval_id,
        });
        const code: HarnessErrorCode = approval.decision.outcome === "unavailable" ? "approval_unavailable" : "approval_rejected";
        const cancelled = approval.decision.outcome === "cancelled" && signal.aborted;
        return await finish(
          cancelled ? "cancelled" : "rejected",
          cancelled ? EXIT_CODES.cancelled : exitCodeFor(code),
          `plan not approved: ${approval.decision.outcome} (${approval.decision.decided_by})`,
          "cancelled",
        );
      }
      await recorder.record("plan/state_changed", {
        plan_id: plan.plan_id,
        digest: planDigestValue,
        from: "proposed",
        to: "approved",
        reason: `approved by ${approval.decision.decided_by} in ${approval.decision.mode} mode`,
        approval_id: approval.request.approval_id,
      });
      if (request.policyMode === "ask") await moveRun("running", "plan approved");
      if (ledger !== undefined) {
        await ledger.write(`.ai/tasks/${runId}/plan.json`, `${JSON.stringify(plan, null, 2)}\n`).catch((error: unknown) => {
          notice("warning", `ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }

      const budget = createBudgetTracker({
        scope: "run",
        limits: {
          maxCostUsd: minDefined(request.budget.maxCostUsd, plan.budget.max_cost_usd),
          maxWallTimeSeconds: minDefined(request.budget.maxWallTimeSeconds, plan.budget.max_wall_time_seconds),
          maxSteps: plan.budget.max_steps,
          maxToolCalls: undefined,
        },
        onExceeded: (exceeded) => {
          pendingRecords.push(recorder.record("budget/exceeded", exceeded, { actor: { kind: "system" } }).catch(() => undefined));
          notice("warning", `budget ${exceeded.metric} reached (${exceeded.action})`);
        },
      });
      deps.budgetGate?.set(budget);
      const ticker = setInterval(() => budget.check(), deps.budgetTickMs ?? 1000);
      ticker.unref?.();

      const workers = deps.createWorkers(
        { runId, mode: request.policyMode, workspaceRoot: request.workspaceRoot, projectId, recorder },
        budget,
      );
      let approvedPlan: Plan = plan;
      let approvedDigest: Digest = planDigestValue;
      const entries = new Map<string, TaskEntry>();
      const newEntry = (task: PlanTask): TaskEntry => ({
        key: task.key,
        taskId: createId("task"),
        plan: task,
        state: "draft",
        route: undefined,
        attempts: [],
        completion: undefined,
        integrated: [],
        summary: "",
        failure: undefined,
      });
      const createTask = async (entry: TaskEntry): Promise<void> => {
        await recorder.record(
          "task/created",
          {
            task_id: entry.taskId,
            plan_id: approvedPlan.plan_id,
            key: entry.key,
            role: entry.plan.role,
            depends_on: entry.plan.depends_on.map((key) => entries.get(key)?.taskId).filter((id): id is TaskId => id !== undefined),
            owned_paths: entry.plan.owned_paths,
            risk: entry.plan.risk,
          },
          { taskId: entry.taskId },
        );
        entry.route = await deps.router.resolve({ tier: entry.plan.model_tier, role: entry.plan.role }, signal);
      };
      for (const task of plan.tasks) entries.set(task.key, newEntry(task));
      for (const entry of entries.values()) await createTask(entry);

      const move = async (entry: TaskEntry, to: TaskState, reason: string): Promise<void> => {
        const check = validateTransition("task", entry.state, to);
        if (!check.ok) throw new HarnessError({ code: "internal", message: check.message, workspace_effect: "unknown", retry_safe: false });
        await recorder.record("task/state_changed", { task_id: entry.taskId, from: entry.state, to, reason: reason.slice(0, 1000) }, { taskId: entry.taskId });
        entry.state = to;
      };

      const packetSources = async (entry: TaskEntry): Promise<PacketSource[]> => {
        const candidates = new Set<string>();
        for (const pattern of [...entry.plan.owned_paths, ...entry.plan.read_paths]) if (isLiteralPattern(pattern)) candidates.add(pattern);
        for (const dependency of entry.plan.depends_on) for (const path of entries.get(dependency)?.integrated ?? []) candidates.add(path);
        const current = await currentDigests([...candidates], sources);
        return [...current.entries()].flatMap(([path, digest]) => (digest === undefined ? [] : [{ path, digest }]));
      };

      const findings = (entry: TaskEntry): string[] =>
        entry.plan.depends_on.flatMap((key) => {
          const dependency = entries.get(key);
          if (dependency?.completion === undefined) return [];
          return [
            `Finding from ${key}: ${dependency.completion.summary}`.slice(0, 2000),
            ...dependency.completion.recommended_context_updates.map((update) => `Context update from ${key}: ${update}`),
          ];
        });

      /**
       * A blocked route (exhausted quota) is never replaced silently: the router proposes a
       * provider change, the broker asks a human, and only an allowing user decision applies it.
       */
      const changeProvider = async (entry: TaskEntry, failure: RouteBlockedFailure): Promise<boolean> => {
        let proposal;
        try {
          proposal = deps.router.proposeProviderChange(failure, { runId, taskId: entry.taskId });
        } catch {
          return false;
        }
        await recorder.record("approval/requested", { request: proposal.request }, { taskId: entry.taskId, actor: { kind: "orchestrator", role: "orchestrator" } });
        const decision = await deps.approvals.request(proposal.request, signal);
        await recorder.record("approval/decided", { decision }, { taskId: entry.taskId, actor: decision.decided_by === "user" ? { kind: "user" } : { kind: "system" } });
        try {
          deps.router.applyProviderChange(decision);
          return true;
        } catch {
          return false;
        }
      };

      const issueDelta = async (entry: TaskEntry, base: TaskContextPacket, notes: readonly string[], evidence: Parameters<typeof createDeltaPacket>[0]["evidence"]): Promise<TaskContextPacket> => {
        const delta = createDeltaPacket({ base, createdAt: now().toISOString(), notes: notes.slice(0, 20), evidence, newCriteria: [] });
        const blob = await recorder.putJson(delta, PACKET_MEDIA_TYPE);
        await recorder.record("task/packet_issued", { task_id: entry.taskId, kind: "delta", packet_digest: packetDigest(delta), blob }, { taskId: entry.taskId });
        return applyDelta(base, delta);
      };

      const runTask = async (entry: TaskEntry): Promise<TaskResult> => {
        await move(entry, "ready", "plan approved and dependencies completed");
        let packet = compileTaskPacket({
          plan: approvedPlan,
          planDigest: approvedDigest,
          task: entry.plan,
          taskId: entry.taskId,
          createdAt: now().toISOString(),
          sources: await packetSources(entry),
          findings: findings(entry),
          forbiddenPaths: [],
          preferWorktree: deps.preferWorktree ?? true,
        });
        let retries = 0;
        let revisions = 0;
        let repackages = 0;
        let seed: Uint8Array | undefined;
        for (;;) {
          if (signal.aborted) {
            await move(entry, "cancelled", "run cancelled");
            return "failed";
          }
          const admission = budget.exhausted();
          if (!admission.ok) {
            budget.admit();
            await move(entry, "cancelled", `budget ${admission.metric} exhausted`);
            return "failed";
          }
          let handle;
          try {
            if (entry.attempts.length > 0) entry.route = await deps.router.resolve({ tier: entry.plan.model_tier, role: entry.plan.role }, signal);
            handle = await workers.dispatch(packet, signal, {
              ...(entry.route === undefined ? {} : { route: entry.route }),
              ...(seed === undefined ? {} : { seedArtifact: seed }),
            });
          } catch (error) {
            if (errorCodeOf(error) === "stale_packet" && repackages < limits.maxRepackages) {
              repackages += 1;
              packet = refreshPacketSources(packet, await currentDigests(packet.context.sources.map((source) => source.path), sources), now().toISOString());
              continue;
            }
            if (error instanceof RouteBlockedFailure && (await changeProvider(entry, error))) {
              entry.route = await deps.router.resolve({ tier: entry.plan.model_tier, role: entry.plan.role }, signal);
              continue;
            }
            entry.failure = error instanceof RouteBlockedFailure ? "provider_failed" : error instanceof HarnessError || error instanceof ProviderFailure ? errorCodeOf(error) : entry.failure;
            await move(entry, "blocked", `dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
            return "failed";
          }
          entry.attempts.push(handle.attemptId);
          await move(entry, "running", `attempt ${handle.attemptId} dispatched`);
          const completion = await handle.completion;
          entry.completion = completion;
          entry.summary = completion.summary;
          entry.failure = workers.attempt(handle.attemptId)?.failure;
          seed = undefined;

          const retry = async (reason: string, notes: readonly string[]): Promise<boolean> => {
            if (retries >= limits.maxRetries) return false;
            retries += 1;
            await workers.revert(handle.attemptId, signal);
            await workers.dispose(handle.attemptId);
            await move(entry, "retry_pending", reason);
            packet = await issueDelta(entry, packet, notes, []);
            await move(entry, "ready", `retry ${retries} with a new attempt`);
            return true;
          };

          if (completion.status === "needs_context") {
            await move(entry, "needs_context", completion.summary);
            if (repackages >= limits.maxRepackages) {
              entry.failure = "stale_packet";
              await move(entry, "cancelled", "context could not be refreshed within the repackage limit");
              return "failed";
            }
            repackages += 1;
            await workers.revert(handle.attemptId, signal);
            await workers.dispose(handle.attemptId);
            packet = refreshPacketSources(packet, await currentDigests(packet.context.sources.map((source) => source.path), sources), now().toISOString());
            await move(entry, "ready", "re-packaged with fresh sources");
            continue;
          }
          if (completion.status === "blocked") {
            await move(entry, "blocked", completion.summary);
            return "failed";
          }
          if (completion.status !== "completed") {
            await move(entry, "failed", `attempt ${completion.status}: ${completion.summary}`);
            if (await retry("retrying after a failed attempt", [`Previous attempt ${completion.status}: ${completion.summary}`])) continue;
            return "failed";
          }

          await move(entry, "verifying", "completion received");
          const verification = await workers.verify(handle.attemptId);
          if (verification.decision !== "pass") {
            entry.failure = "verification_failed";
            await move(entry, "failed", `verification ${verification.decision}: ${verification.problems.slice(0, 5).join("; ")}`);
            if (await retry("retrying after failed verification", verification.problems)) continue;
            return "failed";
          }
          const record = workers.attempt(handle.attemptId);
          const artifact = record?.changeSet;
          if (!reviewRequired(packet)) {
            if (artifact !== undefined && artifact.changes.length > 0) {
              try {
                await workers.integrate(handle.attemptId, artifact.artifactDigest, signal);
                entry.integrated = artifact.changes.map((change) => change.path);
              } catch (error) {
                await move(entry, "failed", `integration failed: ${error instanceof Error ? error.message : String(error)}`);
                return "failed";
              }
            }
            await move(entry, "completed", "verified; trivial risk needs no review");
            return "completed";
          }

          await move(entry, "reviewing", "independent review required");
          if (artifact === undefined) {
            await move(entry, "failed", "no pinned artifact to review");
            return "failed";
          }
          const reviewerTask = approvedPlan.tasks.find((task) => task.role === "reviewer" && task.depends_on.includes(entry.key));
          let outcome: "accept" | "revise" | "block" | "invalid" = "invalid";
          let problems: readonly string[] = [];
          let findingsEvidence: Parameters<typeof createDeltaPacket>[0]["evidence"] = [];
          for (let review = 1; review <= limits.maxReviewAttempts; review += 1) {
            const reviewerPacket = compileReviewerPacket({
              implementation: packet,
              artifactDigest: artifact.artifactDigest,
              createdAt: now().toISOString(),
              reviewerTier: reviewerTask?.model_tier,
              extraCriteria: [],
            });
            const reviewerRoute = await deps.router.resolve({ tier: reviewerPacket.model_tier, role: "reviewer" }, signal);
            const reviewHandle = await workers.dispatchReview(reviewerPacket, handle.attemptId, signal, { route: reviewerRoute });
            entry.attempts.push(reviewHandle.attemptId);
            const result = await reviewHandle.result;
            outcome = result.verification.decision;
            problems = result.verification.problems;
            findingsEvidence = (result.review?.findings ?? []).map((finding) => ({ kind: "review" as const, ref: `review:${finding.id}`, produced_by: "reviewer" as const }));
            if (outcome !== "invalid") {
              if (result.review !== undefined) {
                problems = [...problems, ...result.review.findings.map((finding) => `${finding.id} (${finding.severity}): ${finding.summary}`)];
              }
              break;
            }
            notice("warning", `review ${review} of ${entry.key} is invalid: ${problems.slice(0, 3).join("; ")}`);
          }
          if (outcome === "accept" && mayComplete(packet, { decision: outcome, problems })) {
            try {
              await workers.integrate(handle.attemptId, artifact.artifactDigest, signal);
              entry.integrated = artifact.changes.map((change) => change.path);
            } catch (error) {
              await move(entry, "failed", `integration failed: ${error instanceof Error ? error.message : String(error)}`);
              return "failed";
            }
            await move(entry, "completed", "review accepted and artifact integrated");
            return "completed";
          }
          if (outcome === "revise") {
            await move(entry, "changes_requested", problems.slice(0, 5).join("; ") || "review requested changes");
            if (revisions >= limits.maxRevisions) {
              entry.failure = "verification_failed";
              await move(entry, "cancelled", "revision limit reached");
              return "failed";
            }
            revisions += 1;
            seed = artifact.artifactBytes;
            await workers.revert(handle.attemptId, signal);
            await workers.dispose(handle.attemptId);
            packet = await issueDelta(entry, packet, problems.length > 0 ? problems : ["address the review findings"], findingsEvidence);
            await move(entry, "ready", `revision ${revisions} requested by review`);
            continue;
          }
          entry.failure = outcome === "block" ? "review_blocked" : "verification_failed";
          await move(entry, "failed", outcome === "block" ? `review blocked: ${problems.join("; ")}` : `no valid review: ${problems.slice(0, 5).join("; ")}`);
          return "failed";
        }
      };

      const scheduler: DagScheduler = createDagScheduler(
        [...entries.values()].map((entry) => ({
          key: entry.key,
          dependsOn: entry.plan.depends_on,
          ownedPaths: entry.plan.owned_paths,
          provider: entry.route?.route.provider_id,
          workspace: request.workspaceRoot,
        })),
        limits.concurrency,
      );
      const taskLine = (entry: TaskEntry): string =>
        `${entry.key} ${entry.taskId} (${entry.plan.role}, ${entry.plan.risk}, owns ${entry.plan.owned_paths.join(", ") || "nothing"}): ${entry.state}${entry.summary === "" ? "" : ` - ${entry.summary.slice(0, 300)}`}`;
      const revisionCandidate = (planId: Plan["plan_id"], extra: readonly PlanTask[], notes: readonly string[]): Record<string, unknown> => ({
        ...approvedPlan,
        plan_id: planId,
        version: approvedPlan.version + 1,
        tasks: [...approvedPlan.tasks, ...extra],
        assumptions: [...approvedPlan.assumptions, ...notes.map((note) => `User steering: ${note}`)],
        created_at: now().toISOString(),
      });
      const spawned: PlanTask[] = [];
      let consulting = false;
      const deny = (code: Extract<DelegationResult, { ok: false }>["code"], message: string): DelegationResult => ({ ok: false, code, message });
      deps.delegation?.set({
        runId,
        spawn(raw, caller) {
          if (caller.role !== "orchestrator" || caller.runId !== runId) return deny("policy_denied", "only the orchestrator of this run delegates tasks");
          if (!consulting) return deny("execution_failed", "task_spawn is accepted while the orchestrator is consulted at a safe boundary (after user steering)");
          if (spawned.length >= limits.maxSpawnedTasks) return deny("policy_denied", `at most ${limits.maxSpawnedTasks} follow-up task(s) may be spawned per run`);
          const admission = budget.exhausted();
          if (!admission.ok) return deny("policy_denied", `the run budget is exhausted (${admission.metric} ${admission.used} of ${admission.limit}); no task can be added`);
          const parsed = planTaskSchema.safeParse(raw);
          if (!parsed.success) return deny("invalid_arguments", parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "));
          if (entries.has(parsed.data.key) || spawned.some((task) => task.key === parsed.data.key)) return deny("invalid_arguments", `task key ${parsed.data.key} already exists`);
          const probeId = createId("plan");
          const validation = validatePlan(revisionCandidate(probeId, [...spawned, parsed.data], []), { runId, planId: probeId, version: approvedPlan.version + 1 });
          if (!validation.ok) return deny("invalid_arguments", `the task does not fit the plan: ${validation.issues.slice(0, 5).join("; ")}`);
          spawned.push(parsed.data);
          return { ok: true, text: `task ${parsed.data.key} accepted for plan v${approvedPlan.version + 1}; it runs only after the revised plan is approved` };
        },
        status(task) {
          const selected = [...entries.values()].filter((entry) => task === undefined || entry.taskId === task || entry.key === task);
          if (selected.length === 0) return deny("invalid_arguments", `unknown task ${task ?? ""}`);
          return { ok: true, text: [`plan ${approvedPlan.plan_id} v${approvedPlan.version}`, ...selected.map(taskLine)].join("\n") };
        },
      });

      /**
       * Applies queued user steering at a safe boundary (no dispatch in flight for the affected
       * tasks): the orchestrator is consulted once, then the plan is re-versioned with the steering
       * (and any spawned follow-up tasks) and re-approved under the run's policy mode. Only an
       * approved revision supersedes the running plan; tasks that have not started get its packets.
       */
      const revise = async (): Promise<void> => {
        const notes = steering.splice(0);
        if (notes.length === 0) return;
        if (deps.planner.consult !== undefined) {
          consulting = true;
          try {
            await deps.planner.consult(
              {
                runId,
                goal: request.goal,
                planVersion: approvedPlan.version,
                steering: notes,
                tasks: [...entries.values()].map(taskLine),
                route: orchestratorRoute.route,
                policy: orchestratorPolicy,
                events: log,
                sessionId: log.sessionId,
              },
              signal,
            );
          } catch (error) {
            notice("warning", `orchestrator consultation failed: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            consulting = false;
          }
        }
        const extra = spawned.splice(0);
        const pending = [...entries.values()].some((entry) => scheduler.state(entry.key) === "pending");
        if (!pending && extra.length === 0) {
          notice("info", `steering noted, but no task is left to apply it to: ${notes.join("; ")}`.slice(0, 500));
          return;
        }
        const revisionId = createId("plan");
        const validation = validatePlan(revisionCandidate(revisionId, extra, notes), { runId, planId: revisionId, version: approvedPlan.version + 1 });
        if (!validation.ok) {
          notice("warning", `plan revision invalid; the run continues with v${approvedPlan.version}: ${validation.issues.slice(0, 5).join("; ")}`);
          return;
        }
        await recorder.record("plan/proposed", { plan: validation.plan, digest: validation.digest });
        if (request.policyMode === "ask") await moveRun("waiting_for_approval", `revised plan v${validation.plan.version} approval requested`);
        const decision = await approvePlan({ plan: validation.plan, digest: validation.digest, mode: request.policyMode, broker: deps.approvals, now }, signal);
        await recordApproval(decision);
        if (request.policyMode === "ask") {
          await moveRun("running", decision.approved ? `revised plan v${validation.plan.version} approved` : `revised plan not approved; continuing with v${approvedPlan.version}`);
        }
        if (!decision.approved) {
          await recorder.record("plan/state_changed", {
            plan_id: validation.plan.plan_id,
            digest: validation.digest,
            from: "proposed",
            to: "rejected",
            reason: `revision ${decision.decision.outcome} by ${decision.decision.decided_by}`,
            approval_id: decision.request.approval_id,
          });
          notice("warning", `revised plan v${validation.plan.version} was not approved; the run continues with v${approvedPlan.version}`);
          return;
        }
        await recorder.record("plan/state_changed", {
          plan_id: approvedPlan.plan_id,
          digest: approvedDigest,
          from: "approved",
          to: "superseded",
          reason: `superseded by ${validation.plan.plan_id} v${validation.plan.version} after user steering`,
        });
        await recorder.record("plan/state_changed", {
          plan_id: validation.plan.plan_id,
          digest: validation.digest,
          from: "proposed",
          to: "approved",
          reason: `revision approved by ${decision.decision.decided_by} in ${decision.decision.mode} mode`,
          approval_id: decision.request.approval_id,
        });
        approvedPlan = validation.plan;
        approvedDigest = validation.digest;
        for (const task of extra) {
          const entry = newEntry(task);
          entries.set(task.key, entry);
          await createTask(entry);
          scheduler.add({ key: task.key, dependsOn: task.depends_on, ownedPaths: task.owned_paths, provider: entry.route?.route.provider_id, workspace: request.workspaceRoot });
        }
      };

      const inflight = new Map<string, Promise<void>>();
      let budgetStop = false;
      try {
        for (;;) {
          while (!scheduler.done()) {
            if (signal.aborted) break;
            if (!budget.exhausted().ok) {
              budget.admit();
              budgetStop = true;
              break;
            }
            if (steering.length > 0) await revise();
            for (const key of scheduler.startable()) {
              const entry = entries.get(key);
              if (entry === undefined) continue;
              scheduler.start(key);
              const task = runTask(entry)
                .catch(async (error: unknown): Promise<TaskResult> => {
                  const reason = `task error: ${error instanceof Error ? error.message : String(error)}`;
                  for (const to of ["failed", "cancelled"] as const) {
                    if (validateTransition("task", entry.state, to).ok) {
                      await move(entry, to, reason).catch(() => undefined);
                      break;
                    }
                  }
                  return "failed";
                })
                .then(async (result) => {
                  if (result === "failed") {
                    for (const attemptId of [...entry.attempts].reverse()) await workers.revert(attemptId, signal).catch(() => undefined);
                  }
                  for (const attemptId of entry.attempts) await workers.dispose(attemptId).catch(() => undefined);
                  scheduler.finish(key, result);
                })
                .finally(() => inflight.delete(key));
              inflight.set(key, task);
            }
            if (inflight.size === 0) break;
            await Promise.race(inflight.values());
          }
          if (signal.aborted || budgetStop || steering.length === 0) break;
          await revise();
          if (scheduler.done()) break;
        }
        for (const handle of workers.running()) if (signal.aborted) handle.cancel("run cancelled");
        await Promise.allSettled(inflight.values());
      } finally {
        clearInterval(ticker);
      }
      for (const key of scheduler.skipPending()) {
        const entry = entries.get(key);
        if (entry !== undefined && !isTerminalState("task", entry.state)) {
          await move(entry, "cancelled", signal.aborted ? "run cancelled" : budgetStop ? "budget exhausted" : "a dependency did not complete");
        }
      }

      const lines = [...entries.values()].map((entry) => {
        const files = entry.integrated.length > 0 ? ` [integrated: ${entry.integrated.join(", ")}]` : "";
        return `${entry.key} (${entry.plan.role}): ${entry.state}${files}`;
      });
      const allCompleted = [...entries.values()].every((entry) => entry.state === "completed");
      const report = [`Run ${runId}: ${request.goal}`, ...lines].join("\n");
      if (ledger !== undefined) {
        await ledger.write(`.ai/tasks/${runId}/report.md`, `# Run report\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`).catch((error: unknown) => {
          notice("warning", `ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      if (signal.aborted) return await finish("cancelled", EXIT_CODES.cancelled, report, "cancelled");
      if (budgetStop || (!allCompleted && !budget.exhausted().ok)) return await finish("failed", EXIT_CODES.budget, report, "failed");
      if (!allCompleted) {
        const causes = [...entries.values()].filter((entry) => entry.state !== "completed").map((entry) => entry.failure);
        return await finish("failed", failedRunExitCode(causes), report, "failed");
      }
      return await finish("succeeded", EXIT_CODES.success, report, "completed");
    } catch (error) {
      const code = errorCodeOf(error);
      const message = error instanceof Error ? error.message : String(error);
      notice("error", message);
      if (signal.aborted) return await finish("cancelled", EXIT_CODES.cancelled, `cancelled: ${message}`, "cancelled").catch(() => ({ runId, sessionId: log.sessionId, status: "cancelled" as const, exitCode: EXIT_CODES.cancelled, summary: message }));
      return await finish("failed", exitCodeFor(code), message, "failed").catch(() => ({ runId, sessionId: log.sessionId, status: "failed" as const, exitCode: exitCodeFor(code), summary: message }));
    }
  };

  return {
    run,
    steer(text) {
      const trimmed = text.trim();
      if (trimmed === "") return;
      steering.push(trimmed);
      void activeRecorder?.record("steer/queued", { text: trimmed }, { actor: { kind: "user" } }).catch(() => undefined);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
