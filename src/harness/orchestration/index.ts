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
  type AdmitOptions,
  type BudgetAdmission,
  type BudgetExceeded,
  type BudgetGateSlot,
  type BudgetLimits,
  type BudgetTracker,
  type UsageObservation,
} from "./budget.ts";
export { buildAttemptLog, latestReport, type AttemptLog, type RecordedReportCall, type RecordedToolCall } from "./attempt-log.ts";
export { commandMentioned, roleCapabilityIssues } from "./capabilities.ts";
export { extractJsonBlock, parseClaim, readClaim, reviewerClaimSchema, workerClaimSchema } from "./claims.ts";
export { createControlPlaneWriter, type ControlPlaneWriter } from "./control-plane.ts";
export {
  createCoordinator,
  criterionEvidence,
  DEFAULT_COORDINATOR_LIMITS,
  failedRunExitCode,
  resolveBudgets,
  retryNotes,
  scopeLimitedReview,
  type CoordinatorDependencies,
  type CoordinatorLimits,
  type WorkerFactory,
} from "./coordinator.ts";
export {
  createDelegationSlot,
  createReportSlot,
  delegationCallbacks,
  REPORT_RECORDED,
  reportCallbacks,
  type ReportCheck,
  type ReportSlot,
  type DelegationCaller,
  type DelegationPort,
  type DelegationResult,
  type DelegationSlot,
  type TriageDecision,
} from "./delegation.ts";
export {
  commandArgv,
  commandsFromLog,
  evidenceCandidates,
  firstPathToken,
  harnessCanSubstitute,
  isPlanCausedVerification,
  INDEPENDENT_EVIDENCE_HINT,
  isIndependentReviewEvidence,
  mayComplete,
  provingVerification,
  resolveCompletionEvidence,
  resolveEvidence,
  resolvePointer,
  reviewRequired,
  verifyCompletion,
  verifyReview,
  type CompletionEvidence,
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
  DEFAULT_STEP_FLOORS,
  MIN_REVIEWER_STEPS,
  MIN_TASK_STEPS,
  isIntegrationReview,
  perTaskStepLimit,
  placeCrossTaskCriteria,
  WORKSPACE_READ_EXCLUSIONS,
  workspaceReadScope,
  refreshPacketSources,
  reviewerStepLimit,
  runStepLimit,
  validatePlan,
  type PlanValidation,
  type StepFloors,
} from "./plan.ts";
export {
  createModelPlanner,
  renderConsultPrompt,
  renderPlanningPrompt,
  renderTriagePrompt,
  type ConsultInput,
  type Planner,
  type PlannerInput,
  type TriageInput,
} from "./planner.ts";
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
  classifyAttemptFailure,
  DEFAULT_FINISH_WARNING,
  renderFinishNowMessage,
  renderReportOnlyMessage,
  createWorkerManager,
  renderRepairMessage,
  renderIntegrationReviewBrief,
  renderReviewBrief,
  type IntegratedDependency,
  type IntegrationReviewHandle,
  type IntegrationReviewOutcome,
  type AttemptFailure,
  renderWorkerMessage,
  type AttemptRecord,
  type VerificationRequest,
  type VerificationResult,
  type VerificationRunner,
  type WorkerDispatchOptions,
  type OrchestrationWorkerManager,
  type RunScope,
  type WorkerManagerDependencies,
} from "./worker-manager.ts";
export { formatVerificationRefusal, preflightVerification, type VerificationPreflight, type VerificationPreflightContext, type VerificationRefusal } from "./verification-preflight.ts";
export { contentIdentities, contentIdentity, createWorkspaceDigestReader, resolveOnDiskPath, type ContentIdentityOptions, type WorkspaceDigestOptions } from "./workspace-digest.ts";
