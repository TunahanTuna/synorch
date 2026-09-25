import type { OrchestrationTaskView, OrchestrationView } from "../../contracts/views.ts";
import { clean, displayWidth, finish, formatElapsed, padEnd, padStart, spread, truncate, wrap, type ViewContext, type ViewTheme } from "./kit.ts";

/**
 * The live orchestration board (TUI experience §7.3, §8.6; X1): one row per task — status glyph,
 * role, model, current activity, elapsed — updated in place. Past six tasks it folds the finished
 * and waiting rows; once the run is done it collapses to a summary that is pinned to the
 * transcript once. The plain renderer prints board *changes* as `task i/n key:` lines (§12).
 */

export type Tone = "text" | "muted" | "running" | "success" | "warning" | "error";

export interface TaskPresentation {
  readonly glyph: string;
  readonly tone: Tone;
  readonly label: string;
  readonly active: boolean;
}

const LIVE_FOLD_THRESHOLD = 6;

export function paint(theme: ViewTheme, tone: Tone, text: string): string {
  return theme[tone](text);
}

export function isActive(task: OrchestrationTaskView): boolean {
  return task.state === "running" || task.state === "verifying" || task.state === "reviewing";
}

export function isFinished(task: OrchestrationTaskView): boolean {
  return task.state === "completed" || task.state === "failed" || task.state === "cancelled";
}

export function isWaiting(task: OrchestrationTaskView): boolean {
  return task.state === "draft" || task.state === "awaiting_approval" || task.state === "ready";
}

export function taskElapsedMs(task: OrchestrationTaskView, now: number): number | undefined {
  if (task.startedAtMs !== undefined) return Math.max(0, (task.endedAtMs ?? now) - task.startedAtMs);
  return task.elapsedMs;
}

export function runElapsedMs(view: OrchestrationView, now: number): number | undefined {
  if (view.startedAtMs !== undefined) return Math.max(0, (view.endedAtMs ?? now) - view.startedAtMs);
  return view.elapsedMs;
}

function verdictText(task: OrchestrationTaskView): string | undefined {
  const review = task.review;
  if (review === undefined) return undefined;
  const revisions = review.revisions ?? 0;
  const after = revisions > 0 ? ` after ${revisions} revision${revisions === 1 ? "" : "s"}` : "";
  switch (review.verdict) {
    case "accepted":
      return `accepted${after}`;
    case "changes_requested":
      return "changes requested";
    case "rejected":
      return `rejected${after}`;
  }
}

function outcomeFacts(task: OrchestrationTaskView, ctx: ViewContext): string[] {
  const facts: string[] = [];
  if (task.diffstat !== undefined) {
    const { files, added, removed } = task.diffstat;
    facts.push(`${files} file${files === 1 ? "" : "s"} +${added} ${ctx.glyphs.base.minus}${removed}`);
  }
  if (task.checks !== undefined) facts.push(`checks ${task.checks.passed}/${task.checks.total}`);
  return facts;
}

