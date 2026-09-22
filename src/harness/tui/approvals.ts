import type { ApprovalBroker, ApprovalDecision, ApprovalRequest, PolicyMode } from "../contracts/index.ts";

/**
 * Broker outcomes a renderer may produce on its own. A headless broker answers every request with
 * `unavailable` (ADR-15), which refuses ask-mode prompts and human-only subjects and ends the run
 * with exit code 3. Interactive brokers only add `allowed-*`/`rejected` when a human answered.
 */

export type ApprovalChoice = "allowed-once" | "allowed-for-scope" | "rejected";

export function brokerDecision(
  request: ApprovalRequest,
  outcome: "unavailable" | "expired" | "cancelled",
  mode: PolicyMode,
  now: Date,
  reason: string,
): ApprovalDecision {
  return {
    approval_id: request.approval_id,
    subject_kind: request.subject_kind,
    subject_digest: request.subject_digest,
    outcome,
    decided_by: "broker",
    mode,
    decided_at: now.toISOString(),
    reason,
  };
}

export function userDecision(request: ApprovalRequest, choice: ApprovalChoice, mode: PolicyMode, now: Date): ApprovalDecision {
  return {
    approval_id: request.approval_id,
    subject_kind: request.subject_kind,
    subject_digest: request.subject_digest,
    outcome: choice,
    decided_by: "user",
    mode,
    decided_at: now.toISOString(),
  };
}

export class HeadlessApprovalBroker implements ApprovalBroker {
  public readonly availability = "headless" as const;
  private readonly mode: PolicyMode;
  private readonly clock: () => Date;

  public constructor(mode: PolicyMode, clock: () => Date = () => new Date()) {
    this.mode = mode;
    this.clock = clock;
  }

  public async request(request: ApprovalRequest, _signal: AbortSignal): Promise<ApprovalDecision> {
    return brokerDecision(request, "unavailable", this.mode, this.clock(), "no interactive terminal is attached to answer this request");
  }
}

/**
 * Races a human prompt against the request expiry and the caller's signal. Expiry resolves as
 * `expired` (the default on timeout is refusal), abort as `cancelled`; both are broker outcomes.
 */
export async function withApprovalDeadline(
  request: ApprovalRequest,
  mode: PolicyMode,
  signal: AbortSignal,
  clock: () => Date,
  ask: (signal: AbortSignal) => Promise<ApprovalChoice>,
): Promise<ApprovalDecision> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (signal.aborted) return brokerDecision(request, "cancelled", mode, clock(), "the request was cancelled");
    const races: Promise<ApprovalDecision>[] = [
      ask(controller.signal).then(
        (choice) => userDecision(request, choice, mode, clock()),
        () => brokerDecision(request, "cancelled", mode, clock(), "the prompt was cancelled"),
      ),
      new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(brokerDecision(request, "cancelled", mode, clock(), "the request was cancelled")), { once: true });
      }),
    ];
    if (request.expires_at !== undefined) {
      const remaining = Math.max(0, Date.parse(request.expires_at) - clock().getTime());
      races.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(brokerDecision(request, "expired", mode, clock(), "no answer before the approval expired")), remaining);
        }),
      );
    }
    return await Promise.race(races);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
