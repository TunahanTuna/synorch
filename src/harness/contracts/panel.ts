import type { HarnessView } from "./views.ts";

/**
 * Layered panels (interactive renderer only): report-style commands (`/skills`, `/plugins`,
 * `/mcp`, `/status`, `/config`…) describe what they show as pages of data, and the renderer draws
 * them as a navigable overlay with a breadcrumb, tabs, lists, scrollable detail pages and per-item
 * actions. Pages are plain data plus callbacks: no painting, no terminal knowledge. Plain and JSONL
 * modes keep their text output; they never see a panel.
 *
 * Navigation is a stack: Enter on an item pushes the page its `open` returns, Esc / ← pops it.
 */

/** Semantic colour of a badge or a field value; the renderer maps it to theme tokens. */
export type PanelTone = "success" | "muted" | "warning" | "error" | "accent" | "info";

/** A short status chip (`on`, `off`, `needs trust`, `needs sign-in`, `shadowed`). */
export interface PanelBadge {
  readonly label: string;
  readonly tone: PanelTone;
}

export interface PanelField {
  readonly label: string;
  readonly value: string;
  readonly tone?: PanelTone;
}

/** One block of a document view. Every string is untrusted and sanitized by the renderer. */
export type PanelBlock =
  | { readonly kind: "fields"; readonly rows: readonly PanelField[] }
  /** Rendered with the transcript's markdown renderer, wrapped to the panel width. */
  | { readonly kind: "markdown"; readonly text: string }
  /** Word-wrapped paragraphs; newlines are kept. */
  | { readonly kind: "text"; readonly text: string; readonly tone?: PanelTone }
  /** Preformatted (JSON, a file): kept verbatim, long lines are cut, not wrapped. */
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "heading"; readonly text: string }
  /** A harness card (usage, context, diff…) drawn as the transcript draws it. */
  | { readonly kind: "view"; readonly view: HarnessView };

/** What an action asks for before it runs. */
export interface PanelActionInput {
  readonly prompt: string;
}

/** What happened: the renderer shows `message` in the panel's status line and follows the flags. */
export interface PanelActionResult {
  readonly message?: string;
  readonly level?: "info" | "success" | "warning" | "error";
  /** Re-read the current page (`page.reload`) and mark the pages below it stale. */
  readonly refresh?: boolean;
  /** Pop the current page (after a remove). */
  readonly back?: boolean;
  /** Close the whole panel. */
  readonly close?: boolean;
  /** Close the panel and put this text into the editor (invoke a skill: `/name `). */
  readonly editorText?: string;
  /** Close the panel and run this slash command as if typed (`/memory review`). */
  readonly command?: string;
  /** Push a page (an action that opens something). */
  readonly push?: PanelPage;
}

export interface PanelAction {
  /** One printable key (`e`, `d`, `o`). `j`, `k`, `q` and `/` are the panel's own. */
  readonly key: string;
  /** Shown in the footer: `e enable`. */
  readonly label: string;
  /** Ask a line of text first (install <spec>); Esc skips the action. */
  readonly input?: PanelActionInput;
  /** A yes/no question first (remove). */
  readonly confirm?: string;
  /** Enter runs this action on a list item that has no `open` page. */
  readonly primary?: boolean;
  run(input: string | undefined): Promise<PanelActionResult | void> | PanelActionResult | void;
}

export interface PanelItem {
  /** Stable across reloads: the selection follows it. */
  readonly id: string;
  readonly label: string;
  /** One dim line after the label. */
  readonly description?: string;
  /** A short column before the description (source, transport, size). */
  readonly meta?: string;
  readonly badges?: readonly PanelBadge[];
  /** Extra text the `/` filter matches besides label, meta and description. */
  readonly search?: string;
  /** Enter (or →) pushes this page. */
  open?(): Promise<PanelPage> | PanelPage;
  readonly actions?: readonly PanelAction[];
}

export interface PanelListView {
  readonly kind: "list";
  /** The tab label; the renderer appends the item count. */
  readonly label: string;
  readonly items: readonly PanelItem[];
  /** Shown when there are no items. */
  readonly empty?: string;
}

export interface PanelDocumentView {
  readonly kind: "document";
  readonly label: string;
  readonly blocks: readonly PanelBlock[];
}

export type PanelView = PanelListView | PanelDocumentView;

export interface PanelPage {
  readonly title: string;
  /** The breadcrumb segment (defaults to the title). */
  readonly crumb?: string;
  /** One dim line under the title bar. */
  readonly subtitle?: string;
  /** Two or more views show as tabs (Tab / Shift+Tab). */
  readonly views: readonly PanelView[];
  readonly initialView?: number;
  /** Page-wide actions (install, refresh), available on every item of the page. */
  readonly actions?: readonly PanelAction[];
  /** Re-reads the page after an action changed state; the panel keeps the tab and the selection. */
  reload?(): Promise<PanelPage> | PanelPage;
}

/** A page with one document view. */
export function documentPage(title: string, blocks: readonly PanelBlock[], extra: Partial<Omit<PanelPage, "views" | "title">> = {}): PanelPage {
  return { title, ...extra, views: [{ kind: "document", label: title, blocks }] };
}

/**
 * List tabs grouped by a key: `All` first, then one tab per group that has items, in `order`.
 *
 * @example groupedViews(items, (item) => item.source, [["project", "Project"], ["user", "User"]])
 */
export function groupedViews<T>(entries: readonly T[], toItem: (entry: T) => PanelItem, groupOf: (entry: T) => string, order: readonly (readonly [string, string])[], options: { readonly all?: string; readonly empty?: string } = {}): PanelListView[] {
  const views: PanelListView[] = [{ kind: "list", label: options.all ?? "All", items: entries.map(toItem), ...(options.empty === undefined ? {} : { empty: options.empty }) }];
  for (const [group, label] of order) {
    const members = entries.filter((entry) => groupOf(entry) === group);
    if (members.length > 0) views.push({ kind: "list", label, items: members.map(toItem) });
  }
  return views;
}
