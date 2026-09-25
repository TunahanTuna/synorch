import { writeSync } from "node:fs";
import {
  Box,
  Container,
  CURSOR_MARKER,
  decodeKittyPrintable,
  Editor,
  getNativeClipboard,
  Input,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type SelectListTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import type {
  AppearanceControls,
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  AuthInteraction,
  AuthNotice,
  ChoiceAnswer,
  ChoiceQuestion,
  CommandPaletteEntry,
  DeviceCodePrompt,
  InteractiveInputControls,
  ModelPickerEntry,
  PickerHeading,
  ModelStreamEvent,
  PermissionMode,
  PolicyMode,
  RenderEvent,
  SessionEvent,
  SessionHeaderView,
  SessionWelcomeView,
  StatusLine,
  TerminalRenderer,
  UserInputSource,
  WelcomePreferences,
} from "../contracts/index.ts";
import { choiceAnswerText, nextPermissionMode, WORKSPACE_TRUST_CHOICES } from "../contracts/index.ts";
import { ChoiceModal, type ChoiceModalOptions } from "./choice-modal.ts";
import { actionChoices, actionTitle, withApprovalDeadline, type ApprovalAnswer, type ApprovalChoice } from "./approvals.ts";
import {
  activityText,
  ConversationPresenter,
  GLYPH_SETS,
  headerLines,
  type ConversationItem,
  type FooterState,
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
import { createStyler, type Styler, type ThemedStyler } from "./style.ts";
import { BUILTIN_THEMES, type ColorDepth, type ThemeDefinition } from "./theme.ts";
import {
  FULL_MIN_ROWS,
  logoLines,
  MINIMAL_WELCOME,
  renderWelcome,
  themePreview,
  WELCOME_FIELDS,
  type WelcomeField,
  type WelcomeInfo,
  type WelcomeSettings,
} from "./welcome.ts";
import {
  ConsoleCodepageGuard,
  EMERGENCY_RESTORE_SEQUENCE,
  installTerminalGuard,
  type GuardProcess,
  type GuardSignal,
  type TerminalGuard,
} from "./terminal-lifecycle.ts";
import { TOOL_STATUS_LABEL, ToolCardTracker, type ToolCard } from "./tool-cards.ts";
import { diffLine, renderToolRow, type ToolRowPaint } from "./tool-row.ts";
import { splitMarker, wrapHanging, type TextWrapper } from "./wrap.ts";

/** Grapheme- and wide-char-aware word wrap for the transcript (plain text in, plain lines out). */
const wrapText: TextWrapper = (text, width) => wrapTextWithAnsi(text, width);
import { AttachmentTray } from "./input/attachments.ts";
import { InputCompletionProvider } from "./input/autocomplete.ts";
import { imagePathFromPaste, readClipboardImage, type ClipboardImage } from "./input/clipboard.ts";
import { DEFAULT_COMMAND_PALETTE, mergeCommands, requiresArgument } from "./input/commands.ts";
import { WorkspaceFileIndex } from "./input/file-index.ts";
import { isMouseSequence, MOUSE_DISABLE_SEQUENCE, MOUSE_ENABLE_SEQUENCE, parseSgrMouse, TranscriptViewport, type MouseInput } from "./input/mouse.ts";
import type { HarnessView, MemorySeam, OrchestrationTaskView, OrchestrationView, ViewHost, WorkerAssignmentView, WorkerSeam, WorkerStreamEvent } from "../contracts/views.ts";
import {
  cycleWorker,
  DelegationComponent,
  initialSelection,
  LiveBoardComponent,
  MemoryGraphComponent,
  moveSelection,
  renderAssignment,
  renderWorkerHeader,
  StaticViewComponent,
  UserToWorkerComponent,
  viewContext,
  type SelectionMove,
  type ViewStyleOptions,
} from "./views/index.ts";

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
  /** K8: the theme to paint with (default: the 16-colour ANSI mapping) and the colour depth it is resolved at. */
  readonly theme?: ThemeDefinition;
  readonly colorDepth?: ColorDepth;
  /** K8: every theme `/theme` offers (default: the built-ins). */
  readonly themes?: readonly ThemeDefinition[];
  /** K8: the welcome header (conversation view). Default: the one-line title of before K8. */
  readonly welcome?: WelcomeSettings;
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

function errorText(error: unknown): string {
  return sanitizeInline(error instanceof Error ? error.message : String(error), 300);
}

/**
 * The editor with a placeholder (K1.7: `message convert-mocks…` while a worker view is open),
 * drawn after the cursor on the empty first line.
 */
class ChatEditor extends Editor {
  public placeholder: string | undefined;
  public placeholderStyle: (text: string) => string = (text) => text;
  /** Conversation view: a `> ` prompt in front of the first line makes the input the obvious place to type. */
  public prompt: ((text: string) => string) | undefined;
  /** ASCII glyph set: the rules are drawn with `-`. */
  public ascii = false;
  /** Separator glyph substituted for `{sep}` in the placeholder. */
  public sep = "·";

  public override render(width: number): string[] {
    const gutter = this.prompt === undefined || width < 12 ? 0 : 2;
    const inner = width - gutter;
    const lines = super.render(inner);
    if (this.placeholder !== undefined && this.getText().length === 0 && lines.length >= 3) {
      const line = lines[1] ?? "";
      const reset = "\x1b[0m";
      const cursorEnd = line.indexOf(reset);
      const head = cursorEnd === -1 ? "" : line.slice(0, cursorEnd + reset.length);
      const room = inner - visibleWidth(head) - 1;
      if (cursorEnd !== -1 && room >= 4) {
        const drawn = head + this.placeholderStyle(truncateToWidth(this.placeholder.replaceAll("{sep}", this.sep), room, this.ascii ? "..." : "…"));
        lines[1] = drawn + " ".repeat(Math.max(0, inner - visibleWidth(drawn)));
      }
    }
    const visible = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount ?? 1;
    const border = (line: string): string => (this.ascii ? line.replaceAll("─", "-") : line);
    if (gutter === 0 || this.prompt === undefined) return lines.map((line, index) => (index === 0 || index === visible + 1 ? border(line) : line));
    const rule = this.borderColor((this.ascii ? "-" : "─").repeat(gutter));
    return lines.map((line, index) => {
      if (index === 0 || index === visible + 1) return rule + border(line);
      if (index === 1) return (this.prompt ?? ((text: string) => text))(">") + " " + line;
      return " ".repeat(gutter) + line;
    });
  }
}

interface ItemViewDeps {
  readonly style: Styler;
  readonly glyphs: GlyphSet;
  readonly markdownTheme: MarkdownTheme;
  readonly expanded: (itemId: string) => boolean;
}

/** One conversation item as a component; shared by the main transcript and the worker view. */
function conversationItemView(item: ConversationItem, deps: ItemViewDeps, previous?: Component): Component {
  switch (item.kind) {
    case "result":
      return new ResultLineView(item, deps.style, deps.glyphs);
    case "user":
      return new UserMessageView(item.text, deps.style, deps.glyphs, () => deps.expanded(item.id));
    case "assistant": {
      const view = new AssistantMessageView(new Markdown("", 0, 0, deps.markdownTheme), deps.glyphs.bullet);
      view.setText(item.text);
      return view;
    }
    case "tool":
      return new ToolLineView(item, deps.style, deps.glyphs, () => deps.expanded(item.id), !(previous instanceof ToolLineView));
    case "note": {
      const paint = item.level === "error" ? deps.style.red : item.level === "warning" ? deps.style.yellow : deps.style.dim;
      return new NoteView(item.text, paint);
    }
  }
}

function updateItemView(view: Component, item: ConversationItem): void {
  if (view instanceof AssistantMessageView && item.kind === "assistant") view.setText(item.text);
  else if (view instanceof ToolLineView && item.kind === "tool") view.update(item);
}

interface WorkerPaneDeps extends ItemViewDeps {
  readonly now: () => number;
  /** The task as the live board last reported it. */
  readonly task: (key: string) => OrchestrationTaskView | undefined;
  /** Status word overriding the board's (optimistic `pausing…`, `cancelling…`). */
  readonly status: (key: string) => string | undefined;
  readonly allExpanded: () => boolean;
  readonly rows: () => number;
  readonly siblings: () => readonly Component[];
}

/**
 * The worker view (K1.7): header, the pinned assignment, then the worker's live transcript with the
 * conversation rules. It takes the transcript's place in the tree; the board stays below it. The
 * transcript is tailed so the header and assignment stay on screen.
 */
class WorkerPane implements Component {
  public readonly key: string;
  private assignment: WorkerAssignmentView | undefined;
  private readonly deps: WorkerPaneDeps;
  private readonly items: Component[] = [];
  private readonly itemViews = new Map<string, Component>();
  private readonly presenter: ConversationPresenter;
  private unsubscribe: (() => void) | undefined;

  public constructor(key: string, deps: WorkerPaneDeps) {
    this.key = key;
    this.deps = deps;
    this.presenter = new ConversationPresenter({ glyphs: deps.glyphs, echoesUser: true, now: deps.now });
  }

  public attach(seam: WorkerSeam | undefined): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (seam === undefined) {
      this.applyOp(this.presenter.note("info", "No worker transcript is connected yet."));
      return;
    }
    try {
      this.unsubscribe = seam.stream.subscribe(this.key, (event) => this.apply(event));
    } catch (error) {
      this.applyOp(this.presenter.note("error", `Could not open the worker's transcript: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  public dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  public apply(event: WorkerStreamEvent): void {
    if (event.kind === "assignment") {
      this.assignment = event.assignment;
      return;
    }
    for (const op of this.presenter.apply(event)) this.applyOp(op);
  }

  public addUser(text: string): void {
    this.items.push(new UserMessageView(sanitizeTerminalText(text), this.deps.style, this.deps.glyphs, this.deps.allExpanded));
  }

  public note(level: "info" | "warning" | "error", text: string): void {
    this.applyOp(this.presenter.note(level, text));
  }

  private applyOp(op: ViewOp): void {
    const existing = this.itemViews.get(op.item.id);
    if (existing !== undefined) {
      updateItemView(existing, op.item);
      return;
    }
    const view = conversationItemView(op.item, this.deps, this.items.at(-1));
    this.itemViews.set(op.item.id, view);
    this.items.push(view);
  }

  public invalidate(): void {
    for (const item of this.items) item.invalidate();
  }

  public render(width: number): string[] {
    const ctx = viewContext({ glyphs: this.deps.glyphs, color: this.deps.style, width, now: this.deps.now() });
    const task = this.deps.task(this.key) ?? { key: this.key, role: "worker", state: "running" as const };
    const top = ["", ...renderWorkerHeader(task, ctx, { status: this.deps.status(this.key) }), ...renderAssignment(this.assignment, ctx, { expanded: this.deps.allExpanded() })];
    const body: string[] = [];
    for (const item of this.items) body.push(...item.render(width));
    if (body.length === 0) body.push("", fit(this.deps.style.dim("  no worker output yet"), width));
    // Tail the transcript so the header and the assignment stay pinned on screen.
    const siblings = this.deps.siblings();
    let others = 0;
    for (const sibling of siblings) if (sibling !== this) others += sibling.render(width).length;
    const room = this.deps.rows() - others - top.length - 1;
    if (room >= 3 && body.length > room) {
      const hidden = body.length - (room - 1);
      const up = this.deps.glyphs.name === "ascii" ? "^" : "↑";
      return [...top, fit(this.deps.style.dim(`  ${up} ${hidden} earlier line(s)`), width), ...body.slice(hidden), ""];
    }
    return [...top, ...body, ""];
  }
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

/** Longer pastes than this collapse to their first lines + `[+N lines]` (Ctrl+O shows all). */
const USER_COLLAPSE_LINES = 30;
const USER_COLLAPSED_SHOWN = 12;

/**
 * Bold `>` user line with a blank line above (TUI §8.2). The user's own message is never cut: it
 * word-wraps with a hanging indent at the current width. Only a very long paste collapses.
 */
class UserMessageView implements Component {
  private readonly text: string;
  private readonly style: Styler;
  private readonly glyphs: GlyphSet;
  private readonly expanded: () => boolean;

  public constructor(text: string, style: Styler, glyphs: GlyphSet, expanded: () => boolean) {
    this.text = text;
    this.style = style;
    this.glyphs = glyphs;
    this.expanded = expanded;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const lines = wrapHanging("> ", this.text.trimEnd(), width, { wrapText }).map((line) => this.style.user(line));
    if (lines.length <= USER_COLLAPSE_LINES || this.expanded()) return ["", ...lines];
    const hidden = lines.length - USER_COLLAPSED_SHOWN;
    return ["", ...lines.slice(0, USER_COLLAPSED_SHOWN), this.style.dim(`  ${this.glyphs.ellipsis} [+${hidden} lines] ctrl+o shows all`)];
  }
}

/** A notice line: word-wrapped under its marker (`●`, `→`, `1.`) instead of cut or flush-left. */
class NoteView implements Component {
  private readonly text: string;
  private readonly paint: (text: string) => string;

  public constructor(text: string, paint: (text: string) => string) {
    this.text = text;
    this.paint = paint;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const { prefix, body } = splitMarker(this.text);
    return wrapHanging(prefix, body, width, { wrapText }).map((line) => this.paint(line));
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

function toolPaint(style: Styler): ToolRowPaint {
  return { ok: style.success, fail: style.danger, warn: style.warning, running: style.accent, dim: style.muted, bold: style.tool, add: style.diffAdd, remove: style.diffRemove };
}

/** `✓ Verb target  stat` (+ `⎿ reason` on trouble) + an edit diff of at most 8 lines (Ctrl+O shows the detail). */
class ToolLineView implements Component {
  private item: Extract<ConversationItem, { kind: "tool" }>;
  private readonly style: Styler;
  private readonly glyphs: GlyphSet;
  private readonly expanded: () => boolean;
  private readonly gap: boolean;

  public constructor(item: Extract<ConversationItem, { kind: "tool" }>, style: Styler, glyphs: GlyphSet, expanded: () => boolean, gap = true) {
    this.item = item;
    this.style = style;
    this.glyphs = glyphs;
    this.expanded = expanded;
    this.gap = gap;
  }

  public update(item: Extract<ConversationItem, { kind: "tool" }>): void {
    this.item = item;
  }

  public get itemId(): string {
    return this.item.id;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    return renderToolRow(this.item, { width, glyphs: this.glyphs, paint: toolPaint(this.style), expanded: this.expanded(), gap: this.gap, measure: visibleWidth, fit, wrapText });
  }
}

/** The turn-end result line: `Changed src/a.ts (+8 −3) · Tests: 12 passed · /diff for details`. */
class ResultLineView implements Component {
  private readonly item: Extract<ConversationItem, { kind: "result" }>;
  private readonly style: Styler;
  private readonly glyphs: GlyphSet;

  public constructor(item: Extract<ConversationItem, { kind: "result" }>, style: Styler, glyphs: GlyphSet) {
    this.item = item;
    this.style = style;
    this.glyphs = glyphs;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const g = this.glyphs;
    const glyph = this.item.tone === "ok" ? this.style.green(g.ok) : this.item.tone === "error" ? this.style.red(g.fail) : this.style.yellow(g.warn);
    const [head = "", ...rest] = this.item.text.split(` ${g.sep} `);
    const tail = rest.map((part) => (/^Tests: not run/.test(part) ? this.style.yellow(part) : /failed/.test(part) ? this.style.red(part) : this.style.dim(part)));
    const text = [this.style.bold(head), ...tail].join(this.style.dim(` ${g.sep} `));
    return ["", ...wrapSegments(`${glyph} ${text}`, width)];
  }
}

/** Soft-wraps an ANSI-painted line at spaces, continuation indented by two columns. */
function wrapSegments(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (visibleWidth(candidate) > width && current !== "") {
      out.push(current);
      current = `  ${word}`;
    } else current = candidate;
  }
  if (current !== "") out.push(current);
  return out.map((entry) => fit(entry, width));
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

/**
 * K8 welcome header: laid out for the current width (and terminal height) at render time, so a
 * theme or style change repaints it. It is the first child of the main screen and scrolls away.
 */
class WelcomeView implements Component {
  public info: WelcomeInfo;
  public settings: WelcomeSettings;
  private readonly frame: () => { readonly rows: number; readonly glyphs: GlyphSet; readonly style: Styler };

  public constructor(info: WelcomeInfo, settings: WelcomeSettings, frame: () => { readonly rows: number; readonly glyphs: GlyphSet; readonly style: Styler }) {
    this.info = info;
    this.settings = settings;
    this.frame = frame;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    return renderWelcome(this.info, this.settings, { width, ...this.frame() });
  }
}

/** A footer field: its painted text and when it gives way on a narrow screen (0 never; lower goes first). */
export interface FooterPart {
  readonly text: string;
  readonly drop: number;
}

/** Status line thresholds (K3): green below 60 %, yellow up to 85 %, red above. */
export function usageTone(percent: number, style: Styler): (text: string) => string {
  return percent > 85 ? (text) => style.bold(style.red(text)) : percent >= 60 ? (text) => style.yellow(text) : (text) => style.green(text);
}

/**
 * The status line's left fields from live state (K3 UI): `folder · branch · model · effort · mode ·
 * ctx% · quota%/$`. Each field has its own tone; ctx and quota are coloured by threshold and keep
 * their text, so colour is never the only signal (NO_COLOR / plain: the Styler paints nothing).
 * Narrow screens drop branch, folder, cost, quota, effort, model in that order; mode and ctx stay.
 */
export function statusLineParts(
  footer: FooterState,
  extra: { readonly folder: string; readonly branch: string | undefined; readonly mode: string | undefined; readonly approvalWaiting: boolean; readonly style: Styler },
): FooterPart[] {
  const style = extra.style;
  const parts: FooterPart[] = [
    { text: style.dim(extra.folder), drop: 3 },
    { text: extra.branch === undefined ? "" : style.secondary(extra.branch), drop: 2 },
    { text: footer.model === undefined ? "" : style.bold(style.cyan(footer.model)), drop: 6 },
    { text: footer.model === undefined || footer.effort === undefined ? "" : style.magenta(footer.effort), drop: 5 },
  ];
  if (extra.mode !== undefined) parts.push({ text: extra.mode, drop: 0 });
  if (extra.approvalWaiting) parts.push({ text: style.yellow("approval waiting"), drop: 0 });
  if (footer.contextPercent !== undefined) parts.push({ text: usageTone(footer.contextPercent, style)(`ctx ${footer.contextPercent}%`), drop: 0 });
  if (footer.quotaPercent !== undefined) parts.push({ text: usageTone(footer.quotaPercent, style)(`quota ${footer.quotaPercent}%${footer.quotaProvider === undefined ? "" : ` ${footer.quotaProvider}`}`), drop: 4 });
  else if (footer.costUsd !== undefined) parts.push({ text: style.dim(`$${footer.costUsd.toFixed(2)}`), drop: 3.5 });
  return parts;
}

/**
 * One line under the editor (TUI §10.2): `folder · branch · model · mode · ctx% · $` on the left,
 * `? shortcuts` on the right. On a narrow screen fields give way in order (hint, cost, branch,
 * folder, model); the permission mode and ctx% never do, so nothing important is cut mid-word.
 */
class FooterView implements Component {
  private readonly parts: () => { readonly left: readonly FooterPart[]; readonly right: FooterPart | undefined };
  private readonly style: Styler;
  private readonly sep: string;

  public constructor(parts: () => { readonly left: readonly FooterPart[]; readonly right: FooterPart | undefined }, style: Styler, sep: string) {
    this.parts = parts;
    this.style = style;
    this.sep = sep;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const { left, right } = this.parts();
    let shown = left.filter((part) => part.text !== "");
    let hint = right;
    const joiner = this.style.dim(` ${this.sep} `);
    const measure = (): number => 2 + visibleWidth(shown.map((part) => part.text).join(` ${this.sep} `)) + (hint === undefined ? 0 : 3 + visibleWidth(hint.text));
    while (measure() > width) {
      const candidates = [...shown, ...(hint === undefined ? [] : [hint])].filter((part) => part.drop > 0);
      if (candidates.length === 0) break;
      const first = candidates.reduce((low, part) => (part.drop < low.drop ? part : low));
      if (first === hint) hint = undefined;
      else shown = shown.filter((part) => part !== first);
    }
    const body = `  ${shown.map((part) => part.text).join(joiner)}`;
    if (hint === undefined) return [fit(body, width)];
    const gap = Math.max(3, width - visibleWidth(body) - visibleWidth(hint.text));
    return [fit(`${body}${" ".repeat(gap)}${hint.text}`, width)];
  }
}

const MAIN_PLACEHOLDER = "Ask anything or describe a change {sep} / commands {sep} @ files";
const BUSY_PLACEHOLDER = "Type to steer Synorch {sep} it reads your message at its next step";
const BACKGROUND_PLACEHOLDER = "Workers run in the background {sep} ask anything {sep} Down selects a worker {sep} Ctrl+G graph";

/** The editor's place in the tree; hidden while an inline dialog takes the input (the draft is kept). */
class EditorSlot implements Component {
  public hidden = false;
  private readonly editor: Component;

  public constructor(editor: Component) {
    this.editor = editor;
  }

  public invalidate(): void {
    this.editor.invalidate();
  }

  public render(width: number): string[] {
    return this.hidden ? [] : this.editor.render(width);
  }
}

/**
 * An inline dialog (conversation view): drawn where the editor was, between two rules, so it
 * wraps with the terminal width instead of being composited over the transcript.
 */
class DialogFrame implements Component {
  private readonly inner: Component;
  private readonly rule: (text: string) => string;

  public constructor(inner: Component, rule: (text: string) => string) {
    this.inner = inner;
    this.rule = rule;
  }

  public invalidate(): void {
    this.inner.invalidate();
  }

  public render(width: number): string[] {
    const line = this.rule("─".repeat(Math.max(1, width)));
    return ["", line, ...this.inner.render(width).map((entry) => fit(entry, width)), line];
  }
}

interface DialogEntry {
  readonly component: Component;
  readonly focus: Component;
  readonly cancel: () => void;
  readonly tone: "attention" | "neutral";
}

type Interruption = { readonly kind: "interrupt" | "exit" };
type InputResult = Awaited<ReturnType<UserInputSource["next"]>>;

/** Two Esc presses within this window on an empty, idle editor open /rewind. */
const DOUBLE_ESCAPE_MS = 800;
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
  private readonly style: ThemedStyler;
  /** K8: the themes `/theme` offers and the welcome header (conversation view). */
  private readonly themes: readonly ThemeDefinition[];
  private welcomeSettings: WelcomeSettings;
  private welcomeView: WelcomeView | undefined;
  private readonly clock: () => Date;
  private readonly now: () => number;
  private readonly terminal: ChunkedTerminal;
  private readonly tui: TuiMainScreen;
  private readonly header: Text;
  private readonly transcript = new Container();
  private readonly status: StatusBar;
  private readonly editor: ChatEditor;
  private readonly markdownTheme: MarkdownTheme;
  private readonly selectTheme: SelectListTheme;
  private readonly queue: RenderQueue;
  private readonly tools = new ToolCardTracker();
  private readonly toolViews = new Map<string, ToolCardView>();
  private readonly streams = new Map<string, StreamState>();
  private readonly interrupts = new InterruptController();
  private readonly pendingInputs: InputResult[] = [];
  private readonly inputWaiters: ((result: InputResult) => void)[] = [];
  /**
   * The prompt-owner stack: every question, picker and approval pushes an entry and owns the
   * keyboard while it is on top; the editor only gets input back when the stack is empty. A prompt
   * opened over another (an approval during an `ask_user` question) hides it without cancelling it.
   */
  private readonly dialogs: DialogEntry[] = [];
  private dialogOverlay: { hide(): void } | undefined;
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
  private readonly permissionListeners = new Set<(mode: PermissionMode) => void>();
  private tray: AttachmentTray;
  /** When the last Esc with nothing to interrupt was pressed (a second one opens /rewind). */
  private lastIdleEscapeAt: number | undefined;
  private inputRoot = process.cwd();
  /** The session's permission mode (Shift+Tab); shown in the footer once the session reports one. */
  private permission: PermissionMode = "auto";
  private permissionShown = false;
  private mouseOn = false;
  private selectMode = false;
  private mousePress: MouseInput | undefined;
  /** K1-U3 views: the live orchestration board sits between the transcript and the activity line. */
  private readonly boardSlot = new Container();
  /** Conversation view: approval, picker and secret prompts render inline here, in place of the editor. */
  private readonly dialogSlot = new Container();
  private editorSlot!: EditorSlot;
  private board: LiveBoardComponent | undefined;
  /** K3: wall-clock ms of the last key typed into the editor (0 = never). */
  private lastKeyAtMs = 0;
  /** K1.7 worker drill-in: the seam, the board selection, the open worker view and its input chrome. */
  private workerSeam: WorkerSeam | undefined;
  private lastBoard: OrchestrationView | undefined;
  private selecting = false;
  private selectedKey: string | undefined;
  private workerPane: WorkerPane | undefined;
  /** Interactive `/memory graph`: the session seam and the graph being navigated. */
  private memorySeam: MemorySeam | undefined;
  private memoryGraph: MemoryGraphComponent | undefined;
  private readonly inputHint = new Text("", 0, 0);
  private readonly localPaused = new Set<string>();
  private readonly localCancelled = new Set<string>();
  private cancelArmed: { readonly key: string; readonly at: number } | undefined;
  private readonly delegationIds = new WeakMap<DelegationComponent, string>();
  private delegationCount = 0;

  /** The prompt that currently owns the input, if any. */
  private get dialog(): DialogEntry | undefined {
    return this.dialogs.at(-1);
  }

  public constructor(options: PiTuiRendererOptions) {
    this.options = options;
    this.style = createStyler(options.color, { theme: options.theme, depth: options.colorDepth });
    this.themes = options.themes ?? BUILTIN_THEMES;
    this.welcomeSettings = options.welcome ?? MINIMAL_WELCOME;
    this.clock = options.clock ?? (() => new Date());
    this.now = options.now ?? (() => Date.now());
    this.terminal = new ChunkedTerminal(options.terminal ?? new ProcessTerminal());
    this.tui = new TuiMainScreen(this.terminal);
    this.header = new Text("", 0, 0);
    this.status = new StatusBar(this.style);
    const style = this.style;
    this.selectTheme = {
      selectedPrefix: (text) => style.accent(text),
      selectedText: (text) => style.bold(text),
      description: (text) => style.muted(text),
      scrollInfo: (text) => style.muted(text),
      noMatch: (text) => style.muted(text),
    };
    this.markdownTheme = {
      heading: (text) => style.bold(style.heading(text)),
      link: (text) => style.link(text),
      linkUrl: (text) => style.muted(text),
      code: (text) => style.code(text),
      codeBlock: (text) => text,
      codeBlockBorder: (text) => style.border(text),
      quote: (text) => style.muted(text),
      quoteBorder: (text) => style.border(text),
      hr: (text) => style.border(text),
      listBullet: (text) => style.accent(text),
      bold: (text) => style.bold(text),
      italic: (text) => text,
      strikethrough: (text) => text,
      underline: (text) => text,
    };
    this.presenter =
      options.view === "conversation"
        ? new ConversationPresenter({ glyphs: options.glyphs ?? GLYPH_SETS.rich, echoesUser: true, debug: options.debug === true, now: () => this.now() })
        : undefined;
    this.editor = new ChatEditor(this.tui, { borderColor: (text) => style.border(text), selectList: this.selectTheme });
    this.editor.placeholderStyle = (text) => style.muted(text);
    this.editorSlot = new EditorSlot(this.editor);
    this.editor.onSubmit = (text) => this.submit(text);
    this.completions = new InputCompletionProvider(mergeCommands(DEFAULT_COMMAND_PALETTE), options.fileIndex);
    this.editor.setAutocompleteProvider(this.completions);
    this.tray = new AttachmentTray(options.workspaceRoot ?? options.fileIndex?.root ?? process.cwd());
    this.viewport = new TranscriptViewport(this.transcript, {
      siblings: () => this.tui.children,
      rows: () => this.terminal.rows,
      hint: (text, width) => fit(style.dim(text), width),
      up: (options.glyphs ?? GLYPH_SETS.rich).name === "ascii" ? "^" : "↑",
      down: (options.glyphs ?? GLYPH_SETS.rich).name === "ascii" ? "v" : "↓",
    });
    const self = this;
    this.controls = {
      setCommands: (entries) => this.setCommands(entries),
      onAttachment: (listener) => {
        this.attachmentListeners.add(listener);
        return () => this.attachmentListeners.delete(listener);
      },
      openModelPicker: (entries, signal, heading) => this.openModelPicker(entries, signal, heading),
      ask: (question, options, signal) => this.askQuestion(question, options, signal),
      choose: (question, signal) => this.chooseQuestion(question, signal),
      get permissionMode() {
        return self.permission;
      },
      setPermissionMode: (mode) => this.setPermissionMode(mode),
      onPermissionModeChange: (listener) => {
        this.permissionListeners.add(listener);
        return () => this.permissionListeners.delete(listener);
      },
      get mouseMode() {
        return self.mouseOn;
      },
      setMouseMode: (on) => this.setMouseMode(on),
      setEditorText: (text) => {
        if (this.stopped) return;
        this.editor.setText(text);
        this.tui.requestRender();
      },
      setSessionStatus: (status) => {
        // The footer reads the presenter on every render: update it and redraw now.
        this.presenter?.configure({ model: status.model, effort: status.effort ?? null, contextWindowTokens: status.contextWindowTokens });
        this.tui.requestRender();
      },
      inputActivity: () => ({ lastKeyAtMs: this.lastKeyAtMs, draft: this.editor.getText().trim().length > 0 }),
      ...(options.view === "conversation" ? { appearance: this.appearanceControls() } : {}),
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
      this.tui.addChild(this.inputHint);
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
    this.footerLabel = { folder, branch: header.gitBranch, mode: header.permissionMode === undefined && header.policyMode === "ask" ? "ask mode" : "" };
    if (header.permissionMode !== undefined) {
      this.permission = header.permissionMode;
      this.permissionShown = true;
      this.editor.borderColor = this.borderFor(this.permission);
    }
    const { warning } = headerLines({
      version: header.version ?? "",
      folder,
      branch: header.gitBranch,
      model: header.model,
      mode: "",
      sandboxEnforcement: header.sandboxEnforcement,
      ...(header.sandboxNoticeSeen === undefined ? {} : { sandboxNoticeSeen: header.sandboxNoticeSeen }),
      warnings: header.notices,
      glyphs: presenter.glyphs,
    });
    // K8 welcome: the first lines of the main screen. They scroll away with the transcript; a change
    // above the viewport forces a full repaint, so only explicit actions (/theme, /welcome) change
    // them. Live facts (model, effort, permission mode) are the footer's, which updates in place.
    const g = presenter.glyphs;
    const welcome = header.welcome;
    const info: WelcomeInfo = {
      version: header.version ?? "",
      commit: welcome?.commit,
      model: header.model,
      effort: welcome?.effort,
      contextWindowTokens: header.contextWindowTokens,
      plan: welcome?.plan,
      workers: welcome?.workers,
      folder,
      path: welcome?.path,
      branch: header.gitBranch,
      mode: header.permissionMode ?? (header.policyMode === "ask" ? "ask" : undefined),
      hint: welcome?.hint,
      warning,
    };
    this.welcomeView = new WelcomeView(info, this.welcomeSettings, () => ({ rows: this.terminal.rows, glyphs: presenter.glyphs, style: this.style }));
    this.editor.prompt = (text) => this.style.bold(this.style.accent(text));
    this.editor.ascii = g.name === "ascii";
    this.editor.sep = g.sep;
    this.editor.placeholder = MAIN_PLACEHOLDER;
    this.tui.addChild(this.welcomeView ?? this.header);
    this.tui.addChild(this.viewport);
    this.tui.addChild(this.boardSlot);
    this.tui.addChild(new ActivityLineView(presenter, this.style, () => this.now()));
    this.tui.addChild(this.inputHint);
    this.tui.addChild(this.dialogSlot);
    this.tui.addChild(this.editorSlot);
    this.tui.addChild(new FooterView(() => this.footerParts(presenter), this.style, g.sep));
  }

  /** Footer fields in display order with their drop priority (TUI §10.2). */
  private footerParts(presenter: ConversationPresenter): { readonly left: readonly FooterPart[]; readonly right: FooterPart | undefined } {
    const parts = statusLineParts(presenter.footer(), {
      folder: this.footerLabel.folder,
      branch: this.footerLabel.branch,
      mode: this.modeLabel(presenter.glyphs.sep),
      approvalWaiting: this.dialog !== undefined && presenter.activity()?.waiting === true,
      style: this.style,
    });
    const left: FooterPart[] = [...parts];
    const dim = this.style.dim;
    const right = this.editor.getText().length === 0 && this.workerPane === undefined ? { text: dim("? shortcuts"), drop: 1 } : undefined;
    return { left, right };
  }

  private applyOp(op: ViewOp): void {
    const item = op.item;
    const existing = this.itemViews.get(item.id);
    if (existing !== undefined) {
      if (existing instanceof AssistantMessageView && item.kind === "assistant") existing.setText(item.text);
      else if (existing instanceof ToolLineView && item.kind === "tool") existing.update(item);
      return;
    }
    const view = conversationItemView(item, this.itemDeps(), this.transcript.children.at(-1));
    this.itemViews.set(item.id, view);
    this.transcript.addChild(view);
  }

  private itemDeps(): ItemViewDeps {
    return {
      style: this.style,
      glyphs: this.presenter?.glyphs ?? this.options.glyphs ?? GLYPH_SETS.rich,
      markdownTheme: this.markdownTheme,
      expanded: (itemId) => this.expanded || this.expandedItems.has(itemId),
    };
  }

  private viewStyle(): ViewStyleOptions {
    return { glyphs: this.presenter?.glyphs ?? this.options.glyphs ?? GLYPH_SETS.rich, color: this.style, now: () => this.now() };
  }

  /** Pins a card (usage, evidence, action, why, or a board summary) once to the transcript. */
  public showView(view: HarnessView): void {
    if (this.stopped) return;
    // Queued lines first, so a card lands after the output that came before it.
    this.queue.flush();
    if (view.kind === "delegation") {
      const id = `delegation-${(this.delegationCount += 1)}`;
      const line = new DelegationComponent(view, this.viewStyle(), () => this.expanded || this.expandedItems.has(id));
      this.delegationIds.set(line, id);
      this.transcript.addChild(line);
    } else if (view.kind === "memory-graph" && view.nodes.length > 0) {
      this.showMemoryGraph(view);
    } else {
      this.transcript.addChild(new StaticViewComponent(view, this.viewStyle()));
    }
    this.tui.requestRender();
  }

  public connectMemory(seam: MemorySeam | undefined): void {
    this.memorySeam = seam;
  }

  /** The graph under selection is the newest one; an older one keeps its last frame. */
  private showMemoryGraph(view: Extract<HarnessView, { kind: "memory-graph" }>): void {
    if (this.memoryGraph !== undefined) this.memoryGraph.selecting = false;
    const graph = new MemoryGraphComponent(view, this.viewStyle());
    graph.selecting = true;
    graph.selected = initialSelection(graph.plan);
    this.memoryGraph = graph;
    this.transcript.addChild(graph);
  }

  /** Keys of the memory graph under selection (K1.7 model). Undefined passes the key on. */
  private onMemoryGraphKey(data: string, empty: boolean): { consume?: boolean } | undefined {
    const graph = this.memoryGraph;
    if (graph === undefined || !graph.selecting) return undefined;
    const done = (): undefined => {
      graph.selecting = false;
      this.tui.requestRender();
      return undefined;
    };
    if (!empty) return done();
    const id = graph.selected;
    if (matchesKey(data, "escape")) {
      if (graph.note !== undefined) graph.note = undefined;
      else graph.selecting = false;
    } else if (data === "o") {
      if (id !== undefined) this.openMemoryNote(id);
    } else if (graph.note !== undefined) {
      return done();
    } else if (matchesKey(data, "up") || data === "k") graph.selected = moveSelection(graph.plan, "graph", id, "up");
    else if (matchesKey(data, "down") || data === "j") graph.selected = moveSelection(graph.plan, "graph", id, "down");
    else if (matchesKey(data, "left") || data === "h") graph.selected = moveSelection(graph.plan, "graph", id, "left");
    else if (matchesKey(data, "right") || data === "l") graph.selected = moveSelection(graph.plan, "graph", id, "right");
    else if (matchesKey(data, "tab")) graph.selected = moveSelection(graph.plan, "graph", id, "next");
    else if (matchesKey(data, "shift+tab")) graph.selected = moveSelection(graph.plan, "graph", id, "previous");
    else if (matchesKey(data, "enter") || data === "\r") {
      if (id !== undefined) this.loadMemoryNote(graph, id);
    } else return done();
    this.tui.requestRender();
    return { consume: true };
  }

  private loadMemoryNote(graph: MemoryGraphComponent, id: string): void {
    const seam = this.memorySeam;
    if (seam === undefined) {
      this.appendLine({ level: "info", text: `/memory show ${id} prints this note` });
      return;
    }
    seam.note(id).then(
      (note) => {
        if (note === undefined) this.appendLine({ level: "warning", text: `No memory note ${id}.` });
        else if (graph.selecting && graph.selected === id) graph.note = note;
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.appendLine({ level: "error", text: `Couldn't open ${id}: ${errorText(error)}` });
        this.tui.requestRender();
      },
    );
  }

  private openMemoryNote(id: string): void {
    const seam = this.memorySeam;
    if (seam === undefined) {
      this.appendLine({ level: "info", text: `/memory open ${id} opens it in Obsidian` });
      return;
    }
    seam.open(id).then(
      (outcome) => {
        this.appendLine({ level: "info", text: outcome });
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.appendLine({ level: "error", text: `Couldn't open ${id} in Obsidian: ${errorText(error)}` });
        this.tui.requestRender();
      },
    );
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
    if (view !== undefined) this.lastBoard = view;
    if (view === undefined || view.done) {
      // A done board is pinned once: only the live board it replaces is collapsed; later done updates are ignored.
      const live = this.board !== undefined;
      this.boardSlot.clear();
      this.board = undefined;
      this.selecting = false;
      if (view !== undefined && live) this.transcript.addChild(new StaticViewComponent(view, this.viewStyle()));
    } else if (this.board === undefined) {
      this.board = new LiveBoardComponent(view, this.viewStyle());
      this.boardSlot.addChild(this.board);
    } else {
      this.board.setView(view);
    }
    if (view !== undefined) {
      // The board confirms optimistic pause / cancel states.
      for (const task of view.tasks) {
        if (task.paused !== undefined) this.localPaused.delete(task.key);
        if (task.state === "cancelled" || task.state === "completed" || task.state === "failed") this.localCancelled.delete(task.key);
      }
    }
    this.syncBoardSelection();
    this.updateSpinner();
    this.tui.requestRender();
  }

  /** Mode of the live board (`g` / Ctrl+G toggles board and graph); undefined without a board. */
  public get boardMode(): "board" | "graph" | undefined {
    return this.board?.mode;
  }

  // ---- K1.7 worker drill-in -------------------------------------------------------------------

  /** Connects the worker transcripts and controls; an open worker view re-subscribes. */
  public connectWorkers(seam: WorkerSeam | undefined): void {
    this.workerSeam = seam;
    this.workerPane?.attach(seam);
    this.updateInputChrome();
    this.tui.requestRender();
  }

  /** The selected task key on the board / graph (undefined when nothing is selected). */
  public get selectedTask(): string | undefined {
    return this.selecting ? this.selectedKey : undefined;
  }

  /** Key of the open worker view, if any. */
  public get openWorker(): string | undefined {
    return this.workerPane?.key;
  }

  /** Opens the worker view of a task the board knows; false otherwise. */
  public openWorkerView(taskKey: string): boolean {
    if (this.stopped) return false;
    const task = this.findTask(taskKey);
    if (task === undefined) return false;
    const previous = this.workerPane;
    const deps: WorkerPaneDeps = {
      ...this.itemDeps(),
      now: () => this.now(),
      task: (key) => this.findTask(key),
      status: (key) => this.optimisticStatus(key),
      allExpanded: () => this.expanded,
      rows: () => this.terminal.rows,
      siblings: () => this.tui.children,
    };
    const pane = new WorkerPane(task.key, deps);
    const children = this.tui.children;
    const slot = children.indexOf(previous ?? this.viewport);
    if (slot === -1) return false;
    previous?.dispose();
    children[slot] = pane;
    this.workerPane = pane;
    this.selecting = false;
    this.selectedKey = task.key;
    this.cancelArmed = undefined;
    pane.attach(this.workerSeam);
    this.syncBoardSelection();
    this.updateInputChrome();
    this.updateSpinner();
    this.tui.requestRender(true);
    return true;
  }

  /** Back to the main session. */
  public closeWorkerView(): void {
    const pane = this.workerPane;
    if (pane === undefined) return;
    pane.dispose();
    const children = this.tui.children;
    const slot = children.indexOf(pane);
    if (slot !== -1) children[slot] = this.viewport;
    this.workerPane = undefined;
    this.cancelArmed = undefined;
    this.selecting = false;
    this.selectedKey = undefined;
    this.syncBoardSelection();
    this.updateInputChrome();
    this.updateSpinner();
    this.tui.requestRender(true);
  }

  private findTask(key: string): OrchestrationTaskView | undefined {
    return (this.board?.current ?? this.lastBoard)?.tasks.find((task) => task.key === key);
  }

  private optimisticStatus(key: string): string | undefined {
    if (this.localCancelled.has(key)) return "cancelling…";
    const task = this.findTask(key);
    if (task?.paused === undefined && this.localPaused.has(key)) return "paused";
    return undefined;
  }

  private isPaused(key: string): boolean {
    const task = this.findTask(key);
    return task?.paused ?? this.localPaused.has(key);
  }

  /** Mirrors the selection (or the open worker) onto the live board. */
  private syncBoardSelection(): void {
    const board = this.board;
    if (board === undefined) return;
    if (this.selectedKey !== undefined && !board.current.tasks.some((task) => task.key === this.selectedKey) && this.workerPane === undefined) {
      this.selecting = false;
      this.selectedKey = undefined;
    }
    board.selecting = this.selecting;
    board.selected = this.selecting || this.workerPane !== undefined ? this.selectedKey : undefined;
    const sep = ` ${(this.presenter?.glyphs ?? this.options.glyphs ?? GLYPH_SETS.rich).sep} `;
    board.hint = this.workerPane === undefined ? undefined : ["tab next", "g graph", "esc back"].join(sep);
  }

  /** Editor placeholder, border and the hint line above it while a worker view is open. */
  private updateInputChrome(): void {
    const pane = this.workerPane;
    const sep = ` ${(this.presenter?.glyphs ?? this.options.glyphs ?? GLYPH_SETS.rich).sep} `;
    if (pane === undefined) {
      this.editor.placeholder = this.presenter === undefined ? undefined : MAIN_PLACEHOLDER;
      this.editor.borderColor = this.borderFor(this.permission);
      this.inputHint.setText(this.selecting && this.cancelArmed !== undefined ? this.style.yellow(`  press x again to cancel ${this.cancelArmed.key}`) : "");
      return;
    }
    this.editor.placeholder = `message ${pane.key}…`;
    this.editor.borderColor = (text) => this.style.magenta(text);
    if (this.cancelArmed?.key === pane.key) {
      this.inputHint.setText(this.style.yellow(`  press x again to cancel ${pane.key}`));
      return;
    }
    const control = this.workerSeam?.control !== undefined;
    const parts = control
      ? [`enter sends to ${pane.key}`, this.isPaused(pane.key) ? "p resume" : "p pause", "x cancel", "tab next", "esc back"]
      : ["read-only: no worker control connected", "tab next", "esc back"];
    this.inputHint.setText(this.style.dim(`  ${parts.join(sep)}`));
  }

  private startSelecting(): void {
    const view = this.board?.current;
    if (view === undefined) return;
    this.selecting = true;
    if (this.selectedKey === undefined || !view.tasks.some((task) => task.key === this.selectedKey)) this.selectedKey = initialSelection(view);
    this.syncBoardSelection();
    this.tui.requestRender();
  }

  private stopSelecting(): void {
    this.selecting = false;
    this.cancelArmed = undefined;
    this.syncBoardSelection();
    this.updateInputChrome();
    this.tui.requestRender();
  }

  private moveSelected(move: SelectionMove): void {
    const board = this.board;
    if (board === undefined) return;
    this.selectedKey = moveSelection(board.current, board.mode, this.selectedKey, move);
    this.cancelArmed = undefined;
    this.syncBoardSelection();
    this.updateInputChrome();
    this.tui.requestRender();
  }

  private togglePause(key: string): void {
    const control = this.workerSeam?.control;
    if (control === undefined) {
      this.workerNote(key, "warning", "Can't pause: no worker control is connected.");
      return;
    }
    const paused = this.isPaused(key);
    if (paused) this.localPaused.delete(key);
    else this.localPaused.add(key);
    const action = paused ? control.resume(key) : control.pause(key);
    this.workerNote(key, "info", paused ? `Resuming ${key}.` : `Pausing ${key} at its next safe step.`);
    action.catch((error: unknown) => {
      if (paused) this.localPaused.add(key);
      else this.localPaused.delete(key);
      this.workerNote(key, "error", `Couldn't ${paused ? "resume" : "pause"} ${key}: ${errorText(error)}`);
      this.updateInputChrome();
      this.tui.requestRender();
    });
    this.updateInputChrome();
    this.tui.requestRender();
  }

  /** `x` arms, a second `x` within three seconds cancels. */
  private armCancel(key: string): void {
    const control = this.workerSeam?.control;
    if (control === undefined) {
      this.workerNote(key, "warning", "Can't cancel: no worker control is connected.");
      return;
    }
    const now = this.now();
    if (this.cancelArmed?.key === key && now - this.cancelArmed.at <= 3000) {
      this.cancelArmed = undefined;
      this.localCancelled.add(key);
      this.workerNote(key, "warning", `Cancelling ${key}.`);
      control.cancel(key).catch((error: unknown) => {
        this.localCancelled.delete(key);
        this.workerNote(key, "error", `Couldn't cancel ${key}: ${errorText(error)}`);
        this.tui.requestRender();
      });
    } else {
      this.cancelArmed = { key, at: now };
    }
    this.updateInputChrome();
    this.tui.requestRender();
  }

  private messageWorker(key: string, text: string): void {
    const pane = this.workerPane;
    pane?.addUser(text);
    this.transcript.addChild(new UserToWorkerComponent(key, text, this.viewStyle()));
    const control = this.workerSeam?.control;
    if (control === undefined) {
      pane?.note("warning", "Not sent: this worker view is read-only (no worker control is connected).");
    } else {
      control.message(key, text).catch((error: unknown) => {
        this.workerNote(key, "error", `Couldn't message ${key}: ${errorText(error)}`);
        this.tui.requestRender();
      });
    }
    this.tui.requestRender();
  }

  /** A note in the open worker view of `key`, else in the main transcript. */
  private workerNote(key: string, level: "info" | "warning" | "error", text: string): void {
    if (this.workerPane?.key === key) this.workerPane.note(level, text);
    else this.appendLine({ level, text });
  }

  /** K1.7 keys: board / graph selection and the worker view. Undefined passes the key on. */
  private onWorkerKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.dialog !== undefined) return undefined;
    const autocomplete = this.editor.isShowingAutocomplete();
    const empty = this.editor.getText().length === 0 && !autocomplete;
    const pane = this.workerPane;
    if (pane !== undefined) {
      if (matchesKey(data, "escape") && !autocomplete) {
        this.closeWorkerView();
        return { consume: true };
      }
      if (!empty) return undefined;
      const view = this.board?.current ?? this.lastBoard;
      if (data === "b") this.closeWorkerView();
      else if ((matchesKey(data, "tab") || matchesKey(data, "shift+tab")) && view !== undefined) {
        const next = cycleWorker(view, pane.key, matchesKey(data, "tab") ? 1 : -1);
        if (next !== pane.key) this.openWorkerView(next);
      } else if (data === "p") this.togglePause(pane.key);
      else if (data === "x") this.armCancel(pane.key);
      else return undefined;
      return { consume: true };
    }
    const memory = this.onMemoryGraphKey(data, empty);
    if (memory !== undefined) return memory;
    if (this.board === undefined) return undefined;
    if (!this.selecting) {
      if (empty && matchesKey(data, "down")) {
        this.startSelecting();
        return { consume: true };
      }
      return undefined;
    }
    const key = this.selectedKey;
    if (matchesKey(data, "escape")) this.stopSelecting();
    else if (matchesKey(data, "up") || data === "k") this.moveSelected("up");
    else if (matchesKey(data, "down") || data === "j") this.moveSelected("down");
    else if (matchesKey(data, "left") || data === "h") this.moveSelected("left");
    else if (matchesKey(data, "right") || data === "l") this.moveSelected("right");
    else if (matchesKey(data, "tab")) this.moveSelected("next");
    else if (matchesKey(data, "shift+tab")) this.moveSelected("previous");
    else if (matchesKey(data, "enter") || data === "\r") {
      if (key !== undefined) this.openWorkerView(key);
    } else if (data === "p" && key !== undefined) this.togglePause(key);
    else if (data === "x" && key !== undefined) this.armCancel(key);
    else {
      // g toggles the graph and keeps the selection; anything else leaves selection for the editor.
      if (!(data === "g" || matchesKey(data, "ctrl+g") || matchesKey(data, "ctrl+o") || matchesKey(data, "ctrl+c"))) this.stopSelecting();
      return undefined;
    }
    return { consume: true };
  }

  private updateSpinner(): void {
    if (this.presenter !== undefined && this.workerPane === undefined) {
      // While Synorch works, a typed message steers it at its next step; the placeholder says so.
      // K3: workers run in the background; with the agent idle the editor starts a normal message.
      this.editor.placeholder = this.presenter.activity() !== undefined ? BUSY_PLACEHOLDER : this.board !== undefined ? BACKGROUND_PLACEHOLDER : MAIN_PLACEHOLDER;
    }
    const active = this.presenter?.activity() !== undefined || this.board !== undefined || this.workerPane !== undefined;
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

  // ---- K8 appearance: themes and the welcome header -------------------------------------------

  private appearanceControls(): AppearanceControls {
    const self = this;
    return {
      get themes() {
        return self.themes.map((theme) => ({ name: theme.name, description: theme.description, custom: theme.custom === true }));
      },
      get theme() {
        return self.style.themeName;
      },
      get welcome() {
        return welcomePreferences(self.welcomeSettings);
      },
      pickTheme: (signal, step) => this.pickTheme(signal, step),
      pickWelcome: (signal) => this.pickWelcome(signal),
      pickWelcomeStyle: async (signal, step) => {
        const style = await this.chooseWelcomeStyle(this.welcomeSettings, signal, step);
        if (style !== undefined) this.applyWelcome({ ...this.welcomeSettings, style });
        return style;
      },
      pickGlyphs: (signal, step) => this.pickGlyphs(signal, step),
      setTheme: (name) => this.applyTheme(name),
      setWelcome: (preferences) => this.applyWelcome({ ...this.welcomeSettings, ...preferences }),
      updateWelcome: (patch) => this.patchWelcome(patch),
    };
  }

  /** Repaints everything after a theme or welcome change (cached Markdown included). */
  private repaintAll(): void {
    if (!this.started || this.stopped) return;
    this.tui.invalidate();
    this.tui.requestRender(true);
  }

  private applyTheme(name: string): boolean {
    const theme = this.themes.find((candidate) => candidate.name === name);
    if (theme === undefined) return false;
    this.style.setTheme(theme);
    this.repaintAll();
    return true;
  }

  private applyWelcome(settings: WelcomeSettings): void {
    this.welcomeSettings = settings;
    if (this.welcomeView !== undefined) this.welcomeView.settings = settings;
    this.repaintAll();
  }

  private patchWelcome(patch: SessionWelcomeView): void {
    const view = this.welcomeView;
    if (view === undefined || this.stopped) return;
    view.info = {
      ...view.info,
      ...(patch.commit === undefined ? {} : { commit: patch.commit }),
      ...(patch.effort === undefined ? {} : { effort: patch.effort }),
      ...(patch.plan === undefined ? {} : { plan: patch.plan }),
      ...(patch.workers === undefined ? {} : { workers: patch.workers }),
      ...(patch.path === undefined ? {} : { path: patch.path }),
      ...(patch.hint === undefined ? {} : { hint: patch.hint }),
    };
    if (this.started) this.tui.requestRender();
  }

  /** Option rows that fit next to a preview of `previewLines` lines (question, hint and frame included). */
  private listRows(previewLines: number): number {
    return Math.max(3, Math.min(10, this.terminal.rows - previewLines - 8));
  }

  private pickerGlyphs(): GlyphSet {
    return this.presenter?.glyphs ?? this.options.glyphs ?? GLYPH_SETS.rich;
  }

  /** `/theme` and the setup wizard: the highlighted theme previews live; Enter applies it, Esc changes nothing. */
  private async pickTheme(signal?: AbortSignal, step?: string): Promise<string | undefined> {
    const themes = this.themes;
    const current = Math.max(0, themes.findIndex((theme) => theme.name === this.style.themeName));
    const glyphs = this.pickerGlyphs();
    const stylers = new Map<number, Styler>();
    const styler = (index: number): Styler => {
      const cached = stylers.get(index);
      if (cached !== undefined) return cached;
      const created = createStyler(this.style.enabled, { theme: themes[index], depth: this.style.depth });
      stylers.set(index, created);
      return created;
    };
    const off = this.style.enabled ? "" : `colour is off (NO_COLOR or --color never): the theme applies once colour is on ${glyphs.sep} `;
    const answer = await this.chooseQuestion(
      {
        question: "Pick a theme",
        ...(step === undefined ? {} : { header: step }),
        subtitle: `${off}↑↓ previews ${glyphs.sep} Enter applies and saves ${glyphs.sep} Esc keeps ${themes[current]?.name ?? "the current one"}`,
        options: themes.map((theme) => ({ label: theme.name, description: `${theme.description}${theme.custom === true ? " (yours)" : ""}` })),
        allowOther: false,
        tone: "neutral",
        initialIndex: current,
        escapeLabel: step === undefined ? "keeps the current theme" : "skips setup",
      },
      signal,
      { livePreview: (selected, _checked, width) => themePreview(styler(selected), glyphs, width), maxVisible: this.listRows(8) },
    );
    if (answer?.kind !== "selected") return undefined;
    const name = themes[answer.indices[0] ?? -1]?.name;
    if (name === undefined) return undefined;
    this.applyTheme(name);
    return name;
  }

  private welcomeInfo(): WelcomeInfo {
    return { ...(this.welcomeView?.info ?? { version: "", folder: this.footerLabel.folder }), warning: undefined };
  }

  /** The welcome as it would look with `settings` (full shown whenever the width allows). */
  private welcomePreview(settings: WelcomeSettings, width: number): string[] {
    const lines = renderWelcome(this.welcomeInfo(), settings, { width, rows: Math.max(this.terminal.rows, FULL_MIN_ROWS), glyphs: this.pickerGlyphs(), style: this.style });
    return lines.length === 0 ? [this.style.muted("(no welcome header; warnings still show)")] : lines;
  }

  private async chooseWelcomeStyle(base: WelcomeSettings, signal?: AbortSignal, step?: string, escapeLabel?: string): Promise<WelcomeSettings["style"] | undefined> {
    const styles = ["full", "compact", "minimal", "off"] as const;
    const meaning: Readonly<Record<(typeof styles)[number], string>> = {
      full: "the mark, version, model, team, folder and a tip (compact on small screens)",
      compact: "one info line and a tip",
      minimal: "one line: Synorch, version and folder",
      off: "no header (warnings still show)",
    };
    const answer = await this.chooseQuestion(
      {
        question: "Welcome screen",
        ...(step === undefined ? {} : { header: step }),
        options: styles.map((style) => ({ label: style, description: meaning[style] })),
        allowOther: false,
        tone: "neutral",
        initialIndex: Math.max(0, styles.indexOf(base.style)),
        escapeLabel: escapeLabel ?? (step === undefined ? "cancels" : "skips setup"),
      },
      signal,
      { livePreview: (selected, _checked, width) => this.welcomePreview({ ...base, style: styles[selected] ?? base.style }, width), maxVisible: 4 },
    );
    return answer?.kind === "selected" ? styles[answer.indices[0] ?? -1] : undefined;
  }

  /** `/welcome`: style, logo, fields and tips with a live preview; applied after the last step, nothing on Esc. */
  private async pickWelcome(signal?: AbortSignal): Promise<WelcomePreferences | undefined> {
    const style = await this.chooseWelcomeStyle(this.welcomeSettings, signal, "1/4", "cancels");
    if (style === undefined) return undefined;
    let draft: WelcomeSettings = { ...this.welcomeSettings, style };
    if (style === "full" || style === "compact") {
      const logos = ["art", "glyph", "off", "custom"] as const;
      const hasCustom = draft.customLogo !== undefined && draft.customLogo.length > 0;
      const logo = await this.chooseQuestion(
        {
          question: "Logo",
          header: "2/4",
          options: [
            { label: "art", description: "the Synorch mark in colour: a conductor, parallel workers, one outcome" },
            { label: "glyph", description: "the mark drawn with text symbols" },
            { label: "off", description: "text only" },
            { label: "custom", description: "your text art from ~/.synorch/logo.txt (up to 6 rows × 32 columns)", ...(hasCustom ? {} : { disabled: "create ~/.synorch/logo.txt first" }) },
          ],
          allowOther: false,
          tone: "neutral",
          initialIndex: Math.max(0, logos.indexOf(draft.logo === "on" || (draft.logo === "custom" && !hasCustom) ? "art" : draft.logo)),
        },
        signal,
        { livePreview: (selected, _checked, width) => this.welcomePreview({ ...draft, logo: logos[selected] ?? "art" }, width), maxVisible: 4 },
      );
      if (logo?.kind !== "selected") return undefined;
      draft = { ...draft, logo: logos[logo.indices[0] ?? 0] ?? "art" };
      const labels: Readonly<Record<WelcomeField, string>> = {
        version: "version and build",
        model: "model, effort and context window",
        plan: "provider and plan",
        workers: "worker models (when they differ)",
        folder: "folder and git branch",
        mode: "permission mode",
      };
      const fieldsFrom = (indices: readonly number[]): WelcomeField[] => indices.map((index) => WELCOME_FIELDS[index]).filter((field): field is WelcomeField => field !== undefined);
      const fields = await this.chooseQuestion(
        {
          question: "Show",
          header: "3/4",
          options: WELCOME_FIELDS.map((field) => ({ label: labels[field] })),
          multiSelect: true,
          initialChecked: WELCOME_FIELDS.flatMap((field, index) => (draft.fields.includes(field) ? [index] : [])),
          allowOther: false,
          tone: "neutral",
        },
        signal,
        { livePreview: (_selected, checked, width) => this.welcomePreview({ ...draft, fields: fieldsFrom(checked) }, width), maxVisible: WELCOME_FIELDS.length },
      );
      if (fields?.kind !== "selected") return undefined;
      draft = { ...draft, fields: fieldsFrom(fields.indices) };
      const tips = await this.chooseQuestion(
        {
          question: "Tip line",
          header: "4/4",
          options: [
            { label: "on", description: "one useful hint: resume a conversation, a shortcut, a command" },
            { label: "off", description: "no hint" },
          ],
          allowOther: false,
          tone: "neutral",
          initialIndex: draft.tips ? 0 : 1,
        },
        signal,
        { livePreview: (selected, _checked, width) => this.welcomePreview({ ...draft, tips: selected === 0 }, width), maxVisible: 2 },
      );
      if (tips?.kind !== "selected") return undefined;
      draft = { ...draft, tips: tips.indices[0] === 0 };
    }
    this.applyWelcome(draft);
    return welcomePreferences(draft);
  }

  /** Glyph set with the mark and a tool row drawn in each; the session saves it (applies from the next session). */
  private async pickGlyphs(signal?: AbortSignal, step?: string): Promise<"rich" | "safe" | "ascii" | undefined> {
    const sets = ["rich", "safe", "ascii"] as const;
    const meaning: Readonly<Record<(typeof sets)[number], string>> = {
      rich: "Unicode: Windows Terminal, VS Code, macOS and Linux terminals",
      safe: "classic Windows console fonts (no braille, square corners)",
      ascii: "plain 7-bit characters, works everywhere",
    };
    const current = Math.max(0, sets.indexOf(this.pickerGlyphs().name));
    const answer = await this.chooseQuestion(
      {
        question: "Symbols",
        ...(step === undefined ? {} : { header: step }),
        subtitle: "pick the row that looks right in your terminal (boxes or ? mean the font lacks them)",
        options: sets.map((set) => ({ label: set, description: meaning[set] })),
        allowOther: false,
        tone: "neutral",
        initialIndex: current,
        escapeLabel: step === undefined ? "cancels" : "skips setup",
      },
      signal,
      {
        livePreview: (selected, _checked, width) => {
          const glyphs = GLYPH_SETS[sets[selected] ?? "rich"];
          const logo = logoLines({ glyphs, style: this.style });
          const sample = [
            `${this.style.success(glyphs.ok)} ${this.style.tool("Edit src/app.ts")}  ${this.style.muted(`+2 ${glyphs.minus}1`)}`,
            `  ${this.style.muted(glyphs.result)} ${this.style.danger(`${glyphs.fail} 1 failed`)} ${this.style.muted(glyphs.sep)} ${this.style.accent(`${glyphs.spinner.slice(0, 4).join("")} working${glyphs.ellipsis}`)}`,
          ];
          return logo.lines.map((line, index) => fit(`${line}${" ".repeat(Math.max(0, logo.width - visibleWidth(line)) + 3)}${index === 1 ? (sample[0] ?? "") : index === 2 ? (sample[1] ?? "") : ""}`, width));
        },
        maxVisible: 3,
      },
    );
    return answer?.kind === "selected" ? sets[answer.indices[0] ?? -1] : undefined;
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
    this.workerPane?.dispose();
    for (const dialog of [...this.dialogs].reverse()) dialog.cancel();
    this.removeInputListener?.();
    this.tray.discard();
    if (this.mouseOn && !this.selectMode) this.terminal.write(MOUSE_DISABLE_SEQUENCE);
    await this.terminal.drainInput(this.options.drainInputMs ?? 300, 50);
    this.tui.stop();
    this.guard?.release();
    this.guard = undefined;
    this.options.codepage?.restore();
  }

  private onKey(data: string): { consume?: boolean; data?: string } | undefined {
    // K3: typing into the editor (not a prompt) delays a background worker's prompt until a pause.
    if (this.dialog === undefined && !isMouseSequence(data)) this.lastKeyAtMs = Date.now();
    const worker = isMouseSequence(data) ? undefined : this.onWorkerKey(data);
    if (worker !== undefined) return worker;
    const input = this.onInputKey(data);
    if (input !== undefined) return input;
    if (matchesKey(data, "ctrl+c")) {
      if (this.dialog !== undefined) {
        this.dialog.cancel();
        return { consume: true };
      }
      if (!this.interrupts.requestActive && this.editor.getText().length > 0) {
        this.editor.setText("");
        this.tray.discard();
        this.tui.requestRender();
        return { consume: true };
      }
      this.interrupt("ctrl+c");
      return { consume: true };
    }
    if (matchesKey(data, "escape") && this.dialog === undefined && !this.editor.isShowingAutocomplete()) {
      if (this.interrupt("escape") === "cancel-request") {
        this.lastIdleEscapeAt = undefined;
        return { consume: true };
      }
      // K3: Esc Esc on an empty editor (nothing running) opens /rewind, like Claude Code.
      if (this.presenter !== undefined && this.workerPane === undefined && !this.interrupts.requestActive && this.editor.getText().trim() === "") {
        const now = this.now();
        if (this.lastIdleEscapeAt !== undefined && now - this.lastIdleEscapeAt <= DOUBLE_ESCAPE_MS) {
          this.lastIdleEscapeAt = undefined;
          this.deliver({ kind: "command", text: "/rewind" });
          return { consume: true };
        }
        this.lastIdleEscapeAt = now;
      }
      return undefined;
    }
    if (matchesKey(data, "ctrl+o") && this.dialog === undefined && this.presenter !== undefined) {
      this.expanded = !this.expanded;
      this.tui.requestRender(true);
      return { consume: true };
    }
    // K3: the editor is free while workers run in the background, so a bare `g` toggles the graph only
    // while a worker is selected (a message may begin with "g"); Ctrl+G always does.
    if (this.board !== undefined && this.dialog === undefined && (matchesKey(data, "ctrl+g") || (data === "g" && this.selecting && this.editor.getText().length === 0 && !this.editor.isShowingAutocomplete()))) {
      this.board.toggleMode();
      this.tui.requestRender(true);
      return { consume: true };
    }
    if (data === "?" && this.presenter !== undefined && this.dialog === undefined && this.workerPane === undefined && this.editor.getText().length === 0) {
      this.showShortcuts(this.presenter.glyphs);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && this.dialog === undefined && this.editor.getText().length === 0) {
      this.deliver({ kind: "exit" });
      return { consume: true };
    }
    return undefined;
  }

  /** `?` on an empty editor: the keys, as one short dim block (commands are behind `/`). */
  private showShortcuts(glyphs: GlyphSet): void {
    const up = glyphs.name === "ascii" ? "up" : "↑";
    const items: readonly (readonly [string, string])[] = [
      ["enter", "send"],
      ["shift+enter", "new line"],
      [up, "history"],
      ["esc", "interrupt"],
      ["ctrl+c", "clear / exit"],
      ["shift+tab", "ask/auto/full/plan"],
      ["ctrl+o", "tool details"],
      ["/diff", "what changed"],
      ["/", "commands"],
      ["@", "attach a file"],
      ["alt+v", "paste image"],
      ["/mouse", "scroll mode"],
    ];
    const style = this.style;
    this.transcript.addChild({
      invalidate: () => undefined,
      render: (width: number): string[] => {
        const keyWidth = Math.max(...items.map(([key]) => key.length));
        const cellWidth = Math.max(...items.map(([key, text]) => keyWidth + 1 + text.length)) + 3;
        const perRow = Math.max(1, Math.floor((width - 2) / cellWidth));
        const lines = ["", style.bold("Shortcuts")];
        for (let index = 0; index < items.length; index += perRow) {
          const row = items.slice(index, index + perRow).map(([key, text]) => `${style.cyan(key.padEnd(keyWidth))} ${style.dim(text.padEnd(cellWidth - keyWidth - 1))}`);
          lines.push(fit(`  ${row.join("")}`, width));
        }
        return lines;
      },
    });
    this.tui.requestRender();
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
    if (this.permissionShown) parts.push(this.permissionLabel());
    if (this.footerLabel.mode !== "") parts.push(this.footerLabel.mode);
    if (this.mouseOn && !this.selectMode) parts.push("mouse");
    return parts.length === 0 ? undefined : parts.join(` ${sep} `);
  }

  /** The footer's permission field: full access red and bold, plan cyan, ask yellow, auto plain. */
  private permissionLabel(): string {
    switch (this.permission) {
      case "full":
        return this.style.red(this.style.bold("full access"));
      case "plan":
        return this.style.cyan("plan mode");
      case "ask":
        return this.style.yellow("ask mode");
      case "auto":
        return "auto mode";
    }
  }

  private borderFor(mode: PermissionMode): (text: string) => string {
    return mode === "plan" ? (text) => this.style.accent(text) : mode === "full" ? (text) => this.style.danger(text) : (text) => this.style.border(text);
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
      this.setPermissionMode(nextPermissionMode(this.permission));
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
    const itemId = hit instanceof ToolLineView ? hit.itemId : hit instanceof DelegationComponent ? this.delegationIds.get(hit) : undefined;
    if (itemId !== undefined) {
      if (this.expandedItems.has(itemId)) this.expandedItems.delete(itemId);
      else this.expandedItems.add(itemId);
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

  /** Shift+Tab cycles ask -> auto -> full -> plan; the session applies the policy and prints the notice. */
  private setPermissionMode(mode: PermissionMode): void {
    if (this.permission === mode) return;
    this.permission = mode;
    this.permissionShown = true;
    if (this.workerPane === undefined) this.editor.borderColor = this.borderFor(mode);
    if (this.presenter === undefined && this.permissionListeners.size === 0) this.appendLine({ level: "info", text: `Permission mode: ${mode} (Shift+Tab cycles).` });
    for (const listener of this.permissionListeners) listener(mode);
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
  private openModelPicker(entries: readonly ModelPickerEntry[], signal?: AbortSignal, heading?: PickerHeading): Promise<ModelPickerEntry | undefined> {
    if (entries.length === 0 || this.stopped) return Promise.resolve(undefined);
    // K5: the picker is the shared choice modal (neutral tone, no "Other…").
    const glyphs = this.presenter?.glyphs ?? GLYPH_SETS.rich;
    const tierWidth = Math.min(14, Math.max(...entries.map((entry) => entry.tier.length)));
    const current = entries.findIndex((entry) => entry.current);
    const question: ChoiceQuestion = {
      question: heading?.title ?? "Select model",
      subtitle: heading?.hint ?? "route per tier · provider/model · auth  —  Enter selects, Esc cancels",
      options: entries.map((entry) => {
        const description = [entry.auth, entry.current ? "current" : undefined, entry.description].filter((part) => part !== undefined && part !== "").join(` ${glyphs.sep} `);
        return {
          label: `${entry.current ? glyphs.bullet : " "} ${entry.tier.padEnd(tierWidth)}  ${entry.label ?? `${entry.provider}/${entry.model}`}`,
          ...(description === "" ? {} : { description }),
          ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
        };
      }),
      allowOther: false,
      ...(current >= 0 ? { initialIndex: current } : {}),
      tone: "neutral",
    };
    return this.chooseQuestion(question, signal).then((answer) => (answer?.kind === "selected" ? entries[answer.indices[0] ?? -1] : undefined));
  }

  private submit(text: string): void {
    // An open prompt owns the input: nothing typed while it is open becomes a message.
    if (this.dialog !== undefined) return;
    const trimmed = text.trim();
    if (trimmed === "") return;
    this.editor.addToHistory(trimmed);
    this.editor.setText("");
    this.viewport.toBottom();
    if (trimmed === "/exit" || trimmed === "/quit") {
      this.deliver({ kind: "exit", command: true });
      return;
    }
    if (this.runLocalCommand(trimmed)) return;
    if (this.workerPane !== undefined && !trimmed.startsWith("/")) {
      // K1.7: in a worker view, messages go to that worker, not to the main session.
      this.messageWorker(this.workerPane.key, trimmed);
      return;
    }
    const attachments = this.tray.collect(trimmed);
    this.transcript.addChild(
      this.presenter !== undefined ? new UserMessageView(sanitizeTerminalText(trimmed), this.style, this.presenter.glyphs, () => this.expanded) :new Text(`${this.style.cyan(">")} ${sanitizeTerminalText(trimmed)}`, 0, 0),
    );
    if (this.presenter !== undefined && !trimmed.startsWith("/")) {
      // The activity line appears with the user line, not when the session reports the turn.
      this.presenter.markSubmitted();
      this.updateSpinner();
    }
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

  private openDialog(component: Component, focus: Component, cancel: () => void, tone: "attention" | "neutral" = "neutral"): DialogEntry {
    const entry: DialogEntry = { component, focus, cancel, tone };
    this.dialogs.push(entry);
    this.showTopDialog();
    return entry;
  }

  private closeDialog(entry: DialogEntry | undefined): void {
    const index = entry === undefined ? -1 : this.dialogs.indexOf(entry);
    if (index < 0) return;
    this.dialogs.splice(index, 1);
    this.showTopDialog();
  }

  /** Draws the top of the prompt stack (conversation view: in place of the editor) and focuses it. */
  private showTopDialog(): void {
    this.dialogOverlay?.hide();
    this.dialogOverlay = undefined;
    const top = this.dialog;
    if (this.presenter !== undefined) {
      this.dialogSlot.clear();
      if (top !== undefined) this.dialogSlot.addChild(new DialogFrame(top.component, top.tone === "attention" ? (text) => this.style.warning(text) : (text) => this.style.border(text)));
      this.editorSlot.hidden = top !== undefined;
    } else if (top !== undefined) {
      this.dialogOverlay = this.tui.showOverlay(top.component, { anchor: "bottom-center", width: "90%", margin: 1 });
    }
    this.tui.setFocus(top?.focus ?? this.editor);
    this.tui.requestRender();
  }

  /**
   * A question that owns the input until it is answered (K5): with options a picker (arrows +
   * Enter, 1-9 as shortcuts, Esc cancels), without a one-line answer field. Nothing typed here
   * reaches the conversation. Resolves undefined on Esc or abort.
   */
  private askQuestion(question: string, options: readonly string[] | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (this.stopped || signal?.aborted === true) return Promise.resolve(undefined);
    if (options !== undefined && options.length > 0) {
      // Harness confirmations (/init, /commit, the memory desk) parse known answers: no free-text "Other…".
      return this.chooseQuestion({ question, options: options.map((label) => ({ label })), allowOther: false, tone: "attention" }, signal).then((answer) => (answer === undefined ? undefined : choiceAnswerText(answer)));
    }
    return new Promise((resolve) => {
      const sep = (this.presenter?.glyphs ?? GLYPH_SETS.rich).sep;
      const box = new Box(1, 0);
      box.addChild(new Text(this.style.yellow(this.style.bold(`? ${sanitizeInline(question, 2000)}`)), 0, 0));
      let entry: DialogEntry | undefined;
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.closeDialog(entry);
        resolve(value);
      };
      const onAbort = (): void => finish(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      const input = new Input({ prompt: "> ", placeholder: `type the answer (Enter sends ${sep} Esc cancels)` });
      input.onSubmit = (value) => finish(value);
      input.onEscape = () => finish(undefined);
      box.addChild(input);
      entry = this.openDialog(box, input, () => finish(undefined), "attention");
    });
  }

  /**
   * The K5 choice modal (`ChoiceModal`): arrows + Enter, 1-9, Space toggles in multi-select,
   * "Other…" opens a free-text line, Esc cancels. It owns the input until answered; resolves
   * undefined on Esc or abort. Every choice prompt of the renderer goes through here.
   */
  private chooseQuestion(question: ChoiceQuestion, signal?: AbortSignal, extra: Pick<ChoiceModalOptions, "livePreview" | "maxVisible"> = {}): Promise<ChoiceAnswer | undefined> {
    if (this.stopped || signal?.aborted === true || question.options.length === 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const modal = this.choiceModal(question, extra);
      let entry: DialogEntry | undefined;
      let settled = false;
      const finish = (answer: ChoiceAnswer | undefined): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.closeDialog(entry);
        resolve(answer);
      };
      const onAbort = (): void => finish(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      modal.onSubmit = (answer) => finish(answer);
      modal.onCancel = () => finish(undefined);
      const box = new Box(1, 0);
      box.addChild(modal);
      entry = this.openDialog(box, modal, () => finish(undefined), question.tone ?? "attention");
    });
  }

  private choiceModal(question: ChoiceQuestion, extra: Pick<ChoiceModalOptions, "livePreview" | "maxVisible"> = {}): ChoiceModal {
    return new ChoiceModal(question, {
      ...extra,
      style: this.style,
      glyphs: this.presenter?.glyphs ?? GLYPH_SETS.rich,
      isKey: (data, key) => matchesKey(data, key),
      printable: (data) => {
        const paste = BRACKETED_PASTE.exec(data);
        if (paste !== null) return (paste[1] ?? "").replace(/\r?\n/g, " ");
        return decodeKittyPrintable(data) ?? (data.startsWith("\x1b") || data.length === 0 ? undefined : data);
      },
    });
  }

  /**
   * The body of an action prompt in plain words: the action as the transcript names it (`Edit
   * src/a.ts  +1 −1`, `$ npm install left-pad`), the edit preview, and what allowing it means. The
   * policy's generic reason (`workspace-write needs your approval`) is left out; a specific one stays.
   */
  private approvalLines(request: ApprovalRequest): string[] {
    const glyphs = this.presenter?.glyphs ?? GLYPH_SETS.rich;
    const paint = toolPaint(this.style);
    const lines = [this.style.yellow(this.style.bold(actionTitle(request)))];
    const pending = request.command === undefined ? this.presenter?.pendingTool() : undefined;
    if (request.command !== undefined) lines.push(`  ${this.style.dim("$")} ${this.style.bold(sanitizeInline(request.command.join(" "), 2000))}`);
    else if (pending !== undefined) lines.push(`  ${this.style.bold(sanitizeInline(pending.title, 500))}${pending.stat === undefined ? "" : `  ${this.style.dim(pending.stat)}`}`);
    else lines.push(`  ${sanitizeInline(request.summary, 2000)}`);
    if (pending !== undefined && pending.preview.length > 0) {
      const shown = pending.preview.slice(0, 8);
      for (const line of shown) lines.push(`    ${diffLine(line, glyphs, paint)}`);
      if (pending.preview.length > shown.length) lines.push(this.style.dim(`    ${glyphs.ellipsis} +${pending.preview.length - shown.length} more lines`));
    }
    if (request.command !== undefined && this.inputRoot !== "") lines.push(this.style.dim(`  in ${this.footerLabel.folder === "" ? this.inputRoot : this.footerLabel.folder}`));
    const why = request.details?.why;
    if (why !== undefined && !/^[\w-]+ needs your approval$/.test(why)) lines.push(this.style.dim(`  why: ${sanitizeInline(why, 1000)}`));
    if (request.details !== undefined) lines.push(this.style.dim(`  ${sanitizeInline(request.details.consequence, 1000)}`));
    else if (request.effect !== undefined) lines.push(this.style.dim(`  effect ${request.effect} ${glyphs.sep} scope ${request.scope}`));
    return lines;
  }

  private requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    // The prompt names the pending tool, so the events queued before the request must be applied first.
    this.queue.flush();
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
      new Promise<ApprovalAnswer>((resolve, reject) => {
        const trust = request.subject_kind === "workspace-trust";
        // K5: the approval card is the shared choice modal; its rows keep the broker's outcomes.
        const values: string[] = [];
        const question: ChoiceQuestion = trust
          ? {
              question: this.presenter !== undefined ? "Trust this folder?" : "Trust this workspace?",
              context: [sanitizeInline(request.summary, 2000)],
              // "Not now" first, so the pre-selected answer never trusts anything; no digit shortcuts either.
              options: WORKSPACE_TRUST_CHOICES.map((choice) => {
                values.push(choice.outcome);
                return { label: choice.label };
              }),
              numberShortcuts: false,
              allowOther: false,
              escapeLabel: "not now",
              tone: "attention",
            }
          : {
              // UX-03 action card: what (and the edit itself), where, what allowing means, then the choices.
              question: actionTitle(request),
              context: this.approvalLines(request).slice(1),
              options: actionChoices(request).map((choice) => {
                values.push(choice.value);
                return { label: choice.label };
              }),
              allowOther: false,
              escapeLabel: "denies",
              tone: "attention",
            };
        const modal = this.choiceModal(question);
        const box = new Box(1, 0);
        box.addChild(modal);
        let entry: DialogEntry | undefined;
        let settled = false;
        const finish = (outcome: ApprovalAnswer | undefined): void => {
          if (settled) return;
          settled = true;
          promptSignal.removeEventListener("abort", onAbort);
          this.closeDialog(entry);
          if (outcome === undefined) reject(new DOMException("The approval prompt was cancelled", "AbortError"));
          else resolve(outcome);
        };
        const onAbort = (): void => finish(undefined);
        promptSignal.addEventListener("abort", onAbort, { once: true });
        const askWhy = (): void => {
          const reason = new Input({ prompt: "why? ", placeholder: "tell Synorch why (Enter sends, Esc just denies)" });
          const why = new Box(1, 0);
          why.addChild(new Text(this.style.yellow("Denied. Tell Synorch why (optional)"), 0, 0));
          why.addChild(reason);
          reason.onSubmit = (value) => finish(value.trim() === "" ? "rejected" : { choice: "rejected", reason: value });
          reason.onEscape = () => finish("rejected");
          // Replace the choices without cancelling the pending answer.
          this.closeDialog(entry);
          entry = this.openDialog(why, reason, () => finish(undefined));
        };
        const pick = (value: string): void => {
          if (value === "rejected-why") askWhy();
          else finish(value as ApprovalChoice);
        };
        modal.onSubmit = (answer) => {
          const value = answer.kind === "selected" ? values[answer.indices[0] ?? -1] : undefined;
          if (value !== undefined) pick(value);
        };
        modal.onCancel = () => finish("rejected");
        entry = this.openDialog(box, modal, () => finish(undefined), "attention");
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
      let entry: DialogEntry | undefined;
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.closeDialog(entry);
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
      entry = this.openDialog(input, input, () => finish(undefined));
    });
  }

  private acknowledge(notice: AuthNotice, signal: AbortSignal): Promise<boolean> {
    if (!notice.requiresAcknowledgement) {
      this.appendLine({ level: "warning", text: `notice: ${sanitizeInline(notice.text, 1000)}` });
      return Promise.resolve(true);
    }
    const question: ChoiceQuestion = { question: sanitizeInline(notice.text, 1000), options: [{ label: "I understand, continue" }, { label: "Cancel" }], allowOther: false, tone: "neutral" };
    return this.chooseQuestion(question, signal).then((answer) => answer?.kind === "selected" && answer.indices[0] === 0);
  }
}

function welcomePreferences(settings: WelcomeSettings): WelcomePreferences {
  return { style: settings.style, logo: settings.logo, fields: [...settings.fields], tips: settings.tips };
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