/** Glyph, tone and label of a task (TUI experience §7.3). */
export function presentTask(task: OrchestrationTaskView, all: readonly OrchestrationTaskView[], ctx: ViewContext): TaskPresentation {
  const g = ctx.glyphs;
  const sep = ` ${g.base.sep} `;
  const spinner = g.base.spinner[(ctx.frame ?? 0) % g.base.spinner.length] ?? "*";
  const reason = clean(task.reason, 120);
  const withReason = (label: string) => (reason === "" ? label : `${label}${sep}${reason}`);
  if (task.paused === true && !isFinished(task)) return { glyph: g.interrupted, tone: "warning", label: "paused", active: false };
  switch (task.state) {
    case "draft":
    case "awaiting_approval":
    case "ready": {
      const open = (task.dependsOn ?? []).filter((key) => {
        const dep = all.find((candidate) => candidate.key === key);
        return dep !== undefined && dep.state !== "completed";
      });
      const label = open.length === 0 ? "waiting" : open.length === 1 ? `waiting for ${clean(open[0], 40)}` : `waiting for ${open.length} tasks`;
      return { glyph: g.pending, tone: "muted", label: task.state === "awaiting_approval" ? "waiting for approval" : label, active: false };
    }
    case "running":
      return { glyph: spinner, tone: "running", label: clean(task.activity, 160) || "working", active: true };
    case "verifying":
      return { glyph: spinner, tone: "running", label: task.activity === undefined ? "checking" : `checking${sep}${clean(task.activity, 120)}`, active: true };
    case "reviewing":
      return { glyph: spinner, tone: "running", label: "in review", active: true };
    case "changes_requested":
      return { glyph: g.retry, tone: "warning", label: withReason("revising"), active: false };
    case "retry_pending":
      return { glyph: g.retry, tone: "warning", label: withReason("retrying"), active: false };
    case "needs_context":
      return { glyph: g.ask, tone: "warning", label: "needs more context", active: false };
    case "blocked":
      return { glyph: g.base.warn, tone: "warning", label: withReason("blocked"), active: false };
    case "interrupted":
      return { glyph: g.interrupted, tone: "warning", label: "interrupted", active: false };
    case "failed":
      return { glyph: g.base.fail, tone: "error", label: withReason("failed"), active: false };
    case "cancelled":
      return { glyph: g.cancelled, tone: "muted", label: "cancelled", active: false };
    case "completed": {
      const verdict = verdictText(task);
      const facts = outcomeFacts(task, ctx);
      const head = clean(task.summary, 120) || (verdict !== undefined && task.role === "reviewer" ? capitalize(verdict) : facts.length > 0 ? "" : "done");
      const parts = [head, ...facts].filter((part) => part !== "");
      if (verdict !== undefined && task.role !== "reviewer") parts.push(`review ${verdict}`);
      return { glyph: g.base.ok, tone: "success", label: parts.join(sep), active: false };
    }
  }
}

