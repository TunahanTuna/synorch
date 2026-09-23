import type { ContentPart, ModelMessage, RenderEvent, SessionEvent, SessionEventOf, Usage } from "../contracts/index.ts";
import { describeEvent } from "./describe.ts";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.ts";

/**
 * The conversation view (TUI experience §2.1, §7, §8.2–8.4; ADR-21): a pure presenter that turns
 * the runtime's render events into conversation items, shared by the pi-tui and plain renderers.
 * Quiet by default (L0): user messages, the agent's streamed answer, one line (+ one summary line)
 * per tool call, a small edit diff, and only the notices that need the user. No ids, no state
 * names, no JSON. `expanded` (Ctrl+O, L1) adds tool output and full diffs; `debug` (L2) adds the
 * raw event lines.
 */

export type GlyphSetName = "rich" | "safe" | "ascii";

export interface GlyphSet {
  readonly name: GlyphSetName;
  readonly bullet: string;
  readonly result: string;
  readonly ok: string;
  readonly fail: string;
  readonly warn: string;
  readonly user: string;
  readonly sep: string;
  readonly minus: string;
  readonly resume: string;
  readonly ellipsis: string;
  readonly spinner: readonly string[];
  readonly spinnerMs: number;
}

export const GLYPH_SETS: { readonly [N in GlyphSetName]: GlyphSet } = {
  rich: { name: "rich", bullet: "●", result: "⎿", ok: "✓", fail: "✗", warn: "!", user: ">", sep: "·", minus: "−", resume: "↻", ellipsis: "…", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], spinnerMs: 80 },
  safe: { name: "safe", bullet: "●", result: "└", ok: "√", fail: "×", warn: "!", user: ">", sep: "·", minus: "-", resume: "~", ellipsis: "…", spinner: ["-", "\\", "|", "/"], spinnerMs: 120 },
  ascii: { name: "ascii", bullet: "*", result: "\\_", ok: "+", fail: "x", warn: "!", user: ">", sep: "-", minus: "-", resume: "~", ellipsis: "...", spinner: ["-", "\\", "|", "/"], spinnerMs: 120 },
};

/**
 * `SYN_GLYPHS` > automatic detection (TUI §11.1): plain or `TERM=dumb` → ascii; Windows Terminal,
 * VS Code or WezTerm → rich; classic conhost → safe (no braille, no ⎿); everything else → rich.
 */
export function selectGlyphs(env: Readonly<Record<string, string | undefined>>, platform: string, plain: boolean): GlyphSet {
  const wanted = env.SYN_GLYPHS?.trim().toLowerCase();
  if (wanted === "rich" || wanted === "safe" || wanted === "ascii") return GLYPH_SETS[wanted];
  if (plain || env.TERM === "dumb") return GLYPH_SETS.ascii;
  if (platform === "win32") {
    const modern = env.WT_SESSION !== undefined || ["vscode", "WezTerm", "Tabby", "Hyper"].includes(env.TERM_PROGRAM ?? "");
    return modern ? GLYPH_SETS.rich : GLYPH_SETS.safe;
  }
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (locale !== undefined && locale !== "" && !/utf-?8/i.test(locale)) return GLYPH_SETS.ascii;
  if (env.TERM === "linux") return GLYPH_SETS.safe;
  return GLYPH_SETS.rich;
}

export type ToolStatus = "running" | "ok" | "failed" | "denied" | "cancelled";

export type DiffLine = { readonly op: "+" | "-" | " " | "…"; readonly text: string };

export type ConversationItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string; readonly done: boolean }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly status: ToolStatus;
      /** `Read src/a.ts`, `Run npm test`, `Edit src/a.ts`. */
      readonly title: string;
      /** The `⎿` line; undefined while nothing is known yet. */
      readonly summary: string | undefined;
      /** L0 preview (edit diff ≤ 8 lines, last lines of a failing command). */
      readonly preview: readonly DiffLine[];
      /** L1 detail (Ctrl+O): output head, full diff. */
      readonly detail: readonly DiffLine[];
    }
  | { readonly kind: "note"; readonly id: string; readonly level: "info" | "warning" | "error" | "debug"; readonly text: string };

