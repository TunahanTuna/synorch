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
      /**
       * The compact stat the interactive view prints beside the title (`+8 −3`, `12 passed · 6.1s`);
       * the status glyph carries success or failure, so it repeats neither. Plain mode keeps `summary`.
       */
      readonly stat?: string | undefined;
      /** K4.2: a background process this call started (`◌ dev server (pnpm dev)  running · 12s`). */
      readonly background?: { readonly handle: string; readonly startedAt: number } | undefined;
    }
  /** The turn-end result line: what changed and whether tests ran (never claims an unrun test). */
  | { readonly kind: "result"; readonly id: string; readonly text: string; readonly tone: "ok" | "warning" | "error" }
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
  /** K6: the conversation's reasoning effort, shown next to the model (`gpt-6-sol · high`). */
  readonly effort: string | undefined;
  readonly contextPercent: number | undefined;
  readonly quotaPercent: number | undefined;
  /** Whose quota `quotaPercent` is (`claude`, `chatgpt`): the most-used subscription of this process. */
  readonly quotaProvider?: string | undefined;
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
  stat: string | undefined;
  /** Read grouping: several read_file calls share one item. */
  group: string[] | undefined;
  /** Edit preview shown in an approval prompt before the tool runs. */
  pending: DiffLine[];
  background?: { readonly handle: string; readonly startedAt: number } | undefined;
}

/** What this turn changed and tested, for the result line (terminal polish brief §5). */
interface TurnLedger {
  readonly files: Map<string, { added: number; removed: number; created: boolean }>;
  tests: { passed: number | undefined; failed: number | undefined; ok: boolean; exit: number | undefined } | undefined;
}

type ToolCallPart = Extract<ContentPart, { type: "tool_call" }>;

export class ConversationPresenter {
  private readonly options: ConversationPresenterOptions;
  private readonly now: () => number;
  private readonly tools = new Map<string, ToolState>();
  /** Approval ids whose prompt offered "always allow <domain>" (K4.1). */
  private readonly hostApprovals = new Set<string>();
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
  /** Highest window % per provider (this conversation's requests and its workers'). */
  private readonly quotas = new Map<string, number>();
  private readonly requestProviders = new Map<string, string>();
  private cost: number | undefined;
  private model: string | undefined;
  private effort: string | undefined;
  private contextWindow: number | undefined;
  private ledger: TurnLedger = { files: new Map(), tests: undefined };
  /** The turn's checklist item: later `todo` calls in the same turn update it in place. */
  private todoItem: string | undefined;
  /** Enter was pressed and no turn has started yet: the activity line shows at once. */
  private submittedAt: number | undefined;

  public constructor(options: ConversationPresenterOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.model = options.model;
    this.contextWindow = options.contextWindowTokens;
  }

