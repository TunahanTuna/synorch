import {
  ALLOWING_OUTCOMES,
  approvalDecisionSchema,
  createId,
  digestOf,
  HarnessError,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type PolicyMode,
  type RunId,
  type SessionId,
  type Usage,
} from "../contracts/index.ts";

/**
 * Run budget (ADR-14). Before every model request the remaining budget is checked; at the limit no
 * new request starts (`stop-new-requests`), at 120% of a metered limit or at the wall-time limit the
 * active request is cancelled (`cancel-active`). A budget increase is a human-only approval.
 */

export const BUDGET_METRICS = ["cost_usd", "wall_time_seconds", "steps", "tool_calls"] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export interface BudgetLimits {
  readonly maxCostUsd: number | undefined;
  readonly maxWallTimeSeconds: number | undefined;
  readonly maxSteps: number | undefined;
  readonly maxToolCalls: number | undefined;
}

export const CANCEL_THRESHOLD = 1.2;

export interface BudgetExceeded {
  readonly scope: "run" | "task";
  readonly metric: BudgetMetric;
  readonly limit: number;
  readonly used: number;
  readonly action: "stop-new-requests" | "cancel-active";
}

export type BudgetAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly metric: BudgetMetric; readonly limit: number; readonly used: number };

export interface UsageObservation {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly usage: Usage;
}

export interface BudgetUsage {
  readonly costUsd: number;
  readonly wallTimeSeconds: number;
  readonly steps: number;
  readonly toolCalls: number;
}

export interface BudgetTracker {
  readonly scope: "run" | "task";
  limits(): BudgetLimits;
  usage(): BudgetUsage;
  /** Folds provider-reported usage in; observations are de-duplicated by session and seq. */
  observe(observations: readonly UsageObservation[]): void;
  recordToolCalls(count: number): void;
  /** Called right before a model request; a successful admission counts one step. */
  admit(): BudgetAdmission;
  /** Non-consuming check used before dispatching new work. */
  exhausted(): BudgetAdmission;
  /** Re-evaluates wall time and the 120% rule; fires cancel listeners at most once. */
  check(): void;
  onCancel(listener: (reason: BudgetExceeded) => void): () => void;
  /** Applies a raise only when a human allowed exactly these limits. */
  applyIncrease(decision: ApprovalDecision, subjectDigest: string, limits: BudgetLimits): boolean;
}

export interface BudgetTrackerOptions {
  readonly scope: "run" | "task";
  readonly limits: BudgetLimits;
  readonly now?: () => number;
  readonly onExceeded?: (exceeded: BudgetExceeded) => void;
}

function limitOf(limits: BudgetLimits, metric: BudgetMetric): number | undefined {
  switch (metric) {
    case "cost_usd":
      return limits.maxCostUsd;
    case "wall_time_seconds":
      return limits.maxWallTimeSeconds;
    case "steps":
      return limits.maxSteps;
    case "tool_calls":
      return limits.maxToolCalls;
  }
}

export function createBudgetTracker(options: BudgetTrackerOptions): BudgetTracker {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let limits = options.limits;
  let costUsd = 0;
  let steps = 0;
  let toolCalls = 0;
  const seen = new Set<string>();
  const reported = new Set<string>();
  const cancelListeners = new Set<(reason: BudgetExceeded) => void>();
  let cancelled = false;

  const usedOf = (metric: BudgetMetric): number => {
    switch (metric) {
      case "cost_usd":
        return costUsd;
      case "wall_time_seconds":
        return (now() - startedAt) / 1000;
      case "steps":
        return steps;
      case "tool_calls":
        return toolCalls;
    }
  };

  const report = (exceeded: BudgetExceeded): void => {
    const key = `${exceeded.metric}:${exceeded.action}:${exceeded.limit}`;
    if (reported.has(key)) return;
    reported.add(key);
    options.onExceeded?.(exceeded);
  };

  const exhausted = (): BudgetAdmission => {
    for (const metric of BUDGET_METRICS) {
      const limit = limitOf(limits, metric);
      if (limit === undefined) continue;
      const used = usedOf(metric);
      if (used >= limit) return { ok: false, metric, limit, used };
    }
    return { ok: true };
  };

  const check = (): void => {
    for (const metric of BUDGET_METRICS) {
      const limit = limitOf(limits, metric);
      if (limit === undefined) continue;
      const used = usedOf(metric);
      const threshold = metric === "wall_time_seconds" ? limit : limit * CANCEL_THRESHOLD;
      if (used >= threshold) {
        const exceeded: BudgetExceeded = { scope: options.scope, metric, limit, used, action: "cancel-active" };
        report(exceeded);
        if (!cancelled) {
          cancelled = true;
          for (const listener of cancelListeners) listener(exceeded);
        }
        return;
      }
    }
  };

  return {
    scope: options.scope,
    limits: () => limits,
    usage: () => ({ costUsd, wallTimeSeconds: usedOf("wall_time_seconds"), steps, toolCalls }),
    observe(observations) {
      for (const observation of observations) {
        const key = `${observation.sessionId}#${observation.seq}`;
        if (seen.has(key)) continue;
        seen.add(key);
        costUsd += observation.usage.cost_usd_estimate ?? 0;
      }
      check();
    },
    recordToolCalls(count) {
      toolCalls += count;
      check();
    },
    admit() {
      check();
      const verdict = exhausted();
      if (!verdict.ok) {
        report({ scope: options.scope, metric: verdict.metric, limit: verdict.limit, used: verdict.used, action: "stop-new-requests" });
        return verdict;
      }
      steps += 1;
      return verdict;
    },
    exhausted,
    check,
    onCancel(listener) {
      cancelListeners.add(listener);
      return () => cancelListeners.delete(listener);
    },
    applyIncrease(decision, subjectDigest, next) {
      if (!isHumanBudgetGrant(decision, subjectDigest)) return false;
      limits = next;
      cancelled = false;
      return true;
    },
  };
}

