import type {
  OrchestrationTaskView,
  OrchestrationView,
  WorkerAssignmentView,
  WorkerDelegationView,
  WorkerSnapshotView,
  WorkerStreamEvent,
} from "../../contracts/views.ts";
import { ConversationPresenter, type ConversationItem } from "../conversation-view.ts";
import { renderToolRow } from "../tool-row.ts";
import { isActive, isWaiting, paint, presentTask, taskElapsedMs } from "./board.ts";
import { graphLevels } from "./graph.ts";
import { clean, displayWidth, finish, formatElapsed, padEnd, spread, truncate, wrap, type ViewContext } from "./kit.ts";

/**
 * Worker drill-in (K1.7): selection on the live board and the graph, the worker view's header and
 * pinned assignment block, delegation lines of the main chat, and the plain-mode worker snapshot.
 * Pure functions; the interactive renderer mounts them next to the worker's live transcript.
 */

export type SelectionMove = "up" | "down" | "left" | "right" | "next" | "previous";

/** The task selected first: the first running one, else the first that started, else the first. */
export function initialSelection(view: OrchestrationView): string | undefined {
  return (view.tasks.find(isActive) ?? view.tasks.find((task) => !isWaiting(task)) ?? view.tasks[0])?.key;
}

/**
 * Moves the selection. Board: ↑/↓ walk the rows. Graph: ←/→ move across levels (keeping the row
 * where possible), ↑/↓ within a level. `next`/`previous` (Tab) walk every task and wrap.
 */
export function moveSelection(view: OrchestrationView, mode: "board" | "graph", current: string | undefined, move: SelectionMove): string | undefined {
  const keys = view.tasks.map((task) => task.key);
  if (keys.length === 0) return undefined;
  if (current === undefined || !keys.includes(current)) return initialSelection(view);
  if (mode === "board" || move === "next" || move === "previous") {
    const order = mode === "graph" ? graphLevels(view).flat() : keys;
    const index = order.indexOf(current);
    switch (move) {
      case "up":
        return order[Math.max(0, index - 1)];
      case "down":
        return order[Math.min(order.length - 1, index + 1)];
      case "next":
        return order[(index + 1) % order.length];
      case "previous":
        return order[(index - 1 + order.length) % order.length];
      default:
        return current;
    }
  }
  const levels = graphLevels(view);
  const level = levels.findIndex((keysAt) => keysAt.includes(current));
  if (level === -1) return current;
  const row = (levels[level] ?? []).indexOf(current);
  if (move === "up" || move === "down") {
    const within = levels[level] ?? [];
    return within[Math.max(0, Math.min(within.length - 1, row + (move === "up" ? -1 : 1)))];
  }
  const target = levels[Math.max(0, Math.min(levels.length - 1, level + (move === "left" ? -1 : 1)))] ?? [];
  return target[Math.min(row, target.length - 1)] ?? current;
}

/** Tab / Shift+Tab in the worker view: the workers that started (every task when none has), wrapping. */
export function cycleWorker(view: OrchestrationView, current: string, direction: 1 | -1): string {
  const started = view.tasks.filter((task) => !isWaiting(task)).map((task) => task.key);
  const keys = started.length > 0 ? started : view.tasks.map((task) => task.key);
  if (keys.length === 0) return current;
  const index = keys.indexOf(current);
  if (index === -1) return keys[0] ?? current;
  return keys[(index + direction + keys.length) % keys.length] ?? current;
}

/** One status word for the header. */
export function workerStatus(task: OrchestrationTaskView): string {
  if (task.paused === true && task.state !== "completed" && task.state !== "failed" && task.state !== "cancelled") return "paused";
  switch (task.state) {
    case "draft":
    case "ready":
      return "waiting";
    case "awaiting_approval":
      return "waiting for approval";
    default:
      return task.state.replace(/_/g, " ");
  }
}

export interface WorkerHeaderOptions {
  /** Right-aligned key hint. */
  readonly hint?: string | undefined;
  /** Overrides the status word (e.g. `pausing…` before the board confirms). */
  readonly status?: string | undefined;
}