  /** Live facts of the conversation model (start, `/model`, `/effort`): `effort: null` clears it, undefined keeps it. */
  public configure(values: { readonly model?: string | undefined; readonly effort?: string | null | undefined; readonly contextWindowTokens?: number | undefined }): void {
    if (values.model !== undefined) this.model = values.model;
    if (values.effort !== undefined) this.effort = values.effort ?? undefined;
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

  /** The user just sent a message: show the activity line now, before the session reports the turn. */
  public markSubmitted(): void {
    if (this.turnStartedAt === undefined) this.submittedAt = this.now();
  }

  /** Drops a pending (not yet started) activity, e.g. when the session answered with an error. */
  public clearSubmitted(): void {
    this.submittedAt = undefined;
  }

  /** The tool an approval prompt is about: its title and the edit it would make. */
  public pendingTool(): { readonly title: string; readonly stat: string | undefined; readonly preview: readonly DiffLine[] } | undefined {
    const running = [...this.tools.values()].reverse().find((state) => state.status === "running");
    if (running === undefined) return undefined;
    const added = running.pending.filter((line) => line.op === "+").length;
    const removed = running.pending.filter((line) => line.op === "-").length;
    return { title: running.title, stat: running.pending.length === 0 ? undefined : `+${added} ${this.options.glyphs.minus}${removed}`, preview: running.pending };
  }

  public activity(): ActivityState | undefined {
    if (this.turnStartedAt === undefined && this.submittedAt !== undefined) {
      if (this.now() - this.submittedAt > 15_000) this.submittedAt = undefined;
      else return { verb: "Thinking", detail: undefined, startedAt: this.submittedAt, tokens: 0, waiting: false };
    }
    if (this.turnStartedAt === undefined) return undefined;
    const verb = this.waiting ? { verb: "Waiting for you", detail: undefined } : (this.activityVerb ?? { verb: "Thinking", detail: undefined });
    return { verb: verb.verb, detail: verb.detail, startedAt: this.turnStartedAt, tokens: this.turnTokens + Math.round(this.streamChars / 4), waiting: this.waiting };
  }

  public footer(): FooterState {
    const window = this.contextWindow;
    return {
      model: this.model,
      effort: this.effort,
      contextPercent: this.contextTokens === undefined || window === undefined || window <= 0 ? undefined : Math.min(100, Math.round((this.contextTokens / window) * 100)),
      ...this.topQuota(),
      costUsd: this.cost,
    };
  }

  private topQuota(): { quotaPercent: number | undefined; quotaProvider?: string } {
    let top: [string, number] | undefined;
    for (const entry of this.quotas) if (top === undefined || entry[1] > top[1]) top = entry;
    if (top === undefined) return { quotaPercent: undefined };
    return top[0] === "" ? { quotaPercent: top[1] } : { quotaPercent: top[1], quotaProvider: quotaProviderLabel(top[0]) };
  }

  private noteQuota(provider: string | undefined, windows: readonly { readonly used_percent: number }[]): void {
    const percent = maxQuota(windows);
    if (percent !== undefined) this.quotas.set(provider ?? "", percent);
  }

  public apply(event: RenderEvent): ViewOp[] {
    switch (event.kind) {
      case "session-event":
        return this.onEvent(event.event);
      case "stream":
        return this.onStream(event.requestId, event.event);
      case "notice":
        if (event.level !== "info") this.submittedAt = undefined;
        return [this.note(event.level, event.message)];
      case "status":
        return [];
    }
  }

  /** A line the CLI adds itself (slash command output, trust decisions). */
  public note(level: "info" | "warning" | "error" | "debug", text: string): ViewOp {
    // Leading indentation is layout (plan items, `Workspace` rows under an error): keep it, flatten the rest.
    const item: ConversationItem = { kind: "note", id: this.nextId(), level, text: `${/^ {0,8}/.exec(text)?.[0] ?? ""}${sanitizeInline(text, 2000)}` };
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
      this.activityVerb = { verb: "Responding", detail: undefined };
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
      if (this.activityVerb?.verb === "Responding") this.activityVerb = undefined;
      return ops;
    }
    if (event.type === "quota") this.noteQuota(this.requestProviders.get(requestId), event.quota.windows);
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
        this.ledger = { files: new Map(), tests: undefined };
        this.todoItem = undefined;
        if (!this.replaying) {
          this.turnStartedAt = this.submittedAt ?? this.now();
          this.submittedAt = undefined;
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
        this.requestProviders.set(event.data.request_id, event.data.route.provider_id);
        return [];
      case "provider/usage":
        this.turnTokens += usageTokens(event.data.usage);
        if (event.data.usage.cost_usd_estimate !== undefined) this.cost = (this.cost ?? 0) + event.data.usage.cost_usd_estimate;
        if (event.data.quota !== undefined) this.noteQuota(event.data.provider_id ?? this.requestProviders.get(event.data.request_id), event.data.quota.windows);
        this.requestProviders.delete(event.data.request_id);
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
      case "backend/tool_observed":
        return this.backendTool(event);
      case "approval/requested":
        this.waiting = !this.replaying;
        if (event.data.request.hosts !== undefined) this.hostApprovals.add(event.data.request.approval_id);
        return [];
      case "approval/decided":
        this.waiting = false;
        // A domain grant has its own line (network/host_allowed).
        if (this.hostApprovals.delete(event.data.decision.approval_id)) return [];
        // The tool row already shows a one-off answer (it runs, or turns ✗ denied); only a lasting grant gets its own line.
        return event.data.decision.decided_by === "user" && event.data.decision.outcome === "allowed-for-scope" ? [this.note("info", `${this.options.glyphs.ok} Allowed for the rest of this session`)] : [];
      case "network/host_allowed":
        return [this.note("info", `${this.options.glyphs.ok} Always allowed: ${event.data.host} (every project) ${this.options.glyphs.sep} /permissions lists and removes it`)];
      case "web/searched":
        return this.nativeSearch(event);
      case "context/compacted":
        // The footer's ctx% follows at once, not only at the next request.
        this.contextTokens = event.data.tokens_after;
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
    this.submittedAt = undefined;
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
        if (!this.replaying) ops.push(this.note("error", `${g.fail} The turn stopped on an error ${g.sep} files are unchanged unless a tool line above says otherwise ${g.sep} say "try again", or /diff to check`));
        break;
      default:
        break;
    }
    const result = this.resultLine(event.data.outcome);
    if (result !== undefined) ops.push(result);
    if (started !== undefined && !this.replaying) {
      const elapsed = this.now() - started;
      if (elapsed >= 10_000) ops.push(this.note("info", `  worked ${formatElapsed(elapsed)} ${g.sep} ${formatTokens(this.turnTokens)} tokens`));
    }
    return ops;
  }