export type ViewOp = { readonly op: "append" | "update"; readonly item: ConversationItem };

export interface ActivityState {
  readonly verb: string;
  readonly detail: string | undefined;
  readonly startedAt: number;
  readonly tokens: number;
  readonly waiting: boolean;
}

export interface FooterState {
  readonly model: string | undefined;
  readonly contextPercent: number | undefined;
  readonly quotaPercent: number | undefined;
  readonly costUsd: number | undefined;
}

export interface ConversationPresenterOptions {
  readonly glyphs: GlyphSet;
  /** The renderer already echoed the user's live messages (the TUI echoes on Enter). */
  readonly echoesUser: boolean;
  readonly debug?: boolean;
  readonly model?: string;
  readonly contextWindowTokens?: number;
  readonly now?: () => number;
}

const COORDINATION_TOOLS = new Set(["ask_user", "load_skill", "memory_propose", "plan_propose", "task_spawn", "task_status", "task_triage", "task_report", "review_report"]);
const PREVIEW_LINES = 8;
const DETAIL_LINES = 10;

interface ToolState {
  id: string;
  name: string;
  args: Readonly<Record<string, unknown>>;
  status: ToolStatus;
  title: string;
  summary: string | undefined;
  preview: DiffLine[];
  detail: DiffLine[];
  /** Read grouping: several read_file calls share one item. */
  group: string[] | undefined;
}

type ToolCallPart = Extract<ContentPart, { type: "tool_call" }>;

export class ConversationPresenter {
  private readonly options: ConversationPresenterOptions;
  private readonly now: () => number;
  private readonly tools = new Map<string, ToolState>();
  /** tool_call_id -> item id (a read group maps several calls to one item). */
  private readonly toolItem = new Map<string, string>();
  private readonly assistant = new Map<string, { id: string; text: string }>();
  private readonly streamed = new Set<string>();
  private counter = 0;
  private lastItem: string | undefined;
  private replaying = false;
  private turnStartedAt: number | undefined;
  private turnTokens = 0;
  private streamChars = 0;
  private activityVerb: { verb: string; detail: string | undefined } | undefined;
  private waiting = false;
  private contextTokens: number | undefined;
  private quota: number | undefined;
  private cost: number | undefined;
  private model: string | undefined;
  private contextWindow: number | undefined;

  public constructor(options: ConversationPresenterOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.model = options.model;
    this.contextWindow = options.contextWindowTokens;
  }

  /** Header facts known only at start: the conversation model and its context window. */
  public configure(values: { readonly model?: string | undefined; readonly contextWindowTokens?: number | undefined }): void {
    if (values.model !== undefined) this.model = values.model;
    if (values.contextWindowTokens !== undefined) this.contextWindow = values.contextWindowTokens;
  }

  public get glyphs(): GlyphSet {
    return this.options.glyphs;
  }

  /** Renders earlier events of a resumed conversation (the TUI shows past user messages too). */
  public replay(events: readonly SessionEvent[]): ViewOp[] {
    this.replaying = true;
    try {
      return events.flatMap((event) => this.apply({ kind: "session-event", event }));
    } finally {
      this.replaying = false;
      this.turnStartedAt = undefined;
      this.activityVerb = undefined;
    }
  }

  public setWaiting(waiting: boolean): void {
    this.waiting = waiting;
  }

  public activity(): ActivityState | undefined {
    if (this.turnStartedAt === undefined) return undefined;
    const verb = this.waiting ? { verb: "Waiting for you", detail: undefined } : (this.activityVerb ?? { verb: "Thinking", detail: undefined });
    return { verb: verb.verb, detail: verb.detail, startedAt: this.turnStartedAt, tokens: this.turnTokens + Math.round(this.streamChars / 4), waiting: this.waiting };
  }

