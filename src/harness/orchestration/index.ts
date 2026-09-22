/** I4 — coordinator, plan/DAG scheduler, WorkerManager, IsolationProvider, review gate. */
export type { Coordinator, IsolationProvider, WorkerManager } from "../contracts/index.ts";
export { approvePlan, decisionAnswers, isAllowing, isHumanOnlySubject, summarizePlan, type PlanApprovalOutcome } from "./approval.ts";
export {
  BUDGET_METRICS,
  CANCEL_THRESHOLD,
  createBudgetGateSlot,
  createBudgetTracker,
  isHumanBudgetGrant,
  requestBudgetIncrease,
  type BudgetAdmission,
  type BudgetExceeded,
  type BudgetGateSlot,
  type BudgetLimits,
  type BudgetTracker,
  type UsageObservation,
} from "./budget.ts";
export { latestReport, type AttemptLog, type RecordedReportCall } from "./attempt-log.ts";
export { extractJsonBlock, parseClaim, readClaim, reviewerClaimSchema, workerClaimSchema } from "./claims.ts";
export { createControlPlaneWriter, type ControlPlaneWriter } from "./control-plane.ts";
export {
  createCoordinator,
  DEFAULT_COORDINATOR_LIMITS,
  type CoordinatorDependencies,
  type CoordinatorLimits,
  type WorkerFactory,
} from "./coordinator.ts";
export {
  mayComplete,
  resolveEvidence,
  reviewRequired,
  verifyCompletion,
  verifyReview,
  type CompletionVerification,
  type EvidenceIndex,
  type ReviewVerification,
} from "./evidence.ts";
export { createWorkerFactory, type SharedWorkerDependencies } from "./factories.ts";
export { runGit, type GitRunner } from "./git.ts";
export {
  ARTIFACT_FORMAT,
  createIsolationProvider,
  decodeArtifact,
  isAttemptOwnerLive,
  pruneOrphanedAttempts,
  resolveLinkSafeTarget,
  SCOPED_SNAPSHOT_LIMITS,
  type AttemptOwner,
  type ChangeSet,
  type PruneOrphansOptions,
  type PruneReport,
  type IsolationProviderDependencies,
  type OrchestratedWorkspace,
  type OrchestrationIsolationProvider,
} from "./isolation.ts";
export { findScopeViolations, isControlPlanePath, matchesAny, matchesPattern } from "./paths.ts";
export {
  applyDelta,
  compileReviewerPacket,
  compileTaskPacket,
  createDeltaPacket,
  refreshPacketSources,
  validatePlan,
  type PlanValidation,
} from "./plan.ts";
export { createModelPlanner, renderPlanningPrompt, type Planner, type PlannerInput } from "./planner.ts";
export { createWorkspaceSourceReader, type SourceDigestReader } from "./recorder.ts";
export {
  createDagScheduler,
  DEFAULT_CONCURRENCY,
  findDependencyCycle,
  SchedulerError,
  type ConcurrencyLimits,
  type DagScheduler,
  type SchedulableTask,
} from "./scheduler.ts";
export {
  createWorkerManager,
  renderReviewBrief,
  renderWorkerMessage,
  type OrchestrationWorkerManager,
  type RunScope,
  type WorkerManagerDependencies,
} from "./worker-manager.ts";