  /** `Changed src/a.ts (+8 −3) · Tests: 12 passed · /diff /evidence`; undefined when nothing changed or ran. */
  private resultLine(outcome: string): ViewOp | undefined {
    const g = this.options.glyphs;
    const files = [...this.ledger.files.entries()];
    const tests = this.ledger.tests;
    if (files.length === 0 && tests === undefined) return undefined;
    const parts: string[] = [];
    let tone: "ok" | "warning" | "error" = "ok";
    if (files.length > 0) {
      const added = files.reduce((sum, [, file]) => sum + file.added, 0);
      const removed = files.reduce((sum, [, file]) => sum + file.removed, 0);
      const names = files.length === 1 ? (files[0]?.[0] ?? "") : `${files.length} files`;
      parts.push(`Changed ${names} (+${added} ${g.minus}${removed})`);
    }
    if (tests === undefined) {
      parts.push("Tests: not run");
      tone = "warning";
    } else if (tests.ok) {
      parts.push(`Tests: ${tests.passed === undefined ? "passed" : `${tests.passed} passed`}`);
    } else {
      parts.push(`Tests: ${tests.failed === undefined ? `failed (exit ${tests.exit ?? "?"})` : `${tests.failed} failed`}`);
      tone = "error";
    }
    if ((outcome === "cancelled" || outcome === "failed") && tone === "ok") tone = "warning";
    parts.push(files.length > 0 ? "/diff /evidence" : "/evidence");
    const item: ConversationItem = { kind: "result", id: this.nextId(), text: parts.join(` ${g.sep} `), tone };
    this.lastItem = item.id;
    return { op: "append", item };
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
      // A user message inside a step (request id) is the harness's own: a tool image for the model (K4.2).
      if (event.data.request_id !== undefined) return [];
      if (this.options.echoesUser && !this.replaying) return [];
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      // A K3 completion turn carries only a harness note (no user text): nothing to show as the user's line.
      const shown = stripHarnessNotes(text);
      return shown.trim() === "" ? [] : [this.user(shown)];
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
    if (part.name === "todo" && this.todoItem !== undefined) {
      const existing = this.tools.get(this.todoItem);
      if (existing !== undefined) {
        existing.args = args;
        existing.status = "running";
        this.toolItem.set(part.tool_call_id, existing.id);
        return [{ op: "update", item: this.toolView(existing) }];
      }
    }
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
      stat: undefined,
      group: part.name === "read_file" ? [stringArg(args, "path") ?? "?"] : undefined,
      pending: pendingPreview(part.name, args),
    };
    this.tools.set(state.id, state);
    this.toolItem.set(part.tool_call_id, state.id);
    this.lastItem = state.id;
    if (part.name === "todo") this.todoItem = state.id;
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
    state.summary = denialSummary(event.data.decision.reasons, event.data.action.role === "session" ? event.data.action.command?.argv : undefined, this.options.glyphs);
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
            : state.name === "web_search"
              ? { verb: "Searching", detail: sanitizeInline(stringArg(state.args, "query") ?? "", 60) }
              : state.name === "web_fetch"
                ? { verb: "Fetching", detail: sanitizeInline(shortUrl(stringArg(state.args, "url") ?? ""), 60) }
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
      state.summary = sanitizeInline(result.error?.message ?? "refused", 600);
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
    state.stat = outcome.stat;
    state.preview = outcome.preview;
    state.detail = outcome.detail;
    if (state.name === "exec" && state.args.background === true && !failed) {
      const handle = /^(p\d+) · /.exec(result.text)?.[1];
      if (handle !== undefined && / · running · /.test(result.text.split("\n", 1)[0] ?? "")) state.background = { handle, startedAt: Date.parse(event.timestamp) - event.data.duration_ms };
    }
    this.record(state, result, failed);
    return [{ op: "update", item: this.toolView(state) }];
  }

  /**
   * Claude Code native mode: a built-in tool Claude ran itself, as a tool row (`✓ Bash pnpm test
   * 12 passed`, `✓ Edit src/x.ts +3 −1`). Display only; the row feeds the turn's result line.
   */
  private backendTool(event: SessionEventOf<"backend/tool_observed">): ViewOp[] {
    const data = event.data;
    const g = this.options.glyphs;
    const key = `backend:${data.tool_use_id}`;
    let state = this.stateFor(key);
    const fresh = state === undefined;
    if (state === undefined) {
      state = {
        id: this.nextId(),
        name: `claude:${data.tool_name}`,
        args: {},
        status: "running",
        title: claudeToolTitle(data.tool_name, data.input_summary),
        summary: undefined,
        preview: [],
        detail: [],
        stat: undefined,
        group: undefined,
        pending: [],
      };
      this.tools.set(state.id, state);
      this.toolItem.set(key, state.id);
      this.lastItem = state.id;
    }
    if (data.phase === "started") {
      if (!this.replaying) {
        this.activityVerb =
          data.tool_name === "Bash" || data.tool_name === "PowerShell"
            ? { verb: "Running", detail: sanitizeInline(data.input_summary, 60) }
            : CLAUDE_WRITE_TOOLS.has(data.tool_name)
              ? { verb: "Editing", detail: undefined }
              : { verb: "Working", detail: undefined };
      }
      return fresh ? [{ op: "append", item: this.toolView(state) }] : [];
    }
    if (!this.replaying) this.activityVerb = undefined;
    const failed = data.is_error === true;
    state.status = failed ? "failed" : "ok";
    const lines = data.lines_added === undefined ? undefined : `+${data.lines_added} ${g.minus}${data.lines_removed ?? 0}`;
    const summary = sanitizeInline(lines ?? data.result_summary ?? "", 600);
    state.summary = summary === "" ? undefined : summary;
    if (!failed && CLAUDE_WRITE_TOOLS.has(data.tool_name) && data.input_summary !== "") {
      const entry = this.ledger.files.get(data.input_summary) ?? { added: 0, removed: 0, created: data.tool_name === "Write" };
      entry.added += data.lines_added ?? 0;
      entry.removed += data.lines_removed ?? 0;
      this.ledger.files.set(data.input_summary, entry);
    } else if (data.tool_name === "Bash" && isTestCommand(data.input_summary.split(/\s+/))) {
      const body = data.result_summary ?? "";
      const failures = testCount(body, "fail");
      this.ledger.tests = { passed: testCount(body, "pass"), failed: failures === 0 ? undefined : failures, ok: !failed, exit: undefined };
    }
    return [{ op: fresh ? "append" : "update", item: this.toolView(state) }];
  }

  /** Feeds the turn's result line: edited files with their line counts, and test commands. */
  private record(state: ToolState, result: SessionEventOf<"tool/result_recorded">["data"]["result"], failed: boolean): void {
    if (state.name === "apply_patch" && !failed) {
      const patch = stringArg(state.args, "patch") ?? "";
      const diff = patchDiff(patch);
      const created = /^\*\*\* Add File: /m.test(patch);
      patchPaths(patch).forEach((file, index) => {
        const entry = this.ledger.files.get(file) ?? { added: 0, removed: 0, created };
        // Line counts belong to the whole patch; the first file carries them so the totals stay exact.
        if (index === 0) {
          entry.added += diff.filter((line) => line.op === "+").length;
          entry.removed += diff.filter((line) => line.op === "-").length;
        }
        this.ledger.files.set(file, entry);
      });
    } else if (state.name === "write_file" && !failed) {
      const file = stringArg(state.args, "path") ?? "?";
      const content = stringArg(state.args, "content") ?? "";
      const entry = this.ledger.files.get(file) ?? { added: 0, removed: 0, created: result.text.startsWith("created") };
      entry.added += content === "" ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length;
      this.ledger.files.set(file, entry);
    } else if (state.name === "exec" && state.args.background !== true && isTestCommand(argvOf(state.args))) {
      const body = outputLines(result.text).join("\n");
      const failures = testCount(body, "fail");
      this.ledger.tests = { passed: testCount(body, "pass"), failed: failures === 0 ? undefined : failures, ok: !failed && result.exit_code === 0, exit: result.exit_code };
    }
  }

  /** A search the provider ran natively inside the model turn (OpenAI hosted web_search). */
  private nativeSearch(event: SessionEventOf<"web/searched">): ViewOp[] {
    const label = event.data.provider === "openai-hosted" ? "OpenAI" : event.data.provider === "claude-code" ? "Claude" : event.data.provider;
    const summary = plural(event.data.sources, "source");
    const state: ToolState = {
      id: this.nextId(),
      name: "web_search",
      args: { query: event.data.query },
      status: "ok",
      title: `Search (${label}) "${sanitizeInline(event.data.query, 80)}"`,
      summary,
      preview: [],
      detail: [],
      stat: summary,
      group: undefined,
      pending: [],
    };
    this.tools.set(state.id, state);
    this.lastItem = state.id;
    return [{ op: "append", item: this.toolView(state) }];
  }

  private toolView(state: ToolState): ConversationItem {
    return {
      kind: "tool",
      id: state.id,
      status: state.status,
      title: state.title,
      summary: state.summary,
      preview: [...state.preview],
      detail: [...state.detail],
      stat: state.stat,
      ...(state.background === undefined ? {} : { background: state.background }),
    };
  }
}