  public footer(): FooterState {
    const window = this.contextWindow;
    return {
      model: this.model,
      contextPercent: this.contextTokens === undefined || window === undefined || window <= 0 ? undefined : Math.min(100, Math.round((this.contextTokens / window) * 100)),
      quotaPercent: this.quota,
      costUsd: this.cost,
    };
  }

  public apply(event: RenderEvent): ViewOp[] {
    switch (event.kind) {
      case "session-event":
        return this.onEvent(event.event);
      case "stream":
        return this.onStream(event.requestId, event.event);
      case "notice":
        return [this.note(event.level, event.message)];
      case "status":
        return [];
    }
  }

  /** A line the CLI adds itself (slash command output, trust decisions). */
  public note(level: "info" | "warning" | "error" | "debug", text: string): ViewOp {
    const item: ConversationItem = { kind: "note", id: this.nextId(), level, text: sanitizeInline(text, 2000) };
    this.lastItem = item.id;
    return { op: "append", item };
  }

  private nextId(): string {
    this.counter += 1;
    return `v${this.counter}`;
  }

  private onStream(requestId: string, event: Extract<RenderEvent, { kind: "stream" }>["event"]): ViewOp[] {
    if (event.type === "text_delta") {
      this.streamed.add(requestId);
      this.streamChars += event.text.length;
      this.activityVerb = undefined;
      const key = `${requestId}:${event.index}`;
      const known = this.assistant.get(key);
      if (known === undefined) {
        const state = { id: this.nextId(), text: event.text };
        this.assistant.set(key, state);
        this.lastItem = state.id;
        return [{ op: "append", item: { kind: "assistant", id: state.id, text: sanitizeTerminalText(state.text), done: false } }];
      }
      known.text += event.text;
      return [{ op: "update", item: { kind: "assistant", id: known.id, text: sanitizeTerminalText(known.text), done: false } }];
    }
    if (event.type === "done") {
      const ops: ViewOp[] = [];
      event.message.content.forEach((part, index) => {
        if (part.type !== "text") return;
        const known = this.assistant.get(`${requestId}:${index}`);
        if (known === undefined) return;
        known.text = part.text;
        ops.push({ op: "update", item: { kind: "assistant", id: known.id, text: sanitizeTerminalText(known.text), done: true } });
      });
      this.streamChars = 0;
      return ops;
    }
    if (event.type === "quota") this.quota = maxQuota(event.quota.windows);
    return [];
  }

  private onEvent(event: SessionEvent): ViewOp[] {
    const debug = this.options.debug === true ? this.debugLine(event) : [];
    return [...this.present(event), ...debug];
  }

  private debugLine(event: SessionEvent): ViewOp[] {
    const line = describeEvent(event);
    return line === undefined ? [] : [this.note("debug", `[event] ${line.text}`)];
  }

