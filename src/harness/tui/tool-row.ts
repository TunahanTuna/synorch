import type { ConversationItem, DiffLine, GlyphSet } from "./conversation-view.ts";
import { wrapHanging, type TextWrapper } from "./wrap.ts";

/** Collapsed tool rows: the headline wraps to 3 lines, the result summary to 2 (Ctrl+O: all). */
const HEADLINE_LINES = 3;
const SUMMARY_LINES = 2;

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
  /** Diff lines (K8 theme tokens); default to ok / fail. */
  add?(text: string): string;
  remove?(text: string): string;
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
  /** Plain-text word wrapper (the TUI passes pi-tui's grapheme-aware one); defaults to the view kit's. */
  readonly wrapText?: TextWrapper | undefined;
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
    // The headline wraps under the tool name (3 lines, then `…`; Ctrl+O shows it all), never cut at one line.
    const glyph = background?.glyph ?? toolGlyph(item, g, paint);
    const slot = " ".repeat(measure(glyph) + 1);
    const headLines = wrapHanging(slot, item.title, width, { maxLines: options.expanded ? undefined : HEADLINE_LINES, ellipsis: g.ellipsis, wrapText: options.wrapText });
    headLines.forEach((line, index) => lines.push(index === 0 ? `${glyph} ${paint.bold(line.slice(slot.length))}` : paint.bold(line)));
    if (stat !== undefined) {
      const tone = (text: string): string => (item.status === "cancelled" ? paint.warn(text) : trouble ? paint.fail(text) : paint.dim(text));
      const lead = `  ${g.result} `;
      const statLines = wrapHanging(lead, stat, width, { maxLines: options.expanded ? undefined : SUMMARY_LINES, ellipsis: g.ellipsis, wrapText: options.wrapText });
      statLines.forEach((line, index) => lines.push(index === 0 ? `  ${paint.dim(g.result)} ${tone(line.slice(lead.length))}` : tone(line)));
    }
  }
  const full = options.expanded && item.detail.length > 0;
  const body = full ? item.detail : item.preview;
  // Expanded (Ctrl+O) detail wraps so nothing is lost; the collapsed preview stays one line per row.
  for (const line of body) {
    if (full) {
      const mark = line.op === "+" ? "+ " : line.op === "-" ? `${g.minus} ` : line.op === "…" ? `${g.ellipsis} ` : "  ";
      const slot = `    ${" ".repeat(measure(mark))}`;
      const tone = line.op === "+" ? (paint.add ?? paint.ok) : line.op === "-" ? (paint.remove ?? paint.fail) : paint.dim;
      wrapHanging(slot, line.text, width, { wrapText: options.wrapText }).forEach((piece, index) => {
        const text = piece.slice(slot.length);
        lines.push(index === 0 ? `    ${diffLine({ op: line.op, text }, g, paint)}` : `${slot}${tone(text)}`);
      });
    }
    else lines.push(fit(`    ${diffLine(line, g, paint)}`, width));
  }
  return lines;
}

export function diffLine(line: DiffLine, glyphs: GlyphSet, paint: ToolRowPaint): string {
  if (line.op === "+") return (paint.add ?? paint.ok)(`+ ${line.text}`);
  if (line.op === "-") return (paint.remove ?? paint.fail)(`${glyphs.minus} ${line.text}`);
  if (line.op === "…") return paint.dim(`${glyphs.ellipsis} ${line.text}`);
  return paint.dim(`  ${line.text}`);
}
