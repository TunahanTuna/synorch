import {
  approvalDecisionSchema,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type PolicyMode,
} from "../contracts/index.ts";

export interface HeadlessApprovalBrokerOptions {
  /** The run's policy mode, recorded on every refusal. Defaults to `ask`, the only mode that prompts per action. */
  readonly mode?: PolicyMode;
  readonly now?: () => Date;
}

/**
 * The broker for runs without a human (ADR-15). It can only refuse: every request is answered
 * `unavailable` (or `cancelled` once the run is aborted), so the action never executes and the
 * run ends with the approval exit code.
 */
export function createHeadlessApprovalBroker(options: HeadlessApprovalBrokerOptions = {}): ApprovalBroker {
  const mode = options.mode ?? "ask";
  const now = options.now ?? (() => new Date());
  return {
    availability: "headless",
    async request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
      return approvalDecisionSchema.parse({
        approval_id: request.approval_id,
        subject_kind: request.subject_kind,
        subject_digest: request.subject_digest,
        outcome: signal.aborted ? "cancelled" : "unavailable",
        decided_by: "broker",
        mode,
        decided_at: now().toISOString(),
        reason: signal.aborted ? "run cancelled" : "headless run: no human can answer",
      });
    },
  };
}
