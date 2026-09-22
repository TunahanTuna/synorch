import { writeSync } from "node:fs";
import {
  Box,
  Container,
  CURSOR_MARKER,
  Editor,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  truncateToWidth,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type OverlayHandle,
  type SelectListTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  AuthInteraction,
  AuthNotice,
  DeviceCodePrompt,
  ModelStreamEvent,
  PolicyMode,
  RenderEvent,
  SessionEvent,
  SessionHeaderView,
  StatusLine,
  TerminalRenderer,
  UserInputSource,
} from "../contracts/index.ts";
import { withApprovalDeadline, type ApprovalChoice } from "./approvals.ts";
import { deviceCodeText } from "./auth-interaction.ts";
import { describeEvent, levelPrefix, type EventLine } from "./describe.ts";
import { INTERRUPT_NOTICES, InterruptController, type InterruptAction, type InterruptKey } from "./interrupt.ts";
import { openBrowser, type BrowserEnvironment, type BrowserLauncher } from "./open-browser.ts";
import { chunkForConPty } from "./output-chunks.ts";
import { RenderQueue } from "./render-queue.ts";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.ts";
import { createStyler, type Styler } from "./style.ts";
import {
  ConsoleCodepageGuard,
  EMERGENCY_RESTORE_SEQUENCE,
  installTerminalGuard,
  type GuardProcess,
  type GuardSignal,
  type TerminalGuard,
} from "./terminal-lifecycle.ts";
import { TOOL_STATUS_LABEL, ToolCardTracker, type ToolCard } from "./tool-cards.ts";

/**
 * The interactive renderer (ADR-04): the only file that imports `@earendil-works/pi-tui`. It keeps
 * a retained component tree (header, transcript, status line, editor) on the main screen so the
 * terminal scrollback survives, streams Markdown, follows tool calls as cards and shows approval,
 * secret and acknowledgement dialogs as overlays. Every write is split for ConPTY.
 */

export interface PiTuiLifecycle {
  readonly process: GuardProcess;
  readonly onSignal: (signal: GuardSignal) => void;
  readonly onCrash: (error: unknown) => void;
  /** Synchronous last-resort writer for the restore sequence; defaults to fd 1. */
  readonly emergencyWrite?: (data: string) => void;
  readonly setRawMode?: (mode: boolean) => void;
}

export interface PiTuiRendererOptions {
  readonly color: boolean;
  readonly policyMode: PolicyMode;
  readonly environment: BrowserEnvironment;
  /** Defaults to pi-tui's `ProcessTerminal` on process.stdin/stdout. */
  readonly terminal?: Terminal;
  readonly launch?: BrowserLauncher;
  readonly onInterrupt?: () => void;
  readonly onExit?: () => void;
  readonly lifecycle?: PiTuiLifecycle;
  readonly codepage?: ConsoleCodepageGuard;
  readonly clock?: () => Date;
  readonly now?: () => number;
  readonly queueCapacity?: number;
  readonly schedule?: (flush: () => void) => void;
  /** Upper bound for draining late key events before the terminal is released. */
  readonly drainInputMs?: number;
}

/** Wraps a pi-tui terminal so that no single write exceeds the ConPTY-safe size. */
export class ChunkedTerminal implements Terminal {
  private readonly inner: Terminal;

  public constructor(inner: Terminal) {
    this.inner = inner;
  }

  public start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, onResize);
  }

  public stop(): void {
    this.inner.stop();
  }

  public drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs);
  }

  public write(data: string): void {
    for (const chunk of chunkForConPty(data)) this.inner.write(chunk);
  }

  public get columns(): number {
    return this.inner.columns;
  }

  public get rows(): number {
    return this.inner.rows;
  }

  public get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive;
  }

  public moveBy(lines: number): void {
    this.inner.moveBy(lines);
  }

  public hideCursor(): void {
    this.inner.hideCursor();
  }

  public showCursor(): void {
    this.inner.showCursor();
  }

  public clearLine(): void {
    this.inner.clearLine();
  }

  public clearFromCursor(): void {
    this.inner.clearFromCursor();
  }

  public clearScreen(): void {
    this.inner.clearScreen();
  }

  public setTitle(title: string): void {
    this.inner.setTitle(title);
  }

  public setProgress(active: boolean): void {
    this.inner.setProgress(active);
  }
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width));
}

