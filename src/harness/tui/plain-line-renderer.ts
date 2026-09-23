import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  AuthInteraction,
  ModelStreamEvent,
  PolicyMode,
  RenderEvent,
  SessionEvent,
  SessionHeaderView,
  StatusLine,
  TerminalRenderer,
  UserInputSource,
} from "../contracts/index.ts";
import { WORKSPACE_TRUST_CHOICES } from "../contracts/index.ts";
import { HeadlessApprovalBroker, withApprovalDeadline, type ApprovalChoice } from "./approvals.ts";
import { HeadlessAuthInteraction, LineAuthInteraction } from "./auth-interaction.ts";
import { describeEvent, levelPrefix, type EventLine } from "./describe.ts";
import { INTERRUPT_NOTICES, InterruptController, type InterruptAction, type InterruptKey } from "./interrupt.ts";
import { LineSource, type InputStream } from "./line-source.ts";
import type { BrowserEnvironment, BrowserLauncher } from "./open-browser.ts";
import { chunkForConPty } from "./output-chunks.ts";
import { RenderQueue } from "./render-queue.ts";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.ts";
import { createStyler, type Styler } from "./style.ts";
import { installTerminalGuard, type GuardProcess, type GuardSignal, type TerminalGuard } from "./terminal-lifecycle.ts";
import { TOOL_STATUS_LABEL, ToolCardTracker, type ToolCard, type ToolCardStatus } from "./tool-cards.ts";

/**
 * Append-only renderer for pipes, CI, `TERM=dumb`, `--plain` and screen readers (ADR-04). It never
 * moves the cursor, never animates and never emits an escape sequence other than SGR colour when
 * colour was explicitly selected. Streamed text is written as it arrives; the final `done` message
 * reconciles anything the bounded queue dropped.
 */

export interface PlainLifecycle {
  readonly process: GuardProcess;
  readonly onSignal: (signal: GuardSignal) => void;
  readonly onCrash: (error: unknown) => void;
}

export interface PlainLineRendererOptions {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly color: boolean;
  readonly policyMode: PolicyMode;
  /** Source of user lines (`syn agent` in plain mode, approvals and secrets when interactive). */
  readonly input?: InputStream;
  /** True only when a human can answer prompts: stdin is a TTY and plain mode was chosen explicitly. */
  readonly interactive: boolean;
  readonly environment: BrowserEnvironment;
  readonly launch?: BrowserLauncher;
  /** Cancels the active request (first Ctrl+C / SIGINT). */
  readonly onInterrupt?: () => void;
  /** Confirmed safe exit (Ctrl+C inside the confirmation window). */
  readonly onExit?: () => void;
  readonly lifecycle?: PlainLifecycle;
  readonly clock?: () => Date;
  readonly queueCapacity?: number;
  readonly schedule?: (flush: () => void) => void;
}

const ANNOUNCED_STATUSES: ReadonlySet<ToolCardStatus> = new Set(["proposed", "denied", "running", "succeeded", "failed", "cancelled", "interrupted"]);
const INTERRUPTION_EVENT = Symbol("interruption");

type Interruption = { readonly kind: "interrupt" | "exit" };

export class PlainLineRenderer implements TerminalRenderer {
  public readonly kind = "plain" as const;
  public readonly input: UserInputSource | undefined;
  public readonly approvals: ApprovalBroker;
  public readonly auth: AuthInteraction;
  private readonly options: PlainLineRendererOptions;
  private readonly style: Styler;
  private readonly clock: () => Date;
  private readonly queue: RenderQueue;
  private readonly tools = new ToolCardTracker();
  private readonly announced = new Map<string, ToolCardStatus>();
  private readonly printed = new Map<string, Map<number, string>>();
  private readonly interrupts = new InterruptController();
  private readonly interruptions: Interruption[] = [];
  private readonly interruptionWaiters: ((interruption: Interruption) => void)[] = [];
  private readonly lines: LineSource | undefined;
  private lineOpen = false;
  private lastStatus = "";
  private turnActive = false;
  private requestActive = false;
  private guard: TerminalGuard | undefined;
  private stopped = false;