function usageTokens(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/** Short footer name of a provider's subscription: `anthropic` -> `claude`, `openai` -> `chatgpt`. */
export function quotaProviderLabel(provider: string): string {
  if (provider === "anthropic") return "claude";
  if (provider === "openai") return "chatgpt";
  return sanitizeInline(provider, 16);
}

/**
 * A `syn run` (or orchestrated) session: its goal and the orchestrator's own prompts. Inside a run
 * (from `run/created` until the run reaches a terminal state) user-role messages are the planner's
 * prompts, never something the person typed; the resume card shows `run: <goal>` instead.
 */
export function runPrompts(events: readonly SessionEvent[]): { readonly goal: string | undefined; readonly hidden: ReadonlySet<SessionEvent> } {
  const hidden = new Set<SessionEvent>();
  let goal: string | undefined;
  let active: string | undefined;
  for (const event of events) {
    if (event.type === "run/created") {
      goal ??= event.data.goal;
      active = event.run_id ?? "";
    } else if (event.type === "run/state_changed" && active !== undefined && (event.run_id ?? "") === active && RUN_ENDS.has(event.data.to)) {
      active = undefined;
    } else if (active !== undefined && event.type === "message/recorded" && event.data.role === "user") {
      hidden.add(event);
    }
  }
  return { goal, hidden };
}

const RUN_ENDS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

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

const TEST_WORDS = /^(test|tests|vitest|jest|pytest|mocha|ava|tap|ctest|rspec|phpunit|--test)$/;

/** `npm test`, `pnpm run test`, `node --test`, `pytest -q`, `go test ./...`, `cargo test`. */
export function isTestCommand(argv: readonly string[]): boolean {
  return argv.some((word, index) => {
    const base = word.toLowerCase().replace(/\.(cmd|exe)$/, "").split(/[\\/]/).pop() ?? "";
    return TEST_WORDS.test(base) || (index > 0 && /^test:[\w:-]+$/.test(base));
  });
}

/** `12 passed`, `pass 12`, `ℹ pass 12`, `3 failed`; undefined when the output does not say. */
function testCount(body: string, kind: "pass" | "fail"): number | undefined {
  const word = kind === "pass" ? "pass(?:ed|ing)?" : "fail(?:ed|ing|ures?)?";
  const after = new RegExp(`(?:^|\\s)(?:ℹ\\s+)?${word}\\s+(\\d+)`, "im").exec(body)?.[1];
  const before = new RegExp(`(\\d+)\\s+${word}\\b`, "i").exec(body)?.[1];
  const found = after ?? before;
  return found === undefined ? undefined : Number(found);
}

/** The edit a pending apply_patch / write_file would make, for the approval prompt (≤ 12 lines). */
function pendingPreview(name: string, args: Readonly<Record<string, unknown>>): DiffLine[] {
  if (name === "apply_patch") return patchDiff(stringArg(args, "patch") ?? "").slice(0, 12);
  if (name === "write_file") return (stringArg(args, "content") ?? "").split(/\r?\n/).slice(0, 12).map((text) => ({ op: "+", text: diffText(text) }));
  return [];
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

const CLAUDE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** A Claude built-in's row title: `Bash pnpm test`, `Edit src/x.ts`, `Search (Claude) "q"`, `Fetch (Claude) host/path`. */
function claudeToolTitle(name: string, summary: string): string {
  const detail = sanitizeInline(summary, 2000);
  const label = name === "WebSearch" ? "Search (Claude)" : name === "WebFetch" ? "Fetch (Claude)" : sanitizeInline(name, 40);
  return detail === "" ? label : `${label} ${detail}`;
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
    case "exec": {
      const command = sanitizeInline(argvOf(args).join(" "), 2000);
      if (args.background !== true) return `Run ${command}`;
      const name = stringArg(args, "name");
      return name === undefined ? `Start ${command}` : `${sanitizeInline(name, 40)} (${command})`;
    }
    case "glob": {
      const where = stringArg(args, "path");
      return `Find ${sanitizeInline(stringArg(args, "pattern") ?? "", 60)}${where === undefined || where === "." ? "" : ` in ${where}`}`;
    }
    case "todo":
      return "Tasks";
    case "process_output":
      return `Output of ${stringArg(args, "handle") ?? "?"}`;
    case "process_wait":
      return `Wait for ${stringArg(args, "handle") ?? "?"}`;
    case "process_kill":
      return `Stop ${stringArg(args, "handle") ?? "?"}`;
    case "process_list":
      return "Background processes";
    case "git_status":
      return "Git status";
    case "git_diff":
      return "Git diff";
    case "web_search":
      return `Search "${sanitizeInline(stringArg(args, "query") ?? "", 80)}"`;
    case "web_fetch":
      return `Fetch ${sanitizeInline(shortUrl(stringArg(args, "url") ?? "?"), 100)}`;
    case "orchestrate":
      return `Workers ${sanitizeInline(stringArg(args, "goal") ?? "", 2000)}`.trimEnd();
    default: {
      const first = Object.values(args).find((value): value is string => typeof value === "string");
      return `${name}${first === undefined ? "" : ` ${sanitizeInline(first, 2000)}`}`;
    }
  }
}

/** `https://www.example.com/a/b?q` → `example.com/a/b?q` for a compact row. */
export function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    return `${url.host.replace(/^www\./, "")}${rest}`;
  } catch {
    return raw;
  }
}

