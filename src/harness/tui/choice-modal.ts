import { initialChoiceIndex, OTHER_LABEL, type ChoiceAnswer, type ChoiceQuestion } from "../contracts/index.ts";
import type { GlyphSet } from "./conversation-view.ts";
import { sanitizeInline } from "./sanitize.ts";
import type { Styler } from "./style.ts";
import { displayWidth, fitLine, truncate, wrap } from "./views/kit.ts";

/**
 * The K5 choice modal: the one focused prompt every question uses (ask_user, approvals, `/init`,
 * `/model`, `/config`, trust, the memory desk). ↑/↓ move, Enter selects, 1-9 pick directly, Space
 * toggles in multi-select, "Other…" switches to a free-text line, Esc cancels (or leaves the text
 * line). It satisfies pi-tui's `Component` shape structurally, so this module never imports pi-tui
 * (ADR-04); the adapter injects key matching.
 */

export type ChoiceKey = "up" | "down" | "enter" | "escape" | "space" | "backspace" | "tab" | "pageUp" | "pageDown";

export interface ChoiceModalOptions {
  readonly style: Styler;
  readonly glyphs: GlyphSet;
  /** True when `data` is the named key (pi-tui's `matchesKey` in the adapter). */
  readonly isKey: (data: string, key: ChoiceKey) => boolean;
  /** The printable text `data` carries, undefined for control sequences. */
  readonly printable?: (data: string) => string | undefined;
  /** Option rows shown at once before the list scrolls. */
  readonly maxVisible?: number;
}

interface Row {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
  readonly recommended: boolean;
  readonly disabled?: string;
  readonly other: boolean;
}

const PREVIEW_LINES = 8;

function defaultPrintable(data: string): string | undefined {
  if (data.startsWith("\x1b[200~")) return data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
  return data.startsWith("\x1b") ? undefined : data;
}

export class ChoiceModal {
  public onSubmit: ((answer: ChoiceAnswer) => void) | undefined;
  public onCancel: (() => void) | undefined;
  private readonly question: ChoiceQuestion;
  private readonly options: ChoiceModalOptions;
  private readonly rows: Row[];
  private readonly checked = new Set<number>();
  private selected: number;
  private offset = 0;
  private typing = false;
  private draft = "";
  private notice: string | undefined;