class ToolCardView implements Component {
  private card: ToolCard;
  private readonly style: Styler;

  public constructor(card: ToolCard, style: Styler) {
    this.card = card;
    this.style = style;
  }

  public update(card: ToolCard): void {
    this.card = card;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const card = this.card;
    const duration = card.durationMs === undefined ? "" : ` ${card.durationMs} ms`;
    const label = `${TOOL_STATUS_LABEL[card.status]}${duration}`;
    const painted =
      card.status === "succeeded"
        ? this.style.green(label)
        : card.status === "running" || card.status === "streaming" || card.status === "proposed"
          ? this.style.cyan(label)
          : this.style.yellow(label);
    const lines = [`${this.style.dim("┌")} ${this.style.bold(card.name)} ${this.style.dim("·")} ${painted}`];
    if (card.args !== "") lines.push(`${this.style.dim("│")} ${this.style.dim(card.args)}`);
    lines.push(`${this.style.dim("└")}${card.detail === undefined ? "" : ` ${card.detail}`}`);
    return lines.map((line) => fit(line, width));
  }
}

class StatusBar implements Component {
  private text = "ready";
  private readonly style: Styler;

  public constructor(style: Styler) {
    this.style = style;
  }

  public set(text: string): void {
    this.text = text === "" ? "ready" : text;
  }

  public get value(): string {
    return this.text;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    return [fit(this.style.dim(this.text), width)];
  }
}

class SecretInput implements Component, Focusable {
  public focused = false;
  public onSubmit: ((value: string) => void) | undefined;
  public onCancel: (() => void) | undefined;
  private value = "";
  private readonly label: string;

  public constructor(label: string) {
    this.label = label;
  }

  public invalidate(): void {}

  public handleInput(data: string): void {
    if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
      this.onSubmit?.(this.value);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
      this.value = [...this.value].slice(0, -1).join("");
      return;
    }
    if (!data.startsWith("\x1b")) this.value += data.replace(/[\x00-\x1f\x7f]/g, "");
  }

  public render(width: number): string[] {
    const masked = "•".repeat([...this.value].length);
    return [fit(`${this.label}: ${masked}${this.focused ? CURSOR_MARKER : ""}`, width)];
  }
}

type Interruption = { readonly kind: "interrupt" | "exit" };
type InputResult = Awaited<ReturnType<UserInputSource["next"]>>;

interface StreamState {
  readonly parts: Map<number, { readonly view: Markdown; raw: string }>;
}

export class PiTuiRenderer implements TerminalRenderer {
  public readonly kind = "tui" as const;
  public readonly input: UserInputSource;
  public readonly approvals: ApprovalBroker;
  public readonly auth: AuthInteraction;
  private readonly options: PiTuiRendererOptions;
  private readonly style: Styler;
  private readonly clock: () => Date;
  private readonly now: () => number;
  private readonly terminal: ChunkedTerminal;
  private readonly tui: TuiMainScreen;
  private readonly header: Text;
  private readonly transcript = new Container();
  private readonly status: StatusBar;
  private readonly editor: Editor;
  private readonly markdownTheme: MarkdownTheme;
  private readonly selectTheme: SelectListTheme;
  private readonly queue: RenderQueue;
  private readonly tools = new ToolCardTracker();
  private readonly toolViews = new Map<string, ToolCardView>();
  private readonly streams = new Map<string, StreamState>();
  private readonly interrupts = new InterruptController();
  private readonly pendingInputs: InputResult[] = [];
  private readonly inputWaiters: ((result: InputResult) => void)[] = [];
  private dialog: { readonly handle: OverlayHandle; readonly cancel: () => void } | undefined;
  private guard: TerminalGuard | undefined;
  private removeInputListener: (() => void) | undefined;
  private turnActive = false;
  private requestActive = false;
  private started = false;
  private stopped = false;