/** The `/allow` prefix to suggest for a refused argv: the program and, when it is not a flag, its first argument. */
export function allowPrefixFor(argv: readonly string[]): string {
  const [program = "", first] = argv;
  return first !== undefined && !first.startsWith("-") ? `${program} ${first}` : program;
}

/** `argv` is given only for the conversation agent: `/allow` never applies to a worker, so its refusal is explained instead. */
function denialSummary(reasons: readonly { readonly code: string; readonly layer?: string; readonly message: string }[], argv: readonly string[] | undefined, g: GlyphSet): string {
  const codes = new Set(reasons.map((reason) => reason.code));
  if (argv !== undefined && argv.length > 0 && reasons.some((reason) => reason.code === "exec-not-allowlisted" && reason.layer !== "role") && !reasons.some((reason) => /changes the repository|refused:/.test(reason.message))) {
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
  readonly stat?: string;
  readonly preview: DiffLine[];
  readonly detail: DiffLine[];
}

function textLines(lines: readonly string[]): DiffLine[] {
  return lines.map((text) => ({ op: " ", text: sanitizeInline(text, 2000) }));
}

function summarizeResult(
  name: string,
  args: Readonly<Record<string, unknown>>,
  result: SessionEventOf<"tool/result_recorded">["data"]["result"],
  durationMs: number,
  g: GlyphSet,
): ResultSummary {
  const failedText = friendlyError(result.error?.message ?? "failed");
  const text = result.text;
  switch (name) {
    case "read_file": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const header = text.split("\n", 1)[0] ?? "";
      const total = /of (\d+)\+?$/.exec(header.replace(/\s*\(.*\)$/, ""))?.[1];
      const lines = text.split("\n").slice(1);
      return { summary: header.includes("empty file") ? "empty file" : total === undefined ? "read" : plural(Number(total), "line"), preview: [], detail: textLines(lines.slice(0, DETAIL_LINES)) };
    }
    case "list_dir": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const entries = text === "(empty)" ? [] : text.split("\n").filter((line) => line.trim() !== "");
      return { summary: plural(entries.length, "entry", "entries"), preview: [], detail: textLines(entries.slice(0, DETAIL_LINES)) };
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
      return { summary: `${created ? "new file" : "rewritten"} ${g.sep} ${plural(lines, "line")}`, preview: [], detail: textLines(content.split(/\r?\n/).slice(0, DETAIL_LINES)) };
    }
    case "exec": {
      if (args.background === true) return backgroundSummary(result, g);
      const body = outputLines(text);
      const seconds = `${(durationMs / 1000).toFixed(1)}s`;
      if (result.exit_code === undefined) return { summary: `${g.fail} ${failedText}`, stat: failedText, preview: textLines(body.slice(-5)), detail: textLines(body.slice(-DETAIL_LINES)) };
      if (result.exit_code === 0) {
        const tests = /(?:^|\s)(?:ℹ\s+)?pass(?:ed)?\s+(\d+)/im.exec(body.join("\n"))?.[1] ?? /(\d+) passed/i.exec(body.join("\n"))?.[1];
        return {
          summary: `${g.ok} exit 0${tests === undefined ? "" : ` ${g.sep} ${tests} passed`} ${g.sep} ${seconds}`,
          stat: `${tests === undefined ? "" : `${tests} passed ${g.sep} `}${seconds}`,
          preview: [],
          detail: textLines(body.slice(-DETAIL_LINES)),
        };
      }
      const failures = testCount(body.join("\n"), "fail");
      return {
        summary: `${g.fail} exit ${result.exit_code} ${g.sep} ${seconds}`,
        stat: `exit ${result.exit_code}${failures === undefined || failures === 0 ? "" : ` ${g.sep} ${failures} failed`} ${g.sep} ${seconds}`,
        preview: textLines(body.slice(-5)),
        detail: textLines(body.slice(-DETAIL_LINES)),
      };
    }
    case "glob": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const [header = "", ...files] = text.split("\n");
      const count = /^(\d+) files? match/.exec(header)?.[1];
      return { summary: count === undefined ? "no files" : plural(Number(count), "file"), preview: [], detail: textLines(files.slice(0, DETAIL_LINES)) };
    }
    case "todo": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const items = todoItems(args);
      if (items.length === 0) return { summary: "checklist cleared", preview: [], detail: [] };
      const done = items.filter((item) => item.status === "done").length;
      const mark = (status: string): string => (status === "done" ? g.ok : status === "in_progress" ? (g.name === "rich" ? "◐" : ">") : g.name === "rich" ? "○" : "o");
      const lines = items.map((item) => ({ op: " " as const, text: `${mark(item.status)} ${sanitizeInline(item.text, 200)}` }));
      const inline = items.map((item) => `${item.status === "done" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${sanitizeInline(item.text, 80)}`).join("; ");
      return { summary: `${done}/${items.length} done ${g.sep} ${inline}`, stat: `${done}/${items.length} done`, preview: lines.slice(0, 12), detail: lines };
    }
    case "process_output":
    case "process_wait":
    case "process_kill":
    case "process_list": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const [first = "", ...rest] = text.split("\n");
      const body = rest.filter((line) => !/^(output \d+-\d+|no new output|still running|wait cancelled)/.test(line));
      if (name === "process_list") return { summary: first === "no background processes" ? "none" : plural(text.split("\n").length, "process", "processes"), preview: [], detail: textLines(text.split("\n").slice(0, DETAIL_LINES)) };
      const status = first.split(" · ").slice(2, 4).join(` ${g.sep} `);
      const lines = rest.find((line) => line.startsWith("no new output")) !== undefined ? "no new output" : plural(body.length, "line");
      return { summary: name === "process_kill" ? "stopped" : `${status}${name === "process_output" ? ` ${g.sep} ${lines}` : ""}`, preview: [], detail: textLines(body.slice(-DETAIL_LINES)) };
    }
    case "git_status": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const changed = text.split("\n").filter((line) => /^[ MADRCU?!]{2} /.test(line));
      return { summary: changed.length === 0 ? "clean" : `${changed.length} changed`, preview: [], detail: textLines(changed.slice(0, DETAIL_LINES)) };
    }
    case "web_search": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const header = text.split("\n", 1)[0] ?? "";
      const count = /: (\d+) results?$/.exec(header)?.[1];
      const backend = / via ([\w-]+):/.exec(header)?.[1];
      const titles = text.split("\n").filter((line) => /^\d+\. /.test(line));
      const summary = `${count === undefined ? "done" : plural(Number(count), "result")}${backend === undefined ? "" : ` ${g.sep} ${backend}`}`;
      return { summary, stat: summary, preview: [], detail: textLines(titles.slice(0, DETAIL_LINES)) };
    }
    case "web_fetch": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const header = text.split("\n", 1)[0] ?? "";
      const size = /, (\d+(?:\.\d+)? (?:B|KB|MB))[,)]/.exec(header)?.[1];
      const redirect = /redirects \(\d+\) to another host: (\S+)/.exec(header)?.[1];
      const summary = redirect !== undefined ? `redirects to ${shortUrl(redirect)}` : (size ?? "read");
      const title = /title: (.*?) chars \d+/.exec(header)?.[1];
      return { summary, stat: summary, preview: [], detail: title === undefined ? [] : textLines([title]) };
    }
    case "orchestrate": {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      // K3: the background start is one concise line; the agent-facing instructions stay in the detail.
      const started = /^Started worker run (\S+) in the background/.exec(text);
      const lines = text.split("\n");
      if (started !== null) return { summary: `Workers running in background (${started[1]}) ${g.sep} keep chatting ${g.sep} /runs`, preview: [], detail: textLines(lines.slice(0, 20)) };
      return { summary: sanitizeInline(lines[0] ?? "done", 600) || "done", preview: [], detail: textLines(lines.slice(0, 40)) };
    }
    default: {
      if (result.status === "error") return { summary: failedText, preview: [], detail: [] };
      const lines = text.split("\n");
      return { summary: sanitizeInline(lines[0] ?? "done", 600) || "done", preview: [], detail: textLines(lines.slice(0, 20)) };
    }
  }
}

