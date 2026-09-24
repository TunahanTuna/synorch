import type { OrchestrationTaskView, OrchestrationView } from "../../contracts/views.ts";
import { boardHint, isActive, paint, presentTask, type Tone } from "./board.ts";
import { charWidth, clean, displayWidth, finish, padEnd, spread, truncate, type BoxGlyphs, type ViewContext } from "./kit.ts";

/**
 * The orchestration graph (`/graph`, `g` from the live board): the plan as a terminal DAG. Tasks
 * are boxes (glyph, key, role · model) placed in topological levels; dependency edges are routed
 * with box-drawing characters (ASCII fallback) through per-target lanes, and edges that skip a
 * level pass through dummy slots (Sugiyama layering, one barycentre pass). The running path —
 * active tasks and the dependency chains that lead to them — is highlighted: accent colour for
 * edges and a double border for active boxes, so it survives NO_COLOR. When the levels do not fit
 * side by side the graph wraps its levels vertically along a spine.
 */

interface Layout {
  /** Task keys per level, ordered. */
  readonly levels: readonly (readonly Entry[])[];
  readonly segments: readonly Segment[];
  readonly hot: ReadonlySet<string>;
  readonly cyclic: boolean;
}

type Entry = { readonly id: string; readonly task: OrchestrationTaskView | undefined };

interface Segment {
  readonly from: string;
  readonly to: string;
  /** Level of `from`; `to` is on the next level. */
  readonly level: number;
  readonly hot: boolean;
}

const NODE_HEIGHT = 4;
const NODE_PITCH = NODE_HEIGHT + 1;
const MAX_BOX_INNER = 24;

function dependencies(task: OrchestrationTaskView, byKey: ReadonlyMap<string, OrchestrationTaskView>): string[] {
  return [...new Set(task.dependsOn ?? [])].filter((key) => key !== task.key && byKey.has(key));
}

export function layoutGraph(view: OrchestrationView): Layout {
  const byKey = new Map<string, OrchestrationTaskView>();
  for (const task of view.tasks) if (!byKey.has(task.key)) byKey.set(task.key, task);
  const tasks = [...byKey.values()];
  const deps = new Map(tasks.map((task) => [task.key, dependencies(task, byKey)]));

  // Longest-path levels (Kahn); tasks caught in a cycle go one level below everything else.
  const level = new Map<string, number>();
  const indegree = new Map(tasks.map((task) => [task.key, deps.get(task.key)?.length ?? 0]));
  const queue = tasks.filter((task) => indegree.get(task.key) === 0).map((task) => task.key);
  for (let head = 0; head < queue.length; head += 1) {
    const key = queue[head] as string;
    const own = Math.max(0, ...(deps.get(key) ?? []).map((dep) => (level.get(dep) ?? 0) + 1));
    level.set(key, own);
    for (const task of tasks) {
      if (!(deps.get(task.key) ?? []).includes(key)) continue;
      const left = (indegree.get(task.key) ?? 0) - 1;
      indegree.set(task.key, left);
      if (left === 0) queue.push(task.key);
    }
  }
  const cyclic = level.size < tasks.length;
  if (cyclic) {
    const bottom = Math.max(-1, ...level.values()) + 1;
    for (const task of tasks) if (!level.has(task.key)) level.set(task.key, bottom);
  }

  // Running path: active tasks and every ancestor.
  const hot = new Set<string>();
  const visit = (key: string) => {
    if (hot.has(key)) return;
    hot.add(key);
    for (const dep of deps.get(key) ?? []) visit(dep);
  };
  for (const task of tasks) if (isActive(task)) visit(task.key);

  const depth = Math.max(0, ...level.values()) + 1;
  const levels: Entry[][] = Array.from({ length: depth }, () => []);
  for (const task of tasks) levels[level.get(task.key) ?? 0]?.push({ id: task.key, task });
  const segments: Segment[] = [];
  let dummy = 0;
  for (const task of tasks) {
    const to = level.get(task.key) ?? 0;
    for (const dep of deps.get(task.key) ?? []) {
      const from = level.get(dep) ?? 0;
      if (from >= to) continue; // a cycle edge: shown in the legend instead
      const isHot = hot.has(dep) && hot.has(task.key);
      let previous = dep;
      for (let l = from + 1; l < to; l += 1) {
        const id = `\u0000dummy-${(dummy += 1)}`;
        levels[l]?.push({ id, task: undefined });
        segments.push({ from: previous, to: id, level: l - 1, hot: isHot });
        previous = id;
      }
      segments.push({ from: previous, to: task.key, level: to - 1, hot: isHot });
    }
  }

  // One barycentre pass downwards keeps edges short and mostly uncrossed.
  for (let l = 1; l < levels.length; l += 1) {
    const above = levels[l - 1] ?? [];
    const position = new Map(above.map((entry, index) => [entry.id, index]));
    const current = levels[l] ?? [];
    const centre = new Map(
      current.map((entry, index) => {
        const parents = segments.filter((segment) => segment.to === entry.id).map((segment) => position.get(segment.from) ?? index);
        return [entry.id, parents.length === 0 ? index : parents.reduce((sum, value) => sum + value, 0) / parents.length];
      }),
    );
    levels[l] = current.map((entry, index) => ({ entry, index })).sort((a, b) => (centre.get(a.entry.id) ?? 0) - (centre.get(b.entry.id) ?? 0) || a.index - b.index).map((item) => item.entry);
  }
  return { levels, segments, hot, cyclic };
}