  private present(event: SessionEvent): ViewOp[] {
    switch (event.type) {
      case "turn/started":
        if (!this.replaying) {
          this.turnStartedAt = this.now();
          this.turnTokens = 0;
          this.streamChars = 0;
          this.activityVerb = undefined;
        }
        return [];
      case "turn/ended":
        return this.turnEnded(event);
      case "message/recorded":
        return this.message(event);
      case "steer/queued":
        return this.options.echoesUser && !this.replaying ? [] : [this.user(event.data.text)];
      case "model/request_prepared":
        this.contextTokens = event.data.context.reduce((sum, block) => sum + block.tokens_estimate, 0);
        this.model ??= event.data.route.model_id;
        return [];
      case "provider/usage":
        this.turnTokens += usageTokens(event.data.usage);
        if (event.data.usage.cost_usd_estimate !== undefined) this.cost = (this.cost ?? 0) + event.data.usage.cost_usd_estimate;
        if (event.data.quota !== undefined) this.quota = maxQuota(event.data.quota.windows);
        return [];
      case "model/response_failed":
        if (event.data.error.code === "cancelled") return [];
        return [this.note("error", `${this.options.glyphs.fail} The model request failed: ${event.data.error.message}${event.data.error.retryable ? " · press Enter to try again" : ""}`)];
      case "model/response_settled":
        return event.data.stop_reason === "length" ? [this.note("warning", `${this.options.glyphs.warn} The reply was cut off (length limit)`)] : [];
      case "tool/policy_decided":
        return this.toolDecided(event);
      case "tool/execution_started":
        return this.toolStarted(event);
      case "tool/result_recorded":
        return this.toolFinished(event);
      case "approval/requested":
        this.waiting = !this.replaying;
        return [];
      case "approval/decided":
        this.waiting = false;
        return event.data.decision.decided_by === "user" ? [this.note("info", `${event.data.decision.outcome.startsWith("allowed") ? this.options.glyphs.ok : this.options.glyphs.fail} ${event.data.decision.outcome.startsWith("allowed") ? "Allowed" : "Not allowed"}`)] : [];
      case "context/compacted":
        return [this.note("info", `${this.options.glyphs.bullet} Context compacted ${this.options.glyphs.sep} ${formatTokens(event.data.tokens_before)} → ${formatTokens(event.data.tokens_after)} tokens`)];
      case "checkpoint/restored":
        return [];
      case "session/resumed":
        return [];
      default:
        return [];
    }
  }

  private turnEnded(event: SessionEventOf<"turn/ended">): ViewOp[] {
    const started = this.turnStartedAt;
    this.turnStartedAt = undefined;
    this.activityVerb = undefined;
    this.waiting = false;
    const ops: ViewOp[] = [];
    const g = this.options.glyphs;
    for (const state of this.tools.values()) {
      if (state.status === "running") {
        state.status = "cancelled";
        state.summary = "interrupted · may have partly run";
        ops.push({ op: "update", item: this.toolView(state) });
      }
    }
    switch (event.data.outcome) {
      case "cancelled":
        if (!this.replaying) ops.push(this.note("warning", `${g.result} Interrupted ${g.sep} tell Synorch what to do instead`));
        break;
      case "max_steps":
        ops.push(this.note("warning", `${g.warn} Stopped: the turn reached its step limit ${g.sep} say "continue" to go on`));
        break;
      case "budget_exceeded":
        ops.push(this.note("warning", `${g.warn} Stopped: the budget admits no further model request`));
        break;
      case "failed":
        if (!this.replaying) ops.push(this.note("error", `${g.fail} The turn failed ${g.sep} workspace unchanged unless a tool line above says otherwise`));
        break;
      default:
        break;
    }
    if (started !== undefined && !this.replaying) {
      const elapsed = this.now() - started;
      if (elapsed >= 10_000) ops.push(this.note("info", `  worked ${formatElapsed(elapsed)} ${g.sep} ${formatTokens(this.turnTokens)} tokens`));
    }
    return ops;
  }

  private user(text: string): ViewOp {
    const item: ConversationItem = { kind: "user", id: this.nextId(), text: sanitizeTerminalText(text) };
    this.lastItem = item.id;
    return { op: "append", item };
  }

  private message(event: SessionEventOf<"message/recorded">): ViewOp[] {
    const message: ModelMessage | undefined = event.data.message;
    if (message === undefined) return [];
    if (message.role === "user") {
      if (this.options.echoesUser && !this.replaying) return [];
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      return text.trim() === "" ? [] : [this.user(stripHarnessNotes(text))];
    }
    if (message.role !== "assistant") return [];
    const ops: ViewOp[] = [];
    const streamed = event.data.request_id !== undefined && this.streamed.has(event.data.request_id);
    for (const part of message.content) {
      if (part.type === "text" && !streamed && part.text.trim() !== "") {
        const id = this.nextId();
        this.lastItem = id;
        ops.push({ op: "append", item: { kind: "assistant", id, text: sanitizeTerminalText(part.text), done: true } });
      }
      if (part.type === "tool_call") ops.push(...this.toolProposed(part));
    }
    return ops;
  }