  public constructor(options: PlainLineRendererOptions) {
    this.options = options;
    this.style = createStyler(options.color);
    this.clock = options.clock ?? (() => new Date());
    this.lines = options.input === undefined ? undefined : new LineSource(options.input);
    this.queue = new RenderQueue((event) => this.consume(event), {
      ...(options.queueCapacity === undefined ? {} : { capacity: options.queueCapacity }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });
    const lines = this.lines;
    if (options.interactive && lines !== undefined) {
      this.approvals = new LineApprovalBroker(options.policyMode, this.clock, lines, (text) => this.writeOut(text), this.style);
      this.auth = new LineAuthInteraction({
        lines,
        write: (text) => this.writeErr(text),
        environment: options.environment,
        ...(options.launch === undefined ? {} : { launch: options.launch }),
      });
    } else {
      this.approvals = new HeadlessApprovalBroker(options.policyMode, this.clock);
      this.auth = new HeadlessAuthInteraction((text) => this.writeErr(text));
    }
    this.input = lines === undefined ? undefined : { next: (signal) => this.nextInput(lines, signal) };
  }

  public async start(header: SessionHeaderView): Promise<void> {
    if (this.options.lifecycle !== undefined && this.guard === undefined) {
      const lifecycle = this.options.lifecycle;
      this.guard = installTerminalGuard({
        process: lifecycle.process,
        restore: () => this.options.input?.setRawMode?.(false),
        onSignal: (signal) => {
          if (signal === "SIGINT") this.interrupt("ctrl+c");
          else lifecycle.onSignal(signal);
        },
        onCrash: lifecycle.onCrash,
        handleSigint: true,
      });
    }
    const out: string[] = [`${this.style.bold("Synorch")} ${header.workspaceRoot}${header.gitBranch === undefined ? "" : ` (${header.gitBranch})`}`];
    out.push(`Policy: ${header.policyMode}; sandbox: ${header.sandboxEnforcement}`);
    for (const route of header.routes) out.push(`Route ${route.tier}: ${route.model} (${route.source})`);
    for (const notice of header.notices) out.push(`notice: ${sanitizeInline(notice)}`);
    this.writeLine(out.join("\n"));
  }

  public render(event: RenderEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
  }

  /** Applies Ctrl+C / Esc (or SIGINT) semantics; exposed for the CLI and tests. */
  public interrupt(key: InterruptKey, now: number = Date.now()): InterruptAction {
    const action = this.interrupts.press(key, now);
    if (action === "cancel-request") {
      this.notice("warning", INTERRUPT_NOTICES.cancelled);
      this.options.onInterrupt?.();
      this.deliverInterruption({ kind: "interrupt" });
    } else if (action === "offer-exit") {
      this.notice("info", INTERRUPT_NOTICES.offerExit);
    } else if (action === "exit") {
      this.options.onExit?.();
      this.deliverInterruption({ kind: "exit" });
    }
    return action;
  }

  public async stop(_reason: "completed" | "error" | "signal"): Promise<void> {
    if (this.stopped) return;
    this.queue.flush();
    this.stopped = true;
    this.closeLine();
    this.lines?.close();
    this.guard?.release();
    this.guard = undefined;
  }

  private consume(event: RenderEvent): void {
    switch (event.kind) {
      case "session-event":
        this.onSessionEvent(event.event);
        return;
      case "stream":
        this.onStream(event.requestId, event.event);
        return;
      case "status":
        this.onStatus(event.status);
        return;
      case "notice":
        this.notice(event.level, event.message);
        return;
    }
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.type === "turn/started") this.setTurnActive(true);
    if (event.type === "turn/ended") this.setTurnActive(false);
    if (event.type.startsWith("tool/")) {
      const card = this.tools.applyEvent(event);
      if (card !== undefined) {
        this.announce(card);
        return;
      }
    }
    const line = describeEvent(event, { policyMode: this.options.policyMode });
    if (line !== undefined) this.writeLine(this.formatLine(line));
  }

