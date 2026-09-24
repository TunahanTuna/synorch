import type { HarnessView, OrchestrationView, WorkerDelegationView } from "../../contracts/views.ts";
import type { GlyphSet } from "../conversation-view.ts";
import type { Styler } from "../style.ts";
import { boardHint, PlainBoardTracker, renderBoardSummary, renderLiveBoard, selectionHint } from "./board.ts";
import { renderAction, renderEvidence, renderWhy } from "./cards.ts";
import { renderDiff } from "./diff.ts";
import { renderGraph } from "./graph.ts";
import { createViewTheme, viewGlyphs, type ViewContext, type ViewGlyphs, type ViewTheme } from "./kit.ts";
import { renderUsage } from "./usage.ts";
import { renderDelegation, renderUserToWorker, renderWorkerSnapshot } from "./worker.ts";

/**
 * Mountable views. The components satisfy pi-tui's `Component` shape structurally
 * (`render(width)`, `invalidate()`), so this module never imports pi-tui (ADR-04: only the adapter
 * does); `PlainViews` gives the plain renderer the same views as append-only text.
 */

export interface ViewComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface ViewStyleOptions {
  readonly glyphs: GlyphSet;
  readonly color: boolean | Styler;
  readonly now?: (() => number) | undefined;
}

/** Pure dispatcher over every card view. */
export function renderView(view: HarnessView, ctx: ViewContext): string[] {
  switch (view.kind) {
    case "orchestration":
      return view.done ? renderBoardSummary(view, ctx) : renderLiveBoard(view, ctx);
    case "usage":
      return renderUsage(view, ctx);
    case "evidence":
      return renderEvidence(view, ctx);
    case "action":
      return renderAction(view, ctx);
    case "why":
      return renderWhy(view, ctx);
    case "delegation":
      return renderDelegation(view, ctx);
    case "worker":
      return renderWorkerSnapshot(view, ctx);
    case "diff":
      return renderDiff(view, ctx);
  }
}

class Styled {
  protected readonly glyphs: ViewGlyphs;
  protected readonly theme: ViewTheme;
  protected readonly now: () => number;

  public constructor(options: ViewStyleOptions) {
    this.glyphs = viewGlyphs(options.glyphs);
    this.theme = createViewTheme(options.color);
    this.now = options.now ?? (() => Date.now());
  }

  protected context(width: number, now: number, frame = 0): ViewContext {
    return { glyphs: this.glyphs, theme: this.theme, width: Math.max(20, width), now, frame };
  }
}

/** A card pinned once to the transcript: its clock is frozen when it is created. */
export class StaticViewComponent extends Styled implements ViewComponent {
  private readonly draw: (ctx: ViewContext) => string[];
  private readonly frozenAt: number;
  private cache: { readonly width: number; readonly lines: string[] } | undefined;

  public constructor(content: HarnessView | { readonly kind: "graph"; readonly view: OrchestrationView }, options: ViewStyleOptions) {
    super(options);
    this.frozenAt = this.now();
    this.draw = content.kind === "graph" ? (ctx) => renderGraph(content.view, ctx) : (ctx) => renderView(content, ctx);
  }

  public invalidate(): void {
    this.cache = undefined;
  }

  public render(width: number): string[] {
    if (this.cache?.width !== width) this.cache = { width, lines: this.draw(this.context(width, this.frozenAt)) };
    return this.cache.lines;
  }
}

/** Main chat delegation line (K1.7): one line, the assignment when expanded (Ctrl+O or a click). */
export class DelegationComponent extends Styled implements ViewComponent {
  private readonly view: WorkerDelegationView;
  private readonly expanded: () => boolean;

  public constructor(view: WorkerDelegationView, options: ViewStyleOptions, expanded: () => boolean) {
    super(options);
    this.view = view;
    this.expanded = expanded;
  }

  public get taskKey(): string {
    return this.view.taskKey;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    return renderDelegation(this.view, this.context(width, this.now()), this.expanded());
  }
}

/** Main chat: `↳ you → key: message` after the user messaged a worker. */
export class UserToWorkerComponent extends Styled implements ViewComponent {
  private readonly taskKey: string;
  private readonly text: string;

  public constructor(taskKey: string, text: string, options: ViewStyleOptions) {
    super(options);
    this.taskKey = taskKey;
    this.text = text;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    return renderUserToWorker(this.taskKey, this.text, this.context(width, this.now()));
  }
}

/** The live board, updated in place; `g` toggles it with the graph of the same plan. */
export class LiveBoardComponent extends Styled implements ViewComponent {
  private view: OrchestrationView;
  private shownMode: "board" | "graph" = "board";
  /** K1.7: the selected task key, and whether the selection keys are live (vs. only marking the open worker). */
  public selected: string | undefined;
  public selecting = false;
  /** Replaces the header hint (the worker view shows its own keys). */
  public hint: string | undefined;

  public constructor(view: OrchestrationView, options: ViewStyleOptions) {
    super(options);
    this.view = view;
  }

  public get mode(): "board" | "graph" {
    return this.shownMode;
  }

  public get current(): OrchestrationView {
    return this.view;
  }

  public setView(view: OrchestrationView): void {
    this.view = view;
  }

  public toggleMode(): "board" | "graph" {
    this.shownMode = this.shownMode === "board" ? "graph" : "board";
    return this.shownMode;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const now = this.now();
    const ctx = this.context(width, now, Math.floor(now / this.glyphs.base.spinnerMs));
    const hint = this.hint ?? (this.selecting ? selectionHint(ctx, this.shownMode) : boardHint(ctx, this.shownMode));
    const selected = this.selected;
    return this.shownMode === "graph" ? renderGraph(this.view, ctx, { fromBoard: true, selected, hint }) : renderLiveBoard(this.view, ctx, { selected, hint });
  }
}

/** Plain-mode equivalents: cards as text blocks, the board as change lines (TUI experience §12). */
export class PlainViews extends Styled {
  private readonly width: number;
  private tracker = new PlainBoardTracker();

  public constructor(options: ViewStyleOptions & { readonly width?: number | undefined }) {
    super(options);
    this.width = options.width ?? 80;
  }

  public view(view: HarnessView): string[] {
    return renderView(view, this.context(this.width, this.now()));
  }

  public graph(view: OrchestrationView): string[] {
    return renderGraph(view, this.context(this.width, this.now()));
  }

  /** Lines to append for a board update; `undefined` forgets the board (a new run starts fresh). */
  public board(view: OrchestrationView | undefined): string[] {
    if (view === undefined) {
      this.tracker = new PlainBoardTracker();
      return [];
    }
    return this.tracker.update(view, this.context(this.width, this.now()));
  }
}