/** A budget raise is honoured only for an allowing decision made by a user for this exact subject. */
export function isHumanBudgetGrant(decision: ApprovalDecision, subjectDigest: string): boolean {
  if (!approvalDecisionSchema.safeParse(decision).success) return false;
  return (
    decision.subject_kind === "budget" &&
    decision.decided_by === "user" &&
    decision.subject_digest === subjectDigest &&
    (ALLOWING_OUTCOMES as readonly string[]).includes(decision.outcome)
  );
}

export interface BudgetIncreaseRequest {
  readonly tracker: BudgetTracker;
  readonly broker: ApprovalBroker;
  readonly runId: RunId;
  readonly mode: PolicyMode;
  readonly limits: BudgetLimits;
  readonly now: () => Date;
  readonly record?: (request: ApprovalRequest, decision: ApprovalDecision | undefined) => Promise<void>;
}

export interface BudgetIncreaseOutcome {
  readonly granted: boolean;
  readonly request: ApprovalRequest;
  readonly decision: ApprovalDecision | undefined;
  readonly reason: string;
}

/**
 * Asks a human to raise the budget. There is no orchestrator path: a decision that is not a user
 * grant for these exact limits (including a malformed or orchestrator-made one) leaves them as is.
 */
export async function requestBudgetIncrease(input: BudgetIncreaseRequest, signal: AbortSignal): Promise<BudgetIncreaseOutcome> {
  const subjectDigest = digestOf({ kind: "budget", run_id: input.runId, limits: input.limits });
  const request: ApprovalRequest = {
    approval_id: createId("approval"),
    run_id: input.runId,
    subject_kind: "budget",
    subject_digest: subjectDigest,
    summary: `Raise run budget to ${JSON.stringify(input.limits)}`,
    scope: "once",
    requested_at: input.now().toISOString(),
  };
  let decision: ApprovalDecision | undefined;
  try {
    decision = await input.broker.request(request, signal);
  } catch (error) {
    await input.record?.(request, undefined);
    return { granted: false, request, decision: undefined, reason: error instanceof Error ? error.message : String(error) };
  }
  await input.record?.(request, approvalDecisionSchema.safeParse(decision).success ? decision : undefined);
  const granted = input.tracker.applyIncrease(decision, subjectDigest, input.limits);
  return {
    granted,
    request,
    decision,
    reason: granted ? "raised by a user decision" : `not raised: ${decision.decided_by} decided ${decision.outcome}`,
  };
}

/** Converts a denied admission into the error the context builder surfaces to the driver. */
export function budgetError(admission: Extract<BudgetAdmission, { ok: false }>): HarnessError {
  return new HarnessError({
    code: "budget_exceeded",
    message: `budget exhausted: ${admission.metric} used ${admission.used.toFixed(2)} of ${admission.limit}`,
    workspace_effect: "none",
    retry_safe: false,
    next_command: "syn run --budget <higher limit> (a raise needs a human decision)",
  });
}

/**
 * A late-bound gate shared by the coordinator (which owns the tracker for the active run) and the
 * context builder (which calls it before every model request).
 */
export interface BudgetGateSlot {
  set(tracker: BudgetTracker | undefined): void;
  current(): BudgetTracker | undefined;
  admit(observations: readonly UsageObservation[]): BudgetAdmission;
}

export function createBudgetGateSlot(): BudgetGateSlot {
  let tracker: BudgetTracker | undefined;
  return {
    set(next) {
      tracker = next;
    },
    current: () => tracker,
    admit(observations) {
      if (tracker === undefined) return { ok: true };
      tracker.observe(observations);
      return tracker.admit();
    },
  };
}
