import { GLYPH_SETS, formatElapsed as formatConversationElapsed, formatTokens, type GlyphSet, type GlyphSetName } from "../conversation-view.ts";
import { sanitizeInline } from "../sanitize.ts";
import { createStyler, type Styler } from "../style.ts";

/**
 * Shared kit of the rich views: display width (no pi-tui import, ADR-04 keeps that in the adapter),
 * ANSI-aware truncation, the colour tokens of TUI experience §11.2 over the 16-colour `Styler`, and
 * the view glyphs of §11.1 (rich / safe / ascii). Views lay out plain text first and paint last, so
 * with colour off every token is the identity and no line ever carries an SGR byte.
 */

export interface ViewTheme {
  readonly enabled: boolean;
  text(s: string): string;
  muted(s: string): string;
  accent(s: string): string;
  bold(s: string): string;
  running(s: string): string;
  success(s: string): string;
  warning(s: string): string;
  error(s: string): string;
}

export function createViewTheme(color: boolean | Styler): ViewTheme {
  const style = typeof color === "boolean" ? createStyler(color) : color;
  return {
    enabled: style.enabled,
    text: (s) => s,
    muted: style.dim,
    accent: style.cyan,
    bold: style.bold,
    running: style.cyan,
    success: style.green,
    warning: style.yellow,
    error: style.red,
  };
}

export interface BoxGlyphs {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
}

export interface ViewGlyphs {
  readonly base: GlyphSet;
  readonly name: GlyphSetName;
  readonly pending: string;
  readonly retry: string;
  readonly interrupted: string;
  readonly cancelled: string;
  readonly ask: string;
  readonly arrowHead: string;
  readonly leftArrow: string;
  readonly downArrow: string;
  readonly box: BoxGlyphs;
  /** Border of an active graph node (double line; `#` in ascii). */
  readonly strongBox: BoxGlyphs;
  /** Direction mask (N=1, E=2, S=4, W=8) → line character. */
  readonly line: readonly string[];
  /** Bar fill from empty to full; the last is a full cell. */
  readonly bar: readonly string[];
  readonly barEmpty: string;
  readonly barOpen: string;
  readonly barClose: string;
}

const LINE_UNICODE = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"];
const LINE_ASCII = [" ", "|", "-", "+", "|", "|", "+", "+", "-", "+", "-", "+", "+", "+", "+", "+"];

const VIEW_GLYPHS: { readonly [N in GlyphSetName]: Omit<ViewGlyphs, "base" | "name"> } = {
  rich: {
    pending: "○",
    retry: "↻",
    interrupted: "‖",
    cancelled: "–",
    ask: "?",
    arrowHead: "►",
    leftArrow: "←",
    downArrow: "↓",
    box: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
    strongBox: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
    line: LINE_UNICODE,
    bar: ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"],
    barEmpty: "░",
    barOpen: "",
    barClose: "",
  },
  safe: {
    pending: "o",
    retry: "~",
    interrupted: "=",
    cancelled: "-",
    ask: "?",
    arrowHead: "►",
    leftArrow: "←",
    downArrow: "↓",
    box: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
    strongBox: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
    line: LINE_UNICODE,
    bar: ["", "▌", "█"],
    barEmpty: "░",
    barOpen: "",
    barClose: "",
  },
  ascii: {
    pending: ".",
    retry: "~",
    interrupted: "=",
    cancelled: "-",
    ask: "?",
    arrowHead: ">",
    leftArrow: "<-",
    downArrow: "v",
    box: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
    strongBox: { tl: "#", tr: "#", bl: "#", br: "#", h: "=", v: "#" },
    line: LINE_ASCII,
    bar: ["", "#"],
    barEmpty: "-",
    barOpen: "[",
    barClose: "]",
  },
};

export function viewGlyphs(set: GlyphSet | GlyphSetName = "rich"): ViewGlyphs {
  const base = typeof set === "string" ? GLYPH_SETS[set] : set;
  return { base, name: base.name, ...VIEW_GLYPHS[base.name] };
}

/** Everything a view needs besides its data. */
export interface ViewContext {
  readonly glyphs: ViewGlyphs;
  readonly theme: ViewTheme;
  readonly width: number;
  /** Clock for elapsed time of live tasks; defaults to `Date.now()`. */
  readonly now?: number | undefined;
  /** Spinner frame index. */
  readonly frame?: number | undefined;
}

export function viewContext(options: { readonly glyphs?: GlyphSet | GlyphSetName | undefined; readonly color?: boolean | Styler | undefined; readonly width?: number | undefined; readonly now?: number | undefined; readonly frame?: number | undefined }): ViewContext {
  return {
    glyphs: viewGlyphs(options.glyphs ?? "rich"),
    theme: createViewTheme(options.color ?? false),
    width: Math.max(20, options.width ?? 80),
    now: options.now,
    frame: options.frame,
  };
}

