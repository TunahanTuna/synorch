/**
 * Opt-in mouse support for the main-screen TUI (SGR 1006 reporting). While it is on the terminal
 * sends wheel and click events instead of scrolling its own scrollback and selecting text, so the
 * transcript is drawn through `TranscriptViewport`: the frame fills the screen exactly, the wheel
 * moves a window over the transcript and a click maps back to the transcript row that was hit.
 * Off by default (`/mouse`, `SYN_MOUSE=1`); most terminals still select natively with Shift held.
 */

/** Button-event tracking + SGR extended coordinates (no any-motion: less traffic over SSH/ConPTY). */
export const MOUSE_ENABLE_SEQUENCE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_DISABLE_SEQUENCE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export interface MouseInput {
  readonly type: "press" | "release" | "drag" | "wheel";
  readonly button: "left" | "middle" | "right" | "none";
  /** 1-based terminal cell. */
  readonly x: number;
  readonly y: number;
  /** Wheel only: -1 up (away from the user), +1 down. */
  readonly wheel?: -1 | 1;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseSgrMouse(data: string): MouseInput | undefined {
  const match = SGR_MOUSE.exec(data);
  if (match === null) return undefined;
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const release = match[4] === "m";
  const modifiers = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 };
  if ((code & 64) !== 0) {
    const low = code & 3;
    if (low > 1) return undefined; // horizontal wheel
    return { type: "wheel", button: "none", x, y, wheel: low === 0 ? -1 : 1, ...modifiers };
  }
  const low = code & 3;
  const button = low === 0 ? "left" : low === 1 ? "middle" : low === 2 ? "right" : "none";
  const type = release ? "release" : (code & 32) !== 0 ? "drag" : "press";
  return { type, button, x, y, ...modifiers };
}

/** Any mouse report (SGR or legacy X10), so stray reports never reach the editor as text. */
export function isMouseSequence(data: string): boolean {
  return SGR_MOUSE.test(data) || (data.startsWith("\x1b[M") && data.length === 6);
}

/** The pi-tui `Component` shape, restated so this module stays pi-tui free (ADR-04). */
export interface ViewComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface ViewContainer extends ViewComponent {
  readonly children: readonly ViewComponent[];
}

interface Range {
  readonly child: ViewComponent;
  readonly start: number;
  readonly end: number;
}

export interface TranscriptViewportOptions {
  /** The components drawn with this one, in order (the TUI's children). */
  readonly siblings: () => readonly ViewComponent[];
  readonly rows: () => number;
  /** Paints the "more above" line and fits it into `width` columns. */
  readonly hint: (text: string, width: number) => string;
  readonly up: string;
}

export class TranscriptViewport implements ViewComponent {
  public enabled = false;
  private readonly inner: ViewContainer;
  private readonly options: TranscriptViewportOptions;
  private offset = 0;
  private lastTotal = 0;
  private ranges: Range[] = [];
  private frameTop = 0;
  private padTop = 0;
  private windowStart = 0;
  private shown = 0;
  private visibleRows = 10;

  public constructor(inner: ViewContainer, options: TranscriptViewportOptions) {
    this.inner = inner;
    this.options = options;
  }

  public get scrollOffset(): number {
    return this.offset;
  }

  public invalidate(): void {
    this.inner.invalidate();
  }

  /** Positive scrolls back (older lines), negative forward; returns true when the window moved. */
  public scroll(lines: number): boolean {
    const before = this.offset;
    this.offset = Math.max(0, Math.min(Math.max(0, this.lastTotal - this.visibleRows + 1), this.offset + lines));
    return this.offset !== before;
  }

  public page(direction: -1 | 1): boolean {
    return this.scroll(-direction * Math.max(1, this.visibleRows - 2));
  }

  public toBottom(): void {
    this.offset = 0;
  }

  public render(width: number): string[] {
    if (!this.enabled) return this.inner.render(width);
    const siblings = this.options.siblings();
    const me = siblings.indexOf(this);
    let above = 0;
    let below = 0;
    siblings.forEach((component, index) => {
      if (index === me) return;
      const height = component.render(width).length;
      if (index < me) above += height;
      else below += height;
    });
    const available = Math.max(3, this.options.rows() - above - below);
    const lines: string[] = [];
    const ranges: Range[] = [];
    for (const child of this.inner.children) {
      const rendered = child.render(width);
      ranges.push({ child, start: lines.length, end: lines.length + rendered.length });
      lines.push(...rendered);
    }
    const total = lines.length;
    // Keep the reader's place while new output arrives below.
    if (this.offset > 0 && total > this.lastTotal) this.offset += total - this.lastTotal;
    this.lastTotal = total;
    this.visibleRows = available;
    const scrolled = total > available && this.offset > 0;
    const capacity = scrolled ? available - 1 : available;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - capacity)));
    const end = total - this.offset;
    const start = Math.max(0, end - capacity);
    const window = lines.slice(start, end);
    const out: string[] = [];
    if (this.offset > 0) out.push(this.options.hint(`${this.options.up} ${start} more line(s) above · wheel scrolls · Enter or Ctrl+End jumps to the latest`, width));
    const indicatorRows = out.length;
    const pad = Math.max(0, available - indicatorRows - window.length);
    for (let index = 0; index < pad; index += 1) out.push("");
    out.push(...window);
    this.ranges = ranges;
    this.frameTop = above;
    this.padTop = indicatorRows + pad;
    this.windowStart = start;
    this.shown = window.length;
    return out;
  }

  /** The transcript child drawn at a 1-based screen row, if any. */
  public hit(screenRow: number): ViewComponent | undefined {
    if (!this.enabled) return undefined;
    const row = screenRow - 1 - this.frameTop - this.padTop;
    if (row < 0 || row >= this.shown) return undefined;
    const index = this.windowStart + row;
    return this.ranges.find((range) => index >= range.start && index < range.end)?.child;
  }
}
