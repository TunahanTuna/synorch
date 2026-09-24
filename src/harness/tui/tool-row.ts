import type { ConversationItem, DiffLine, GlyphSet } from "./conversation-view.ts";

/**
 * One tool call at L0 (TUI §7.4, terminal polish brief): a status glyph, the verb and target, and
 * the compact stat on the same line when it fits — `✓ Edit src/a.ts  +8 −3`. A failure, denial or
 * interruption puts its reason on a second `⎿` line so it is never lost to truncation. The edit
 * preview (≤ 8 lines) follows; Ctrl+O swaps it for the full detail. Colour never carries meaning
 * alone: the glyph differs per status. Shared by the interactive transcript and the worker views.
 */

export interface ToolRowPaint {
  ok(text: string): string;
  fail(text: string): string;
  warn(text: string): string;
  running(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

type ToolItem = Extract<ConversationItem, { kind: "tool" }>;

export interface ToolRowOptions {
  readonly width: number;
  readonly glyphs: GlyphSet;
  readonly paint: ToolRowPaint;
  readonly expanded: boolean;
  /** A blank line above (the first tool after text); consecutive tool rows stay compact. */
  readonly gap: boolean;
  /** Visible width of a string (ANSI-aware); the caller's measure. */
  readonly measure: (text: string) => number;
  readonly fit: (text: string, width: number) => string;
}

export function toolGlyph(item: ToolItem, glyphs: GlyphSet, paint: ToolRowPaint): string {
  switch (item.status) {
    case "ok":
      return paint.ok(glyphs.ok);
    case "failed":
    case "denied":
      return paint.fail(glyphs.fail);
    case "cancelled":
      return paint.warn(glyphs.warn);
    case "running":
      return paint.running(glyphs.bullet);
  }
}

/** What a background process is doing now; the session binds it to its process manager (K4.2). */
export interface BackgroundStatus {
  readonly running: boolean;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  /** `exited 0`, `stopped`, `timed out` once it ended. */
  readonly ended: string | undefined;
}

let backgroundSource: ((handle: string) => BackgroundStatus | undefined) | undefined;

/** Binds the live status of background processes shown in tool rows; returns the unbind. */
export function bindBackgroundStatus(source: (handle: string) => BackgroundStatus | undefined): () => void {
  backgroundSource = source;
  return () => {
    if (backgroundSource === source) backgroundSource = undefined;
  };
}

function elapsedShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `◌ dev server (pnpm dev)  running · 12s` (live) or `✓ … exited 0 · 34s` once it ended. */
function backgroundHead(item: ToolItem, g: GlyphSet, paint: ToolRowPaint): { readonly glyph: string; readonly stat: string } | undefined {
  const background = item.background;
  if (background === undefined || item.status !== "ok") return undefined;
  const live = backgroundSource?.(background.handle);
  const now = Date.now();
  if (live === undefined || live.running) {
    const started = live?.startedAt ?? background.startedAt;
    return { glyph: paint.running(g.name === "rich" ? "◌" : "o"), stat: `running ${g.sep} ${elapsedShort(now - started)} ${g.sep} ${background.handle}` };
  }
  const failed = live.ended !== undefined && !/^(exited 0|stopped)/.test(live.ended);
  return { glyph: failed ? paint.fail(g.fail) : paint.dim(g.ok), stat: `${live.ended ?? "ended"} ${g.sep} ${elapsedShort((live.endedAt ?? now) - live.startedAt)} ${g.sep} ${background.handle}` };
}

export function renderToolRow(item: ToolItem, options: ToolRowOptions): string[] {
  const { width, glyphs: g, paint, fit, measure } = options;
  const lines: string[] = options.gap ? [""] : [];
  const background = backgroundHead(item, g, paint);
  const head = `${background?.glyph ?? toolGlyph(item, g, paint)} ${paint.bold(item.title)}`;
  const trouble = item.status === "failed" || item.status === "denied" || item.status === "cancelled";
  const stat = background?.stat ?? item.stat ?? item.summary;
  if (stat !== undefined && !trouble && measure(item.title) + measure(stat) + 4 <= width) {
    lines.push(fit(`${head}  ${paint.dim(stat)}`, width));
  } else {
    lines.push(fit(head, width));
    if (stat !== undefined) {
      const painted = item.status === "cancelled" ? paint.warn(stat) : trouble ? paint.fail(stat) : paint.dim(stat);
      lines.push(fit(`  ${paint.dim(g.result)} ${painted}`, width));
    }
  }
  const body = options.expanded && item.detail.length > 0 ? item.detail : item.preview;
  for (const line of body) lines.push(fit(`    ${diffLine(line, g, paint)}`, width));
  return lines;
}

export function diffLine(line: DiffLine, glyphs: GlyphSet, paint: ToolRowPaint): string {
  if (line.op === "+") return paint.ok(`+ ${line.text}`);
  if (line.op === "-") return paint.fail(`${glyphs.minus} ${line.text}`);
  if (line.op === "…") return paint.dim(`${glyphs.ellipsis} ${line.text}`);
  return paint.dim(`  ${line.text}`);
}