  private onStream(requestId: string, event: ModelStreamEvent): void {
    switch (event.type) {
      case "start":
        this.setRequestActive(true);
        return;
      case "text_delta": {
        const text = sanitizeTerminalText(event.text);
        const parts = this.printed.get(requestId) ?? new Map<number, string>();
        this.printed.set(requestId, parts);
        parts.set(event.index, (parts.get(event.index) ?? "") + text);
        this.writeText(text);
        return;
      }
      case "tool_call_start":
      case "tool_call_delta":
      case "tool_call_end": {
        const card = this.tools.applyStream(event);
        if (card !== undefined) this.announce(card);
        return;
      }
      case "done": {
        const parts = this.printed.get(requestId) ?? new Map<number, string>();
        event.message.content.forEach((part, index) => {
          if (part.type !== "text") return;
          const full = sanitizeTerminalText(part.text);
          const shown = parts.get(index) ?? "";
          if (full.startsWith(shown)) this.writeText(full.slice(shown.length));
          else {
            this.closeLine();
            this.writeLine(this.style.dim("[stream resynchronised; full message follows]"));
            this.writeText(full);
          }
        });
        this.printed.delete(requestId);
        this.closeLine();
        this.setRequestActive(false);
        return;
      }
      case "error": {
        this.printed.delete(requestId);
        const card = this.tools.failStreaming(event.error.code === "cancelled" ? "request cancelled" : "model stream failed");
        if (card !== undefined) this.announce(card);
        this.closeLine();
        if (event.error.code === "cancelled") this.writeLine(this.style.yellow("Request cancelled."));
        else this.writeErrLine(`error: model request failed (${event.error.code}): ${sanitizeInline(event.error.message)}`);
        this.setRequestActive(false);
        return;
      }
      default:
        return;
    }
  }

  private onStatus(status: StatusLine): void {
    const parts = [
      status.runId === undefined ? undefined : `run ${status.runId}`,
      status.task === undefined ? undefined : `task ${status.task}`,
      status.model === undefined ? undefined : `model ${status.model}`,
      status.step === undefined ? undefined : `step ${status.step}`,
      status.budgetUsed === undefined ? undefined : `budget ${status.budgetUsed}${status.budgetLimit === undefined ? "" : `/${status.budgetLimit}`}`,
      status.workersRunning > 0 ? `workers ${status.workersRunning}` : undefined,
      status.pendingApproval === undefined ? undefined : `approval pending: ${status.pendingApproval}`,
      status.lastVerification === undefined ? undefined : `verification ${status.lastVerification}`,
    ].filter((part): part is string => part !== undefined);
    const text = sanitizeInline(parts.join(" | "));
    if (text === this.lastStatus || text === "") return;
    this.lastStatus = text;
    this.writeLine(this.style.dim(`[status] ${text}`));
  }

  private announce(card: ToolCard): void {
    if (!ANNOUNCED_STATUSES.has(card.status) || this.announced.get(card.key) === card.status) return;
    this.announced.set(card.key, card.status);
    const duration = card.durationMs === undefined ? "" : ` in ${card.durationMs} ms`;
    const args = card.status === "proposed" && card.args !== "" ? ` ${card.args}` : "";
    const detail = card.detail === undefined || card.status === "proposed" ? "" : `: ${card.detail}`;
    const label = `${TOOL_STATUS_LABEL[card.status]}${duration}`;
    const painted =
      card.status === "succeeded" ? this.style.green(label) : card.status === "running" || card.status === "proposed" ? label : this.style.yellow(label);
    this.writeLine(`[tool] ${card.name} ${painted}${args}${detail}`);
  }

  private notice(level: "info" | "warning" | "error", message: string): void {
    const text = `${levelPrefix(level)}${sanitizeInline(message, 1000)}`;
    if (level === "info") this.writeLine(this.style.dim(text));
    else this.writeErrLine(level === "error" ? this.style.red(text) : this.style.yellow(text));
  }

  private formatLine(line: EventLine): string {
    const text = `${levelPrefix(line.level)}${line.text}`;
    switch (line.level) {
      case "success":
        return this.style.green(text);
      case "warning":
        return this.style.yellow(text);
      case "error":
        return this.style.red(text);
      default:
        return text;
    }
  }

  private setTurnActive(active: boolean): void {
    this.turnActive = active;
    this.interrupts.setActive(this.turnActive || this.requestActive, active);
  }

  private setRequestActive(active: boolean): void {
    this.requestActive = active;
    this.interrupts.setActive(this.turnActive || this.requestActive, active);
  }

