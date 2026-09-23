import type { SessionEvent, SessionId, TaskState } from "../contracts/index.ts";
import type { OrchestrationTaskView, OrchestrationView, ReviewVerdictView } from "../contracts/views.ts";

/**
 * Projects one orchestration (the coordinator's run session plus its attempt sessions) into U3's
 * `OrchestrationView` (live board, `/graph`, pinned summary; TUI §8.6) and into the ≤ 4 KiB result
 * block the `orchestrate` tool returns to the conversation agent (ADR-21 D5, TUI R5). It only reads
 * events; worker transcripts never reach the view or the model.
 */

const RESULT_LIMIT_BYTES = 4 * 1024;

export type OrchestrationPhase = "planning" | "awaiting-approval" | "running" | "integrating" | "done" | "failed" | "cancelled";

interface TaskEntry {
  readonly taskId: string;
  readonly key: string;
  readonly role: string;
  readonly dependsOn: readonly string[];
  state: TaskState;
  model: string | undefined;
  activity: string | undefined;
  reason: string | undefined;
  startedAtMs: number | undefined;
  endedAtMs: number | undefined;
  attempts: number;
  reviewer: boolean;
  checks: { passed: number; total: number };
  integratedPaths: string[];
  review: { verdict: ReviewVerdictView; revisions: number } | undefined;
}

const TOOL_VERBS: Readonly<Record<string, string>> = {
  read_file: "reading",
  search: "searching",
  list_dir: "listing files",
  git_status: "checking git status",
  git_diff: "reading the diff",
  apply_patch: "editing",
  write_file: "writing",
  exec: "running a command",
  task_report: "reporting",
  review_report: "writing the review",
  load_skill: "loading a skill",
};

const TERMINAL_TASK_STATES: readonly TaskState[] = ["completed", "failed", "cancelled", "blocked"];

export class OrchestrationTracker {
  public readonly goal: string;
  public readonly reason: string | undefined;
  private readonly startedAt: number;
  private readonly now: () => number;
  private runId: string | undefined;
  private runSession: SessionId | undefined;
  private endedAt: number | undefined;
  private phase: OrchestrationPhase = "planning";
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly attempts = new Map<string, string>();
  private readonly attemptSessions = new Map<string, string>();
  private readonly verification: string[] = [];
  public stopArmed = false;

  public constructor(goal: string, reason: string | undefined, now: () => number = Date.now) {
    this.goal = goal;
    this.reason = reason;
    this.now = now;
    this.startedAt = now();
  }

  public get sessionId(): SessionId | undefined {
    return this.runSession;
  }

  public get currentPhase(): OrchestrationPhase {
    return this.phase;
  }

  /** Returns true when the event belongs to this orchestration and changed the view. */
  public observe(event: SessionEvent): boolean {
    if (event.type === "run/created" && this.runId === undefined && event.data.goal === this.goal) {
      this.runId = event.run_id;
      this.runSession = event.session_id;
      return true;
    }
    if (this.runSession !== undefined && event.session_id === this.runSession) return this.runEvent(event);
    const attemptTask = event.attempt_id === undefined ? undefined : this.attempts.get(event.attempt_id);
    if (attemptTask !== undefined) return this.attemptEvent(attemptTask, event);
    const bySession = this.attemptSessions.get(event.session_id);
    if (bySession !== undefined) return this.attemptEvent(bySession, event);
    return false;
  }