/** Wraps at ` · ` separators first, words only inside a fact that is itself too long. */
function wrapFacts(text: string, sep: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const fact of text.split(sep)) {
    const candidate = current === "" ? fact : `${current}${sep}${fact}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    const pieces = wrap(fact, width);
    current = pieces.pop() ?? "";
    lines.push(...pieces);
  }
  if (current !== "") lines.push(current);
  return lines;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

interface Columns {
  readonly key: number;
  readonly role: number;
  readonly model: number;
  readonly elapsed: number;
  readonly activity: number;
  /** Activity moves to its own line when the row is too narrow. */
  readonly stacked: boolean;
}

function columns(tasks: readonly OrchestrationTaskView[], width: number, withModel: boolean, withElapsed: boolean): Columns {
  const key = Math.min(18, Math.max(4, ...tasks.map((task) => displayWidth(clean(task.key, 40)))));
  const role = Math.min(12, Math.max(4, ...tasks.map((task) => displayWidth(clean(task.role, 20)))));
  const modelWanted = withModel ? Math.min(10, Math.max(0, ...tasks.map((task) => displayWidth(clean(task.model, 20))))) : 0;
  const elapsed = withElapsed ? 7 : 0;
  const fixed = (model: number) => 2 + 2 + key + 1 + role + 1 + (model > 0 ? model + 1 : 0) + (elapsed > 0 ? elapsed + 1 : 0);
  let model = modelWanted;
  if (width - fixed(model) < 16) model = 0;
  const activity = width - fixed(model);
  return { key, role, model, elapsed, activity: Math.max(0, activity), stacked: activity < 12 };
}

function taskRow(task: OrchestrationTaskView, all: readonly OrchestrationTaskView[], cols: Columns, ctx: ViewContext, now: number, selected = false): string[] {
  const rows = taskRowLines(task, all, cols, ctx, now, selected);
  if (!selected || rows.length === 0) return rows;
  // The selected row: `›` in the margin (survives NO_COLOR), the key in the accent colour.
  return [`${ctx.theme.accent(ctx.glyphs.select)}${(rows[0] ?? "").slice(1)}`, ...rows.slice(1)];
}

function taskRowLines(task: OrchestrationTaskView, all: readonly OrchestrationTaskView[], cols: Columns, ctx: ViewContext, now: number, selected: boolean): string[] {
  const t = ctx.theme;
  const shown = presentTask(task, all, ctx);
  const elapsedMs = cols.elapsed > 0 ? taskElapsedMs(task, now) : undefined;
  const elapsed = elapsedMs === undefined || isWaiting(task) ? "" : formatElapsed(elapsedMs);
  const glyph = paint(t, shown.tone, shown.glyph);
  const keyText = padEnd(clean(task.key, 40), cols.key);
  const key = selected ? t.accent(t.bold(keyText)) : shown.active ? t.bold(keyText) : keyText;
  const role = t.muted(padEnd(clean(task.role, 20), cols.role));
  const model = cols.model > 0 ? ` ${t.muted(padEnd(clean(task.model, 20), cols.model))}` : "";
  const labelTone: Tone = shown.tone === "success" || shown.tone === "running" ? "text" : shown.tone;
  const elapsedCell = cols.elapsed > 0 ? ` ${t.muted(padStart(elapsed, cols.elapsed))}` : "";
  if (cols.stacked) {
    const head = `  ${glyph} ${key} ${role}${model}`;
    const rest = ctx.width - 6 - (elapsed === "" ? 0 : cols.elapsed + 1);
    const detail = `      ${paint(t, labelTone, padEnd(shown.label, Math.max(4, rest)))}${elapsed === "" ? "" : ` ${t.muted(padStart(elapsed, cols.elapsed))}`}`;
    return [head, detail];
  }
  if (cols.elapsed === 0 && displayWidth(shown.label) > cols.activity) {
    // The pinned summary wraps instead of cutting the outcome short.
    const indent = " ".repeat(ctx.width - cols.activity);
    const parts = wrapFacts(shown.label, ` ${ctx.glyphs.base.sep} `, cols.activity);
    return parts.map((part, index) => (index === 0 ? `  ${glyph} ${key} ${role}${model} ${paint(t, labelTone, part)}` : `${indent}${paint(t, labelTone, part)}`));
  }
  const label = paint(t, labelTone, cols.elapsed > 0 ? padEnd(shown.label, cols.activity) : truncate(shown.label, cols.activity));
  return [`  ${glyph} ${key} ${role}${model} ${label}${elapsedCell}`.trimEnd()];
}

export interface BoardOptions {
  /** Key of the selected task (K1.7): marked with `›`; a folded row is shown while selected. */
  readonly selected?: string | undefined;
  /** Replaces the header hint on the right. */
  readonly hint?: string | undefined;
}

/** Header hint of the live board while nothing is selected. */
export function boardHint(ctx: ViewContext, mode: "board" | "graph" = "board"): string {
  const sep = ` ${ctx.glyphs.base.sep} `;
  // K3: the editor stays free while workers run in the background, so the toggle is Ctrl+G (a bare
  // `g` would start a message) and stopping is /runs cancel rather than Esc.
  return [mode === "board" ? "ctrl+g graph" : "ctrl+g board", `${ctx.glyphs.downArrow} select`, "/runs"].join(sep);
}

/** Header hint while a task is selected or a worker is open. */
export function selectionHint(ctx: ViewContext, mode: "board" | "graph" = "board"): string {
  const sep = ` ${ctx.glyphs.base.sep} `;
  // The graph header is already long: arrows and Tab are implied there.
  if (mode === "graph") return ["enter open", "g board", "esc back"].join(sep);
  const arrows = ctx.glyphs.name === "ascii" ? "up/down" : "↑↓";
  return [`${arrows} select`, "enter open", "tab next", "g graph", "esc back"].join(sep);
}

/** The live board: header, rows (folded past six tasks). */
export function renderLiveBoard(view: OrchestrationView, ctx: ViewContext, options: BoardOptions = {}): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const now = ctx.now ?? Date.now();
  const width = ctx.width;
  const tasks = view.tasks;
  const running = tasks.filter(isActive).length;
  const title = clean(view.title, 40) || "Workers";
  const folded = tasks.length > LIVE_FOLD_THRESHOLD;
  const headLeft = `${g.base.bullet} ${title} ${g.base.sep} ${tasks.length} task${tasks.length === 1 ? "" : "s"}${folded || running > 0 ? ` ${g.base.sep} ${running} running` : ""}`;
  const head = spread(headLeft, options.hint ?? boardHint(ctx), width);
  const lines = [`${t.accent(head.left)}${head.gap}${t.muted(head.right)}`];
  const cols = columns(tasks, width, true, true);
  const selected = options.selected;
  if (!folded) {
    for (const task of tasks) lines.push(...taskRow(task, tasks, cols, ctx, now, task.key === selected));
    return finish(lines, ctx);
  }
  const done = tasks.filter((task) => task.state === "completed");
  const waiting = tasks.filter(isWaiting);
  if (done.length > 0) lines.push(`  ${t.success(g.base.ok)} ${done.length} done`);
  for (const task of tasks) {
    if ((task.state === "completed" || isWaiting(task)) && task.key !== selected) continue;
    lines.push(...taskRow(task, tasks, cols, ctx, now, task.key === selected));
  }
  if (waiting.length > 0) lines.push(t.muted(`  ${g.pending} ${waiting.length} waiting`));
  return finish(lines, ctx);
}

/** The pinned summary once the run is done (§8.6 c): no model or elapsed column. */
export function renderBoardSummary(view: OrchestrationView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const width = ctx.width;
  const now = ctx.now ?? Date.now();
  const tasks = view.tasks;
  const elapsed = runElapsedMs(view, now);
  const title = clean(view.title, 40) || "Workers";
  const outcome = view.outcome === "failed" ? "failed" : view.outcome === "cancelled" ? "cancelled" : "done";
  const parts = [`${g.base.bullet} ${title}`, `${tasks.length} task${tasks.length === 1 ? "" : "s"}`, elapsed === undefined ? outcome : `${outcome} in ${formatElapsed(elapsed)}`];
  const note = clean(view.note, 80);
  if (note !== "") parts.push(note);
  const tone: Tone | undefined = view.outcome === "failed" ? "error" : view.outcome === "cancelled" ? "warning" : undefined;
  const header = truncate(parts.join(` ${g.base.sep} `), width);
  const lines = [tone === undefined ? t.accent(header) : paint(t, tone, header)];
  const cols = columns(tasks, width, false, false);
  for (const task of tasks) lines.push(...taskRow(task, tasks, cols, ctx, now));
  return finish(lines, ctx);
}

export function renderBoard(view: OrchestrationView, ctx: ViewContext): string[] {
  return view.done ? renderBoardSummary(view, ctx) : renderLiveBoard(view, ctx);
}

/**
 * Plain mode (§12): no live board. The first update prints the `workers:` line, then one
 * `task i/n key:` line whenever a task's label changes, and a `workers:` result line when done.
 */
export class PlainBoardTracker {
  private readonly labels = new Map<string, string>();
  private announced = false;
  private finished = false;

  public update(view: OrchestrationView, ctx: ViewContext): string[] {
    if (this.finished) {
      if (view.done) return [];
      // A new run after the previous one finished.
      this.finished = false;
      this.announced = false;
      this.labels.clear();
    }
    const plainCtx: ViewContext = { ...ctx, frame: 0 };
    const now = ctx.now ?? Date.now();
    const sep = ctx.glyphs.name === "ascii" ? "-" : ctx.glyphs.base.sep;
    const lines: string[] = [];
    const total = view.tasks.length;
    if (!this.announced) {
      this.announced = true;
      const list = view.tasks.map((task) => `${clean(task.key, 40)} (${clean(task.role, 20)}${task.model === undefined ? "" : `, ${clean(task.model, 20)}`})`).join(", ");
      lines.push(`workers: ${total} task${total === 1 ? "" : "s"} ${sep} ${list}`);
    }
    view.tasks.forEach((task, index) => {
      const shown = presentTask(task, view.tasks, plainCtx);
      const elapsedMs = taskElapsedMs(task, now);
      const label =
        task.state === "completed" && elapsedMs !== undefined ? `done in ${formatElapsed(elapsedMs)} ${sep} ${shown.label}` : shown.label;
      const identity = `${task.state}|${task.state === "running" ? clean(task.activity, 160) : label}`;
      if (this.labels.get(task.key) === identity) return;
      const firstSeenWaiting = !this.labels.has(task.key) && isWaiting(task);
      this.labels.set(task.key, identity);
      if (firstSeenWaiting) return;
      lines.push(`task ${index + 1}/${total} ${clean(task.key, 40)}: ${label}`);
    });
    if (view.done) {
      this.finished = true;
      const elapsed = runElapsedMs(view, now);
      const outcome = view.outcome === "failed" ? "failed" : view.outcome === "cancelled" ? "cancelled" : "done";
      lines.push(`workers: ${outcome}${elapsed === undefined ? "" : ` in ${formatElapsed(elapsed)}`}`);
    }
    return lines;
  }
}