  public constructor(options: PiTuiRendererOptions) {
    this.options = options;
    this.style = createStyler(options.color);
    this.clock = options.clock ?? (() => new Date());
    this.now = options.now ?? (() => Date.now());
    this.terminal = new ChunkedTerminal(options.terminal ?? new ProcessTerminal());
    this.tui = new TuiMainScreen(this.terminal);
    this.header = new Text("", 0, 0);
    this.status = new StatusBar(this.style);
    const style = this.style;
    this.selectTheme = {
      selectedPrefix: (text) => style.cyan(text),
      selectedText: (text) => style.bold(text),
      description: (text) => style.dim(text),
      scrollInfo: (text) => style.dim(text),
      noMatch: (text) => style.dim(text),
    };
    this.markdownTheme = {
      heading: (text) => style.bold(style.cyan(text)),
      link: (text) => style.cyan(text),
      linkUrl: (text) => style.dim(text),
      code: (text) => style.yellow(text),
      codeBlock: (text) => text,
      codeBlockBorder: (text) => style.dim(text),
      quote: (text) => style.dim(text),
      quoteBorder: (text) => style.dim(text),
      hr: (text) => style.dim(text),
      listBullet: (text) => style.cyan(text),
      bold: (text) => style.bold(text),
      italic: (text) => text,
      strikethrough: (text) => text,
      underline: (text) => text,
    };
    this.editor = new Editor(this.tui, { borderColor: (text) => style.dim(text), selectList: this.selectTheme });
    this.editor.onSubmit = (text) => this.submit(text);
    this.queue = new RenderQueue((event) => this.consume(event), {
      ...(options.queueCapacity === undefined ? {} : { capacity: options.queueCapacity }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });
    this.input = { next: (signal) => this.nextInput(signal) };
    this.approvals = {
      availability: "interactive",
      request: (request, signal) => this.requestApproval(request, signal),
    };
    this.auth = {
      interactive: true,
      openBrowser: (url) => this.openUrl(url),
      showDeviceCode: (prompt) => this.showDeviceCode(prompt),
      promptSecret: (label, signal) => this.promptSecret(label, signal),
      acknowledge: (notice, signal) => this.acknowledge(notice, signal),
      notify: (message) => this.appendLine({ level: "info", text: sanitizeInline(message, 1000) }),
    };
  }

  /** Visible text of the status line; used by tests and `doctor --runtime`. */
  public get statusText(): string {
    return this.status.value;
  }

  public async start(header: SessionHeaderView): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.options.codepage?.start();
    const lifecycle = this.options.lifecycle;
    if (lifecycle !== undefined) {
      const emergencyWrite = lifecycle.emergencyWrite ?? ((data: string) => writeSync(1, data));
      this.guard = installTerminalGuard({
        process: lifecycle.process,
        restore: () => {
          try {
            this.tui.stop();
          } catch {
            lifecycle.setRawMode?.(false);
          }
          emergencyWrite(EMERGENCY_RESTORE_SEQUENCE);
          lifecycle.setRawMode?.(false);
          this.options.codepage?.restore();
        },
        onSignal: lifecycle.onSignal,
        onCrash: lifecycle.onCrash,
      });
    }
    const lines = [`${this.style.bold("Synorch")} ${this.style.dim(header.workspaceRoot)}${header.gitBranch === undefined ? "" : ` ${this.style.cyan(header.gitBranch)}`}`];
    lines.push(this.style.dim(`policy ${header.policyMode} · sandbox ${header.sandboxEnforcement}`));
    for (const route of header.routes) lines.push(this.style.dim(`${route.tier}: ${route.model} (${route.source})`));
    for (const notice of header.notices) lines.push(this.style.yellow(`notice: ${sanitizeInline(notice)}`));
    this.header.setText(lines.join("\n"));
    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.removeInputListener = this.tui.addInputListener((data) => this.onKey(data));
    this.tui.start();
  }