  private async nextInput(lines: LineSource, signal: AbortSignal): ReturnType<UserInputSource["next"]> {
    const pending = this.interruptions.shift();
    if (pending !== undefined) return pending;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        const result = await Promise.race([
          lines.next(controller.signal).then((line) => ({ line })),
          new Promise<{ readonly [INTERRUPTION_EVENT]: Interruption }>((resolve) => {
            this.interruptionWaiters.push((interruption) => resolve({ [INTERRUPTION_EVENT]: interruption }));
          }),
        ]);
        if (INTERRUPTION_EVENT in result) return result[INTERRUPTION_EVENT];
        const line = result.line;
        if (line === undefined) return { kind: "exit" };
        const text = line.trim();
        if (text === "") continue;
        if (text === "/exit" || text === "/quit") return { kind: "exit" };
        return { kind: text.startsWith("/") ? "command" : "message", text };
      }
    } finally {
      this.interruptionWaiters.length = 0;
      signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  private deliverInterruption(interruption: Interruption): void {
    const waiter = this.interruptionWaiters.shift();
    if (waiter === undefined) this.interruptions.push(interruption);
    else waiter(interruption);
  }

  private writeText(text: string): void {
    if (text.length === 0) return;
    this.writeOut(text);
    this.lineOpen = !text.endsWith("\n");
  }

  private writeLine(text: string): void {
    this.closeLine();
    this.writeOut(`${text}\n`);
  }

  private writeErrLine(text: string): void {
    this.closeLine();
    this.writeErr(`${text}\n`);
  }

  private closeLine(): void {
    if (!this.lineOpen) return;
    this.lineOpen = false;
    this.writeOut("\n");
  }

  private writeOut(text: string): void {
    for (const chunk of chunkForConPty(text)) this.options.stdout(chunk);
  }

  private writeErr(text: string): void {
    for (const chunk of chunkForConPty(text)) this.options.stderr(chunk);
  }
}

/** `[y/N]` approval prompt on a line terminal; any answer other than yes/always is a rejection. */
class LineApprovalBroker implements ApprovalBroker {
  public readonly availability = "interactive" as const;
  private readonly mode: PolicyMode;
  private readonly clock: () => Date;
  private readonly lines: LineSource;
  private readonly write: (text: string) => void;
  private readonly style: Styler;

  public constructor(mode: PolicyMode, clock: () => Date, lines: LineSource, write: (text: string) => void, style: Styler) {
    this.mode = mode;
    this.clock = clock;
    this.lines = lines;
    this.write = write;
    this.style = style;
  }

  public request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return withApprovalDeadline(request, this.mode, signal, this.clock, async (promptSignal) => {
      if (request.subject_kind === "workspace-trust") {
        this.write(`${this.style.yellow("Trust this workspace?")} ${sanitizeInline(request.summary, 2000)}\n`);
        this.write(`${WORKSPACE_TRUST_CHOICES.map((choice, index) => `  [${choice.key}] ${choice.label}${index === 0 ? " (default)" : ""}`).join("\n")}\n`);
        this.write(`Choose [${WORKSPACE_TRUST_CHOICES.map((choice, index) => (index === 0 ? choice.key.toUpperCase() : choice.key)).join("/")}]: `);
        const answer = (await this.lines.next(promptSignal))?.trim().toLowerCase() ?? "";
        const picked = WORKSPACE_TRUST_CHOICES.find((choice) => answer === choice.key || answer === choice.label.toLowerCase());
        return picked?.outcome ?? "rejected";
      }
      const scoped = request.scope !== "once";
      this.write(`${this.style.yellow(`Approval needed (${request.subject_kind})`)}: ${sanitizeInline(request.summary, 2000)}\n`);
      if (request.effect !== undefined) this.write(`  effect: ${request.effect}; scope: ${request.scope}\n`);
      this.write(scoped ? "Allow? [y]es once, [a]lways for this scope, [N]o: " : "Allow? [y/N] ");
      const answer = (await this.lines.next(promptSignal))?.trim().toLowerCase();
      const choice: ApprovalChoice = answer === "y" || answer === "yes" ? "allowed-once" : scoped && (answer === "a" || answer === "always") ? "allowed-for-scope" : "rejected";
      return choice;
    });
  }
}