// ---------------------------------------------------------------------------------------------

type CellTone = "edge" | "hot" | Tone | "accent" | "bold";

class Grid {
  private readonly masks: number[][];
  private readonly chars: (string | undefined)[][];
  private readonly tones: (CellTone | undefined)[][];

  public readonly width: number;
  public readonly height: number;

  public constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.masks = Array.from({ length: height }, () => new Array<number>(width).fill(0));
    this.chars = Array.from({ length: height }, () => new Array<string | undefined>(width).fill(undefined));
    this.tones = Array.from({ length: height }, () => new Array<CellTone | undefined>(width).fill(undefined));
  }

  public line(x: number, y: number, mask: number, hot: boolean): void {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
    const row = this.masks[y] as number[];
    row[x] = (row[x] ?? 0) | mask;
    const tones = this.tones[y] as (CellTone | undefined)[];
    if (hot || tones[x] === undefined) tones[x] = hot ? "hot" : "edge";
  }

  public put(x: number, y: number, text: string, tone: CellTone | undefined): void {
    if (y < 0 || y >= this.height) return;
    let column = x;
    for (const char of text) {
      if (column >= this.width) break;
      (this.chars[y] as (string | undefined)[])[column] = char;
      (this.tones[y] as (CellTone | undefined)[])[column] = tone;
      column += 1;
      if (charWidth(char) === 2 && column < this.width) {
        // A wide character covers the next cell too.
        (this.chars[y] as (string | undefined)[])[column] = "";
        (this.tones[y] as (CellTone | undefined)[])[column] = tone;
        column += 1;
      }
    }
  }

  public render(ctx: ViewContext): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let line = "";
      let run = "";
      let runTone: CellTone | undefined;
      const flush = () => {
        if (run === "") return;
        line += paintCell(ctx, runTone, run);
        run = "";
      };
      for (let x = 0; x < this.width; x += 1) {
        const char = this.chars[y]?.[x] ?? ctx.glyphs.line[this.masks[y]?.[x] ?? 0] ?? " ";
        const tone = this.tones[y]?.[x];
        if (tone !== runTone) {
          flush();
          runTone = tone;
        }
        run += char;
      }
      flush();
      out.push(line.trimEnd());
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
  }
}

function paintCell(ctx: ViewContext, tone: CellTone | undefined, text: string): string {
  const t = ctx.theme;
  if (tone === undefined || text.trim() === "") return text;
  switch (tone) {
    case "edge":
      return t.muted(text);
    case "hot":
    case "accent":
      return t.accent(text);
    case "bold":
      return t.bold(text);
    default:
      return paint(t, tone, text);
  }
}

