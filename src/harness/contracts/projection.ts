import type { BlobRef } from "./common.ts";
import type { SessionEventOf } from "./events.ts";
import type { AttemptId, RequestId, RunId, SessionId, TaskId, ToolCallId, TurnId } from "./ids.ts";
import type { ModelMessage } from "./model.ts";
import type { PolicyMode } from "./policy.ts";
import type { ApprovalState, AttemptState, PlanState, RunState, StepState, TaskState, ToolCallState } from "./state.ts";

/**
 * Read models over the session event log. Core owns the projector and crash recovery; the CLI,
 * orchestration and `syn show` consume these shapes. A projection is always derived, never stored.
 */

export type ProjectionIssueCode =
  | "unsupported-event"
  | "invalid-event"
  | "seq-gap"
  | "unknown-entity"
  | "duplicate-entity"
  | "state-mismatch"
  | "illegal-transition";

export interface ProjectionIssue {
  readonly seq: number | undefined;
  readonly code: ProjectionIssueCode;
  readonly message: string;
}

export interface ProjectedEntity<S extends string> {
  readonly id: string;
  readonly state: S;
  readonly updatedSeq: number;
  readonly runId: RunId | undefined;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
}

export interface ProjectedRun extends ProjectedEntity<RunState> {
  readonly goal: string;
  readonly policyMode: PolicyMode;
}

export interface ProjectedToolCall extends ProjectedEntity<ToolCallState> {
  readonly toolName: string;
  readonly providerCallId: string;
  readonly requestId: RequestId | undefined;
}

export interface ProjectedApproval extends ProjectedEntity<ApprovalState> {
  readonly subjectKind: SessionEventOf<"approval/decided">["data"]["decision"]["subject_kind"];
  readonly subjectDigest: SessionEventOf<"approval/decided">["data"]["decision"]["subject_digest"];
}

export interface ProjectedStep extends ProjectedEntity<StepState> {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
}

export interface ProjectedTurn {
  readonly turnId: TurnId;
  readonly open: boolean;
  readonly startedSeq: number;
  readonly runId: RunId | undefined;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
}

export interface ProjectedMessage {
  readonly seq: number;
  readonly role: "user" | "assistant" | "tool";
  readonly requestId: RequestId | undefined;
  readonly message: ModelMessage | undefined;
  readonly blob: BlobRef | undefined;
}

/**
 * State derived from the event log. `status` is `corrupt` when the log breaks framing or a state
 * machine (the projection stops there rather than guessing) and `unsupported` when a newer writer
 * produced an event this version cannot read; either way the session is not writable.
 */
export interface SessionProjection {
  readonly status: "ok" | "unsupported" | "corrupt";
  readonly writable: boolean;
  readonly issues: readonly ProjectionIssue[];
  readonly tornTail: { readonly segment: number; readonly bytes: number } | undefined;
  readonly lastSeq: number;
  /** Highest seq whose effect is reflected in the maps below. */
  readonly appliedSeq: number;
  readonly lastEventAt: string | undefined;
  readonly opened: SessionEventOf<"session/opened">["data"] | undefined;
  readonly runs: ReadonlyMap<string, ProjectedRun>;
  readonly plans: ReadonlyMap<string, ProjectedEntity<PlanState>>;
  readonly tasks: ReadonlyMap<string, ProjectedEntity<TaskState>>;
  readonly attempts: ReadonlyMap<string, ProjectedEntity<AttemptState>>;
  readonly toolCalls: ReadonlyMap<string, ProjectedToolCall>;
  readonly approvals: ReadonlyMap<string, ProjectedApproval>;
  readonly steps: ReadonlyMap<string, ProjectedStep>;
  readonly turns: ReadonlyMap<string, ProjectedTurn>;
  readonly messages: readonly ProjectedMessage[];
  readonly lastCompaction: SessionEventOf<"context/compacted"> | undefined;
}

export type RecoveredMachine = SessionEventOf<"session/resumed">["data"]["recovered"][number]["machine"];

export interface RecoveredEntity {
  readonly machine: RecoveredMachine;
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** What crash recovery closed; the same facts are recorded in `session/resumed` and its closing events. */
export interface RecoveryReport {
  readonly sessionId: SessionId;
  readonly previousLastSeq: number;
  /** Seq of the `session/resumed` event this recovery wrote. */
  readonly resumedSeq: number;
  readonly recovered: readonly RecoveredEntity[];
  /** Calls that may have run: recorded as `tool/interrupted {outcome: unknown}` and never re-executed. */
  readonly interruptedToolCalls: readonly ToolCallId[];
  /** Calls that never started executing: closed as `cancelled`. */
  readonly cancelledToolCalls: readonly ToolCallId[];
  /** Torn final line the writer moved aside when it opened the session (also in `session/resumed.torn_tail`). */
  readonly tornTail: { readonly segment: number; readonly bytes: number; readonly file: string | undefined } | undefined;
}
