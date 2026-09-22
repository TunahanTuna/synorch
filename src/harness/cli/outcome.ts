import { HarnessError, ProviderFailure, type ApprovalDecision, type HarnessErrorInfo } from "../contracts/index.ts";

/**
 * Maps whatever ended a runtime command to the user-facing error standard and, through
 * `exitCodeFor`, to exactly one exit code. An aborted operation is a user cancellation (130), a
 * refused approval is exit 3; anything unknown is `internal` and never claims a retry is safe.
 */

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as { code?: unknown }).code === "ABORT_ERR");
}

export function failureInfo(error: unknown): HarnessErrorInfo {
  if (error instanceof HarnessError) return error.info;
  if (isAbortError(error)) {
    return { code: "cancelled", message: "cancelled by the user", workspace_effect: "unknown", retry_safe: false };
  }
  if (error instanceof ProviderFailure) {
    const auth = error.error.code === "unauthenticated" || error.error.code === "auth_expired";
    return {
      code: auth ? (error.error.code === "auth_expired" ? "auth_expired" : "auth_required") : "provider_failed",
      message: error.error.message,
      workspace_effect: "none",
      retry_safe: error.error.retryable,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "internal", message: message.length > 0 ? message.slice(0, 2000) : "unexpected failure", workspace_effect: "unknown", retry_safe: false };
}

/** A broker refusal becomes the approval error the headless contract requires (ADR-15). */
export function approvalFailure(decision: ApprovalDecision): HarnessErrorInfo | undefined {
  switch (decision.outcome) {
    case "allowed-once":
    case "allowed-for-scope":
      return undefined;
    case "cancelled":
      return { code: "cancelled", message: `the ${decision.subject_kind} approval was cancelled`, ids: { approval_id: decision.approval_id }, workspace_effect: "none", retry_safe: true };
    case "rejected":
      return { code: "approval_rejected", message: `the ${decision.subject_kind} approval was rejected`, ids: { approval_id: decision.approval_id }, workspace_effect: "none", retry_safe: true };
    case "unavailable":
    case "expired":
      return {
        code: "approval_unavailable",
        message:
          decision.outcome === "expired"
            ? `the ${decision.subject_kind} approval expired without an answer`
            : `${decision.subject_kind} requires a human decision; this run cannot ask`,
        ids: { approval_id: decision.approval_id },
        workspace_effect: "none",
        retry_safe: true,
        next_command: "syn run --policy ask ... in an interactive terminal",
      };
  }
}