/** `● convert-mocks · implementer · opus-5.5 · running · 1m 12s        tab next · esc back` */
export function renderWorkerHeader(task: OrchestrationTaskView, ctx: ViewContext, options: WorkerHeaderOptions = {}): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const sep = ` ${g.base.sep} `;
  const shown = presentTask(task, [task], ctx);
  const elapsedMs = taskElapsedMs(task, ctx.now ?? Date.now());
  const status = options.status ?? workerStatus(task);
  const facts = [clean(task.role, 20), clean(task.model, 20)].filter((part) => part !== "");
  const plainLeft = [`${shown.glyph} ${clean(task.key, 40)}`, ...facts, status, ...(elapsedMs === undefined || isWaiting(task) ? [] : [formatElapsed(elapsedMs)])].join(sep);
  const head = spread(plainLeft, options.hint ?? "", ctx.width);
  const left =
    head.left === plainLeft
      ? [
          `${paint(t, shown.tone, shown.glyph)} ${t.bold(t.accent(clean(task.key, 40)))}`,
          ...facts.map((fact) => t.muted(fact)),
          paint(t, shown.tone === "running" ? "text" : shown.tone, status),
          ...(elapsedMs === undefined || isWaiting(task) ? [] : [t.muted(formatElapsed(elapsedMs))]),
        ].join(t.muted(sep))
      : head.left;
  const lines = [`${left}${head.gap}${t.muted(head.right)}`];
  if (isActive(task) && task.paused !== true) {
    const activity = clean(task.activity, 160);
    if (activity !== "") lines.push(t.muted(`  ${g.base.result} ${activity}`));
  }
  return finish(lines, ctx);
}

const COLLAPSED_ITEMS = 3;
const LABEL_WIDTH = 10;

export interface AssignmentOptions {
  /** Ctrl+O: every item instead of the first three of each list. */
  readonly expanded?: boolean | undefined;
  /** Left margin (the delegation line indents its details). */
  readonly indent?: number | undefined;
}

/** The pinned "Assignment" block: objective, owned files, acceptance, verification, steering. */
export function renderAssignment(assignment: WorkerAssignmentView | undefined, ctx: ViewContext, options: AssignmentOptions = {}): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const margin = " ".repeat(options.indent ?? 2);
  const box = g.box;
  const expanded = options.expanded === true;
  if (assignment === undefined) return finish([t.muted(`${margin}${box.tl} Assignment`), t.muted(`${margin}${box.v} waiting for the orchestrator's instructions`), t.muted(`${margin}${box.bl}`)], ctx);
  const valueWidth = Math.max(10, ctx.width - margin.length - 2 - LABEL_WIDTH - 1);
  const lines: string[] = [`${margin}${t.muted(box.tl)} ${t.bold("Assignment")}`];
  let hidden = 0;
  const row = (label: string, values: readonly string[], paintValue: (text: string) => string = (text) => text) => {
    if (values.length === 0) return;
    const shown = expanded ? values : values.slice(0, COLLAPSED_ITEMS);
    hidden += values.length - shown.length;
    shown.forEach((value, index) => {
      wrap(value, valueWidth).forEach((part, partIndex) => {
        const cell = index === 0 && partIndex === 0 ? padEnd(label, LABEL_WIDTH) : " ".repeat(LABEL_WIDTH);
        lines.push(`${margin}${t.muted(box.v)} ${t.muted(cell)} ${paintValue(part)}`);
      });
    });
  };
  row("objective", [clean(assignment.objective, 4000)]);
  const owned = assignment.owned_paths.map((path) => clean(path, 200)).filter((path) => path !== "");
  if (owned.length > 0) row("owns", expanded ? owned : [truncate(owned.join(", "), valueWidth * 2)]);
  row("accept", assignment.acceptance_criteria.map((item) => `${g.base.bullet === "*" ? "-" : "•"} ${clean(item, 300)}`));
  row("verify", assignment.verification_commands.map((command) => `$ ${clean(command, 300)}`), (text) => t.accent(text));
  const steering = assignment.steering.map((steer) => {
    const who = steer.from === "user" ? "you" : "orchestrator";
    const queued = steer.delivered === false ? " (queued)" : "";
    return `${who}: ${clean(steer.text, 400)}${queued}`;
  });
  // The latest steering matters most: collapsed shows the last three.
  if (!expanded) hidden += Math.max(0, steering.length - COLLAPSED_ITEMS);
  row("steering", expanded ? steering : steering.slice(-COLLAPSED_ITEMS));
  const foot = hidden > 0 ? ` ${hidden} more ${g.base.sep} ctrl+o expands` : "";
  lines.push(`${margin}${t.muted(`${box.bl}${foot}`)}`);
  return finish(lines, ctx);
}