const N = 1;
const E = 2;
const S = 4;
const W = 8;

interface NodeText {
  readonly head: string;
  readonly sub: string;
  readonly glyph: string;
  readonly tone: Tone;
  readonly active: boolean;
}

function nodeText(task: OrchestrationTaskView, all: readonly OrchestrationTaskView[], ctx: ViewContext): NodeText {
  const shown = presentTask(task, all, ctx);
  const model = clean(task.model, 20);
  return {
    glyph: shown.glyph,
    head: clean(task.key, 40),
    sub: model === "" ? clean(task.role, 20) : `${clean(task.role, 20)} ${ctx.glyphs.base.sep} ${model}`,
    tone: shown.tone,
    active: shown.active,
  };
}

function drawBox(grid: Grid, x: number, y: number, inner: number, text: NodeText, box: BoxGlyphs, select?: string): void {
  const borderTone: CellTone = text.active || select !== undefined ? "accent" : "edge";
  grid.put(x, y, box.tl + box.h.repeat(inner) + box.tr, borderTone);
  grid.put(x, y + 1, box.v, borderTone);
  grid.put(x + 1, y + 1, select ?? " ", select === undefined ? undefined : "accent");
  grid.put(x + 2, y + 1, text.glyph, text.tone);
  grid.put(x + 3, y + 1, " ", undefined);
  grid.put(x + 4, y + 1, padEnd(text.head, inner - 3), text.active ? "bold" : undefined);
  grid.put(x + inner + 1, y + 1, box.v, borderTone);
  grid.put(x, y + 2, box.v, borderTone);
  grid.put(x + 1, y + 2, ` ${padEnd(text.sub, inner - 1)}`, "muted");
  grid.put(x + inner + 1, y + 2, box.v, borderTone);
  grid.put(x, y + 3, box.bl + box.h.repeat(inner) + box.br, borderTone);
}

