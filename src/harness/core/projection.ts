import {
  validateTransition,
  type ApprovalState,
  type AttemptId,
  type AttemptState,
  type BlobRef,
  type EventReadItem,
  type MachineName,
  type ModelMessage,
  type PlanState,
  type PolicyMode,
  type RequestId,
  type RunId,
  type RunState,
  type SessionEvent,
  type SessionEventOf,
  type StepState,
  type TaskId,
  type TaskState,
  type ToolCallState,
  type TurnId,
} from "../contracts/index.ts";

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

const APPROVAL_OUTCOME_STATE: { readonly [O in SessionEventOf<"approval/decided">["data"]["decision"]["outcome"]]: ApprovalState } = {
  "allowed-once": "allowed",
  "allowed-for-scope": "allowed",
  rejected: "rejected",
  cancelled: "cancelled",
  unavailable: "unavailable",
  expired: "expired",
};

/** Replays read items (or bare events) into a `SessionProjection`; validates every transition. */
export function projectSession(items: Iterable<EventReadItem | SessionEvent>): SessionProjection {
  const projector = new SessionProjector();
  for (const item of items) {
    projector.apply(item);
  }
  return projector.result();
}

/** Incremental form of `projectSession` for streaming a large log without buffering it. */
export class SessionProjector {
  readonly #issues: ProjectionIssue[] = [];
  readonly #runs = new Map<string, ProjectedRun>();
  readonly #plans = new Map<string, ProjectedEntity<PlanState>>();
  readonly #tasks = new Map<string, ProjectedEntity<TaskState>>();
  readonly #attempts = new Map<string, ProjectedEntity<AttemptState>>();
  readonly #toolCalls = new Map<string, ProjectedToolCall>();
  readonly #approvals = new Map<string, ProjectedApproval>();
  readonly #steps = new Map<string, ProjectedStep>();
  readonly #turns = new Map<string, ProjectedTurn>();
  readonly #messages: ProjectedMessage[] = [];
  #status: SessionProjection["status"] = "ok";
  #tornTail: SessionProjection["tornTail"];
  #lastSeq = 0;
  #appliedSeq = 0;
  #lastEventAt: string | undefined;
  #opened: SessionProjection["opened"];
  #lastCompaction: SessionProjection["lastCompaction"];
  #halted = false;