// ---------------------------------------------------------------------------------------------
// Width.

const ANSI = /\x1b\[[0-9;]*m/g;
const SGR_AT = /^\x1b\[[0-9;]*m/;

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function isZeroWidth(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f || (code >= 0x1ab0 && code <= 0x1aff);
}

export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (isZeroWidth(code)) return 0;
  return isWide(code) ? 2 : 1;
}

/** Visible width of a line (SGR sequences ignored). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI, "")) width += charWidth(char);
  return width;
}

/** Truncates plain text to `width` cells, ending in the ellipsis when cut. */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return ellipsis.slice(0, width);
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > room) break;
    out += char;
    used += w;
  }
  return out + ellipsis;
}

export function padEnd(text: string, width: number): string {
  const fitted = truncate(text, width);
  return fitted + " ".repeat(Math.max(0, width - displayWidth(fitted)));
}

export function padStart(text: string, width: number): string {
  const fitted = truncate(text, width);
  return " ".repeat(Math.max(0, width - displayWidth(fitted))) + fitted;
}

/** ANSI-aware last-resort guard: no painted line may exceed the terminal width. */
export function fitLine(line: string, width: number): string {
  if (displayWidth(line) <= width) return line;
  let out = "";
  let used = 0;
  let painted = false;
  for (let index = 0; index < line.length; ) {
    const sgr = SGR_AT.exec(line.slice(index));
    if (sgr !== null) {
      out += sgr[0];
      painted = true;
      index += sgr[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index) ?? 32);
    const w = charWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
    index += char.length;
  }
  return `${out}…${painted ? "\x1b[0m" : ""}`;
}

/** Last step of every view: trailing blanks go, lines fit the width, ascii mode stays 7-bit. */
export function finish(lines: readonly string[], ctx: ViewContext): string[] {
  return lines.map((line) => {
    const fitted = fitLine(line.trimEnd(), ctx.width);
    return ctx.glyphs.name === "ascii" ? fitted.replace(/…/g, ".").replace(/·/g, "-") : fitted;
  });
}

/** Word-wraps plain text to `width`, hard-cutting words longer than a line. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    let rest = word;
    while (displayWidth(rest) > width) {
      const head = truncate(rest, width, "");
      lines.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  if (current !== "" || lines.length === 0) lines.push(current);
  return lines;
}

/** Untrusted view strings: one line, no escapes, bounded. */
export function clean(text: string | undefined, max = 200): string {
  return text === undefined ? "" : sanitizeInline(text, max);
}

// ---------------------------------------------------------------------------------------------
// Numbers and bars.

export { formatTokens };

/** `14s`, `4m 12s`, `1h 12m`. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return formatConversationElapsed(ms);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatUsd(value: number, estimated = false): string {
  const text = `$${value.toFixed(value >= 100 ? 0 : 2)}`;
  return estimated ? `~${text}` : text;
}

export function formatCount(value: number): string {
  return value >= 10_000 ? formatTokens(value) : String(value);
}

/** A share bar of `cells` width for `ratio` in [0, 1] (sub-cell precision where the glyph set allows). */
export function shareBar(ratio: number, cells: number, glyphs: ViewGlyphs): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const steps = glyphs.bar.length - 1;
  const units = Math.round(clamped * cells * steps);
  const full = Math.floor(units / steps);
  const partial = units % steps;
  const body = (glyphs.bar[steps] ?? "#").repeat(full) + (partial > 0 ? (glyphs.bar[partial] ?? "") : "");
  return body;
}

/** A meter with an empty track, e.g. `███████░░░░░` or `[#######-----]`. */
export function meterBar(ratio: number, cells: number, glyphs: ViewGlyphs): { readonly filled: string; readonly empty: string } {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const filledCells = Math.round(clamped * cells);
  const full = glyphs.bar[glyphs.bar.length - 1] ?? "#";
  return { filled: glyphs.barOpen + full.repeat(filledCells), empty: glyphs.barEmpty.repeat(cells - filledCells) + glyphs.barClose };
}

/** A two-column right-aligned header: `left` then `right` pushed to the edge when it fits. */
export function spread(left: string, right: string, width: number): { readonly left: string; readonly gap: string; readonly right: string } {
  const lw = displayWidth(left);
  const rw = displayWidth(right);
  if (right === "" || lw + rw + 2 > width) return { left: truncate(left, width), gap: "", right: "" };
  return { left, gap: " ".repeat(width - lw - rw), right };
}