function todoItems(args: Readonly<Record<string, unknown>>): { readonly text: string; readonly status: string }[] {
  const items = args.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    return typeof record.text === "string" ? [{ text: record.text, status: typeof record.status === "string" ? record.status : "pending" }] : [];
  });
}

/** `exec {background: true}`: `running · p1` while it runs, or how it ended within the start window. */
function backgroundSummary(result: SessionEventOf<"tool/result_recorded">["data"]["result"], g: GlyphSet): ResultSummary {
  const [first = "", ...rest] = result.text.split("\n");
  const body = rest.slice(2);
  if (result.status === "error") return { summary: friendlyError(result.error?.message ?? "failed to start"), preview: textLines(body.slice(-5)), detail: textLines(body.slice(-DETAIL_LINES)) };
  const parts = first.split(" · ");
  const handle = parts[0] ?? "";
  const state = parts[2] ?? "";
  if (state === "running") return { summary: `running in the background ${g.sep} ${handle}`, stat: `running ${g.sep} ${handle}`, preview: [], detail: textLines(body.slice(-DETAIL_LINES)) };
  return { summary: `${state} ${g.sep} ${parts[3] ?? ""}`, stat: `${state} ${g.sep} ${parts[3] ?? ""}`, preview: textLines(body.slice(-5)), detail: textLines(body.slice(-DETAIL_LINES)) };
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

const ERROR_WORDS: Readonly<Record<string, string>> = {
  ENOENT: "file not found",
  EACCES: "permission denied",
  EPERM: "not permitted",
  EISDIR: "is a folder, not a file",
  ENOTDIR: "not a folder",
  EEXIST: "already exists",
  ETIMEDOUT: "timed out",
  EBUSY: "file is busy (locked by another program)",
};

/**
 * Tool errors in plain words: `ENOENT … stat 'C:\\…\\missing.mjs'` becomes `file not found`;
 * absolute paths shrink to their file name (the tool line already names the file).
 */
export function friendlyError(message: string): string {
  const code = /\b(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EEXIST|ETIMEDOUT|EBUSY)\b/.exec(message)?.[1];
  if (code !== undefined) return ERROR_WORDS[code] ?? code;
  return sanitizeInline(message.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'",:\\/]+[\\/])+([^\s'",:\\/]+)/g, "$1"), 200);
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
  readonly sandboxNoticeSeen?: boolean;
  readonly warnings: readonly string[];
  readonly glyphs: GlyphSet;
}): { readonly title: string; readonly warning: string | undefined } {
  const g = options.glyphs;
  const title = [`Synorch ${options.version}`, `${options.folder}${options.branch === undefined ? "" : ` (${options.branch})`}`, options.model, options.mode]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(` ${g.sep} `);
  const warnings: string[] = [];
  if (options.sandboxEnforcement !== "full" && options.sandboxNoticeSeen !== true) warnings.push(`Sandbox is partial: allowed commands can write outside this folder ${g.sep} /permissions`);
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
    footer.model === undefined ? undefined : footer.effort === undefined ? footer.model : `${footer.model} ${g.sep} ${footer.effort}`,
    extra.mode,
    footer.contextPercent === undefined ? undefined : `ctx ${footer.contextPercent}%`,
    footer.quotaPercent === undefined ? undefined : `quota ${footer.quotaPercent}%${footer.quotaProvider === undefined ? "" : ` ${footer.quotaProvider}`}`,
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
