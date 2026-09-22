import {
  EVENT_VERSIONS,
  RECOVERY_STATE,
  StoreFailure,
  validateTransition,
  type Actor,
  type EventStore,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionEventType,
  type ToolCallId,
  type ProjectedEntity,
  type RecoveredEntity,
  type RecoveryReport,
  type SessionProjection,
} from "../contracts/index.ts";
import { SessionProjector } from "./projection.ts";

export interface RecoveryOptions {
  /** Tool metadata lookup for the `idempotent` flag of `tool/interrupted`; unknown tools count as not idempotent. */
  readonly isIdempotent?: (toolName: string) => boolean;
  /** Time source for `decided_at` of cancelled approvals. */
  readonly clock?: () => Date;
}

const SYSTEM: Actor = { kind: "system" };
const RECOVERY_REASON = "session resumed after an unclean shutdown";

/**
 * Closes every entity a crash left open (`RECOVERY_STATE`), announces it with `session/resumed`
 * and returns what was closed. A tool call that had started executing becomes
 * `tool/interrupted {outcome: unknown}` and is never repeated automatically.
 */
export async function recoverSession(store: EventStore, options: RecoveryOptions = {}): Promise<RecoveryReport> {
  const projector = new SessionProjector();
  for await (const item of store.read()) {
    projector.apply(item);
  }
  const projection = projector.result();
  if (projection.status === "corrupt") {
    throw new StoreFailure("session_corrupt", `session ${store.sessionId} cannot be recovered: ${projection.issues[0]?.message ?? "corrupt log"}`);
  }
  if (projection.status === "unsupported") {
    throw new StoreFailure("unsupported_version", `session ${store.sessionId} was written by a newer version; it opens read-only`);
  }

  const plan = planRecovery(projection, options);
  const tornTail = store.quarantinedTail;
  const resumed = await store.append(
    draft("session/resumed", {
      previous_last_seq: projection.lastSeq,
      recovered: plan.recovered.map((entry) => ({ ...entry })),
      ...(tornTail === undefined ? {} : { torn_tail: { segment: tornTail.segment, bytes: tornTail.bytes } }),
    }),
  );
  for (const closing of plan.closings) {
    await store.append({ ...closing, causation_seq: resumed.seq } as SessionEventDraft);
  }
  return {
    sessionId: store.sessionId,
    previousLastSeq: projection.lastSeq,
    resumedSeq: resumed.seq,
    recovered: plan.recovered,
    interruptedToolCalls: plan.interrupted,
    cancelledToolCalls: plan.cancelled,
    tornTail: tornTail === undefined ? undefined : { segment: tornTail.segment, bytes: tornTail.bytes, file: tornTail.file },
  };
}

interface RecoveryPlan {
  readonly recovered: RecoveredEntity[];
  readonly closings: SessionEventDraft[];
  readonly interrupted: ToolCallId[];
  readonly cancelled: ToolCallId[];
}