function renderWide(view: OrchestrationView, layout: Layout, ctx: ViewContext, selected?: string): string[] | undefined {
  const all = view.tasks;
  const texts = new Map<string, NodeText>();
  for (const entries of layout.levels) for (const entry of entries) if (entry.task !== undefined) texts.set(entry.id, nodeText(entry.task, all, ctx));
  const inner = layout.levels.map((entries) =>
    Math.min(MAX_BOX_INNER, Math.max(6, ...entries.map((entry) => {
      const text = texts.get(entry.id);
      return text === undefined ? 0 : Math.max(displayWidth(text.head) + 3, displayWidth(text.sub) + 1);
    })) + 1),
  );
  const lanes = layout.levels.map((_, level) => {
    const targets = [...new Set(layout.segments.filter((segment) => segment.level === level).map((segment) => segment.to))];
    const next = layout.levels[level + 1] ?? [];
    return targets.sort((a, b) => next.findIndex((entry) => entry.id === a) - next.findIndex((entry) => entry.id === b));
  });
  const gutter = lanes.map((targets) => (targets.length === 0 ? 0 : targets.length + 3));
  const columnX: number[] = [];
  let x = 2;
  layout.levels.forEach((_, level) => {
    columnX.push(x);
    x += (inner[level] ?? 0) + 2;
    if (level < layout.levels.length - 1) x += Math.max(4, gutter[level] ?? 0);
  });
  const width = x;
  if (width > ctx.width) return undefined;
  const slots = Math.max(1, ...layout.levels.map((entries) => entries.length));
  const grid = new Grid(width, slots * NODE_PITCH - 1);
  const rowOf = new Map<string, number>();
  layout.levels.forEach((entries, level) => entries.forEach((entry, slot) => rowOf.set(`${level}:${entry.id}`, slot * NODE_PITCH)));
  // Edges leave a box from its first text row and enter the next box on its second, so an outgoing
  // and an incoming horizontal never share a row.

  // Edges first; boxes are drawn over them.
  layout.levels.forEach((entries, level) => {
    const x0 = (columnX[level] ?? 0) + (inner[level] ?? 0) + 2;
    const targets = lanes[level] ?? [];
    for (const segment of layout.segments.filter((candidate) => candidate.level === level)) {
      const rs = (rowOf.get(`${level}:${segment.from}`) ?? 0) + 1;
      const rt = (rowOf.get(`${level + 1}:${segment.to}`) ?? 0) + 2;
      const lane = x0 + 1 + targets.indexOf(segment.to);
      const end = columnX[level + 1] ?? width;
      for (let cx = x0; cx < lane; cx += 1) grid.line(cx, rs, E | W, segment.hot);
      if (rs === rt) grid.line(lane, rs, E | W, segment.hot);
      else {
        const down = rt > rs;
        grid.line(lane, rs, W | (down ? S : N), segment.hot);
        for (let cy = Math.min(rs, rt) + 1; cy < Math.max(rs, rt); cy += 1) grid.line(lane, cy, N | S, segment.hot);
        grid.line(lane, rt, E | (down ? N : S), segment.hot);
      }
      for (let cx = lane + 1; cx < end - 1; cx += 1) grid.line(cx, rt, E | W, segment.hot);
      const isDummy = segment.to.startsWith("\u0000");
      if (isDummy) grid.line(end - 1, rt, E | W, segment.hot);
      else grid.put(end - 1, rt, ctx.glyphs.arrowHead, segment.hot ? "hot" : "edge");
    }
    // Dummy slots: the edge passes through the column, stepping up one row in the middle.
    entries.forEach((entry) => {
      if (entry.task !== undefined) return;
      const top = rowOf.get(`${level}:${entry.id}`) ?? 0;
      const hot = layout.segments.some((segment) => segment.to === entry.id && segment.hot);
      const left = columnX[level] ?? 0;
      const right = left + (inner[level] ?? 0) + 2;
      const middle = left + Math.floor((right - left) / 2);
      for (let cx = left; cx < middle; cx += 1) grid.line(cx, top + 2, E | W, hot);
      grid.line(middle, top + 2, W | N, hot);
      grid.line(middle, top + 1, S | E, hot);
      for (let cx = middle + 1; cx < right; cx += 1) grid.line(cx, top + 1, E | W, hot);
    });
    entries.forEach((entry, slot) => {
      const text = texts.get(entry.id);
      if (text === undefined) return;
      const select = entry.id === selected ? ctx.glyphs.select : undefined;
      drawBox(grid, columnX[level] ?? 0, slot * NODE_PITCH, inner[level] ?? 6, text, text.active ? ctx.glyphs.strongBox : ctx.glyphs.box, select);
    });
  });
  return grid.render(ctx);
}

function renderStacked(view: OrchestrationView, layout: Layout, ctx: ViewContext, selected?: string): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const all = view.tasks;
  const lines: string[] = [];
  const keyWidth = Math.min(20, Math.max(4, ...all.map((task) => displayWidth(clean(task.key, 40)))));
  const byKey = new Map(all.map((task) => [task.key, task]));
  layout.levels.forEach((entries, level) => {
    const last = level === layout.levels.length - 1;
    const first = level === 0;
    const corner = layout.levels.length === 1 ? g.line[E] : first ? g.line[E | S] : last ? g.line[N | E] : g.line[N | E | S];
    const spine = last ? " " : g.line[N | S];
    const anyHot = entries.some((entry) => layout.hot.has(entry.id));
    lines.push(`  ${anyHot ? t.accent(corner ?? "+") : t.muted(corner ?? "+")} ${t.muted(`level ${level + 1}`)}`);
    for (const entry of entries) {
      const task = entry.task;
      if (task === undefined) continue;
      const text = nodeText(task, all, ctx);
      const deps = (task.dependsOn ?? []).filter((key) => byKey.has(key)).map((key) => clean(key, 40));
      const depText = deps.length === 0 ? "" : `${g.leftArrow} ${deps.join(", ")}`;
      const isSelected = task.key === selected;
      const lead = `${isSelected ? t.accent(g.select) : " "} ${t.muted(spine ?? " ")} `;
      const keyText = padEnd(text.head, keyWidth);
      const head = `${paint(t, text.tone, text.glyph)} ${isSelected ? t.accent(t.bold(keyText)) : text.active ? t.bold(keyText) : keyText}`;
      const room = ctx.width - 4 - 2 - keyWidth - 1;
      const sub = truncate(text.sub, Math.max(4, room));
      const inline = depText !== "" && displayWidth(sub) + 2 + displayWidth(depText) <= room;
      lines.push(`${lead}${head} ${t.muted(sub)}${inline ? `  ${layout.hot.has(task.key) && text.active ? t.accent(depText) : t.muted(depText)}` : ""}`);
      if (!inline && depText !== "") lines.push(`${lead}    ${t.muted(truncate(depText, ctx.width - 8))}`);
    }
  });
  return lines;
}

