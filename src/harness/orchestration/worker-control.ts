import type { RenderEvent, SessionEvent } from "../contracts/index.ts";
import type { WorkerAssignmentView, WorkerStreamEvent, WorkerStreamSource } from "../contracts/views.ts";

/**
 * K1.7 — entering running workers (runtime side of `contracts/views.ts`). Workers are named by
 * their board key (`edit-a`); the runtime resolves a key to the task's latest attempt.
 *
 * - `WorkerStreamHub` implements `WorkerStreamSource`: the assignment first, then the task's current
 *   attempt session replayed synchronously, then live events; a new attempt of the task (retry,
 *   revision, review) is followed automatically and the assignment is re-sent on every steer.
 * - `WorkerDirectory` (the coordinator's) lists the workers of the active or last run, projects
 *   assignments and runs the per-worker commands; the session adapts it to `WorkerControl`.
 */

export type WorkerControlResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

/** One row of `/workers`. */
export interface WorkerSummary {
  readonly key: string;
  readonly taskId: string;
  readonly role: string;
  readonly state: string;
  readonly model?: string | undefined;
  /** 1-based attempt ordinal of the task's latest attempt (reviews included); 0 before the first dispatch. */
  readonly attempt: number;
  readonly live: boolean;
  readonly paused: boolean;
  readonly objective: string;
}

/** What the coordinator offers about the workers of its active (or last) run; `task` is the board key (or the task id). */
export interface WorkerDirectory {
  list(): readonly WorkerSummary[];
  assignment(task: string): WorkerAssignmentView | undefined;
  /** Delivered to the running attempt at its next safe step boundary; recorded and passed on to the orchestrator. */
  message(task: string, text: string): Promise<WorkerControlResult>;
  /** Holds the attempt's next model step (the step in flight finishes). */
  pause(task: string): Promise<WorkerControlResult>;
  resume(task: string): Promise<WorkerControlResult>;
  /** Aborts the attempt; the coordinator treats it like any cancelled attempt. */
  cancel(task: string): Promise<WorkerControlResult>;
}

const SESSION_BUFFER_LIMIT = 5000;
const SESSION_LIMIT = 128;
/** Run-log events of a task that its worker view shows (they are not in the attempt session). */
const TASK_EVENTS: ReadonlySet<SessionEvent["type"]> = new Set(["task/delegated", "task/user_message", "attempt/user_control", "task/state_changed", "attempt/verification_ran", "review/recorded"]);

interface AttemptTrack {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly role: string;
}

interface TaskTrack {
  readonly taskId: string;
  readonly key: string;
  readonly attempts: AttemptTrack[];
}

interface Subscriber {
  readonly key: string;
  readonly onEvent: (event: WorkerStreamEvent) => void;
  taskId: string | undefined;
  sessionId: string | undefined;
}

/**
 * The live worker streams of this process, fed with every `RenderEvent` the runtime fans out (run
 * logs, attempt sessions, model streams). Attempt session events are buffered per session (bounded)
 * so a late subscriber gets the history; stream deltas are forwarded live only (their settled
 * message is recorded anyway). Events of `ignore`d sessions (the conversation) are never kept.
 */
export class WorkerStreamHub implements WorkerStreamSource {
  readonly #ignore: (sessionId: string) => boolean;
  readonly #sessions = new Map<string, SessionEvent[]>();
  readonly #tasks = new Map<string, TaskTrack>();
  readonly #keys = new Map<string, string>();
  readonly #requests = new Map<string, string>();
  readonly #subscribers = new Set<Subscriber>();
  /** Where assignments come from (the coordinator's directory); without it no assignment is sent. */
  public assignments: ((taskKey: string) => WorkerAssignmentView | undefined) | undefined;

  public constructor(ignore: (sessionId: string) => boolean = () => false) {
    this.#ignore = ignore;
  }