  private toolProposed(part: ToolCallPart): ViewOp[] {
    if (COORDINATION_TOOLS.has(part.name) || part.tool_call_id === undefined) return [];
    const args = part.arguments as Readonly<Record<string, unknown>>;
    if (part.name === "read_file") {
      const last = this.lastItem === undefined ? undefined : [...this.tools.values()].find((state) => state.id === this.lastItem && state.group !== undefined);
      const file = stringArg(args, "path") ?? "?";
      if (last !== undefined && last.group !== undefined && last.status !== "denied" && last.status !== "failed") {
        last.group.push(file);
        last.title = `Read ${last.group.length} files`;
        last.summary = shortList(last.group.map((entry) => entry.split("/").at(-1) ?? entry));
        last.status = "running";
        this.toolItem.set(part.tool_call_id, last.id);
        return [{ op: "update", item: this.toolView(last) }];
      }
    }
    const state: ToolState = {
      id: this.nextId(),
      name: part.name,
      args,
      status: "running",
      title: toolTitle(part.name, args),
      summary: undefined,
      preview: [],
      detail: [],
      group: part.name === "read_file" ? [stringArg(args, "path") ?? "?"] : undefined,
    };
    this.tools.set(state.id, state);
    this.toolItem.set(part.tool_call_id, state.id);
    this.lastItem = state.id;
    return [{ op: "append", item: this.toolView(state) }];
  }

  private stateFor(toolCallId: string): ToolState | undefined {
    const id = this.toolItem.get(toolCallId);
    return id === undefined ? undefined : this.tools.get(id);
  }

  private toolDecided(event: SessionEventOf<"tool/policy_decided">): ViewOp[] {
    const state = this.stateFor(event.data.tool_call_id);
    if (state === undefined || event.data.decision.decision !== "deny") return [];
    state.status = "denied";
    state.summary = denialSummary(event.data.decision.reasons, event.data.action.command?.argv, this.options.glyphs);
    return [{ op: "update", item: this.toolView(state) }];
  }

  private toolStarted(event: SessionEventOf<"tool/execution_started">): ViewOp[] {
    const state = this.stateFor(event.data.tool_call_id);
    if (state === undefined) return [];
    if (!this.replaying) {
      this.activityVerb =
        state.name === "exec"
          ? { verb: "Running", detail: sanitizeInline(argvOf(state.args).join(" "), 60) }
          : state.name === "apply_patch" || state.name === "write_file"
            ? { verb: "Editing", detail: undefined }
            : { verb: "Reading", detail: undefined };
    }
    return [];
  }

  private toolFinished(event: SessionEventOf<"tool/result_recorded">): ViewOp[] {
    const state = this.stateFor(event.data.tool_call_id);
    if (!this.replaying) this.activityVerb = undefined;
    if (state === undefined) return [];
    if (event.data.state === "denied" && state.status === "denied") return [];
    const result = event.data.result;
    const g = this.options.glyphs;
    if (event.data.state === "denied") {
      state.status = "denied";
      state.summary = sanitizeInline(result.error?.message ?? "refused", 200);
      return [{ op: "update", item: this.toolView(state) }];
    }
    if (event.data.state === "cancelled") {
      state.status = "cancelled";
      state.summary = "interrupted · may have partly run";
      return [{ op: "update", item: this.toolView(state) }];
    }
    const failed = event.data.state !== "succeeded" || result.status === "error";
    if (state.group !== undefined && state.group.length > 1) {
      state.status = failed ? "failed" : "ok";
      if (failed) state.summary = `${state.summary ?? ""} ${g.sep} ${sanitizeInline(result.error?.message ?? "failed", 120)}`;
      return [{ op: "update", item: this.toolView(state) }];
    }
    state.status = failed ? "failed" : "ok";
    const outcome = summarizeResult(state.name, state.args, result, event.data.duration_ms, g);
    state.summary = outcome.summary;
    state.preview = outcome.preview;
    state.detail = outcome.detail;
    return [{ op: "update", item: this.toolView(state) }];
  }

