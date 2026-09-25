import type { PanelAction, PanelActionResult, PanelBadge, PanelBlock, PanelItem, PanelPage, PanelTone, PanelView } from "../../contracts/panel.ts";
import type { HarnessView } from "../../contracts/views.ts";
import type { GlyphSet } from "../conversation-view.ts";
import { sanitizeInline, sanitizeTerminalText } from "../sanitize.ts";
import type { Styler } from "../style.ts";
import { displayWidth, fitLine, padEnd, truncate, wrap } from "../views/kit.ts";

/**
 * The layered panel (interactive renderer): a stack of pages drawn in place of the transcript.
 * Title bar with the breadcrumb, tabs, a navigable list or a scrollable document, a status line
 * and the key hints. It satisfies pi-tui's `Component` shape structurally and never imports pi-tui
 * (ADR-04): the adapter injects key matching, markdown rendering, harness cards and the prompts an
 * action needs (a line of text, a yes/no question).
 *
 * Keys: ↑↓ / j k move (scroll in a document), PgUp/PgDn, Home/End, Enter or → opens, ← / Backspace
 * / Esc go back one level, Esc at the root or `q` closes, `/` filters a list, Tab / Shift+Tab switch
 * tabs, and each action's own key (shown in the footer) runs it.
 */

export type PanelKey = "up" | "down" | "left" | "right" | "enter" | "escape" | "backspace" | "tab" | "shiftTab" | "pageUp" | "pageDown" | "home" | "end";

export interface PanelViewOptions {
  readonly style: Styler;
  readonly glyphs: GlyphSet;
  readonly isKey: (data: string, key: PanelKey) => boolean;
  readonly printable?: (data: string) => string | undefined;
  /** Rows the panel may fill (the terminal minus whatever is drawn with it). */
  readonly rows: () => number;
  /** The transcript's markdown renderer: painted lines at `width`. */
  readonly markdown: (text: string, width: number) => string[];
  /** A harness card at `width` (usage, context, diff); absent draws nothing. */
  readonly view?: (view: HarnessView, width: number) => string[];
  /** A line of text for an action (Esc: undefined). */
  readonly ask: (prompt: string) => Promise<string | undefined>;
  readonly confirm: (question: string) => Promise<boolean>;
  /** The panel closed: with the result that closed it (editor text, a command), if any. */
  readonly onClose: (result: PanelActionResult | undefined) => void;
  readonly requestRender: () => void;
}

interface Frame {
  page: PanelPage;
  view: number;
  selected: number;
  top: number;
  scroll: number;
  filter: string;
  stale: boolean;
}

interface Status {
  readonly text: string;
  readonly level: NonNullable<PanelActionResult["level"]>;
}

/** Keys the panel keeps for itself: an action can never take them. */
const RESERVED = new Set(["j", "k", "q", "/"]);