  public feed(event: RenderEvent): void {
    if (event.kind === "stream") {
      const sessionId = this.#requests.get(event.requestId);
      if (sessionId !== undefined) this.#emitTo((subscriber) => subscriber.sessionId === sessionId, event);
      return;
    }
    if (event.kind !== "session-event") return;
    const recorded = event.event;
    if (this.#ignore(recorded.session_id)) return;
    switch (recorded.type) {
      case "task/created":
        this.#track(recorded.data.task_id, recorded.data.key);
        break;
      case "attempt/started":
        if (recorded.data.session_id !== undefined) this.#attemptStarted(recorded.data.task_id, recorded.data.attempt_id, recorded.data.session_id, recorded.data.role);
        break;
      case "model/request_prepared":
        this.#requests.set(recorded.data.request_id, recorded.session_id);
        break;
      default:
        break;
    }
    if (recorded.task_id !== undefined && TASK_EVENTS.has(recorded.type) && !this.#isAttemptSession(recorded.session_id)) {
      const taskId = recorded.task_id;
      this.#emitTo((subscriber) => subscriber.taskId === taskId, event);
      // A steer changes the assignment: it is re-sent in full (it replaces the last one).
      if (recorded.type === "task/user_message") for (const subscriber of this.#subscribers) if (subscriber.taskId === taskId) this.#sendAssignment(subscriber);
      return;
    }
    this.#buffer(recorded);
    this.#emitTo((subscriber) => subscriber.sessionId === recorded.session_id, event);
  }

  /** Delivers the assignment and the current attempt's past events synchronously, then live events; an unknown key delivers nothing until it appears. */
  public subscribe(taskKey: string, onEvent: (event: WorkerStreamEvent) => void): () => void {
    const subscriber: Subscriber = { key: taskKey, onEvent, taskId: undefined, sessionId: undefined };
    this.#subscribers.add(subscriber);
    const track = this.#resolve(taskKey);
    if (track !== undefined) this.#bind(subscriber, track);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** The past events a subscriber would get now (assignment first), without staying subscribed. */
  public snapshot(taskKey: string): readonly WorkerStreamEvent[] {
    const events: WorkerStreamEvent[] = [];
    this.subscribe(taskKey, (event) => events.push(event))();
    return events;
  }

  public taskIdOf(taskKey: string): string | undefined {
    return this.#resolve(taskKey)?.taskId;
  }

  public recent(taskKey: string, limit: number): readonly SessionEvent[] {
    const attempt = this.#resolve(taskKey)?.attempts.at(-1);
    if (attempt === undefined) return [];
    return (this.#sessions.get(attempt.sessionId) ?? []).slice(-Math.max(0, limit));
  }

  #resolve(taskKey: string): TaskTrack | undefined {
    return this.#tasks.get(this.#keys.get(taskKey) ?? "") ?? this.#tasks.get(taskKey);
  }

  #isAttemptSession(sessionId: string): boolean {
    for (const track of this.#tasks.values()) if (track.attempts.some((attempt) => attempt.sessionId === sessionId)) return true;
    return false;
  }

  #track(taskId: string, key: string): void {
    if (!this.#tasks.has(taskId)) this.#tasks.set(taskId, { taskId, key, attempts: [] });
    this.#keys.set(key, taskId);
    const track = this.#tasks.get(taskId);
    if (track === undefined) return;
    // A subscriber waiting for this key (or re-pointed by a new run using the same key) binds now.
    for (const subscriber of this.#subscribers) if (subscriber.key === key || subscriber.key === taskId) this.#bind(subscriber, track);
  }

  #attemptStarted(taskId: string, attemptId: string, sessionId: string, role: string): void {
    const track = this.#tasks.get(taskId);
    if (track === undefined) return;
    track.attempts.push({ attemptId, sessionId, role });
    for (const subscriber of this.#subscribers) {
      if (subscriber.taskId !== taskId) continue;
      if (track.attempts.length > 1) this.#safe(subscriber, { kind: "notice", level: "info", message: `${track.key}: attempt ${track.attempts.length} (${role}) started` });
      this.#sendAssignment(subscriber);
      this.#follow(subscriber, sessionId);
    }
  }

  #bind(subscriber: Subscriber, track: TaskTrack): void {
    subscriber.taskId = track.taskId;
    this.#sendAssignment(subscriber);
    const attempt = track.attempts.at(-1);
    if (attempt === undefined) {
      subscriber.sessionId = undefined;
      return;
    }
    this.#follow(subscriber, attempt.sessionId);
  }

  #sendAssignment(subscriber: Subscriber): void {
    const track = subscriber.taskId === undefined ? undefined : this.#tasks.get(subscriber.taskId);
    const assignment = track === undefined ? undefined : this.assignments?.(track.key);
    if (assignment !== undefined) this.#safe(subscriber, { kind: "assignment", assignment });
  }

  #follow(subscriber: Subscriber, sessionId: string): void {
    subscriber.sessionId = sessionId;
    for (const past of this.#sessions.get(sessionId) ?? []) this.#safe(subscriber, { kind: "session-event", event: past });
  }

  #buffer(event: SessionEvent): void {
    let events = this.#sessions.get(event.session_id);
    if (events === undefined) {
      if (this.#sessions.size >= SESSION_LIMIT) {
        const oldest = this.#sessions.keys().next().value;
        if (oldest !== undefined) this.#sessions.delete(oldest);
      }
      events = [];
      this.#sessions.set(event.session_id, events);
    }
    events.push(event);
    if (events.length > SESSION_BUFFER_LIMIT) events.splice(0, events.length - SESSION_BUFFER_LIMIT);
  }

  #emitTo(match: (subscriber: Subscriber) => boolean, event: RenderEvent): void {
    if (event.kind === "status") return;
    for (const subscriber of this.#subscribers) if (match(subscriber)) this.#safe(subscriber, event);
  }

  #safe(subscriber: Subscriber, event: WorkerStreamEvent): void {
    try {
      subscriber.onEvent(event);
    } catch {
      return;
    }
  }
}