  public render(event: RenderEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
  }

  /** Applies Ctrl+C / Esc semantics; key input and tests both go through here. */
  public interrupt(key: InterruptKey): InterruptAction {
    const action = this.interrupts.press(key, this.now());
    if (action === "cancel-request") {
      this.appendLine({ level: "warning", text: INTERRUPT_NOTICES.cancelled });
      this.options.onInterrupt?.();
      this.deliver({ kind: "interrupt" });
    } else if (action === "offer-exit") {
      this.appendLine({ level: "info", text: INTERRUPT_NOTICES.offerExit });
    } else if (action === "exit") {
      this.options.onExit?.();
      this.deliver({ kind: "exit" });
    }
    this.tui.requestRender();
    return action;
  }

  /** Renders synchronously; used by tests and before handing the terminal back. */
  public flush(): void {
    this.queue.flush();
    if (this.started && !this.stopped) this.tui.renderNow();
  }

  public async stop(_reason: "completed" | "error" | "signal"): Promise<void> {
    if (this.stopped || !this.started) return;
    this.flush();
    this.stopped = true;
    this.dialog?.cancel();
    this.removeInputListener?.();
    await this.terminal.drainInput(this.options.drainInputMs ?? 300, 50);
    this.tui.stop();
    this.guard?.release();
    this.guard = undefined;
    this.options.codepage?.restore();
  }