export interface GraphOptions {
  /** Show `g board` in the header (the graph was toggled from the live board). */
  readonly fromBoard?: boolean | undefined;
  /** Force the vertical layout. */
  readonly stacked?: boolean | undefined;
  /** Key of the selected task (K1.7): `›` in its box and an accent border. */
  readonly selected?: string | undefined;
  /** Replaces the header hint on the right. */
  readonly hint?: string | undefined;
  /** K2 memory graph: replaces the `Plan graph · n tasks` header parts. */
  readonly header?: readonly string[] | undefined;
  /** K2 memory graph: no running-activity lines or plan legend. */
  readonly bare?: boolean | undefined;
}

/** Task keys per graph level, top to bottom within a level: the order ←/→ and ↑/↓ move in. */
export function graphLevels(view: OrchestrationView): string[][] {
  return layoutGraph(view)
    .levels.map((entries) => entries.filter((entry) => entry.task !== undefined).map((entry) => entry.id))
    .filter((keys) => keys.length > 0);
}

export function renderGraph(view: OrchestrationView, ctx: ViewContext, options: GraphOptions = {}): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const layout = layoutGraph(view);
  const levelCount = layout.levels.filter((entries) => entries.length > 0).length;
  const running = view.tasks.filter(isActive).length;
  const left = options.header !== undefined ? [...options.header] : [`${g.base.bullet} Plan graph`, `${view.tasks.length} task${view.tasks.length === 1 ? "" : "s"}`, `${levelCount} level${levelCount === 1 ? "" : "s"}`];
  if (running > 0 && options.header === undefined) left.push(`${running} running`);
  const head = spread(left.join(` ${g.base.sep} `), options.hint ?? (options.fromBoard === true ? boardHint(ctx, "graph") : ""), ctx.width);
  const lines = [`${t.accent(head.left)}${head.gap}${t.muted(head.right)}`];
  if (view.tasks.length === 0) {
    lines.push(t.muted("  no tasks in the plan yet"));
    return lines;
  }
  const body = options.stacked === true ? undefined : renderWide(view, layout, ctx, options.selected);
  lines.push(...(body ?? renderStacked(view, layout, ctx, options.selected)));
  if (options.bare === true) return finish(lines, ctx);
  // Activity of what is running now, and the legend.
  for (const task of view.tasks.filter(isActive)) {
    const shown = presentTask(task, view.tasks, ctx);
    lines.push(`  ${t.running(shown.glyph)} ${t.bold(clean(task.key, 40))}${t.muted(":")} ${shown.label}`);
  }
  if (running > 0 && body !== undefined) lines.push(t.muted(`  ${g.strongBox.tl}${g.strongBox.h} running path highlighted`));
  if (layout.cyclic) lines.push(t.warning(`  ${g.base.warn} the plan has a dependency cycle; cyclic tasks are shown last`));
  return finish(lines, ctx);
}