  private toolView(state: ToolState): ConversationItem {
    return { kind: "tool", id: state.id, status: state.status, title: state.title, summary: state.summary, preview: [...state.preview], detail: [...state.detail] };
  }
}

function usageTokens(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function maxQuota(windows: readonly { readonly used_percent: number }[]): number | undefined {
  if (windows.length === 0) return undefined;
  return Math.round(Math.max(...windows.map((window) => window.used_percent)));
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The harness prefixes notes (an /undo) to the next user message; the transcript shows only what the user typed. */
function stripHarnessNotes(text: string): string {
  return text.replace(/^\[Synorch note:[^\]]*\]\s*/u, "");
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function argvOf(args: Readonly<Record<string, unknown>>): string[] {
  const argv = args.argv;
  return Array.isArray(argv) ? argv.filter((entry): entry is string => typeof entry === "string") : [];
}

function shortList(names: readonly string[]): string {
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")}, +${names.length - 2}`;
}

/** The files an apply_patch touches, in order (both patch formats). */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const begin = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
    const unified = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    const found = begin?.[1] ?? (unified !== null && unified[1] !== "/dev/null" ? unified[1] : undefined);
    if (found !== undefined && !paths.includes(found.trim())) paths.push(found.trim());
  }
  if (paths.length === 0) {
    for (const line of patch.split(/\r?\n/)) {
      const removed = /^--- (?:a\/)?(.+)$/.exec(line);
      if (removed?.[1] !== undefined && removed[1] !== "/dev/null") paths.push(removed[1].trim());
    }
  }
  return paths;
}