function defaultPrintable(data: string): string | undefined {
  if (data.startsWith("\x1b[200~")) return data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
  return data.startsWith("\x1b") || data.length === 0 ? undefined : data;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PanelNavigator {
  private readonly options: PanelViewOptions;
  private readonly stack: Frame[] = [];
  private typing = false;
  private busy: string | undefined;
  private status: Status | undefined;
  private closed = false;
  private bodyRows = 10;
  private docCache: { readonly frame: Frame; readonly page: PanelPage; readonly view: number; readonly width: number; readonly lines: string[] } | undefined;

  public constructor(root: PanelPage, options: PanelViewOptions) {
    this.options = options;
    this.stack.push(this.frame(root));
  }

  /** Test and host introspection. */
  public get state(): { readonly depth: number; readonly title: string; readonly view: number; readonly selected: number; readonly scroll: number; readonly filter: string; readonly typing: boolean; readonly busy: boolean; readonly crumbs: readonly string[] } {
    const top = this.top;
    return { depth: this.stack.length, title: top.page.title, view: top.view, selected: top.selected, scroll: top.scroll, filter: top.filter, typing: this.typing, busy: this.busy !== undefined, crumbs: this.stack.map((frame) => frame.page.crumb ?? frame.page.title) };
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public invalidate(): void {
    this.docCache = undefined;
  }

  /** Closes the panel from outside (Ctrl+C, abort). */
  public close(result?: PanelActionResult): void {
    if (this.closed) return;
    this.closed = true;
    this.options.onClose(result);
  }

  /** Mouse wheel: positive scrolls down. */
  public scroll(lines: number): void {
    if (this.closed || this.busy !== undefined) return;
    const view = this.currentView();
    if (view?.kind === "list") this.move(lines > 0 ? 1 : -1);
    else this.scrollDocument(lines);
    this.options.requestRender();
  }

  public handleInput(data: string): void {
    if (this.closed) return;
    const key = (name: PanelKey): boolean => this.options.isKey(data, name);
    if (this.busy !== undefined) {
      if (key("escape")) this.status = { text: `${this.busy}: still working…`, level: "info" };
      return;
    }
    if (this.typing) {
      this.handleFilterInput(data, key);
      this.options.requestRender();
      return;
    }
    const text = (this.options.printable ?? defaultPrintable)(data);
    const view = this.currentView();
    const frame = this.top;
    if (key("escape")) {
      if (frame.filter !== "") {
        frame.filter = "";
        this.resetSelection(frame);
      } else if (this.stack.length > 1) this.pop();
      else this.close();
    } else if (key("left") || key("backspace")) {
      if (this.stack.length > 1) this.pop();
    } else if (key("tab")) this.switchView(1);
    else if (key("shiftTab")) this.switchView(-1);
    else if (key("up") || text === "k") this.stepOrScroll(-1);
    else if (key("down") || text === "j") this.stepOrScroll(1);
    else if (key("pageUp")) this.stepOrScroll(-Math.max(1, this.bodyRows - 1));
    else if (key("pageDown")) this.stepOrScroll(Math.max(1, this.bodyRows - 1));
    else if (key("home")) this.stepOrScroll(-Number.MAX_SAFE_INTEGER);
    else if (key("end")) this.stepOrScroll(Number.MAX_SAFE_INTEGER);
    else if (key("enter") || key("right")) void this.activate();
    else if (text === "q") this.close();
    else if (text === "/" && view?.kind === "list") this.typing = true;
    else if (text !== undefined && text.length === 1) {
      const action = this.actions().find((candidate) => candidate.key === text);
      if (action !== undefined) void this.runAction(action);
    }
    this.options.requestRender();
  }

  // ---- rendering -------------------------------------------------------------------------------

  public render(width: number): string[] {
    const { style, glyphs } = this.options;
    const ascii = glyphs.name === "ascii";
    const rows = Math.max(6, this.options.rows());
    const frame = this.top;
    const page = frame.page;
    const view = this.currentView();
    const head: string[] = [];
    const crumbSep = ascii ? " > " : " › ";
    const crumbs = this.stack.map((entry) => sanitizeInline(entry.page.crumb ?? entry.page.title, 60));
    const crumbText = crumbs.map((crumb, index) => (index === crumbs.length - 1 ? style.bold(style.accent(crumb)) : style.muted(crumb))).join(style.muted(crumbSep));
    const position = this.positionLabel(view, frame);
    head.push(this.spread(` ${crumbText}`, position === "" ? "" : style.muted(`${position} `), width));
    if (page.subtitle !== undefined && page.subtitle !== "") head.push(fitLine(` ${style.muted(sanitizeInline(page.subtitle, 400))}`, width));
    const rule = ascii ? "-" : "─";
    if (page.views.length > 1) {
      const { line, underline } = this.tabs(page.views, frame.view, width);
      head.push(line, underline);
    } else head.push(style.border(rule.repeat(Math.max(1, width))));
    const foot: string[] = [];
    foot.push(style.border(rule.repeat(Math.max(1, width))));
    const statusLine = this.statusLine(width);
    if (statusLine !== undefined) foot.push(statusLine);
    foot.push(fitLine(` ${style.muted(this.hints(view))}`, width));
    const room = Math.max(1, rows - head.length - foot.length);
    this.bodyRows = room;
    const body = view === undefined ? [] : view.kind === "list" ? this.renderList(view.items, width, room) : this.renderDocument(width, room);
    while (body.length < room) body.push("");
    return [...head, ...body.slice(0, room), ...foot].map((line) => fitLine(line, width));
  }

  private spread(left: string, right: string, width: number): string {
    const gap = width - displayWidth(left) - displayWidth(right);
    if (right === "" || gap < 1) return fitLine(left, width);
    return `${left}${" ".repeat(gap)}${right}`;
  }

  private tabs(views: readonly PanelView[], active: number, width: number): { readonly line: string; readonly underline: string } {
    const { style, glyphs } = this.options;
    const ascii = glyphs.name === "ascii";
    let line = " ";
    let underline = style.border((ascii ? "-" : "─").repeat(1));
    views.forEach((view, index) => {
      const count = view.kind === "list" ? ` ${view.items.length}` : "";
      const label = `${sanitizeInline(view.label, 40)}${count}`;
      const cell = ` ${label} `;
      const on = index === active;
      line += on ? style.bold(style.accent(cell)) : style.muted(cell);
      underline += on ? style.accent((ascii ? "=" : "━").repeat(displayWidth(cell))) : style.border((ascii ? "-" : "─").repeat(displayWidth(cell)));
      if (index < views.length - 1) {
        line += " ";
        underline += style.border(ascii ? "-" : "─");
      }
    });
    const used = displayWidth(underline);
    if (used < width) underline += style.border((ascii ? "-" : "─").repeat(width - used));
    return { line: fitLine(line, width), underline: fitLine(underline, width) };
  }

  private positionLabel(view: PanelView | undefined, frame: Frame): string {
    if (view === undefined) return "";
    if (view.kind === "list") {
      const items = this.filtered(view.items, frame.filter);
      return items.length === 0 ? "" : `${Math.min(frame.selected + 1, items.length)}/${items.length}`;
    }
    const total = this.docCache?.lines.length ?? 0;
    if (total <= this.bodyRows) return "";
    const end = Math.min(total, frame.scroll + this.bodyRows);
    return `${Math.round((end / total) * 100)}%`;
  }

  private statusLine(width: number): string | undefined {
    const { style, glyphs } = this.options;
    const frame = this.top;
    if (this.typing || frame.filter !== "") {
      const cursor = this.typing ? style.accent(glyphs.name === "ascii" ? "_" : "▏") : "";
      const label = this.typing ? "filter" : "filtered";
      return fitLine(` ${style.accent("/")} ${style.muted(label)} ${frame.filter}${cursor}`, width);
    }
    if (this.busy !== undefined) return fitLine(` ${style.accent(glyphs.spinner[0] ?? "*")} ${style.muted(`${this.busy}…`)}`, width);
    const status = this.status;
    if (status === undefined) return undefined;
    const paint = status.level === "error" ? style.danger : status.level === "warning" ? style.warning : status.level === "success" ? style.success : style.muted;
    const mark = status.level === "success" ? `${glyphs.ok} ` : status.level === "error" ? `${glyphs.fail} ` : status.level === "warning" ? `${glyphs.warn} ` : "";
    return fitLine(` ${paint(`${mark}${sanitizeInline(status.text, 400)}`)}`, width);
  }

  private hints(view: PanelView | undefined): string {
    const sep = ` ${this.options.glyphs.sep} `;
    const ascii = this.options.glyphs.name === "ascii";
    if (this.typing) return ["type to filter", "Enter keeps", "Esc clears"].join(sep);
    const parts: string[] = [];
    const frame = this.top;
    const actions = this.actions();
    if (view?.kind === "list") {
      const item = this.selectedItem();
      parts.push(ascii ? "up/down move" : "↑↓ move");
      if (item?.open !== undefined) parts.push("Enter open");
      else {
        const primary = actions.find((action) => action.primary === true);
        if (primary !== undefined) parts.push(`Enter ${primary.label}`);
      }
      for (const action of actions) if (action.primary !== true || item?.open !== undefined) parts.push(`${action.key} ${action.label}`);
      parts.push("/ filter");
    } else {
      parts.push(ascii ? "up/down scroll" : "↑↓ scroll", "PgUp/PgDn");
      for (const action of actions) parts.push(`${action.key} ${action.label}`);
    }
    if (frame.page.views.length > 1) parts.push("Tab switch");
    parts.push(this.stack.length > 1 ? "Esc back" : "Esc close");
    return parts.join(sep);
  }

  private renderList(items: readonly PanelItem[], width: number, room: number): string[] {
    const { style, glyphs } = this.options;
    const frame = this.top;
    const view = this.currentView();
    const shown = this.filtered(items, frame.filter);
    if (shown.length === 0) {
      const empty = frame.filter !== "" ? `nothing matches "${frame.filter}"` : view?.kind === "list" && view.empty !== undefined ? view.empty : "nothing here";
      return ["", fitLine(`   ${style.muted(sanitizeInline(empty, 400))}`, width)];
    }
    frame.selected = Math.max(0, Math.min(frame.selected, shown.length - 1));
    if (frame.selected < frame.top) frame.top = frame.selected;
    if (frame.selected >= frame.top + room) frame.top = frame.selected - room + 1;
    frame.top = Math.max(0, Math.min(frame.top, Math.max(0, shown.length - room)));
    const labelWidth = Math.max(8, Math.min(Math.floor(width * 0.4), 40, Math.max(...shown.map((item) => displayWidth(sanitizeInline(item.label, 200))))));
    const badgeText = (badges: readonly PanelBadge[] | undefined): string => (badges ?? []).map((badge) => sanitizeInline(badge.label, 30)).join(" ");
    const badgeWidth = Math.min(24, Math.max(0, ...shown.map((item) => displayWidth(badgeText(item.badges)))));
    const metaWidth = Math.min(16, Math.max(0, ...shown.map((item) => displayWidth(sanitizeInline(item.meta ?? "", 60)))));
    const pointer = glyphs.name === "ascii" ? ">" : "❯";
    const lines: string[] = [];
    for (let index = frame.top; index < Math.min(shown.length, frame.top + room); index += 1) {
      const item = shown[index];
      if (item === undefined) continue;
      const active = index === frame.selected;
      const label = padEnd(sanitizeInline(item.label, 200), labelWidth);
      const badges = (item.badges ?? []).map((badge) => this.paint(badge.tone, sanitizeInline(badge.label, 30))).join(" ");
      const badgeCell = badgeWidth === 0 ? "" : `  ${badges}${" ".repeat(Math.max(0, badgeWidth - displayWidth(badgeText(item.badges))))}`;
      const metaCell = metaWidth === 0 ? "" : `  ${style.muted(padEnd(sanitizeInline(item.meta ?? "", 60), metaWidth))}`;
      const used = 3 + labelWidth + displayWidth(badgeCell) + displayWidth(metaCell) + 2;
      const description = item.description === undefined || item.description === "" ? "" : `  ${style.muted(truncate(sanitizeInline(item.description, 400), Math.max(0, width - used - 1), glyphs.ellipsis))}`;
      const head = active ? ` ${style.accent(pointer)} ` : "   ";
      const body = active ? style.bold(style.accent(label)) : label;
      lines.push(fitLine(`${head}${body}${badgeCell}${metaCell}${width - used > 4 ? description : ""}`, width));
    }
    return lines;
  }

  private renderDocument(width: number, room: number): string[] {
    const frame = this.top;
    const lines = this.documentLines(width);
    frame.scroll = Math.max(0, Math.min(frame.scroll, Math.max(0, lines.length - room)));
    return lines.slice(frame.scroll, frame.scroll + room);
  }

  private documentLines(width: number): string[] {
    const frame = this.top;
    const cache = this.docCache;
    if (cache !== undefined && cache.frame === frame && cache.page === frame.page && cache.view === frame.view && cache.width === width) return cache.lines;
    const view = this.currentView();
    const lines: string[] = [];
    if (view?.kind === "document") {
      const inner = Math.max(10, width - 2);
      view.blocks.forEach((block, index) => {
        if (index > 0) lines.push("");
        for (const line of this.renderBlock(block, inner)) lines.push(fitLine(` ${line}`, width));
      });
    }
    this.docCache = { frame, page: frame.page, view: frame.view, width, lines };
    return lines;
  }

  private renderBlock(block: PanelBlock, width: number): string[] {
    const { style, glyphs } = this.options;
    switch (block.kind) {
      case "heading":
        return [style.bold(style.heading(sanitizeInline(block.text, 200)))];
      case "fields": {
        const labelWidth = Math.min(18, Math.max(0, ...block.rows.map((row) => displayWidth(sanitizeInline(row.label, 40))))) + 2;
        const out: string[] = [];
        for (const row of block.rows) {
          const value = sanitizeTerminalText(row.value);
          const parts = value.split("\n").flatMap((line) => wrap(line.replace(/\t/g, "  "), Math.max(8, width - labelWidth)));
          parts.forEach((part, index) => {
            const label = index === 0 ? style.muted(padEnd(sanitizeInline(row.label, 40), labelWidth)) : " ".repeat(labelWidth);
            out.push(`${label}${row.tone === undefined ? part : this.paint(row.tone, part)}`);
          });
        }
        return out;
      }
      case "markdown": {
        const text = sanitizeTerminalText(block.text);
        try {
          return this.options.markdown(text, width);
        } catch {
          return text.split("\n").flatMap((line) => wrap(line, width));
        }
      }
      case "text": {
        const paint = block.tone === undefined ? (text: string) => text : (text: string) => this.paint(block.tone as PanelTone, text);
        return sanitizeTerminalText(block.text)
          .split("\n")
          .flatMap((line) => wrap(line.replace(/\t/g, "  "), width))
          .map(paint);
      }
      case "code": {
        const bar = style.border(glyphs.name === "ascii" ? "|" : "│");
        return sanitizeTerminalText(block.text)
          .split("\n")
          .map((line) => `${bar} ${style.code(truncate(line.replace(/\t/g, "  "), Math.max(4, width - 2), glyphs.ellipsis))}`);
      }
      case "view":
        return this.options.view?.(block.view, width) ?? [];
    }
  }

  private paint(tone: PanelTone, text: string): string {
    const { style } = this.options;
    switch (tone) {
      case "success":
        return style.success(text);
      case "warning":
        return style.warning(text);
      case "error":
        return style.danger(text);
      case "accent":
        return style.accent(text);
      case "info":
        return style.secondary(text);
      case "muted":
        return style.muted(text);
    }
  }

  // ---- navigation ------------------------------------------------------------------------------

  private get top(): Frame {
    return this.stack[this.stack.length - 1] as Frame;
  }

  private frame(page: PanelPage): Frame {
    const view = Math.max(0, Math.min(page.initialView ?? 0, page.views.length - 1));
    return { page, view, selected: 0, top: 0, scroll: 0, filter: "", stale: false };
  }

  private currentView(): PanelView | undefined {
    const frame = this.top;
    return frame.page.views[frame.view];
  }

  private filtered(items: readonly PanelItem[], filter: string): readonly PanelItem[] {
    const wanted = filter.trim().toLowerCase();
    if (wanted === "") return items;
    return items.filter((item) => [item.label, item.meta ?? "", item.description ?? "", item.search ?? "", ...(item.badges ?? []).map((badge) => badge.label)].join(" ").toLowerCase().includes(wanted));
  }

  private selectedItem(): PanelItem | undefined {
    const view = this.currentView();
    if (view?.kind !== "list") return undefined;
    const frame = this.top;
    return this.filtered(view.items, frame.filter)[frame.selected];
  }

  /** The item's actions, then the page's (an item action wins a key clash). */
  private actions(): PanelAction[] {
    const item = this.selectedItem();
    const out: PanelAction[] = [];
    const seen = new Set<string>();
    for (const action of [...(item?.actions ?? []), ...(this.top.page.actions ?? [])]) {
      if (RESERVED.has(action.key) || seen.has(action.key)) continue;
      seen.add(action.key);
      out.push(action);
    }
    return out;
  }

  private resetSelection(frame: Frame): void {
    frame.selected = 0;
    frame.top = 0;
  }

  private stepOrScroll(delta: number): void {
    const view = this.currentView();
    if (view?.kind === "list") this.move(delta);
    else this.scrollDocument(delta);
  }

  private move(delta: number): void {
    const view = this.currentView();
    if (view?.kind !== "list") return;
    const frame = this.top;
    const total = this.filtered(view.items, frame.filter).length;
    if (total === 0) return;
    if (Math.abs(delta) === 1) frame.selected = (frame.selected + delta + total) % total;
    else frame.selected = Math.max(0, Math.min(total - 1, frame.selected + delta));
  }

  private scrollDocument(delta: number): void {
    const frame = this.top;
    const total = this.docCache?.frame === frame ? this.docCache.lines.length : Number.MAX_SAFE_INTEGER;
    frame.scroll = Math.max(0, Math.min(Math.max(0, total - this.bodyRows), frame.scroll + delta));
  }

  private switchView(delta: number): void {
    const frame = this.top;
    const count = frame.page.views.length;
    if (count < 2) return;
    frame.view = (frame.view + delta + count) % count;
    frame.selected = 0;
    frame.top = 0;
    frame.scroll = 0;
    this.status = undefined;
  }

  private handleFilterInput(data: string, key: (name: PanelKey) => boolean): void {
    const frame = this.top;
    if (key("escape")) {
      frame.filter = "";
      this.typing = false;
      this.resetSelection(frame);
      return;
    }
    if (key("enter") || key("down") || key("tab")) {
      this.typing = false;
      return;
    }
    if (key("up")) {
      this.typing = false;
      this.move(-1);
      return;
    }
    if (key("backspace")) {
      if (frame.filter === "") this.typing = false;
      else frame.filter = [...frame.filter].slice(0, -1).join("");
      this.resetSelection(frame);
      return;
    }
    const text = (this.options.printable ?? defaultPrintable)(data);
    if (text === undefined) return;
    frame.filter = `${frame.filter}${text.replace(/[\x00-\x1f\x7f]/g, "")}`.slice(0, 200);
    this.resetSelection(frame);
  }

  private async activate(): Promise<void> {
    const view = this.currentView();
    if (view?.kind !== "list") return;
    const item = this.selectedItem();
    if (item === undefined) return;
    if (item.open !== undefined) {
      const open = item.open.bind(item);
      await this.working(`opening ${sanitizeInline(item.label, 60)}`, async () => {
        const page = await open();
        this.push(page);
      });
      return;
    }
    const primary = this.actions().find((action) => action.primary === true);
    if (primary !== undefined) await this.runAction(primary);
  }

  private push(page: PanelPage): void {
    this.stack.push(this.frame(page));
    this.typing = false;
    this.status = undefined;
  }

  private pop(): void {
    if (this.stack.length <= 1) return;
    this.stack.pop();
    this.typing = false;
    this.status = undefined;
    const frame = this.top;
    if (frame.stale) void this.reload(frame);
  }

  private async runAction(action: PanelAction): Promise<void> {
    let input: string | undefined;
    if (action.input !== undefined) {
      input = await this.options.ask(action.input.prompt).catch(() => undefined);
      if (input === undefined || input.trim() === "") {
        this.options.requestRender();
        return;
      }
      input = input.trim();
    }
    if (action.confirm !== undefined && !(await this.options.confirm(action.confirm).catch(() => false))) {
      this.options.requestRender();
      return;
    }
    const outcome: { value?: PanelActionResult } = {};
    await this.working(action.label, async () => {
      const value = await action.run(input);
      if (value !== undefined) outcome.value = value;
    });
    if (outcome.value !== undefined) await this.apply(outcome.value);
    this.options.requestRender();
  }

  /** Runs `task` with the busy line shown; a failure becomes the status line. */
  private async working(label: string, task: () => Promise<void>): Promise<void> {
    this.busy = label;
    this.status = undefined;
    this.options.requestRender();
    try {
      await task();
    } catch (error) {
      this.status = { text: errorText(error), level: "error" };
    } finally {
      this.busy = undefined;
      this.options.requestRender();
    }
  }

  private async apply(result: PanelActionResult): Promise<void> {
    if (result.message !== undefined) this.status = { text: result.message, level: result.level ?? "info" };
    if (result.close === true || result.editorText !== undefined || result.command !== undefined) {
      this.close(result);
      return;
    }
    if (result.back === true) {
      for (const frame of this.stack) frame.stale = true;
      const message = this.status;
      this.pop();
      this.status = message;
    } else if (result.refresh === true) {
      for (const frame of this.stack) frame.stale = true;
      await this.reload(this.top);
    }
    if (result.push !== undefined) this.push(result.push);
  }

  /** Re-reads a page, keeping its tab, the selected item (by id) and the scroll position. */
  private async reload(frame: Frame): Promise<void> {
    frame.stale = false;
    const reload = frame.page.reload;
    if (reload === undefined) return;
    const previousView = frame.page.views[frame.view];
    const previousId = previousView?.kind === "list" ? this.filtered(previousView.items, frame.filter)[frame.selected]?.id : undefined;
    const status = this.status;
    await this.working("refreshing", async () => {
      const page = await reload.call(frame.page);
      frame.page = page;
      frame.view = Math.max(0, Math.min(frame.view, page.views.length - 1));
      const view = page.views[frame.view];
      if (view?.kind === "list" && previousId !== undefined) {
        const index = this.filtered(view.items, frame.filter).findIndex((item) => item.id === previousId);
        if (index >= 0) frame.selected = index;
      }
    });
    if (this.status === undefined) this.status = status;
    this.docCache = undefined;
  }
}
