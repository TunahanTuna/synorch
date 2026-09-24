/** I1 — fixed agent loop (AgentDriver), turn/step lifecycle, recovery projection. */
export type {
  AgentDriver,
  AgentDriverDependencies,
  CredentialResolver,
  ProjectedApproval,
  ProjectedEntity,
  ProjectedMessage,
  ProjectedRun,
  ProjectedStep,
  ProjectedToolCall,
  ProjectedTurn,
  ProjectionIssue,
  ProjectionIssueCode,
  RecoveredEntity,
  RecoveryReport,
  SessionProjection,
  TurnInput,
  TurnOutcome,
} from "../contracts/index.ts";
export { BRIDGE_TOOL_PREFIX, createAgentDriver, isPausableDriver, type AgentDriverOptions, type PausableAgentDriver } from "./driver.ts";
export { loadRecordedMessage, putCanonicalJson, rebuildModelRequest } from "./envelope.ts";
export { projectSession, SessionProjector } from "./projection.ts";
export { recoverSession, type RecoveryOptions } from "./recovery.ts";
