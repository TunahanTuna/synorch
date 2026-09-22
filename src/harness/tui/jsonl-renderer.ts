import {
  encodeJsonlFrame,
  exitCodeFor,
  EXIT_CODES,
  JSONL_PROTOCOL,
  JSONL_SCHEMA_VERSION,
  jsonlFrameSchema,
  type ApprovalBroker,
  type AuthInteraction,
  type HarnessErrorInfo,
  type JsonlFrame,
  type PolicyMode,
  type RenderEvent,
  type RunId,
  type SessionHeaderView,
  type SessionId,
  type ExitCode,
  type TerminalRenderer,
} from "../contracts/index.ts";
import { HeadlessApprovalBroker } from "./approvals.ts";
import { HeadlessAuthInteraction } from "./auth-interaction.ts";
import { RenderQueue } from "./render-queue.ts";

/**
 * Machine mode (CLI contract §4, ADR-15). stdout carries only frames: `hello` first, dense `seq`
 * from 1 assigned at write time (so a dropped delta never leaves a gap), exactly one terminal frame
 * last, each validated against the frame schema and terminated by a single LF. Anything else that
 * tries to write to stdout while the renderer runs is redirected to stderr.
 */

export interface FrameSink {
  write(chunk: string): boolean;
  once?(event: "drain", listener: () => void): unknown;
  on?(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export interface GuardableStdout extends FrameSink {
  write: (chunk: string | Uint8Array, ...rest: never[]) => boolean;
}

export type ResultData = Extract<JsonlFrame, { type: "result" }>["data"];

export interface JsonlRendererOptions {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly policyMode: PolicyMode;
  readonly streamDeltas: boolean;
  readonly harnessVersion: string;
  readonly stdout: FrameSink;
  readonly stderr: (text: string) => void;
  /** When given, stray writes to this stream (normally `process.stdout`) go to stderr until stop. */
  readonly guardStdout?: GuardableStdout;
  readonly clock?: () => Date;
  readonly queueCapacity?: number;
  readonly schedule?: (flush: () => void) => void;
}

export class JsonlRenderer implements TerminalRenderer {
  public readonly kind = "jsonl" as const;
  public readonly input = undefined;
  public readonly approvals: ApprovalBroker;
  public readonly auth: AuthInteraction;
  private readonly options: JsonlRendererOptions;
  private readonly clock: () => Date;
  private readonly queue: RenderQueue;
  private readonly write: (chunk: string) => boolean;
  private seq = 0;
  private started = false;
  private terminal: JsonlFrame | undefined;
  private closed = false;
  private idle: (() => void)[] = [];
  private restoreStdout: (() => void) | undefined;

  public constructor(options: JsonlRendererOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.approvals = new HeadlessApprovalBroker(options.policyMode, this.clock);
    this.auth = new HeadlessAuthInteraction(options.stderr);
    this.write = (chunk) => options.stdout.write(chunk);
    if (options.guardStdout !== undefined) {
      const guarded = options.guardStdout;
      const original = guarded.write;
      const bound = original.bind(guarded) as (chunk: string) => boolean;
      if (guarded === options.stdout) this.write = bound;
      guarded.write = ((chunk: string | Uint8Array) => {
        options.stderr(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }) as GuardableStdout["write"];
      this.restoreStdout = () => {
        guarded.write = original;
      };
    }
    options.stdout.on?.("error", (error) => {
      if (error.code === "EPIPE") this.closed = true;
    });
    this.queue = new RenderQueue((event) => this.emitEvent(event), {
      coalesceDeltas: true,
      ...(options.queueCapacity === undefined ? {} : { capacity: options.queueCapacity }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });
  }

  /** Frames written so far; the next frame gets `framesWritten + 1`. */
  public get framesWritten(): number {
    return this.seq;
  }

  public get droppedDeltas(): number {
    return this.queue.dropped;
  }

  public async start(_header: SessionHeaderView): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.emit({
      ...this.base(),
      type: "hello",
      data: {
        protocol: JSONL_PROTOCOL,
        harness_version: this.options.harnessVersion,
        session_id: this.options.sessionId,
        policy_mode: this.options.policyMode,
        stream_deltas: this.options.streamDeltas,
      },
    });
  }

  public render(event: RenderEvent): void {
    if (this.terminal !== undefined) return;
    if (event.kind === "stream" && !this.options.streamDeltas) return;
    if (event.kind === "notice") {
      this.options.stderr(`${event.level}: ${event.message}\n`);
      return;
    }
    if (event.kind === "status") return;
    this.queue.push(event);
  }

  /** Writes the single `result` frame. Later calls and later events are ignored. */
  public async result(data: ResultData): Promise<void> {
    await this.finish({ ...this.base(), type: "result", data });
  }

  /** Writes the single `error` frame with the exit code the contract maps the error code to. */
  public async fail(error: HarnessErrorInfo): Promise<void> {
    await this.finish({ ...this.base(), type: "error", data: { ...error, exit_code: exitCodeFor(error.code) } });
  }

  public async stop(reason: "completed" | "error" | "signal"): Promise<void> {
    if (this.terminal === undefined) {
      await this.fail(
        reason === "signal"
          ? { code: "cancelled", message: "the run was interrupted before it finished", workspace_effect: "unknown", retry_safe: false }
          : { code: "internal", message: "the run ended without a result", workspace_effect: "unknown", retry_safe: false },
      );
    }
    await this.drained();
    this.restoreStdout?.();
    this.restoreStdout = undefined;
  }

  /** The exit code of the terminal frame, or `internal` if none was written. */
  public get exitCode(): ExitCode {
    const terminal = this.terminal;
    if (terminal?.type === "result" || terminal?.type === "error") return terminal.data.exit_code as ExitCode;
    return EXIT_CODES.internal;
  }

  private async finish(frame: JsonlFrame): Promise<void> {
    if (this.terminal !== undefined) return;
    if (!this.started) await this.start({ workspaceRoot: "", gitBranch: undefined, policyMode: this.options.policyMode, routes: [], sandboxEnforcement: "unavailable", notices: [] });
    this.queue.flush();
    await this.drained();
    this.terminal = frame;
    if (!this.emit(frame)) {
      const fallback: JsonlFrame = {
        ...this.base(),
        type: "error",
        data: { code: "internal", message: `the ${frame.type} frame failed validation`, workspace_effect: "unknown", retry_safe: false, exit_code: EXIT_CODES.internal },
      };
      this.terminal = fallback;
      this.emit(fallback);
    }
    await this.drained();
  }

  private emitEvent(event: RenderEvent): void {
    if (event.kind === "session-event") this.emit({ ...this.base(), type: "event", data: event.event });
    else if (event.kind === "stream") this.emit({ ...this.base(), type: "delta", data: event.event });
  }

  private base(): { schema_version: typeof JSONL_SCHEMA_VERSION; run_id: RunId; seq: number; timestamp: string } {
    return { schema_version: JSONL_SCHEMA_VERSION, run_id: this.options.runId, seq: 0, timestamp: this.clock().toISOString() };
  }

  private emit(frame: JsonlFrame): boolean {
    const numbered = { ...frame, seq: this.seq + 1 };
    const parsed = jsonlFrameSchema.safeParse(numbered);
    if (!parsed.success) {
      this.options.stderr(`synorch: dropped an invalid ${frame.type} frame: ${parsed.error.issues[0]?.message ?? "schema mismatch"}\n`);
      return false;
    }
    this.seq += 1;
    if (this.closed) return true;
    const accepted = this.write(encodeJsonlFrame(numbered as JsonlFrame));
    if (!accepted && this.options.stdout.once !== undefined) {
      this.queue.pause();
      this.options.stdout.once("drain", () => {
        this.queue.resume();
        this.settle();
      });
    }
    return true;
  }

  private drained(): Promise<void> {
    this.queue.flush();
    if (this.queue.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private settle(): void {
    this.queue.flush();
    if (this.queue.size === 0) for (const resolve of this.idle.splice(0)) resolve();
  }
}
