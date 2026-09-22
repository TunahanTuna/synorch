import {
  ALLOWING_OUTCOMES,
  approvalDecisionSchema,
  createId,
  HUMAN_ONLY_APPROVAL_SUBJECTS,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type Digest,
  type Plan,
  type PolicyMode,
} from "../contracts/index.ts";

/**
 * The plan gate (ADR-08). In `autonomous` mode the orchestrator approves its own plan and the
 * decision is recorded like any other (`decided_by: orchestrator`, audited). In `ask` mode the
 * broker asks the user; a headless broker answers `unavailable` and the plan does not run.
 * Provider changes and budget increases are never orchestrator-approvable in any mode.
 */

export interface PlanApprovalInput {
  readonly plan: Plan;
  readonly digest: Digest;
  readonly mode: PolicyMode;
  readonly broker: ApprovalBroker;
  readonly now: () => Date;
}

export interface PlanApprovalOutcome {
  readonly request: ApprovalRequest;
  readonly decision: ApprovalDecision;
  readonly approved: boolean;
}

export function isHumanOnlySubject(subject: ApprovalRequest["subject_kind"]): boolean {
  return (HUMAN_ONLY_APPROVAL_SUBJECTS as readonly string[]).includes(subject);
}

export function isAllowing(decision: ApprovalDecision): boolean {
  return (ALLOWING_OUTCOMES as readonly string[]).includes(decision.outcome);
}

export function summarizePlan(plan: Plan): string {
  const roles = new Map<string, number>();
  for (const task of plan.tasks) roles.set(task.role, (roles.get(task.role) ?? 0) + 1);
  const counts = [...roles.entries()].map(([role, count]) => `${count} ${role}`).join(", ");
  return `Plan v${plan.version}: ${plan.goal} (${counts}; risk ${plan.risk})`.slice(0, 2000);
}

/**
 * A decision counts only if it is schema-valid and answers this exact request; anything else —
 * including a user-shaped decision for another digest — is treated as a refusal.
 */
export function decisionAnswers(request: ApprovalRequest, decision: ApprovalDecision, mode: PolicyMode): boolean {
  if (!approvalDecisionSchema.safeParse(decision).success) return false;
  if (decision.approval_id !== request.approval_id) return false;
  if (decision.subject_kind !== request.subject_kind || decision.subject_digest !== request.subject_digest) return false;
  if (decision.mode !== mode) return false;
  if (isHumanOnlySubject(request.subject_kind) && decision.decided_by !== "user" && isAllowing(decision)) return false;
  return true;
}

export async function approvePlan(input: PlanApprovalInput, signal: AbortSignal): Promise<PlanApprovalOutcome> {
  const request: ApprovalRequest = {
    approval_id: createId("approval"),
    run_id: input.plan.run_id,
    subject_kind: "plan",
    subject_digest: input.digest,
    summary: summarizePlan(input.plan),
    scope: "plan",
    requested_at: input.now().toISOString(),
  };
  if (input.mode === "autonomous") {
    const decision = approvalDecisionSchema.parse({
      approval_id: request.approval_id,
      subject_kind: "plan",
      subject_digest: input.digest,
      outcome: "allowed-for-scope",
      decided_by: "orchestrator",
      mode: "autonomous",
      decided_at: input.now().toISOString(),
      reason: "autonomous mode: the plan passed schema validation and stays inside the hard rails",
    });
    return { request, decision, approved: true };
  }
  let decision: ApprovalDecision;
  try {
    decision = await input.broker.request(request, signal);
  } catch (error) {
    decision = {
      approval_id: request.approval_id,
      subject_kind: "plan",
      subject_digest: input.digest,
      outcome: signal.aborted ? "cancelled" : "unavailable",
      decided_by: "broker",
      mode: input.mode,
      decided_at: input.now().toISOString(),
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    };
  }
  if (!decisionAnswers(request, decision, input.mode)) {
    const refused = approvalDecisionSchema.parse({
      approval_id: request.approval_id,
      subject_kind: "plan",
      subject_digest: input.digest,
      outcome: "cancelled",
      decided_by: "broker",
      mode: input.mode,
      decided_at: input.now().toISOString(),
      reason: "the broker returned a decision that does not answer this plan request",
    });
    return { request, decision: refused, approved: false };
  }
  return { request, decision, approved: isAllowing(decision) };
}