  private runEvent(event: SessionEvent): boolean {
    switch (event.type) {
      case "plan/proposed":
        if (this.phase === "planning") this.phase = "awaiting-approval";
        return true;
      case "plan/state_changed":
        if (event.data.to === "approved") this.phase = "running";
        return true;
      case "task/created": {
        const keys = new Map([...this.tasks.values()].map((task) => [task.taskId, task.key]));
        this.tasks.set(event.data.task_id, {
          taskId: event.data.task_id,
          key: event.data.key,
          role: event.data.role,
          dependsOn: event.data.depends_on.map((id) => keys.get(id) ?? id),
          state: "draft",
          model: undefined,
          activity: undefined,
          reason: undefined,
          startedAtMs: undefined,
          endedAtMs: undefined,
          attempts: 0,
          reviewer: false,
          checks: { passed: 0, total: 0 },
          integratedPaths: [],
          review: undefined,
        });
        if (this.phase === "planning" || this.phase === "awaiting-approval") this.phase = "running";
        return true;
      }
      case "task/state_changed": {
        const task = this.tasks.get(event.data.task_id);
        if (task === undefined) return false;
        task.state = event.data.to;
        if (event.data.to === "running" || event.data.to === "verifying" || event.data.to === "reviewing") task.startedAtMs ??= this.now();
        if (TERMINAL_TASK_STATES.includes(event.data.to)) {
          task.endedAtMs ??= this.now();
          task.activity = undefined;
          if (event.data.to !== "completed") task.reason = event.data.reason?.slice(0, 160);
        }
        if (event.data.to === "changes_requested" || event.data.to === "retry_pending") task.reason = event.data.reason?.slice(0, 160);
        return true;
      }
      case "attempt/started": {
        this.attempts.set(event.data.attempt_id, event.data.task_id);
        if (event.data.session_id !== undefined) this.attemptSessions.set(event.data.session_id, event.data.task_id);
        const task = this.tasks.get(event.data.task_id);
        if (task === undefined) return false;
        task.reviewer = event.data.role === "reviewer";
        if (!task.reviewer) {
          task.attempts += 1;
          task.model = event.data.route.model_id;
        }
        task.startedAtMs ??= this.now();
        task.activity = task.reviewer ? `independent review · ${event.data.route.model_id}` : task.attempts > 1 ? "revising" : "starting";
        return true;
      }
      case "attempt/verification_ran": {
        const task = this.tasks.get(event.data.task_id);
        if (task === undefined) return false;
        task.checks.total += 1;
        if (event.data.status === "passed") task.checks.passed += 1;
        task.activity = event.data.command.slice(0, 60);
        this.verification.push(`${event.data.status}: ${event.data.command.slice(0, 80)}`);
        return true;
      }
      case "review/recorded": {
        const task = this.tasks.get(event.data.task_id);
        if (task === undefined) return false;
        const verdict: ReviewVerdictView = event.data.decision === "accept" ? "accepted" : event.data.decision === "revise" ? "changes_requested" : "rejected";
        task.review = { verdict, revisions: (task.review?.revisions ?? 0) + (verdict === "changes_requested" ? 1 : 0) };
        return true;
      }
      case "task/integrated": {
        const task = this.tasks.get(event.data.task_id);
        if (task !== undefined) task.integratedPaths.push(...event.data.paths);
        this.phase = "integrating";
        return true;
      }
      case "run/state_changed":
        if (event.data.to === "completed") this.phase = "done";
        else if (event.data.to === "failed") this.phase = "failed";
        else if (event.data.to === "cancelled") this.phase = "cancelled";
        else if (event.data.to === "waiting_for_approval") this.phase = "awaiting-approval";
        else if (event.data.to === "running" && this.tasks.size > 0) this.phase = "running";
        if (this.phase === "done" || this.phase === "failed" || this.phase === "cancelled") this.endedAt ??= this.now();
        return true;
      default:
        return false;
    }
  }

  private attemptEvent(taskId: string, event: SessionEvent): boolean {
    const task = this.tasks.get(taskId);
    if (task === undefined) return false;
    if (event.type === "tool/call_proposed") {
      if (task.reviewer) return false;
      const verb = TOOL_VERBS[event.data.tool_name] ?? event.data.tool_name.replaceAll("_", " ");
      task.activity = `${task.attempts > 1 ? "revising · " : ""}${verb}`;
      return true;
    }
    if (event.type === "model/request_prepared" && (task.activity === undefined || task.activity === "starting")) {
      task.activity = "thinking";
      return true;
    }
    return false;
  }

  private summary(task: TaskEntry): string | undefined {
    if (task.state !== "completed") return undefined;
    if (task.integratedPaths.length > 0) return `${task.integratedPaths.length} file${task.integratedPaths.length === 1 ? "" : "s"} integrated`;
    return task.role === "explorer" ? "explored" : undefined;
  }

  /** The note line under the board title: planning, the reason, or the armed stop. */
  private note(): string | undefined {
    if (this.stopArmed) return "press Esc again to stop the workers";
    if (this.phase === "planning") return "planning";
    if (this.phase === "awaiting-approval") return "waiting for plan approval";
    return this.reason;
  }

  public view(): OrchestrationView {
    const tasks: OrchestrationTaskView[] = [...this.tasks.values()].map((task) => ({
      key: task.key,
      role: task.role,
      model: task.model,
      state: task.state,
      activity: TERMINAL_TASK_STATES.includes(task.state) ? undefined : task.activity,
      summary: this.summary(task),
      reason: task.reason,
      startedAtMs: task.startedAtMs,
      endedAtMs: task.endedAtMs,
      dependsOn: task.dependsOn,
      review: task.review === undefined ? undefined : { verdict: task.review.verdict, revisions: task.review.revisions },
      checks: task.checks.total === 0 ? undefined : { ...task.checks },
    }));
    const done = this.phase === "done" || this.phase === "failed" || this.phase === "cancelled";
    return {
      kind: "orchestration",
      title: "Workers",
      tasks,
      startedAtMs: this.startedAt,
      endedAtMs: this.endedAt,
      done,
      outcome: this.phase === "done" ? "completed" : this.phase === "failed" ? "failed" : this.phase === "cancelled" ? "cancelled" : undefined,
      note: this.note(),
    };
  }