function planRecovery(projection: SessionProjection, options: RecoveryOptions): RecoveryPlan {
  const plan: RecoveryPlan = { recovered: [], closings: [], interrupted: [], cancelled: [] };
  const policyMode = projection.opened?.policy_mode ?? "ask";

  for (const call of projection.toolCalls.values()) {
    const correlation = correlate(call);
    if (call.state === "executing" || call.state === "awaiting_approval") {
      plan.recovered.push({ machine: "toolCall", id: call.id, from: call.state, to: RECOVERY_STATE.toolCall });
      plan.interrupted.push(call.id as ToolCallId);
      plan.closings.push(draft("tool/interrupted", { tool_call_id: call.id as ToolCallId, outcome: "unknown", idempotent: options.isIdempotent?.(call.toolName) ?? false }, correlation));
    } else if (call.state === "proposed") {
      plan.recovered.push({ machine: "toolCall", id: call.id, from: call.state, to: "cancelled" });
      plan.cancelled.push(call.id as ToolCallId);
      plan.closings.push(
        draft(
          "tool/result_recorded",
          {
            tool_call_id: call.id as ToolCallId,
            state: "cancelled",
            duration_ms: 0,
            result: { status: "error", text: "", truncated: false, redactions: 0, error: { code: "cancelled", message: "the session stopped before this call executed" } },
          },
          correlation,
        ),
      );
    }
  }

  for (const approval of projection.approvals.values()) {
    if (approval.state !== "pending") continue;
    plan.recovered.push({ machine: "approval", id: approval.id, from: approval.state, to: RECOVERY_STATE.approval });
    plan.closings.push(
      draft(
        "approval/decided",
        {
          decision: {
            approval_id: approval.id as SessionEventOf<"approval/decided">["data"]["decision"]["approval_id"],
            subject_kind: approval.subjectKind,
            subject_digest: approval.subjectDigest,
            outcome: "cancelled",
            decided_by: "broker",
            mode: policyMode,
            decided_at: (options.clock ?? (() => new Date()))().toISOString(),
            reason: RECOVERY_REASON,
          },
        },
        correlate(approval),
      ),
    );
  }

  for (const step of projection.steps.values()) {
    if (step.state !== "open") continue;
    plan.recovered.push({ machine: "step", id: step.id, from: step.state, to: RECOVERY_STATE.step });
    plan.closings.push(draft("step/ended", { step_id: step.id as SessionEventOf<"step/ended">["data"]["step_id"], state: "aborted" }, correlate(step)));
  }

  for (const turn of projection.turns.values()) {
    if (!turn.open) continue;
    plan.closings.push(draft("turn/ended", { turn_id: turn.turnId, outcome: "failed" }, correlate(turn)));
  }

  closeMachine(plan, "attempt", projection.attempts, (entity, to) =>
    draft("attempt/state_changed", { attempt_id: entity.id as SessionEventOf<"attempt/state_changed">["data"]["attempt_id"], from: entity.state, to, reason: RECOVERY_REASON }, correlate(entity)),
  );
  closeMachine(plan, "task", projection.tasks, (entity, to) =>
    draft("task/state_changed", { task_id: entity.id as SessionEventOf<"task/state_changed">["data"]["task_id"], from: entity.state, to, reason: RECOVERY_REASON }, correlate(entity)),
  );
  closeMachine(plan, "run", projection.runs, (entity, to) =>
    draft("run/state_changed", { from: entity.state, to, reason: RECOVERY_REASON }, { ...correlate(entity), run_id: entity.id as NonNullable<Correlation["run_id"]> }),
  );
  return plan;
}

function closeMachine<M extends "attempt" | "task" | "run", S extends string>(
  plan: RecoveryPlan,
  machine: M,
  entities: ReadonlyMap<string, ProjectedEntity<S>>,
  closing: (entity: ProjectedEntity<S>, to: (typeof RECOVERY_STATE)[M]) => SessionEventDraft,
): void {
  const to = RECOVERY_STATE[machine];
  for (const entity of entities.values()) {
    if (entity.state === to || !validateTransition(machine, entity.state, to).ok) continue;
    plan.recovered.push({ machine, id: entity.id, from: entity.state, to });
    plan.closings.push(closing(entity, to));
  }
}

interface Correlation {
  readonly run_id?: NonNullable<ProjectedEntity<string>["runId"]>;
  readonly task_id?: NonNullable<ProjectedEntity<string>["taskId"]>;
  readonly attempt_id?: NonNullable<ProjectedEntity<string>["attemptId"]>;
}

function correlate(entity: Pick<ProjectedEntity<string>, "runId" | "taskId" | "attemptId">): Correlation {
  return {
    ...(entity.runId === undefined ? {} : { run_id: entity.runId }),
    ...(entity.taskId === undefined ? {} : { task_id: entity.taskId }),
    ...(entity.attemptId === undefined ? {} : { attempt_id: entity.attemptId }),
  };
}

function draft<T extends SessionEventType>(type: T, data: SessionEventOf<T>["data"], correlation: Correlation = {}): SessionEventDraft {
  return { type, event_version: EVENT_VERSIONS[type], actor: SYSTEM, ...correlation, data } as SessionEventDraft;
}
