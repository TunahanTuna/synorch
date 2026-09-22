import { z } from "zod";

/**
 * Lifecycle state machines. The tables below are the only legal transitions; a projection that
 * observes any other pair in the event log reports corruption instead of guessing. Every
 * transition is recorded as a `*_state_changed` event with actor, reason and previous state.
 */

export const RUN_STATES = [
  "created",
  "running",
  "waiting_for_approval",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
] as const;

export const PLAN_STATES = [
  "draft",
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "invalidated",
] as const;

export const TASK_STATES = [
  "draft",
  "awaiting_approval",
  "ready",
  "running",
  "needs_context",
  "blocked",
  "interrupted",
  "failed",
  "retry_pending",
  "verifying",
  "reviewing",
  "changes_requested",
  "completed",
  "cancelled",
] as const;

export const ATTEMPT_STATES = [
  "queued",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export const TOOL_CALL_STATES = [
  "proposed",
  "awaiting_approval",
  "executing",
  "denied",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export const APPROVAL_STATES = [
  "pending",
  "allowed",
  "rejected",
  "cancelled",
  "unavailable",
  "expired",
  "invalidated",
] as const;

export const STEP_STATES = ["open", "settled", "aborted", "errored"] as const;

export const runStateSchema = z.enum(RUN_STATES);
export const planStateSchema = z.enum(PLAN_STATES);
export const taskStateSchema = z.enum(TASK_STATES);
export const attemptStateSchema = z.enum(ATTEMPT_STATES);
export const toolCallStateSchema = z.enum(TOOL_CALL_STATES);
export const approvalStateSchema = z.enum(APPROVAL_STATES);
export const stepStateSchema = z.enum(STEP_STATES);

export type RunState = (typeof RUN_STATES)[number];
export type PlanState = (typeof PLAN_STATES)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export type ToolCallState = (typeof TOOL_CALL_STATES)[number];
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export type StepState = (typeof STEP_STATES)[number];

interface StateMachines {
  run: RunState;
  plan: PlanState;
  task: TaskState;
  attempt: AttemptState;
  toolCall: ToolCallState;
  approval: ApprovalState;
  step: StepState;
}

export type MachineName = keyof StateMachines;
export type StateOf<M extends MachineName> = StateMachines[M];

type TransitionTable<S extends string> = { readonly [From in S]: readonly S[] };

export const TRANSITIONS: { readonly [M in MachineName]: TransitionTable<StateMachines[M]> } = {
  run: {
    created: ["running", "cancelled", "failed"],
    running: ["waiting_for_approval", "interrupted", "completed", "failed", "cancelled"],
    waiting_for_approval: ["running", "interrupted", "failed", "cancelled"],
    interrupted: ["running", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  },
  plan: {
    draft: ["proposed", "superseded"],
    proposed: ["approved", "rejected", "superseded"],
    approved: ["superseded", "invalidated"],
    rejected: [],
    superseded: [],
    invalidated: [],
  },
  task: {
    draft: ["awaiting_approval", "ready", "cancelled"],
    awaiting_approval: ["ready", "cancelled"],
    ready: ["running", "blocked", "cancelled"],
    running: ["needs_context", "blocked", "interrupted", "failed", "verifying", "cancelled"],
    needs_context: ["running", "ready", "cancelled"],
    blocked: ["ready", "cancelled"],
    interrupted: ["ready", "failed", "cancelled"],
    failed: ["retry_pending", "cancelled"],
    retry_pending: ["ready", "cancelled"],
    verifying: ["reviewing", "completed", "failed", "cancelled"],
    reviewing: ["changes_requested", "completed", "failed", "cancelled"],
    changes_requested: ["ready", "cancelled"],
    completed: [],
    cancelled: [],
  },
  attempt: {
    queued: ["running", "cancelled"],
    running: ["waiting_for_approval", "succeeded", "failed", "cancelled", "interrupted"],
    waiting_for_approval: ["running", "failed", "cancelled", "interrupted"],
    succeeded: [],
    failed: [],
    cancelled: [],
    interrupted: [],
  },
  toolCall: {
    proposed: ["awaiting_approval", "executing", "denied", "cancelled"],
    awaiting_approval: ["executing", "denied", "cancelled", "interrupted"],
    executing: ["succeeded", "failed", "cancelled", "interrupted"],
    denied: [],
    succeeded: [],
    failed: [],
    cancelled: [],
    interrupted: [],
  },
  approval: {
    pending: ["allowed", "rejected", "cancelled", "unavailable", "expired"],
    allowed: ["invalidated", "expired"],
    rejected: [],
    cancelled: [],
    unavailable: [],
    expired: [],
    invalidated: [],
  },
  step: {
    open: ["settled", "aborted", "errored"],
    settled: [],
    aborted: [],
    errored: [],
  },
};

/** States a crash-recovery projection maps an open (non-terminal) entity to on replay. */
export const RECOVERY_STATE: {
  readonly run: RunState;
  readonly task: TaskState;
  readonly attempt: AttemptState;
  readonly toolCall: ToolCallState;
  readonly approval: ApprovalState;
  readonly step: StepState;
} = {
  run: "interrupted",
  task: "interrupted",
  attempt: "interrupted",
  toolCall: "interrupted",
  approval: "cancelled",
  step: "aborted",
};

export type TransitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown-state" | "terminal-state" | "illegal-transition"; readonly message: string };

export function validateTransition<M extends MachineName>(
  machine: M,
  from: string,
  to: string,
): TransitionResult {
  const table = TRANSITIONS[machine] as Readonly<Record<string, readonly string[]>>;
  const allowed = table[from];
  if (allowed === undefined || table[to] === undefined) {
    return { ok: false, reason: "unknown-state", message: `${machine}: unknown state in ${from} -> ${to}` };
  }
  if (allowed.length === 0) {
    return { ok: false, reason: "terminal-state", message: `${machine}: ${from} is terminal` };
  }
  if (!allowed.includes(to)) {
    return { ok: false, reason: "illegal-transition", message: `${machine}: ${from} -> ${to} is not allowed` };
  }
  return { ok: true };
}

export function isTerminalState<M extends MachineName>(machine: M, state: StateOf<M>): boolean {
  const table = TRANSITIONS[machine] as Readonly<Record<string, readonly string[]>>;
  return table[state]?.length === 0;
}