  /** Marks the view ended (the coordinator returned without a terminal run state, e.g. a failure before planning finished). */
  public finish(status: "succeeded" | "failed" | "cancelled" | "rejected"): void {
    if (this.phase === "done" || this.phase === "failed" || this.phase === "cancelled") return;
    this.phase = status === "succeeded" ? "done" : status === "cancelled" ? "cancelled" : "failed";
    this.endedAt ??= this.now();
  }

  /** Plain one-liner for a task (`task i/n key: state - activity`). */
  public line(taskId: string): string | undefined {
    const list = [...this.tasks.values()];
    const index = list.findIndex((task) => task.taskId === taskId);
    const task = list[index];
    if (task === undefined) return undefined;
    const detail = TERMINAL_TASK_STATES.includes(task.state) ? (this.summary(task) ?? task.reason) : task.activity;
    return `task ${index + 1}/${list.length} ${task.key}: ${task.state.replaceAll("_", " ")}${detail === undefined ? "" : ` - ${detail}`}`;
  }

  public integratedPaths(): string[] {
    return [...new Set([...this.tasks.values()].flatMap((task) => task.integratedPaths))];
  }

  /** Summary lines under the pinned board (§8.6 c): changed, checks run by Synorch, review. */
  public resultLines(): string[] {
    const paths = this.integratedPaths();
    const reviews = [...this.tasks.values()].filter((task) => task.review !== undefined).map((task) => `${task.key} ${task.review?.verdict.replaceAll("_", " ")}`);
    const passed = this.verification.filter((line) => line.startsWith("passed")).length;
    return [
      `Changed   ${paths.length === 0 ? "nothing integrated" : `${paths.length} file${paths.length === 1 ? "" : "s"}  ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}`}`,
      `Checks    ${this.verification.length === 0 ? "none" : `${passed}/${this.verification.length} passed`}   run by Synorch`,
      `Review    ${reviews.length === 0 ? "none recorded" : reviews.join("; ")}`,
    ];
  }

  /**
   * The harness-built result block (≤ 4 KiB): goal, status, tasks, integrated paths, checks run by
   * Synorch, reviews and the coordinator's summary. The session agent reports from it.
   */
  public resultBlock(outcome: { readonly status: string; readonly summary: string; readonly runId: string; readonly sessionId: string }): string {
    const paths = this.integratedPaths();
    const reviews = [...this.tasks.values()].filter((task) => task.review !== undefined).map((task) => `${task.key}: ${task.review?.verdict.replaceAll("_", " ")}`);
    const seconds = Math.round(((this.endedAt ?? this.now()) - this.startedAt) / 1000);
    const lines = [
      `Orchestration ${outcome.status} in ${seconds}s.`,
      `Goal: ${this.goal}`,
      `Tasks (${this.tasks.size}):`,
      ...[...this.tasks.values()].map((task) => `- ${task.key} (${task.role}${task.model === undefined ? "" : `, ${task.model}`}): ${task.state.replaceAll("_", " ")}${task.reason === undefined ? "" : ` - ${task.reason}`}`),
      paths.length === 0 ? "Changed: no files integrated into the workspace." : `Changed (${paths.length} files, integrated into the workspace): ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ", …" : ""}`,
      this.verification.length === 0 ? "Checks: none run by Synorch." : `Checks run by Synorch: ${this.verification.slice(-8).join("; ")}`,
      reviews.length === 0 ? "Review: no independent review recorded." : `Independent review: ${reviews.join("; ")}`,
      `Coordinator summary: ${outcome.summary.replace(/\s+/g, " ").trim()}`,
    ];
    // The ids stay last and are never cut: /evidence and /tasks find the run's session through them after a resume.
    const ids = `Run ${outcome.runId} · session ${outcome.sessionId}`;
    let text = lines.join("\n");
    while (Buffer.byteLength(`${text}\n${ids}`, "utf8") > RESULT_LIMIT_BYTES) text = `${text.slice(0, Math.floor(text.length * 0.9))}…`;
    return `${text}\n${ids}`;
  }
}
