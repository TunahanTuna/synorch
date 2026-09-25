import { displayWidth, truncate, wrap } from "./views/kit.ts";

/**
 * Word-wrap with a hanging indent (Claude Code style): the first line starts with `prefix`, every
 * continuation line is indented by the prefix's width so the text reads as one block. Callers wrap
 * plain text and paint the lines afterwards, so no escape sequence is ever split. Width-aware (run
 * on every render, so a resize re-wraps) and wide-char aware. `maxLines` caps the block; the last
 * kept line then ends in the ellipsis. The plain/JSONL paths load this too, so no pi-tui import
 * here: the TUI passes pi-tui's grapheme-aware wrapper as `wrapText`.
 */
export interface HangingOptions {
  /** At most this many lines (undefined: all). */
  readonly maxLines?: number | undefined;
  readonly ellipsis?: string | undefined;
  /** Plain-text word wrapper; defaults to the view kit's. */
  readonly wrapText?: ((text: string, width: number) => string[]) | undefined;
}

export type TextWrapper = (text: string, width: number) => string[];

export function wrapHanging(prefix: string, body: string, width: number, options: HangingOptions = {}): string[] {
  const safeWidth = Math.max(1, width);
  const wrapText = options.wrapText ?? wrap;
  // A prefix wider than most of the screen would leave no room: fall back to a small indent.
  const indent = Math.min(displayWidth(prefix), Math.max(0, safeWidth - 8));
  const room = Math.max(1, safeWidth - indent);
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const paragraph of body.split("\n")) {
    const wrapped = paragraph.trim() === "" ? [""] : wrapText(paragraph.trimEnd(), room);
    for (const line of wrapped) lines.push(lines.length === 0 ? prefix + line : line === "" ? "" : pad + line);
  }
  if (lines.length === 0) lines.push(prefix);
  const max = options.maxLines;
  if (max === undefined || lines.length <= max) return lines.map((line) => truncate(line, safeWidth));
  const kept = lines.slice(0, Math.max(1, max));
  const ellipsis = options.ellipsis ?? "…";
  const last = kept.length - 1;
  const tail = (kept[last] ?? "").trimEnd();
  kept[last] = `${truncate(tail, Math.max(1, safeWidth - displayWidth(ellipsis) - 1), "")} ${ellipsis}`;
  return kept.map((line) => truncate(line, safeWidth));
}

/**
 * Hanging indent for a free-form note line: leading spaces plus a short marker (`●`, `→`, `1.`,
 * `✓`, `!`) when there is one; otherwise just the leading spaces.
 */
export function splitMarker(text: string): { readonly prefix: string; readonly body: string } {
  const match = /^( *)(\d{1,2}\.|[^\p{L}\p{N}\s]{1,2}) (?=\S)/u.exec(text);
  if (match !== null) return { prefix: match[0], body: text.slice(match[0].length) };
  const lead = /^ */.exec(text)?.[0] ?? "";
  return { prefix: lead, body: text.slice(lead.length) };
}