  public constructor(question: ChoiceQuestion, options: ChoiceModalOptions) {
    this.question = question;
    this.options = options;
    this.rows = question.options.map((option) => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
      ...(option.preview === undefined ? {} : { preview: option.preview }),
      recommended: option.recommended === true,
      ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
      other: false,
    }));
    if (question.allowOther !== false) this.rows.push({ label: OTHER_LABEL, recommended: false, other: true });
    this.selected = initialChoiceIndex(question);
  }

  /** Test and host introspection: the highlighted row, whether the text line is open, the checked rows. */
  public get state(): { readonly selected: number; readonly typing: boolean; readonly draft: string; readonly checked: readonly number[] } {
    return { selected: this.selected, typing: this.typing, draft: this.draft, checked: [...this.checked].sort((a, b) => a - b) };
  }

  public invalidate(): void {}

  public handleInput(data: string): void {
    const key = (name: ChoiceKey): boolean => this.options.isKey(data, name);
    this.notice = undefined;
    if (this.typing) {
      this.handleTyping(data, key);
      return;
    }
    if (key("escape")) {
      this.onCancel?.();
      return;
    }
    if (key("up")) return this.move(-1);
    if (key("down") || key("tab")) return this.move(1);
    if (key("pageUp")) return this.move(-this.visibleCount());
    if (key("pageDown")) return this.move(this.visibleCount());
    if (key("enter")) return this.confirm();
    if (key("space") && this.question.multiSelect === true) return this.toggle(this.selected);
    const text = (this.options.printable ?? defaultPrintable)(data);
    if (text !== undefined && /^[1-9]$/.test(text) && this.question.numberShortcuts !== false) {
      const index = Number(text) - 1;
      if (index >= this.rows.length) return;
      this.selected = index;
      this.scrollIntoView();
      if (this.question.multiSelect === true && this.rows[index]?.other !== true) this.toggle(index);
      else this.confirm();
      return;
    }
    if (text !== undefined && text === " " && this.question.multiSelect === true) this.toggle(this.selected);
  }

  public render(width: number): string[] {
    const { style, glyphs } = this.options;
    const ascii = glyphs.name === "ascii";
    const pointer = ascii ? ">" : "❯";
    const lines: string[] = [];
    const chip = this.question.header === undefined ? "" : `${style.cyan(`[${sanitizeInline(this.question.header, 30)}]`)} `;
    // Questions read as questions (`? Which folder?`); cards with their own context (approvals, trust) and pickers keep a plain title.
    const mark = this.question.tone !== "neutral" && this.question.context === undefined ? "? " : "";
    const title = `${mark}${sanitizeInline(this.question.question, 2000)}`;
    const paint = this.question.tone === "neutral" ? (text: string) => style.cyan(text) : (text: string) => style.yellow(style.bold(text));
    const room = Math.max(10, width - 2 - displayWidth(chip));
    wrap(title, room).forEach((part, index) => lines.push(`${index === 0 ? chip : " ".repeat(displayWidth(chip))}${paint(part)}`));
    if (this.question.subtitle !== undefined && this.question.subtitle !== "") lines.push(style.dim(sanitizeInline(this.question.subtitle, 500)));
    for (const line of this.question.context ?? []) lines.push(line);
    const count = this.visibleCount();
    if (this.offset > 0) lines.push(style.dim(`   ${ascii ? "^" : "↑"} ${this.offset} more`));
    const numberWidth = String(Math.min(this.rows.length, 99)).length;
    for (let index = this.offset; index < Math.min(this.rows.length, this.offset + count); index += 1) {
      const row = this.rows[index];
      if (row === undefined) continue;
      const active = index === this.selected;
      const number = `${index + 1}.`.padStart(numberWidth + 1);
      const box = this.question.multiSelect === true && !row.other ? `${this.checked.has(index) ? (ascii ? "[x]" : "[✓]") : "[ ]"} ` : "";
      const label = sanitizeInline(row.label, 200);
      const tag = row.recommended ? `  ${style.green("Recommended")}` : "";
      const why = row.disabled === undefined ? "" : `  ${style.dim(sanitizeInline(row.disabled, 200))}`;
      const head = `${active ? style.cyan(pointer) : " "} ${style.dim(number)} ${box}`;
      const body = row.disabled !== undefined ? style.dim(label) : active ? style.bold(style.cyan(label)) : label;
      // Pickers (neutral tone) keep one row per option: the description follows the label, dim.
      const inline = this.question.tone === "neutral" && row.description !== undefined && row.description !== "" ? `  ${style.dim(sanitizeInline(row.description, 300))}` : "";
      lines.push(fitLine(`${head}${body}${tag}${why}${inline}`, width));
      const indent = " ".repeat(3 + number.length + box.length);
      if (inline === "" && row.description !== undefined && row.description !== "") {
        for (const part of wrap(sanitizeInline(row.description, 500), Math.max(10, width - indent.length)).slice(0, 2)) lines.push(`${indent}${style.dim(part)}`);
      }
      if (row.other && this.typing) {
        const shown = truncate(this.draft, Math.max(4, width - indent.length - 4), glyphs.ellipsis);
        lines.push(`${indent}${style.cyan(">")} ${shown}${style.cyan(ascii ? "_" : "▏")}`);
      }
    }
    const hidden = this.rows.length - (this.offset + count);
    if (hidden > 0) lines.push(style.dim(`   ${ascii ? "v" : "↓"} ${hidden} more`));
    const preview = this.rows[this.selected]?.preview;
    if (preview !== undefined && preview.trim() !== "" && !this.typing) {
      const bar = style.dim(ascii ? "|" : "│");
      const previewLines = preview.replace(/\r\n/g, "\n").split("\n");
      for (const line of previewLines.slice(0, PREVIEW_LINES)) lines.push(`   ${bar} ${truncate(sanitizeInline(line, 400), Math.max(4, width - 6), glyphs.ellipsis)}`);
      if (previewLines.length > PREVIEW_LINES) lines.push(style.dim(`   ${bar} ${glyphs.ellipsis} +${previewLines.length - PREVIEW_LINES} lines`));
    }
    if (this.notice !== undefined) lines.push(style.yellow(`  ${this.notice}`));
    lines.push(style.dim(`  ${this.hint()}`));
    return lines.map((line) => fitLine(line, width));
  }

  private hint(): string {
    const sep = ` ${this.options.glyphs.sep} `;
    if (this.typing) return ["type your answer", "Enter sends", "Esc back to the options"].join(sep);
    const escape = `Esc ${this.question.escapeLabel ?? "cancels"}`;
    const numbers = this.question.numberShortcuts === false ? [] : [`1-${Math.min(9, this.rows.length)}`];
    if (this.question.multiSelect === true) return ["↑↓ move", "Space toggles", ...numbers, "Enter confirms", escape].join(sep);
    return ["↑↓ + Enter", ...numbers, escape].join(sep);
  }

  private handleTyping(data: string, key: (name: ChoiceKey) => boolean): void {
    if (key("escape")) {
      this.typing = false;
      return;
    }
    if (key("enter")) {
      const text = this.draft.trim();
      if (text === "") {
        this.notice = "type an answer, or Esc to go back";
        return;
      }
      this.onSubmit?.({ kind: "other", text });
      return;
    }
    if (key("backspace")) {
      this.draft = [...this.draft].slice(0, -1).join("");
      return;
    }
    const text = (this.options.printable ?? defaultPrintable)(data);
    if (text !== undefined) this.draft = `${this.draft}${text.replace(/[\x00-\x1f\x7f]/g, " ")}`.slice(0, 4000);
  }

  private move(delta: number): void {
    const total = this.rows.length;
    if (total === 0) return;
    let next = this.selected;
    const step = delta > 0 ? 1 : -1;
    for (let moved = 0; moved < Math.abs(delta); moved += 1) {
      next = (next + step + total) % total;
    }
    this.selected = next;
    this.scrollIntoView();
  }

  private toggle(index: number): void {
    const row = this.rows[index];
    if (row === undefined || row.other) return;
    if (row.disabled !== undefined) {
      this.notice = row.disabled;
      return;
    }
    if (this.checked.has(index)) this.checked.delete(index);
    else this.checked.add(index);
  }

  private confirm(): void {
    const row = this.rows[this.selected];
    if (row === undefined) return;
    if (row.other) {
      this.typing = true;
      return;
    }
    if (this.question.multiSelect === true) {
      const indices = this.checked.size > 0 ? [...this.checked].sort((a, b) => a - b) : row.disabled === undefined ? [this.selected] : [];
      if (indices.length === 0) {
        this.notice = "select at least one option (Space toggles)";
        return;
      }
      this.onSubmit?.({ kind: "selected", indices, labels: indices.map((index) => this.rows[index]?.label ?? "") });
      return;
    }
    if (row.disabled !== undefined) {
      this.notice = row.disabled;
      return;
    }
    this.onSubmit?.({ kind: "selected", indices: [this.selected], labels: [row.label] });
  }

  private visibleCount(): number {
    return Math.max(1, Math.min(this.rows.length, this.options.maxVisible ?? 10));
  }

  private scrollIntoView(): void {
    const count = this.visibleCount();
    if (this.selected < this.offset) this.offset = this.selected;
    else if (this.selected >= this.offset + count) this.offset = this.selected - count + 1;
  }
}