  public apply(item: EventReadItem | SessionEvent): void {
    if ("type" in item && !("status" in item)) {
      this.#applyEvent(item);
      return;
    }
    switch (item.status) {
      case "ok":
        this.#applyEvent(item.event);
        return;
      case "torn-tail":
        this.#tornTail = { segment: item.segment, bytes: item.bytes };
        return;
      case "unsupported":
        this.#lastSeq += 1;
        this.#halt("unsupported", {
          seq: this.#lastSeq,
          code: "unsupported-event",
          message: `${item.type} v${item.event_version ?? "?"} was written by a newer version; the session opens read-only`,
        });
        return;
      case "invalid":
        this.#lastSeq += 1;
        this.#halt("corrupt", {
          seq: this.#lastSeq,
          code: "invalid-event",
          message: item.issues.map((issue) => `${issue.path.map(String).join(".") || "<event>"}: ${issue.message}`).join("; "),
        });
        return;
    }
  }

  public result(): SessionProjection {
    return {
      status: this.#status,
      writable: this.#status === "ok",
      issues: [...this.#issues],
      tornTail: this.#tornTail,
      lastSeq: this.#lastSeq,
      appliedSeq: this.#appliedSeq,
      lastEventAt: this.#lastEventAt,
      opened: this.#opened,
      runs: new Map(this.#runs),
      plans: new Map(this.#plans),
      tasks: new Map(this.#tasks),
      attempts: new Map(this.#attempts),
      toolCalls: new Map(this.#toolCalls),
      approvals: new Map(this.#approvals),
      steps: new Map(this.#steps),
      turns: new Map(this.#turns),
      messages: [...this.#messages],
      lastCompaction: this.#lastCompaction,
    };
  }

  #halt(status: "unsupported" | "corrupt", issue: ProjectionIssue): void {
    this.#issues.push(issue);
    if (this.#status !== "corrupt") this.#status = status;
    this.#halted = true;
  }

  #corrupt(event: SessionEvent, code: ProjectionIssueCode, message: string): void {
    this.#halt("corrupt", { seq: event.seq, code, message: `${event.type}: ${message}` });
  }

  #applyEvent(event: SessionEvent): void {
    if (this.#lastSeq !== 0 && event.seq !== this.#lastSeq + 1) {
      const expected = this.#lastSeq + 1;
      this.#lastSeq = Math.max(this.#lastSeq, event.seq);
      this.#halt("corrupt", { seq: event.seq, code: "seq-gap", message: `expected seq ${expected}, found ${event.seq}` });
      return;
    }
    this.#lastSeq = event.seq;
    if (this.#halted) return;
    this.#lastEventAt = event.timestamp;
    this.#dispatch(event);
    if (!this.#halted) this.#appliedSeq = event.seq;
  }

  #dispatch(event: SessionEvent): void {
    const scope = { runId: event.run_id, taskId: event.task_id, attemptId: event.attempt_id };
    switch (event.type) {
      case "session/opened":
        this.#opened = event.data;
        return;
      case "run/created":
        if (event.run_id === undefined) return this.#corrupt(event, "unknown-entity", "run/created carries no run_id");
        if (this.#runs.has(event.run_id)) return this.#corrupt(event, "duplicate-entity", `run ${event.run_id} already exists`);
        this.#runs.set(event.run_id, { id: event.run_id, state: "created", updatedSeq: event.seq, ...scope, goal: event.data.goal, policyMode: event.data.policy_mode });
        return;
      case "run/state_changed":
        return this.#advance(event, "run", this.#runs, event.run_id, event.data.from, event.data.to);
      case "plan/proposed":
        this.#plans.set(event.data.plan.plan_id, { id: event.data.plan.plan_id, state: "proposed", updatedSeq: event.seq, ...scope });
        return;
      case "plan/state_changed":
        return this.#advance(event, "plan", this.#plans, event.data.plan_id, event.data.from, event.data.to);
      case "task/created":
        return this.#create(event, this.#tasks, event.data.task_id, "draft", { ...scope, taskId: event.data.task_id });
      case "task/state_changed":
        return this.#advance(event, "task", this.#tasks, event.data.task_id, event.data.from, event.data.to);
      case "attempt/started":
        return this.#create(event, this.#attempts, event.data.attempt_id, "running", { ...scope, taskId: event.data.task_id, attemptId: event.data.attempt_id });
      case "attempt/state_changed":
        return this.#advance(event, "attempt", this.#attempts, event.data.attempt_id, event.data.from, event.data.to);
      case "tool/call_proposed":
        if (this.#toolCalls.has(event.data.tool_call_id)) return this.#corrupt(event, "duplicate-entity", `tool call ${event.data.tool_call_id} already exists`);
        this.#toolCalls.set(event.data.tool_call_id, {
          id: event.data.tool_call_id,
          state: "proposed",
          updatedSeq: event.seq,
          ...scope,
          toolName: event.data.tool_name,
          providerCallId: event.data.provider_call_id,
          requestId: event.data.request_id,
        });
        return;
      case "tool/policy_decided":
        if (event.data.decision.decision !== "ask") return this.#requireEntity(event, this.#toolCalls, event.data.tool_call_id);
        return this.#advanceTo(event, "toolCall", this.#toolCalls, event.data.tool_call_id, "awaiting_approval");
      case "tool/execution_started":
        return this.#advanceTo(event, "toolCall", this.#toolCalls, event.data.tool_call_id, "executing");
      case "tool/result_recorded":
        return this.#advanceTo(event, "toolCall", this.#toolCalls, event.data.tool_call_id, event.data.state);
      case "tool/interrupted":
        return this.#advanceTo(event, "toolCall", this.#toolCalls, event.data.tool_call_id, "interrupted");
      case "approval/requested": {
        const request = event.data.request;
        if (this.#approvals.has(request.approval_id)) return this.#corrupt(event, "duplicate-entity", `approval ${request.approval_id} already exists`);
        this.#approvals.set(request.approval_id, {
          id: request.approval_id,
          state: "pending",
          updatedSeq: event.seq,
          ...scope,
          taskId: request.task_id ?? scope.taskId,
          subjectKind: request.subject_kind,
          subjectDigest: request.subject_digest,
        });
        return;
      }
      case "approval/decided": {
        const decision = event.data.decision;
        const target = APPROVAL_OUTCOME_STATE[decision.outcome];
        if (!this.#approvals.has(decision.approval_id)) {
          this.#approvals.set(decision.approval_id, {
            id: decision.approval_id,
            state: target,
            updatedSeq: event.seq,
            ...scope,
            subjectKind: decision.subject_kind,
            subjectDigest: decision.subject_digest,
          });
          return;
        }
        return this.#advanceTo(event, "approval", this.#approvals, decision.approval_id, target);
      }
      case "approval/invalidated":
        return this.#advanceTo(event, "approval", this.#approvals, event.data.approval_id, "invalidated");
      case "turn/started":
        if (this.#turns.has(event.data.turn_id)) return this.#corrupt(event, "duplicate-entity", `turn ${event.data.turn_id} already exists`);
        this.#turns.set(event.data.turn_id, { turnId: event.data.turn_id, open: true, startedSeq: event.seq, ...scope });
        return;
      case "turn/ended": {
        const turn = this.#turns.get(event.data.turn_id);
        if (turn === undefined || !turn.open) return this.#corrupt(event, "unknown-entity", `turn ${event.data.turn_id} is not open`);
        this.#turns.set(turn.turnId, { ...turn, open: false });
        return;
      }
      case "step/started":
        if (this.#steps.has(event.data.step_id)) return this.#corrupt(event, "duplicate-entity", `step ${event.data.step_id} already exists`);
        if (this.#turns.get(event.data.turn_id)?.open !== true) return this.#corrupt(event, "unknown-entity", `turn ${event.data.turn_id} is not open`);
        this.#steps.set(event.data.step_id, {
          id: event.data.step_id,
          state: "open",
          updatedSeq: event.seq,
          ...scope,
          turnId: event.data.turn_id,
          requestId: event.data.request_id,
        });
        return;
      case "step/ended":
        return this.#advanceTo(event, "step", this.#steps, event.data.step_id, event.data.state);
      case "message/recorded":
        this.#messages.push({ seq: event.seq, role: event.data.role, requestId: event.data.request_id, message: event.data.message, blob: event.data.blob });
        return;
      case "context/compacted":
        this.#lastCompaction = event;
        return;
      default:
        return;
    }
  }

  #create<S extends string>(event: SessionEvent, map: Map<string, ProjectedEntity<S>>, id: string, state: S, scope: Omit<ProjectedEntity<S>, "id" | "state" | "updatedSeq">): void {
    if (map.has(id)) return this.#corrupt(event, "duplicate-entity", `${id} already exists`);
    map.set(id, { id, state, updatedSeq: event.seq, ...scope });
  }

  #requireEntity(event: SessionEvent, map: ReadonlyMap<string, unknown>, id: string): void {
    if (!map.has(id)) this.#corrupt(event, "unknown-entity", `${id} does not exist`);
  }

  #advance<E extends ProjectedEntity<string>>(event: SessionEvent, machine: MachineName, map: Map<string, E>, id: string | undefined, from: string, to: string): void {
    if (id === undefined) return this.#corrupt(event, "unknown-entity", "no entity id");
    const entity = map.get(id);
    if (entity === undefined) return this.#corrupt(event, "unknown-entity", `${id} does not exist`);
    if (entity.state !== from) return this.#corrupt(event, "state-mismatch", `${id} is ${entity.state}, event says ${from}`);
    this.#transition(event, machine, map, entity, to);
  }

  #advanceTo<E extends ProjectedEntity<string>>(event: SessionEvent, machine: MachineName, map: Map<string, E>, id: string, to: string): void {
    const entity = map.get(id);
    if (entity === undefined) return this.#corrupt(event, "unknown-entity", `${id} does not exist`);
    this.#transition(event, machine, map, entity, to);
  }

  #transition<E extends ProjectedEntity<string>>(event: SessionEvent, machine: MachineName, map: Map<string, E>, entity: E, to: string): void {
    const verdict = validateTransition(machine, entity.state, to);
    if (!verdict.ok) return this.#corrupt(event, "illegal-transition", verdict.message);
    map.set(entity.id, { ...entity, state: to, updatedSeq: event.seq });
  }
}
