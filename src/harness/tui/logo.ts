import { LOGO_PIXELS } from "./logo-art.ts";
import { parseStyleSpec, toXterm256, type ColorDepth, type ThemeDefinition } from "./theme.ts";

/**
 * The Synorch mark (assets/brand/synorch-logo.svg) as half-block pixel art in truecolor or 256
 * colours: two pixels of logo-art.ts per terminal cell, tinted with the active theme's
 * logo1 → logo2 → logo3 gradient, so every theme recolours the same art. 16 colours, NO_COLOR and
 * the safe / ascii glyph sets keep the glyph mark (welcome.ts).
 */

export type Rgb = readonly [number, number, number];

export interface LogoPalette {
  /** The theme's logo1, logo2, logo3 colours. */
  readonly stops: readonly [Rgb, Rgb, Rgb];
  readonly depth: 256 | 24;
}

/** Columns and terminal rows the art takes. */
export const ART_COLUMNS = LOGO_PIXELS[0]?.length ?? 14;
export const ART_ROWS = Math.ceil(LOGO_PIXELS.length / 2);

/** The logo palette of `theme` at `depth`; undefined at 16 colours or when a logo token has no hex colour. */
export function themeLogoPalette(theme: ThemeDefinition | undefined, depth: ColorDepth): LogoPalette | undefined {
  if (theme === undefined || depth === 16) return undefined;
  const stops: Rgb[] = [];
  for (const token of ["logo1", "logo2", "logo3"] as const) {
    const color = parseStyleSpec(theme.tokens[token]).spec.color;
    if (color?.kind !== "hex") return undefined;
    stops.push(color.rgb);
  }
  return { stops: [stops[0]!, stops[1]!, stops[2]!], depth };
}

/** The gradient colour at position 0..1: logo1 → logo2 → logo3. */
export function gradientAt(stops: LogoPalette["stops"], t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t));
  const [from, to, f] = clamped <= 0.5 ? [stops[0], stops[1], clamped * 2] : [stops[1], stops[2], (clamped - 0.5) * 2];
  return [0, 1, 2].map((k) => Math.round(from[k]! + (to[k]! - from[k]!) * f)) as unknown as Rgb;
}

const artCache = new Map<string, string[]>();

/**
 * The half-block art: each cell is two vertical pixels (▀ with the top pixel as foreground and the
 * bottom one as background, ▄ or █ when only one is set or both match). ART_ROWS lines, each
 * ART_COLUMNS cells wide, closing every colour it opens. The gradient runs top to bottom with a
 * slight left-to-right lean, like the SVG's.
 */
export function artLines(palette: LogoPalette): string[] {
  const key = `${palette.depth}:${palette.stops.map((rgb) => rgb.join(",")).join(";")}`;
  const cached = artCache.get(key);
  if (cached !== undefined) return cached;
  const lastRow = Math.max(1, LOGO_PIXELS.length - 1);
  const lastColumn = Math.max(1, ART_COLUMNS - 1);
  const color = (row: number, column: number): string | undefined => {
    if (LOGO_PIXELS[row]?.[column] !== "#") return undefined;
    const rgb = gradientAt(palette.stops, (row / lastRow) * 0.85 + (column / lastColumn) * 0.15);
    return palette.depth === 24 ? `2;${rgb.join(";")}` : `5;${toXterm256(rgb)}`;
  };
  const lines: string[] = [];
  for (let row = 0; row < ART_ROWS; row += 1) {
    let line = "";
    let fg = "";
    let bg = "";
    const set = (nextFg: string, nextBg: string): void => {
      if (nextFg !== fg) line += nextFg === "" ? "\x1b[39m" : `\x1b[38;${nextFg}m`;
      if (nextBg !== bg) line += nextBg === "" ? "\x1b[49m" : `\x1b[48;${nextBg}m`;
      fg = nextFg;
      bg = nextBg;
    };
    for (let column = 0; column < ART_COLUMNS; column += 1) {
      const up = color(row * 2, column);
      const down = color(row * 2 + 1, column);
      if (up === undefined && down === undefined) {
        set(fg, "");
        line += " ";
      } else if (up !== undefined && down !== undefined && up === down) {
        set(up, "");
        line += "█";
      } else if (up !== undefined && down !== undefined) {
        set(up, down);
        line += "▀";
      } else if (up !== undefined) {
        set(up, "");
        line += "▀";
      } else {
        set(down!, "");
        line += "▄";
      }
    }
    set("", "");
    lines.push(line);
  }
  artCache.set(key, lines);
  return lines;
}
