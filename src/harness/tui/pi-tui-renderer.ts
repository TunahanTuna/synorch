import { writeSync } from "node:fs";
import {
  Box,
  Container,
  CURSOR_MARKER,
  Editor,
  getNativeClipboard,
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
  Attachment,
  AuthInteraction,
  AuthNotice,
  CommandPaletteEntry,
  DeviceCodePrompt,
  InteractiveInputControls,
  ModelPickerEntry,
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
import { withApprovalDeadline, type ApprovalChoice } from "./approvals.ts";
import {
  activityText,
  ConversationPresenter,
  footerText,
  GLYPH_SETS,
  headerLines,
  type ConversationItem,
  type DiffLine,
  type GlyphSet,
  type ViewOp,
} from "./conversation-view.ts";
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
import { AttachmentTray } from "./input/attachments.ts";
import { InputCompletionProvider } from "./input/autocomplete.ts";
import { imagePathFromPaste, readClipboardImage, type ClipboardImage } from "./input/clipboard.ts";
import { DEFAULT_COMMAND_PALETTE, mergeCommands, requiresArgument } from "./input/commands.ts";
import { WorkspaceFileIndex } from "./input/file-index.ts";
import { isMouseSequence, MOUSE_DISABLE_SEQUENCE, MOUSE_ENABLE_SEQUENCE, parseSgrMouse, TranscriptViewport, type MouseInput } from "./input/mouse.ts";
import type { HarnessView, OrchestrationView, ViewHost } from "../contracts/views.ts";
import { LiveBoardComponent, StaticViewComponent, type ViewStyleOptions } from "./views/index.ts";

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
  /**
   * `conversation` (ADR-21, TUI experience §8): the quiet main conversation view of `syn agent`
   * (user/assistant messages, tool one-liners, activity line, footer). Default: the event view.
   */
  readonly view?: "events" | "conversation";
  readonly glyphs?: GlyphSet;
  /** L2: raw event lines under the conversation (`--debug`, `SYN_DEBUG=1`). */
  readonly debug?: boolean;
  /** Root for `@` completion and mention attachments; defaults to the header's workspace root. */
  readonly workspaceRoot?: string;
  /** Pre-built path index (tests); otherwise one is created for the workspace root. */
  readonly fileIndex?: WorkspaceFileIndex;
  /** Start with SGR mouse reporting on (default: `SYN_MOUSE=1`, otherwise off so native selection works). */
  readonly mouse?: boolean;
  /** Clipboard image reader (tests); defaults to pi-tui's native helper, then the platform tools. */
  readonly readClipboardImage?: () => Promise<ClipboardImage | undefined>;
  /** Clipboard text reader used when Ctrl+V reaches the app instead of the terminal pasting. */
  readonly readClipboardText?: () => Promise<string | undefined>;
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

/** Bold `>` user line with a blank line above (TUI §8.2). */
class UserMessageView implements Component {
  private readonly text: string;
  private readonly style: Styler;

  public constructor(text: string, style: Styler) {
    this.text = text;
    this.style = style;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const [first = "", ...rest] = this.text.split("\n");
    return ["", fit(`${this.style.bold(">")} ${this.style.bold(first)}`, width), ...rest.map((line) => fit(`  ${this.style.bold(line)}`, width))];
  }
}

/** `● ` + streamed Markdown, continuation lines indented by two columns. */
class AssistantMessageView implements Component {
  private readonly markdown: Markdown;
  private readonly bullet: string;

  public constructor(markdown: Markdown, bullet: string) {
    this.markdown = markdown;
    this.bullet = bullet;
  }

  public setText(text: string): void {
    this.markdown.setText(text);
  }

  public invalidate(): void {
    this.markdown.invalidate();
  }

  public render(width: number): string[] {
    const lines = this.markdown.render(Math.max(1, width - 2));
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    return ["", ...lines.map((line, index) => fit(`${index === 0 ? this.bullet : " "} ${line}`, width))];
  }
}

/** `● Verb target` + `  ⎿ summary` + an edit diff of at most 8 lines (Ctrl+O shows the detail). */
class ToolLineView implements Component {
  private item: Extract<ConversationItem, { kind: "tool" }>;
  private readonly style: Styler;
  private readonly glyphs: GlyphSet;
  private readonly expanded: () => boolean;

  public constructor(item: Extract<ConversationItem, { kind: "tool" }>, style: Styler, glyphs: GlyphSet, expanded: () => boolean) {
    this.item = item;
    this.style = style;
    this.glyphs = glyphs;
    this.expanded = expanded;
  }

  public update(item: Extract<ConversationItem, { kind: "tool" }>): void {
    this.item = item;
  }

  public get itemId(): string {
    return this.item.id;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const item = this.item;
    const g = this.glyphs;
    const bullet =
      item.status === "ok" ? this.style.green(g.bullet) : item.status === "running" ? this.style.cyan(g.bullet) : item.status === "cancelled" ? this.style.yellow(g.bullet) : this.style.red(item.status === "denied" ? g.fail : g.bullet);
    const lines = ["", fit(`${bullet} ${this.style.bold(item.title)}`, width)];
    if (item.summary !== undefined) {
      const summary = item.status === "denied" || item.status === "failed" ? this.style.red(item.summary) : this.style.dim(item.summary);
      lines.push(fit(`  ${this.style.dim(g.result)} ${summary}`, width));
    }
    const body = this.expanded() && item.detail.length > 0 ? item.detail : item.preview;
    for (const line of body) lines.push(fit(`     ${this.diffLine(line)}`, width));
    return lines;
  }

  private diffLine(line: DiffLine): string {
    if (line.op === "+") return this.style.green(`+ ${line.text}`);
    if (line.op === "-") return this.style.red(`${this.glyphs.minus} ${line.text}`);
    if (line.op === "…") return this.style.dim(`${this.glyphs.ellipsis} ${line.text}`);
    return this.style.dim(line.text);
  }
}

/** The single activity line (TUI §10.1); height 0 while idle. */
class ActivityLineView implements Component {
  private readonly presenter: ConversationPresenter;
  private readonly style: Styler;
  private readonly now: () => number;

  public constructor(presenter: ConversationPresenter, style: Styler, now: () => number) {
    this.presenter = presenter;
    this.style = style;
    this.now = now;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const activity = this.presenter.activity();
    if (activity === undefined) return [];
    const g = this.presenter.glyphs;
    const now = this.now();
    const frame = g.spinner[Math.floor(now / g.spinnerMs) % g.spinner.length] ?? g.bullet;
    return ["", fit(this.style.cyan(activityText(activity, now, frame, g)), width)];
  }
}

/** One dim line under the editor: folder · branch · model · ctx% · quota% (TUI §10.2). */
class FooterView implements Component {
  private readonly text: () => string;
  private readonly style: Styler;

  public constructor(text: () => string, style: Styler) {
    this.text = text;
    this.style = style;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    return [fit(this.style.dim(`  ${this.text()}`), width)];
  }
}

type Interruption = { readonly kind: "interrupt" | "exit" };
type InputResult = Awaited<ReturnType<UserInputSource["next"]>>;

const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
const IMAGE_PATH_HINT = /\.(png|jpe?g|gif|webp)['"]?\s*$/i;

interface StreamState {
  readonly parts: Map<number, { readonly view: Markdown; raw: string }>;
}

export class PiTuiRenderer implements TerminalRenderer, ViewHost {
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
  private readonly presenter: ConversationPresenter | undefined;
  private readonly itemViews = new Map<string, Component>();
  private expanded = false;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private footerLabel: { folder: string; branch: string | undefined; mode: string } = { folder: "", branch: undefined, mode: "" };
  public readonly controls: InteractiveInputControls;
  private readonly completions: InputCompletionProvider;
  private readonly viewport: TranscriptViewport;
  private readonly expandedItems = new Set<string>();
  private readonly attachmentListeners = new Set<(attachment: Attachment) => void>();
  private readonly planListeners = new Set<(on: boolean) => void>();
  private tray: AttachmentTray;
  private inputRoot = process.cwd();
  private planModeOn = false;
  private mouseOn = false;
  private selectMode = false;
  private mousePress: MouseInput | undefined;
  /** K1-U3 views: the live orchestration board sits between the transcript and the activity line. */
  private readonly boardSlot = new Container();
  private board: LiveBoardComponent | undefined;

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
    this.presenter =
      options.view === "conversation"
        ? new ConversationPresenter({ glyphs: options.glyphs ?? GLYPH_SETS.rich, echoesUser: true, debug: options.debug === true, now: () => this.now() })
        : undefined;
    this.editor = new Editor(this.tui, { borderColor: (text) => style.dim(text), selectList: this.selectTheme });
    this.editor.onSubmit = (text) => this.submit(text);
    this.completions = new InputCompletionProvider(mergeCommands(DEFAULT_COMMAND_PALETTE), options.fileIndex);
    this.editor.setAutocompleteProvider(this.completions);
    this.tray = new AttachmentTray(options.workspaceRoot ?? options.fileIndex?.root ?? process.cwd());
    this.viewport = new TranscriptViewport(this.transcript, {
      siblings: () => this.tui.children,
      rows: () => this.terminal.rows,
      hint: (text, width) => fit(style.dim(text), width),
      up: (options.glyphs ?? GLYPH_SETS.rich).name === "ascii" ? "^" : "↑",
    });
    const self = this;
    this.controls = {
      setCommands: (entries) => this.setCommands(entries),
      onAttachment: (listener) => {
        this.attachmentListeners.add(listener);
        return () => this.attachmentListeners.delete(listener);
      },
      openModelPicker: (entries, signal) => this.openModelPicker(entries, signal),
      get planMode() {
        return self.planModeOn;
      },
      setPlanMode: (on) => this.setPlanMode(on),
      onPlanModeChange: (listener) => {
        this.planListeners.add(listener);
        return () => this.planListeners.delete(listener);
      },
      get mouseMode() {
        return self.mouseOn;
      },
      setMouseMode: (on) => this.setMouseMode(on),
    };
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
    if (this.presenter !== undefined) {
      this.startConversation(header, this.presenter);
    } else {
      const lines = [`${this.style.bold("Synorch")} ${this.style.dim(header.workspaceRoot)}${header.gitBranch === undefined ? "" : ` ${this.style.cyan(header.gitBranch)}`}`];
      lines.push(this.style.dim(`policy ${header.policyMode} · sandbox ${header.sandboxEnforcement}`));
      for (const route of header.routes) lines.push(this.style.dim(`${route.tier}: ${route.model} (${route.source})`));
      for (const notice of header.notices) lines.push(this.style.yellow(`notice: ${sanitizeInline(notice)}`));
      this.header.setText(lines.join("\n"));
      this.tui.addChild(this.header);
      this.tui.addChild(this.viewport);
      this.tui.addChild(this.boardSlot);
      this.tui.addChild(this.status);
      this.tui.addChild(this.editor);
    }
    this.startInput(header);
    this.tui.setFocus(this.editor);
    this.removeInputListener = this.tui.addInputListener((data) => this.onKey(data));
    this.tui.start();
    const mouseEnv = this.options.environment.env.SYN_MOUSE;
    if (this.options.mouse ?? (mouseEnv !== undefined && mouseEnv !== "" && mouseEnv !== "0")) this.setMouseMode(true, true);
  }

  public render(event: RenderEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
  }

  /** Conversation view: draws the earlier messages of a resumed conversation. */
  public replay(events: readonly SessionEvent[]): void {
    if (this.presenter === undefined) return;
    for (const op of this.presenter.replay(events)) this.applyOp(op);
    this.tui.requestRender();
  }

  private startConversation(header: SessionHeaderView, presenter: ConversationPresenter): void {
    const folder = header.workspaceRoot.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? header.workspaceRoot;
    presenter.configure({ model: header.model, contextWindowTokens: header.contextWindowTokens });
    this.footerLabel = { folder, branch: header.gitBranch, mode: header.policyMode === "ask" ? "ask mode" : "" };
    const { title, warning } = headerLines({
      version: header.version ?? "",
      folder,
      branch: header.gitBranch,
      model: header.model,
      mode: header.policyMode,
      sandboxEnforcement: header.sandboxEnforcement,
      warnings: header.notices,
      glyphs: presenter.glyphs,
    });
    this.header.setText([this.style.cyan(title), ...(warning === undefined ? [] : [this.style.yellow(warning)])].join("\n"));
    this.tui.addChild(this.header);
    this.tui.addChild(this.viewport);
    this.tui.addChild(this.boardSlot);
    this.tui.addChild(new ActivityLineView(presenter, this.style, () => this.now()));
    this.tui.addChild(new Text("", 0, 0));
    this.tui.addChild(this.editor);
    this.tui.addChild(new FooterView(() => footerText(presenter.footer(), { ...this.footerLabel, glyphs: presenter.glyphs, mode: this.modeLabel(presenter.glyphs.sep) }), this.style));
  }

  private applyOp(op: ViewOp): void {
    const item = op.item;
    const existing = this.itemViews.get(item.id);
    if (existing !== undefined) {
      if (existing instanceof AssistantMessageView && item.kind === "assistant") existing.setText(item.text);
      else if (existing instanceof ToolLineView && item.kind === "tool") existing.update(item);
      return;
    }
    const view = this.viewFor(item);
    this.itemViews.set(item.id, view);
    this.transcript.addChild(view);
  }

  private viewFor(item: ConversationItem): Component {
    const glyphs = this.presenter?.glyphs ?? GLYPH_SETS.rich;
    switch (item.kind) {
      case "user":
        return new UserMessageView(item.text, this.style);
      case "assistant": {
        const view = new AssistantMessageView(new Markdown("", 0, 0, this.markdownTheme), glyphs.bullet);
        view.setText(item.text);
        return view;
      }
      case "tool":
        return new ToolLineView(item, this.style, glyphs, () => this.expanded || this.expandedItems.has(item.id));
      case "note": {
        const text =
          item.level === "error" ? this.style.red(item.text) : item.level === "warning" ? this.style.yellow(item.text) : this.style.dim(item.text);
        return new Text(text, 0, 0);
      }
    }
  }

  private viewStyle(): ViewStyleOptions {
    return { glyphs: this.presenter?.glyphs ?? this.options.glyphs ?? GLYPH_SETS.rich, color: this.style, now: () => this.now() };
  }

  /** Pins a card (usage, evidence, action, why, or a board summary) once to the transcript. */
  public showView(view: HarnessView): void {
    if (this.stopped) return;
    this.transcript.addChild(new StaticViewComponent(view, this.viewStyle()));
    this.tui.requestRender();
  }

  /** `/graph`: pins the plan graph to the transcript. */
  public showGraph(view: OrchestrationView): void {
    if (this.stopped) return;
    this.transcript.addChild(new StaticViewComponent({ kind: "graph", view }, this.viewStyle()));
    this.tui.requestRender();
  }

  /** Keeps one live board in place; a `done` board collapses to its summary, pinned once. */
  public setBoard(view: OrchestrationView | undefined): void {
    if (this.stopped) return;
    if (view === undefined || view.done) {
      this.boardSlot.clear();
      this.board = undefined;
      if (view !== undefined) this.transcript.addChild(new StaticViewComponent(view, this.viewStyle()));
    } else if (this.board === undefined) {
      this.board = new LiveBoardComponent(view, this.viewStyle());
      this.boardSlot.addChild(this.board);
    } else {
      this.board.setView(view);
    }
    this.updateSpinner();
    this.tui.requestRender();
  }

  /** Mode of the live board (`g` / Ctrl+G toggles board and graph); undefined without a board. */
  public get boardMode(): "board" | "graph" | undefined {
    return this.board?.mode;
  }

  private updateSpinner(): void {
    const active = this.presenter?.activity() !== undefined || this.board !== undefined;
    if (active && this.spinner === undefined && this.started && !this.stopped) {
      const interval = this.presenter?.glyphs.spinnerMs ?? 80;
      this.spinner = setInterval(() => this.tui.requestRender(), interval);
      this.spinner.unref?.();
    } else if (!active && this.spinner !== undefined) {
      clearInterval(this.spinner);
      this.spinner = undefined;
    }
  }

  /** Applies Ctrl+C / Esc semantics; key input and tests both go through here. */
  public interrupt(key: InterruptKey): InterruptAction {
    const action = this.interrupts.press(key, this.now());
    if (action === "cancel-request") {
      // The conversation view says "Interrupted" once the turn has actually stopped.
      if (this.presenter === undefined) this.appendLine({ level: "warning", text: INTERRUPT_NOTICES.cancelled });
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
    if (this.spinner !== undefined) clearInterval(this.spinner);
    this.spinner = undefined;
    this.dialog?.cancel();
    this.removeInputListener?.();
    if (this.mouseOn && !this.selectMode) this.terminal.write(MOUSE_DISABLE_SEQUENCE);
    await this.terminal.drainInput(this.options.drainInputMs ?? 300, 50);
    this.tui.stop();
    this.guard?.release();
    this.guard = undefined;
    this.options.codepage?.restore();
  }

  private onKey(data: string): { consume?: boolean; data?: string } | undefined {
    const input = this.onInputKey(data);
    if (input !== undefined) return input;
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
    if (matchesKey(data, "ctrl+o") && this.dialog === undefined && this.presenter !== undefined) {
      this.expanded = !this.expanded;
      this.tui.requestRender(true);
      return { consume: true };
    }
    if (this.board !== undefined && this.dialog === undefined && (matchesKey(data, "ctrl+g") || (data === "g" && this.editor.getText().length === 0 && !this.editor.isShowingAutocomplete()))) {
      this.board.toggleMode();
      this.tui.requestRender(true);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && this.dialog === undefined && this.editor.getText().length === 0) {
      this.deliver({ kind: "exit" });
      return { consume: true };
    }
    return undefined;
  }

  // ---- K1-U1 input: palette, @files, images, plan mode, mouse, model picker ------------------------

  private startInput(header: SessionHeaderView): void {
    const root = this.options.workspaceRoot ?? this.options.fileIndex?.root ?? (header.workspaceRoot === "." ? process.cwd() : header.workspaceRoot);
    this.inputRoot = root;
    this.tray = new AttachmentTray(root);
    const index = this.options.fileIndex ?? new WorkspaceFileIndex({ root });
    this.completions.setFiles(index);
    index.warm();
  }

  private setCommands(entries: readonly CommandPaletteEntry[]): void {
    this.completions.setCommands(mergeCommands(entries));
  }

  /** Footer mode field: select/plan/ask/mouse, joined with the glyph separator. */
  private modeLabel(sep: string): string | undefined {
    const parts: string[] = [];
    if (this.selectMode) parts.push("select mode (esc to exit)");
    if (this.planModeOn) parts.push("plan mode");
    if (this.footerLabel.mode !== "") parts.push(this.footerLabel.mode);
    if (this.mouseOn && !this.selectMode) parts.push("mouse");
    return parts.length === 0 ? undefined : parts.join(` ${sep} `);
  }

  /** Keys owned by the input layer; undefined lets the rest of `onKey` and the editor see them. */
  private onInputKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (isMouseSequence(data)) {
      const event = parseSgrMouse(data);
      if (event !== undefined && this.mouseOn && !this.selectMode) this.handleMouse(event);
      return { consume: true };
    }
    if (this.dialog !== undefined) return undefined;
    const paste = BRACKETED_PASTE.exec(data);
    if (paste !== null) return this.onPaste(paste[1] ?? "", data);
    if (this.selectMode && (matchesKey(data, "escape") || matchesKey(data, "enter"))) {
      this.leaveSelectMode();
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "alt+m")) {
      this.setPlanMode(!this.planModeOn);
      return { consume: true };
    }
    if (matchesKey(data, "alt+v") || matchesKey(data, "ctrl+v")) {
      void this.pasteFromClipboard(matchesKey(data, "ctrl+v"));
      return { consume: true };
    }
    if (this.mouseOn && matchesKey(data, "ctrl+end")) {
      this.viewport.toBottom();
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.mouseOn && (matchesKey(data, "shift+pageUp") || matchesKey(data, "shift+pageDown"))) {
      if (this.viewport.page(matchesKey(data, "shift+pageUp") ? -1 : 1)) this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "enter") && this.editor.isShowingAutocomplete()) {
      // `/plan` + Enter completes to `/plan ` so the required argument can be typed.
      const selected = (this.editor as unknown as { autocompleteList?: SelectList }).autocompleteList?.getSelectedItem();
      const entry = selected === null || selected === undefined ? undefined : this.completions.command(selected.value);
      if (entry !== undefined && selected?.value.startsWith("/") === true && requiresArgument(entry)) return { data: "\t" };
    }
    return undefined;
  }

  private handleMouse(event: MouseInput): void {
    if (event.type === "wheel") {
      if (this.viewport.scroll((event.wheel ?? 0) * -3)) this.tui.requestRender();
      return;
    }
    if (event.button !== "left") return;
    if (event.type === "press") {
      this.mousePress = event;
      return;
    }
    if (event.type !== "release") return;
    const press = this.mousePress;
    this.mousePress = undefined;
    if (press === undefined || press.y !== event.y) return;
    const hit = this.viewport.hit(event.y);
    if (hit instanceof ToolLineView) {
      if (this.expandedItems.has(hit.itemId)) this.expandedItems.delete(hit.itemId);
      else this.expandedItems.add(hit.itemId);
      this.tui.requestRender();
    }
  }

  /** `/mouse [on|off]` and `/select` run in the renderer; everything else goes to the session. */
  private runLocalCommand(text: string): boolean {
    const [command = "", argument = ""] = text.split(/\s+/);
    switch (command.toLowerCase()) {
      case "/mouse": {
        const wanted = argument === "on" ? true : argument === "off" ? false : !this.mouseOn;
        this.setMouseMode(wanted);
        return true;
      }
      case "/select":
        if (this.mouseOn) this.enterSelectMode();
        else this.appendLine({ level: "info", text: "Native text selection is already on (mouse mode is off); select and copy with your terminal." });
        return true;
      default:
        return false;
    }
  }

  private setPlanMode(on: boolean): void {
    if (this.planModeOn === on) return;
    this.planModeOn = on;
    this.editor.borderColor = on ? (text) => this.style.cyan(text) : (text) => this.style.dim(text);
    if (this.presenter === undefined) this.appendLine({ level: "info", text: on ? "Plan mode on: Synorch reads and plans, no edits (Shift+Tab to leave)." : "Plan mode off." });
    for (const listener of this.planListeners) listener(on);
    if (this.started && !this.stopped) this.tui.requestRender();
  }

  private setMouseMode(on: boolean, silent = false): void {
    if (this.mouseOn === on) return;
    this.mouseOn = on;
    if (!on) this.selectMode = false;
    this.viewport.enabled = on;
    this.viewport.toBottom();
    this.mousePress = undefined;
    if (this.started && !this.stopped) {
      this.terminal.write(on ? MOUSE_ENABLE_SEQUENCE : MOUSE_DISABLE_SEQUENCE);
      if (!silent) {
        this.appendLine({
          level: "info",
          text: on
            ? "Mouse on: the wheel scrolls, a click expands a tool row. Native selection is off: hold Shift to select, or /select. /mouse off turns it off."
            : "Mouse off: native text selection and scrollback are back.",
        });
      }
      this.tui.requestRender(true);
    }
  }

  /** Copy-friendly: mouse reporting off and the full transcript drawn, until Esc or Enter. */
  private enterSelectMode(): void {
    if (this.selectMode || !this.mouseOn) return;
    this.selectMode = true;
    this.viewport.enabled = false;
    this.terminal.write(MOUSE_DISABLE_SEQUENCE);
    this.tui.requestRender(true);
  }

  private leaveSelectMode(): void {
    if (!this.selectMode) return;
    this.selectMode = false;
    if (this.mouseOn) {
      this.viewport.enabled = true;
      this.viewport.toBottom();
      this.terminal.write(MOUSE_ENABLE_SEQUENCE);
    }
    this.tui.requestRender(true);
  }

  /**
   * Bracketed paste: an empty paste usually means the clipboard holds only an image (Windows
   * Terminal, iTerm2); a single pasted/dragged image path becomes an image chip. Other text goes to
   * the editor unchanged (large pastes collapse to `[paste #n +N lines]` there).
   */
  private onPaste(content: string, raw: string): { consume?: boolean; data?: string } | undefined {
    if (content.trim() === "") {
      void this.pasteFromClipboard(false);
      return { consume: true };
    }
    if (content.includes("\n") || !IMAGE_PATH_HINT.test(content)) return undefined;
    void imagePathFromPaste(content, this.inputRoot).then((image) => {
      if (this.stopped) return;
      if (image === undefined) this.editor.handleInput(raw);
      else this.attachImage(image, "paste-path");
      this.tui.requestRender();
    });
    return { consume: true };
  }

  private async pasteFromClipboard(textFallback: boolean): Promise<void> {
    const reader =
      this.options.readClipboardImage ??
      (() => {
        let native;
        try {
          native = getNativeClipboard();
        } catch {
          native = undefined;
        }
        return readClipboardImage({ platform: this.options.environment.platform, env: this.options.environment.env, native });
      });
    let image: ClipboardImage | undefined;
    try {
      image = await reader();
    } catch {
      image = undefined;
    }
    if (this.stopped) return;
    if (image !== undefined) {
      this.attachImage(image, "clipboard");
      this.tui.requestRender();
      return;
    }
    if (textFallback) {
      // Ctrl+V reached the app, so the terminal did not paste: insert the clipboard text ourselves.
      let text: string | undefined;
      try {
        text = this.options.readClipboardText !== undefined ? await this.options.readClipboardText() : ((await getNativeClipboard()?.getText()) ?? undefined);
      } catch {
        text = undefined;
      }
      if (text !== undefined && text !== "") {
        this.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
        this.tui.requestRender();
        return;
      }
    }
    this.appendLine({ level: "info", text: "No image in the clipboard. Copy an image and press Alt+V (or paste an image file path)." });
  }

  private attachImage(image: ClipboardImage, source: "clipboard" | "paste-path"): void {
    const attachment = this.tray.addImage(image, source);
    const cursor = this.editor.getCursor();
    const line = this.editor.getLines()[cursor.line] ?? "";
    const before = line.slice(0, cursor.col);
    this.editor.insertTextAtCursor(`${before === "" || before.endsWith(" ") ? "" : " "}${attachment.label} `);
    for (const listener of this.attachmentListeners) listener(attachment);
  }

  /** `/model` picker: rows come from the session, which also applies the choice (U2). */
  private openModelPicker(entries: readonly ModelPickerEntry[], signal?: AbortSignal): Promise<ModelPickerEntry | undefined> {
    if (entries.length === 0 || this.stopped) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const glyphs = this.presenter?.glyphs ?? GLYPH_SETS.rich;
      const tierWidth = Math.min(14, Math.max(...entries.map((entry) => entry.tier.length)));
      const items = entries.map((entry, index) => ({
        value: String(index),
        label: `${entry.current ? glyphs.bullet : " "} ${entry.tier.padEnd(tierWidth)}  ${entry.provider}/${entry.model}`,
        description: [entry.auth, entry.current ? "current" : undefined, entry.disabled, entry.description].filter((part) => part !== undefined && part !== "").join(` ${glyphs.sep} `),
      }));
      const list = new SelectList(items, Math.min(items.length, 10), this.selectTheme, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 60 });
      const current = entries.findIndex((entry) => entry.current);
      if (current >= 0) list.setSelectedIndex(current);
      const box = new Box(1, 0);
      box.addChild(new Text(this.style.cyan("Select model"), 0, 0));
      box.addChild(new Text(this.style.dim("route per tier · provider/model · auth  —  Enter selects, Esc cancels"), 0, 0));
      box.addChild(list);
      let settled = false;
      const finish = (entry: ModelPickerEntry | undefined): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.closeDialog();
        resolve(entry);
      };
      const onAbort = (): void => finish(undefined);
      if (signal?.aborted === true) {
        resolve(undefined);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      list.onSelect = (item) => {
        const entry = entries[Number(item.value)];
        if (entry === undefined || entry.disabled !== undefined) return;
        finish(entry);
      };
      list.onCancel = () => finish(undefined);
      this.openDialog(box, list, () => finish(undefined));
    });
  }

  private submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    this.editor.addToHistory(trimmed);
    this.editor.setText("");
    this.viewport.toBottom();
    if (trimmed === "/exit" || trimmed === "/quit") {
      this.deliver({ kind: "exit" });
      return;
    }
    if (this.runLocalCommand(trimmed)) return;
    const attachments = this.tray.collect(trimmed);
    this.transcript.addChild(
      this.presenter !== undefined ? new UserMessageView(sanitizeTerminalText(trimmed), this.style) : new Text(`${this.style.cyan(">")} ${sanitizeTerminalText(trimmed)}`, 0, 0),
    );
    this.tui.requestRender();
    this.deliver({ kind: trimmed.startsWith("/") ? "command" : "message", text: trimmed, ...(attachments.length === 0 ? {} : { attachments }) });
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
    if (this.presenter !== undefined) {
      if (event.kind === "session-event" && event.event.type === "turn/started") this.setActivity("turn", true);
      if (event.kind === "session-event" && event.event.type === "turn/ended") this.setActivity("turn", false);
      for (const op of this.presenter.apply(event)) this.applyOp(op);
      this.updateSpinner();
      this.tui.requestRender();
      return;
    }
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
    if (this.presenter !== undefined) {
      this.applyOp(this.presenter.note(line.level === "success" ? "info" : line.level, line.text));
      if (this.started && !this.stopped) this.tui.requestRender();
      return;
    }
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
    this.presenter?.setWaiting(true);
    const decided = this.promptApproval(request, signal);
    void decided.finally(() => {
      this.presenter?.setWaiting(false);
      if (this.started && !this.stopped) this.tui.requestRender();
    }).catch(() => undefined);
    return decided;
  }

  private promptApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return withApprovalDeadline(request, this.options.policyMode, signal, this.clock, (promptSignal) =>
      new Promise<ApprovalChoice>((resolve, reject) => {
        const trust = request.subject_kind === "workspace-trust";
        const items: { value: string; label: string }[] = [];
        if (trust) {
          // "Not now" first, so the pre-selected answer never trusts anything.
          for (const choice of WORKSPACE_TRUST_CHOICES) items.push({ value: choice.outcome, label: choice.label });
        } else {
          items.push({ value: "allowed-once", label: "Allow once" });
          if (request.scope !== "once") items.push({ value: "allowed-for-scope", label: `Allow for this ${request.scope}` });
          items.push({ value: "rejected", label: "Reject" });
        }
        const list = new SelectList(items, items.length, this.selectTheme);
        const box = new Box(1, 0);
        box.addChild(new Text(this.style.yellow(trust ? (this.presenter !== undefined ? "Trust this folder?" : "Trust this workspace?") : `Approval needed (${request.subject_kind})`), 0, 0));
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
