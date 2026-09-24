import type { DiffFileView, DiffHunkLineView, DiffView } from "../../contracts/views.ts";
import { sanitizeTerminalText } from "../sanitize.ts";
import { clean, displayWidth, finish, padStart, type ViewContext } from "./kit.ts";

/**
 * `/diff` (terminal polish brief): what Synorch changed in this conversation, per file — a header
 * with `+added −removed`, then compact hunks with line numbers and two lines of context. Long
 * files are cut with a count, never silently. Pure; the plain renderer prints the same lines.
 */

const CONTEXT = 2;
const MAX_LINES_PER_FILE = 40;
const MAX_DP_CELLS = 4_000_000;

/** A line diff of two texts (common prefix/suffix trimmed, LCS on the middle), as hunks. */
export function lineDiff(before: string, after: string): { readonly added: number; readonly removed: number; readonly lines: DiffHunkLineView[]; readonly tooLarge: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: { op: "+" | "-" | " "; text: string; oldLine: number; newLine: number }[] = [];
  for (let index = 0; index < start; index += 1) ops.push({ op: " ", text: a[index] ?? "", oldLine: index + 1, newLine: index + 1 });
  let tooLarge = false;
  if ((midA.length + 1) * (midB.length + 1) > MAX_DP_CELLS) {
    tooLarge = true;
    midA.forEach((text, index) => ops.push({ op: "-", text, oldLine: start + index + 1, newLine: start + 1 }));
    midB.forEach((text, index) => ops.push({ op: "+", text, oldLine: start + midA.length + 1, newLine: start + index + 1 }));
  } else {
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] = midA[i] === midB[j] ? (table[(i + 1) * cols + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        ops.push({ op: " ", text: midA[i] ?? "", oldLine: start + i + 1, newLine: start + j + 1 });
        i += 1;
        j += 1;
      } else if (i < midA.length && (j === midB.length || (table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0))) {
        // Removals before additions, as in a unified diff.
        ops.push({ op: "-", text: midA[i] ?? "", oldLine: start + i + 1, newLine: start + j + 1 });
        i += 1;
      } else {
        ops.push({ op: "+", text: midB[j] ?? "", oldLine: start + i + 1, newLine: start + j + 1 });
        j += 1;
      }
    }
  }
  const offset = midB.length - midA.length;
  for (let index = endA; index < a.length; index += 1) ops.push({ op: " ", text: a[index] ?? "", oldLine: index + 1, newLine: index + 1 + offset });
  // Keep changed lines and CONTEXT lines around them; gaps become one `…` line.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((entry, index) => {
    if (entry.op === " ") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k += 1) keep[k] = true;
  });
  const lines: DiffHunkLineView[] = [];
  let skipped = 0;
  ops.forEach((entry, index) => {
    if (!keep[index]) {
      skipped += 1;
      return;
    }
    if (skipped > 0 && lines.length > 0) lines.push({ op: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
    skipped = 0;
    lines.push({ op: entry.op, text: entry.text, line: entry.op === "-" ? entry.oldLine : entry.newLine });
  });
  return { added: ops.filter((entry) => entry.op === "+").length, removed: ops.filter((entry) => entry.op === "-").length, lines, tooLarge };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function renderDiff(view: DiffView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs.base;
  const out: string[] = [""];
  if (view.files.length === 0 && (view.integrated === undefined || view.integrated.length === 0)) {
    return finish(["", t.muted("Synorch has not changed any file in this conversation.")], ctx);
  }
  if (view.files.length > 0) {
    const added = view.files.reduce((sum, file) => sum + file.added, 0);
    const removed = view.files.reduce((sum, file) => sum + file.removed, 0);
    out.push(`${t.bold(`${view.files.length} file${view.files.length === 1 ? "" : "s"} changed by Synorch`)}  ${t.success(`+${added}`)} ${t.error(`${g.minus}${removed}`)}`);
    out.push(t.muted(`not independently reviewed ${g.sep} /undo reverts the last edit`));
    for (const file of view.files) out.push(...renderFile(file, ctx));
  }
  if (view.integrated !== undefined && view.integrated.length > 0) {
    if (out.length > 1) out.push("");
    out.push(t.bold("Integrated by workers (checked by Synorch)"));
    for (const entry of view.integrated) out.push(`  ${clean(entry.path, 300)}${entry.reviewed ? t.muted(` ${g.sep} independently reviewed`) : ""}`);
  }
  return finish(out, ctx);
}

function renderFile(file: DiffFileView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs.base;
  const label = file.change === "added" ? "new" : file.change === "deleted" ? "deleted" : "";
  const out = ["", `${t.accent(g.bullet)} ${t.bold(clean(file.path, 300))}  ${t.success(`+${file.added}`)} ${t.error(`${g.minus}${file.removed}`)}${label === "" ? "" : t.muted(`  ${label}`)}`];
  if (file.note !== undefined) out.push(t.muted(`    ${clean(file.note, 300)}`));
  const numbers = file.lines.map((line) => line.line ?? 0);
  const gutter = Math.max(2, String(Math.max(0, ...numbers)).length);
  const shown = file.lines.slice(0, MAX_LINES_PER_FILE);
  for (const line of shown) {
    const text = sanitizeTerminalText(line.text).replaceAll("\t", "  ").replace(/[\r\n]/g, "");
    if (line.op === "…") {
      out.push(t.muted(`  ${" ".repeat(gutter)} ${g.ellipsis} ${text}`));
      continue;
    }
    const number = t.muted(padStart(line.line === undefined ? "" : String(line.line), gutter));
    const room = Math.max(8, ctx.width - gutter - 6);
    const body = displayWidth(text) > room ? `${text.slice(0, room - 1)}${g.ellipsis}` : text;
    if (line.op === "+") out.push(`  ${number} ${t.success(`+ ${body}`)}`);
    else if (line.op === "-") out.push(`  ${number} ${t.error(`${g.minus} ${body}`)}`);
    else out.push(`  ${number} ${t.muted(`  ${body}`)}`);
  }
  if (file.lines.length > shown.length) out.push(t.muted(`  ${" ".repeat(gutter)} ${g.ellipsis} ${file.lines.length - shown.length} more lines ${g.sep} git diff -- ${clean(file.path, 200)}`));
  return out;
}
