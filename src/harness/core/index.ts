/** I1 — fixed agent loop (AgentDriver), turn/step lifecycle, recovery projection. */
export type { AgentDriver, AgentDriverDependencies, TurnInput, TurnOutcome } from "../contracts/index.ts";
export { BRIDGE_TOOL_PREFIX, createAgentDriver, type AgentDriverOptions, type CredentialResolver } from "./driver.ts";
export { loadRecordedMessage, putCanonicalJson, rebuildModelRequest } from "./envelope.ts";
export {
  projectSession,
  SessionProjector,
  type ProjectedApproval,
  type ProjectedEntity,
  type ProjectedMessage,
  type ProjectedRun,
  type ProjectedStep,
  type ProjectedToolCall,
  type ProjectedTurn,
  type ProjectionIssue,
  type ProjectionIssueCode,
  type SessionProjection,
} from "./projection.ts";
export { recoverSession, type RecoveredEntity, type RecoveryOptions, type RecoveryReport } from "./recovery.ts";
