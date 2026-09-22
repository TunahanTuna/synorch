import { z } from "zod";

/**
 * Harness error taxonomy and process exit codes. Codes 0-2 keep the meaning they already have for
 * `syn inspect/init/sync/doctor` (success, error, usage); the rest are new and exclusive to runtime
 * commands. The mapping is total: every harness error code has exactly one exit code.
 */

export const EXIT_CODES = {
  success: 0,
  internal: 1,
  usage: 2,
  approval: 3,
  provider: 4,
  verification: 5,
  policy: 6,
  auth: 7,
  session_locked: 8,
  budget: 9,
  cancelled: 130,
} as const;
export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

export const HARNESS_ERROR_CODES = [
  "usage_invalid",
  "config_invalid",
  "auth_required",
  "auth_expired",
  "provider_failed",
  "tool_failed",
  "policy_denied",
  "sandbox_insufficient",
  "approval_rejected",
  "approval_unavailable",
  "verification_failed",
  "review_blocked",
  "budget_exceeded",
  "session_locked",
  "session_corrupt",
  "store_write_failed",
  "stale_packet",
  "cancelled",
  "internal",
] as const;
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

export const HARNESS_ERROR_EXIT: { readonly [C in HarnessErrorCode]: ExitCodeName } = {
  usage_invalid: "usage",
  config_invalid: "usage",
  auth_required: "auth",
  auth_expired: "auth",
  provider_failed: "provider",
  tool_failed: "provider",
  policy_denied: "policy",
  sandbox_insufficient: "policy",
  approval_rejected: "approval",
  approval_unavailable: "approval",
  verification_failed: "verification",
  review_blocked: "verification",
  budget_exceeded: "budget",
  session_locked: "session_locked",
  session_corrupt: "internal",
  store_write_failed: "internal",
  stale_packet: "verification",
  cancelled: "cancelled",
  internal: "internal",
};

export function exitCodeFor(code: HarnessErrorCode): ExitCode {
  return EXIT_CODES[HARNESS_ERROR_EXIT[code]];
}

/**
 * The user-facing error standard: what happened, which step/id, the workspace effect, whether a
 * retry is safe and the next command. Secrets and raw prompts never appear in any field.
 */
export const harnessErrorSchema = z.strictObject({
  code: z.enum(HARNESS_ERROR_CODES),
  message: z.string().min(1).max(2000),
  ids: z.record(z.string(), z.string()).optional(),
  workspace_effect: z.enum(["none", "partial", "unknown"]),
  retry_safe: z.boolean(),
  next_command: z.string().min(1).max(500).optional(),
});
export type HarnessErrorInfo = z.infer<typeof harnessErrorSchema>;

export class HarnessError extends Error {
  public readonly info: HarnessErrorInfo;
  public readonly exitCode: ExitCode;

  public constructor(info: HarnessErrorInfo) {
    super(info.message);
    this.name = "HarnessError";
    this.info = info;
    this.exitCode = exitCodeFor(info.code);
  }
}