  private onKey(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, "ctrl+c")) {
      if (this.dialog !== undefined) {
        this.dialog.cancel();
        return { consume: true };
      }
      if (!this.interrupts.requestActive && this.editor.getText().length > 0) {
        this.editor.setText("");
        this.tui.requestRender();
        return { consume: true };
      }
      this.interrupt("ctrl+c");
      return { consume: true };
    }
    if (matchesKey(data, "escape") && this.dialog === undefined && !this.editor.isShowingAutocomplete()) {
      return this.interrupt("escape") === "cancel-request" ? { consume: true } : undefined;
    }
    if (matchesKey(data, "ctrl+d") && this.dialog === undefined && this.editor.getText().length === 0) {
      this.deliver({ kind: "exit" });
      return { consume: true };
    }
    return undefined;
  }

  private submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    this.editor.addToHistory(trimmed);
    this.editor.setText("");
    if (trimmed === "/exit" || trimmed === "/quit") {
      this.deliver({ kind: "exit" });
      return;
    }
    this.transcript.addChild(new Text(`${this.style.cyan(">")} ${sanitizeTerminalText(trimmed)}`, 0, 0));
    this.tui.requestRender();
    this.deliver({ kind: trimmed.startsWith("/") ? "command" : "message", text: trimmed });
  }

  private nextInput(signal: AbortSignal): Promise<InputResult> {
    const pending = this.pendingInputs.shift();
    if (pending !== undefined) return Promise.resolve(pending);
    return new Promise((resolve, reject) => {
      const waiter = (result: InputResult): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        const index = this.inputWaiters.indexOf(waiter);
        if (index !== -1) this.inputWaiters.splice(index, 1);
        reject(new DOMException("The input request was aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.inputWaiters.push(waiter);
    });
  }

  private deliver(result: InputResult | Interruption): void {
    const waiter = this.inputWaiters.shift();
    if (waiter === undefined) this.pendingInputs.push(result);
    else waiter(result);
  }

  private consume(event: RenderEvent): void {
    switch (event.kind) {
      case "session-event":
        this.onSessionEvent(event.event);
        break;
      case "stream":
        this.onStream(event.requestId, event.event);
        break;
      case "status":
        this.status.set(formatStatus(event.status));
        break;
      case "notice":
        this.appendLine({ level: event.level, text: sanitizeInline(event.message, 1000) });
        break;
    }
    this.tui.requestRender();
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.type === "turn/started") this.setActivity("turn", true);
    if (event.type === "turn/ended") this.setActivity("turn", false);
    if (event.type.startsWith("tool/")) {
      const card = this.tools.applyEvent(event);
      if (card !== undefined) {
        this.showCard(card);
        return;
      }
    }
    const line = describeEvent(event, { policyMode: this.options.policyMode });
    if (line !== undefined) this.appendLine(line);
  }

  private onStream(requestId: string, event: ModelStreamEvent): void {
    switch (event.type) {
      case "start":
        this.setActivity("request", true);
        return;
      case "text_delta": {
        const part = this.streamPart(requestId, event.index);
        part.raw += event.text;
        part.view.setText(sanitizeTerminalText(part.raw));
        return;
      }
      case "tool_call_start":
      case "tool_call_delta":
      case "tool_call_end": {
        const card = this.tools.applyStream(event);
        if (card !== undefined) this.showCard(card);
        return;
      }
      case "done": {
        event.message.content.forEach((content, index) => {
          if (content.type !== "text") return;
          const part = this.streamPart(requestId, index);
          part.raw = content.text;
          part.view.setText(sanitizeTerminalText(content.text));
        });
        this.streams.delete(requestId);
        this.setActivity("request", false);
        return;
      }
      case "error": {
        this.streams.delete(requestId);
        const card = this.tools.failStreaming(event.error.code === "cancelled" ? "request cancelled" : "model stream failed");
        if (card !== undefined) this.showCard(card);
        this.appendLine(
          event.error.code === "cancelled"
            ? { level: "warning", text: "Request cancelled." }
            : { level: "error", text: `Model request failed (${event.error.code}): ${sanitizeInline(event.error.message)}` },
        );
        this.setActivity("request", false);
        return;
      }
      default:
        return;
    }
  }

  private setActivity(kind: "turn" | "request", active: boolean): void {
    if (kind === "turn") this.turnActive = active;
    else this.requestActive = active;
    this.interrupts.setActive(this.turnActive || this.requestActive, active);
  }

  private streamPart(requestId: string, index: number): { readonly view: Markdown; raw: string } {
    const state = this.streams.get(requestId) ?? { parts: new Map() };
    this.streams.set(requestId, state);
    const existing = state.parts.get(index);
    if (existing !== undefined) return existing;
    const view = new Markdown("", 0, 0, this.markdownTheme);
    this.transcript.addChild(view);
    const part = { view, raw: "" };
    state.parts.set(index, part);
    return part;
  }

  private showCard(card: ToolCard): void {
    const existing = this.toolViews.get(card.key);
    if (existing !== undefined) {
      existing.update(card);
      return;
    }
    const view = new ToolCardView(card, this.style);
    this.toolViews.set(card.key, view);
    this.transcript.addChild(view);
  }

  private appendLine(line: EventLine): void {
    const text = `${levelPrefix(line.level)}${line.text}`;
    const painted =
      line.level === "success"
        ? this.style.green(text)
        : line.level === "warning"
          ? this.style.yellow(text)
          : line.level === "error"
            ? this.style.red(text)
            : this.style.dim(text);
    this.transcript.addChild(new Text(painted, 0, 0));
    if (this.started && !this.stopped) this.tui.requestRender();
  }

  private openDialog(component: Component, focus: Component, cancel: () => void): void {
    this.dialog?.cancel();
    const handle = this.tui.showOverlay(component, { anchor: "bottom-center", width: "90%", margin: 1 });
    this.tui.setFocus(focus);
    this.dialog = { handle, cancel };
    this.tui.requestRender();
  }

  private closeDialog(): void {
    const dialog = this.dialog;
    this.dialog = undefined;
    dialog?.handle.hide();
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  private requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return withApprovalDeadline(request, this.options.policyMode, signal, this.clock, (promptSignal) =>
      new Promise<ApprovalChoice>((resolve, reject) => {
        const items = [{ value: "allowed-once", label: "Allow once" }];
        if (request.scope !== "once") items.push({ value: "allowed-for-scope", label: `Allow for this ${request.scope}` });
        items.push({ value: "rejected", label: "Reject" });
        const list = new SelectList(items, items.length, this.selectTheme);
        const box = new Box(1, 0);
        box.addChild(new Text(this.style.yellow(`Approval needed (${request.subject_kind})`), 0, 0));
        box.addChild(new Text(sanitizeInline(request.summary, 2000), 0, 0));
        if (request.effect !== undefined) box.addChild(new Text(this.style.dim(`effect ${request.effect} · scope ${request.scope}`), 0, 0));
        box.addChild(list);
        let settled = false;
        const finish = (outcome: ApprovalChoice | undefined): void => {
          if (settled) return;
          settled = true;
          promptSignal.removeEventListener("abort", onAbort);
          this.closeDialog();
          if (outcome === undefined) reject(new DOMException("The approval prompt was cancelled", "AbortError"));
          else resolve(outcome);
        };
        const onAbort = (): void => finish(undefined);
        promptSignal.addEventListener("abort", onAbort, { once: true });
        list.onSelect = (item) => finish(item.value as ApprovalChoice);
        list.onCancel = () => finish("rejected");
        this.openDialog(box, list, () => finish(undefined));
      }),
    );
  }

  private async openUrl(url: string): Promise<boolean> {
    this.appendLine({ level: "info", text: `Open this URL in a browser: ${url}` });
    return openBrowser(url, this.options.environment, this.options.launch);
  }

  private showDeviceCode(prompt: DeviceCodePrompt): void {
    this.appendLine({ level: "warning", text: deviceCodeText(prompt).trim() });
  }

  private promptSecret(label: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const input = new SecretInput(sanitizeInline(label, 100));
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.closeDialog();
        if (value === undefined) reject(new DOMException("The secret prompt was cancelled", "AbortError"));
        else resolve(value);
      };
      const onAbort = (): void => finish(undefined);
      if (signal.aborted) {
        reject(new DOMException("The secret prompt was cancelled", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      input.onSubmit = (value) => finish(value);
      input.onCancel = () => finish(undefined);
      this.openDialog(input, input, () => finish(undefined));
    });
  }

  private acknowledge(notice: AuthNotice, signal: AbortSignal): Promise<boolean> {
    if (!notice.requiresAcknowledgement) {
      this.appendLine({ level: "warning", text: `notice: ${sanitizeInline(notice.text, 1000)}` });
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const list = new SelectList(
        [
          { value: "yes", label: "I understand, continue" },
          { value: "no", label: "Cancel" },
        ],
        2,
        this.selectTheme,
      );
      const box = new Box(1, 0);
      box.addChild(new Text(this.style.yellow(sanitizeInline(notice.text, 1000)), 0, 0));
      box.addChild(list);
      let settled = false;
      const finish = (accepted: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.closeDialog();
        resolve(accepted);
      };
      const onAbort = (): void => finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      list.onSelect = (item) => finish(item.value === "yes");
      list.onCancel = () => finish(false);
      this.openDialog(box, list, () => finish(false));
    });
  }
}

export function formatStatus(status: StatusLine): string {
  return sanitizeInline(
    [
      status.runId,
      status.task,
      status.model,
      status.step,
      status.budgetUsed === undefined ? undefined : `${status.budgetUsed}${status.budgetLimit === undefined ? "" : `/${status.budgetLimit}`}`,
      status.workersRunning > 0 ? `${status.workersRunning} worker(s)` : undefined,
      status.pendingApproval === undefined ? undefined : `approval: ${status.pendingApproval}`,
      status.lastVerification === undefined ? undefined : `verify: ${status.lastVerification}`,
    ]
      .filter((part): part is string => part !== undefined && part !== "")
      .join(" · "),
  );
}