/** Main chat: `→ convert-mocks (implementer, opus-5.5): objective`, expanded to the assignment. */
export function renderDelegation(view: WorkerDelegationView, ctx: ViewContext, expanded = false): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const who = [clean(view.role, 20), clean(view.model, 20)].filter((part) => part !== "").join(", ");
  // The task goal is what the user reads the delegation by: wrapped in full under the arrow.
  const head = `${t.accent(g.rightArrow)} ${t.bold(clean(view.taskKey, 40))}${t.muted(who === "" ? "" : ` (${who})`)}${t.muted(":")} `;
  const lines = hanging(head, clean(view.objective, 4000), ctx.width, 2);
  if (expanded && view.assignment !== undefined) lines.push(...renderAssignment(view.assignment, ctx, { expanded: true, indent: 2 }));
  return finish(lines, ctx);
}

/** Main chat, after the user messages a worker: `↳ you → convert-mocks: message`. */
export function renderUserToWorker(taskKey: string, text: string, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  return finish(hanging(t.muted(`${g.hook} you ${g.rightArrow} ${clean(taskKey, 40)}: `), clean(text, 4000), ctx.width, 2), ctx);
}

/** `head` then `text` word-wrapped; continuation lines indented by `indent` cells. */
function hanging(head: string, text: string, width: number, indent: number): string[] {
  const first = wrap(text, Math.max(10, width - displayWidth(head)))[0] ?? "";
  const rest = text.slice(first.length).trimStart();
  return [head + first, ...(rest === "" ? [] : wrap(rest, Math.max(10, width - indent)).map((line) => " ".repeat(indent) + line))];
}

/** A conversation item as plain lines (the worker snapshot; the TUI uses its own components). */
export function renderItem(item: ConversationItem, ctx: ViewContext, expanded = false): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs.base;
  switch (item.kind) {
    case "user":
      return ["", ...item.text.split("\n").map((line, index) => (index === 0 ? `${t.bold(g.user)} ${t.bold(line)}` : `  ${t.bold(line)}`))];
    case "assistant":
      return ["", ...item.text.trim().split("\n").map((line, index) => `${index === 0 ? g.bullet : " "} ${line}`)];
    case "tool":
      return renderToolRow(item, {
        width: ctx.width,
        glyphs: g,
        paint: { ok: t.success, fail: t.error, warn: t.warning, running: t.running, dim: t.muted, bold: t.bold },
        expanded,
        gap: true,
        measure: displayWidth,
        fit: (line) => line,
      });
    case "result":
      return ["", `${item.tone === "ok" ? t.success(g.ok) : item.tone === "error" ? t.error(g.fail) : t.warning(g.warn)} ${item.text}`];
    case "note":
      return [item.level === "error" ? t.error(item.text) : item.level === "warning" ? t.warning(item.text) : t.muted(item.text)];
  }
}

/** The transcript items a worker's events produce, in order, with the conversation rules. */
export function workerItems(events: readonly WorkerStreamEvent[], ctx: ViewContext): ConversationItem[] {
  const presenter = new ConversationPresenter({ glyphs: ctx.glyphs.base, echoesUser: false, now: () => ctx.now ?? Date.now() });
  const order: string[] = [];
  const items = new Map<string, ConversationItem>();
  for (const event of events) {
    if (event.kind === "assignment") continue;
    for (const op of presenter.apply(event)) {
      if (!items.has(op.item.id)) order.push(op.item.id);
      items.set(op.item.id, op.item);
    }
  }
  return order.map((id) => items.get(id)).filter((item): item is ConversationItem => item !== undefined);
}

/** Plain mode (`/worker <key>`): header, the assignment in full, then the transcript so far. */
export function renderWorkerSnapshot(snapshot: WorkerSnapshotView, ctx: ViewContext): string[] {
  const assignment = snapshot.assignment ?? [...snapshot.events].reverse().find((event): event is Extract<WorkerStreamEvent, { kind: "assignment" }> => event.kind === "assignment")?.assignment;
  const lines = [...renderWorkerHeader(snapshot.task, ctx), ...renderAssignment(assignment, ctx, { expanded: true })];
  const items = workerItems(snapshot.events, ctx);
  if (items.length === 0) lines.push(ctx.theme.muted("  no worker output yet"));
  for (const item of items) lines.push(...renderItem(item, ctx));
  return finish(lines, ctx);
}