function toolTitle(name: string, args: Readonly<Record<string, unknown>>): string {
  switch (name) {
    case "read_file":
      return `Read ${stringArg(args, "path") ?? "?"}`;
    case "list_dir":
      return `List ${stringArg(args, "path") ?? "."}`;
    case "search": {
      const where = stringArg(args, "path");
      return `Search "${sanitizeInline(stringArg(args, "pattern") ?? "", 60)}"${where === undefined || where === "." ? "" : ` in ${where}`}`;
    }
    case "apply_patch": {
      const paths = patchPaths(stringArg(args, "patch") ?? "");
      return `Edit ${paths.length === 0 ? "files" : paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1}`}`;
    }
    case "write_file":
      return `Write ${stringArg(args, "path") ?? "?"}`;
    case "exec":
      return `Run ${sanitizeInline(argvOf(args).join(" "), 120)}`;
    case "git_status":
      return "Git status";
    case "git_diff":
      return "Git diff";
    default: {
      const first = Object.values(args).find((value): value is string => typeof value === "string");
      return `${name}${first === undefined ? "" : ` ${sanitizeInline(first, 60)}`}`;
    }
  }
}

/** The `/allow` prefix to suggest for a refused argv: the program and, when it is not a flag, its first argument. */
export function allowPrefixFor(argv: readonly string[]): string {
  const [program = "", first] = argv;
  return first !== undefined && !first.startsWith("-") ? `${program} ${first}` : program;
}

function denialSummary(reasons: readonly { readonly code: string; readonly message: string }[], argv: readonly string[] | undefined, g: GlyphSet): string {
  const codes = new Set(reasons.map((reason) => reason.code));
  if (argv !== undefined && argv.length > 0 && codes.has("exec-not-allowlisted") && !reasons.some((reason) => /changes the repository|refused:/.test(reason.message))) {
    return `not allowed here ${g.sep} type /allow ${allowPrefixFor(argv)} to permit it`;
  }
  if (codes.has("workspace-untrusted")) return `runs repository code and this folder is not trusted ${g.sep} /trust to allow it`;
  const first = reasons[0];
  const message = first === undefined ? "blocked by policy" : first.message.replace(/^[^:]*? is refused: /, "");
  return `blocked by policy ${g.sep} ${sanitizeInline(message, 160)}`;
}

function outputLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const body: string[] = [];
  for (const line of lines.slice(2)) {
    if (line === "--- stdout ---" || line === "--- stderr ---") continue;
    body.push(line);
  }
  while (body.length > 0 && body.at(-1)?.trim() === "") body.pop();
  return body;
}

interface ResultSummary {
  readonly summary: string;
  readonly preview: DiffLine[];
  readonly detail: DiffLine[];
}

function textLines(lines: readonly string[]): DiffLine[] {
  return lines.map((text) => ({ op: " ", text: sanitizeInline(text, 300) }));
}

function summarizeResult(
  name: string,
  args: Readonly<Record<string, unknown>>,
  result: SessionEventOf<"tool/result_recorded">["data"]["result"],
  durationMs: number,
  g: GlyphSet,
): ResultSummary {
  const failedText = sanitizeInline(result.error?.message ?? "failed", 200);
  const text = result.text;
  switch (name) {
    case "read_file": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const header = text.split("\n", 1)[0] ?? "";
      const total = /of (\d+)\+?$/.exec(header.replace(/\s*\(.*\)$/, ""))?.[1];
      const lines = text.split("\n").slice(1);
      return { summary: header.includes("empty file") ? "empty file" : total === undefined ? "read" : `${total} lines`, preview: [], detail: textLines(lines.slice(0, DETAIL_LINES)) };
    }
    case "list_dir": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const entries = text === "(empty)" ? [] : text.split("\n").filter((line) => line.trim() !== "");
      return { summary: `${entries.length} entries`, preview: [], detail: textLines(entries.slice(0, DETAIL_LINES)) };
    }
    case "search": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const matches = text === "(no matches)" ? [] : text.split("\n").filter((line) => /^[^:]+:\d+:/.test(line));
      const files = new Set(matches.map((line) => line.split(":")[0]));
      return { summary: matches.length === 0 ? "no matches" : `${matches.length} match${matches.length === 1 ? "" : "es"} in ${files.size} file${files.size === 1 ? "" : "s"}`, preview: [], detail: textLines(matches.slice(0, DETAIL_LINES)) };
    }
    case "apply_patch": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const diff = patchDiff(stringArg(args, "patch") ?? "");
      const added = diff.filter((line) => line.op === "+").length;
      const removed = diff.filter((line) => line.op === "-").length;
      const preview = diff.slice(0, PREVIEW_LINES);
      if (diff.length > PREVIEW_LINES) preview.push({ op: "…", text: `+${diff.length - PREVIEW_LINES} lines (ctrl+o)` });
      return { summary: `+${added} ${g.minus}${removed}`, preview, detail: diff };
    }
    case "write_file": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const content = stringArg(args, "content") ?? "";
      const lines = content === "" ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length;
      const created = text.startsWith("created");
      return { summary: `${created ? "new file" : "rewritten"} ${g.sep} ${lines} lines`, preview: [], detail: textLines(content.split(/\r?\n/).slice(0, DETAIL_LINES)) };
    }
    case "exec": {
      const body = outputLines(text);
      const seconds = `${(durationMs / 1000).toFixed(1)}s`;
      if (result.exit_code === undefined) return { summary: `${g.fail} ${failedText}`, preview: textLines(body.slice(-5)), detail: textLines(body.slice(-DETAIL_LINES)) };
      if (result.exit_code === 0) {
        const tests = /(?:^|\s)(?:ℹ\s+)?pass(?:ed)?\s+(\d+)/im.exec(body.join("\n"))?.[1] ?? /(\d+) passed/i.exec(body.join("\n"))?.[1];
        return { summary: `${g.ok} exit 0${tests === undefined ? "" : ` ${g.sep} ${tests} passed`} ${g.sep} ${seconds}`, preview: [], detail: textLines(body.slice(-DETAIL_LINES)) };
      }
      return { summary: `${g.fail} exit ${result.exit_code} ${g.sep} ${seconds}`, preview: textLines(body.slice(-5)), detail: textLines(body.slice(-DETAIL_LINES)) };
    }
    case "git_status": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const changed = text.split("\n").filter((line) => /^[ MADRCU?!]{2} /.test(line));
      return { summary: changed.length === 0 ? "clean" : `${changed.length} changed`, preview: [], detail: textLines(changed.slice(0, DETAIL_LINES)) };
    }
    default: {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const lines = text.split("\n");
      return { summary: sanitizeInline(lines[0] ?? "done", 80) || "done", preview: [], detail: textLines(lines.slice(0, 20)) };
    }
  }
}

/** A diff line with its indentation kept (tabs as two spaces), control characters removed. */
function diffText(text: string): string {
  return sanitizeTerminalText(text).replaceAll("\t", "  ").replace(/[\r\n]/g, "").slice(0, 300);
}

/** The -/+ lines of a patch in order, for the edit preview (context lines are left out). */
export function patchDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inAdd = false;
  for (const line of patch.split(/\r?\n/)) {
    if (/^\*\*\* Add File: /.test(line)) {
      inAdd = true;
      continue;
    }
    if (/^\*\*\* /.test(line)) {
      inAdd = false;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) lines.push({ op: "+", text: diffText(line.slice(1)) });
    else if (line.startsWith("-")) lines.push({ op: "-", text: diffText(line.slice(1)) });
    else if (inAdd && line !== "") lines.push({ op: "+", text: diffText(line) });
  }
  return lines;
}

/** One-line header (TUI §8.1) and at most one warning line. */
export function headerLines(options: {
  readonly version: string;
  readonly folder: string;
  readonly branch: string | undefined;
  readonly model: string | undefined;
  readonly mode: string;
  readonly sandboxEnforcement: "full" | "partial" | "unavailable";
  readonly warnings: readonly string[];
  readonly glyphs: GlyphSet;
}): { readonly title: string; readonly warning: string | undefined } {
  const g = options.glyphs;
  const title = [`Synorch ${options.version}`, `${options.folder}${options.branch === undefined ? "" : ` (${options.branch})`}`, options.model, options.mode]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(` ${g.sep} `);
  const warnings: string[] = [];
  if (options.sandboxEnforcement !== "full") warnings.push("Sandbox is partial: commands you allow can write outside this folder");
  warnings.push(...options.warnings);
  if (warnings.length === 0) return { title, warning: undefined };
  const [first, ...rest] = warnings;
  return { title, warning: `${g.warn} ${first}${rest.length === 0 ? "" : ` ${g.sep} ${rest.length} more warning${rest.length === 1 ? "" : "s"} ${g.sep} syn doctor --runtime`}` };
}

/** `folder · branch · model · ctx 12% · quota 40%` (TUI §10.2, K0 subset). */
export function footerText(footer: FooterState, extra: { readonly folder: string; readonly branch: string | undefined; readonly glyphs: GlyphSet; readonly mode?: string | undefined }): string {
  const g = extra.glyphs;
  return [
    extra.folder,
    extra.branch,
    footer.model,
    extra.mode,
    footer.contextPercent === undefined ? undefined : `ctx ${footer.contextPercent}%`,
    footer.quotaPercent === undefined ? undefined : `quota ${footer.quotaPercent}%`,
    footer.costUsd === undefined || footer.quotaPercent !== undefined ? undefined : `$${footer.costUsd.toFixed(2)}`,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(` ${g.sep} `);
}

/** `⠼ Thinking… 14s · 2.1k tokens · esc to interrupt` (TUI §10.1). */
export function activityText(activity: ActivityState, now: number, frame: string, glyphs: GlyphSet): string {
  const g = glyphs;
  const parts = [`${activity.waiting ? "?" : frame} ${activity.verb}${activity.detail === undefined ? "" : ` ${activity.detail}`}${g.name === "ascii" ? "..." : "…"}`, formatElapsed(now - activity.startedAt)];
  if (activity.tokens > 0) parts.push(`${formatTokens(activity.tokens)} tokens`);
  if (!activity.waiting) parts.push("esc to interrupt");
  return parts.join(` ${g.sep} `);
}
