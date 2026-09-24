import type { ContextView, MemoryGraphView, MemoryLedgerView, MemoryNoteView, MemoryProposalView, OrchestrationTaskView, OrchestrationView } from "../../contracts/views.ts";
import type { TaskState } from "../../contracts/state.ts";
import { paint } from "./board.ts";
import { renderGraph } from "./graph.ts";
import { clean, displayWidth, finish, formatTokens, padEnd, padStart, truncate, wrap, type ViewContext } from "./kit.ts";

/**
 * K2 trust cards: "Why this context?" (`/context`, UX-07), the memory ledger (`/memory`, UX-08),
 * one decision-desk proposal (`/memory review`) and the memory graph (`/memory graph`). Compact,
 * readable without colour, no internal event ids (memory ids are user-facing note names).
 */

export function renderContext(view: ContextView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const sep = ` ${g.base.sep} `;
  const window = view.windowTokens === undefined ? "" : ` of ${formatTokens(view.windowTokens)}`;
  const head = [`${g.base.bullet} Why this context?`, ...(view.model === undefined ? [] : [clean(view.model, 60)]), `~${formatTokens(view.totalTokens)} tokens${window}`].join(sep);
  const lines = [t.accent(truncate(head, ctx.width))];
  const tokenWidth = 7;
  for (const group of view.groups) {
    if (group.items.length === 0) continue;
    const total = group.items.reduce((sum, item) => sum + item.tokens, 0);
    lines.push(`  ${t.bold(clean(group.title, 40))} ${t.muted(`~${formatTokens(total)}`)}`);
    for (const item of group.items) {
      const flags = [item.trust === "untrusted" ? "data" : "", item.truncated === true ? "truncated" : "", item.stale === true ? "STALE" : ""].filter((flag) => flag !== "");
      const right = `${flags.length === 0 ? "" : `${flags.join(", ")} `}${padStart(`~${formatTokens(item.tokens)}`, tokenWidth)}`;
      const available = Math.max(12, ctx.width - 4 - displayWidth(right) - 1);
      const label = truncate(clean(item.label, 80), Math.min(available, Math.max(12, Math.floor(available * 0.55))));
      const room = available - displayWidth(label) - 2;
      const detail = item.detail === undefined || room < 8 ? "" : truncate(clean(item.detail, 200), room);
      const gap = Math.max(1, ctx.width - 4 - displayWidth(label) - (detail === "" ? 0 : displayWidth(detail) + 2) - displayWidth(right));
      lines.push(`    ${label}${detail === "" ? "" : `  ${t.muted(detail)}`}${" ".repeat(gap)}${item.stale === true ? t.warning(right) : t.muted(right)}`);
    }
  }
  for (const note of view.notes ?? []) lines.push(t.muted(`  ${clean(note, 200)}`));
  return finish(lines, ctx);
}

export function renderMemoryLedger(view: MemoryLedgerView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const lines = [t.accent(truncate(`${g.base.bullet} Memory ledger ${g.base.sep} ${clean(view.summary, 120)}`, ctx.width))];
  lines.push(t.muted(`  vault ${truncate(clean(view.vault, 200), ctx.width - 10)}`));
  const idWidth = Math.min(28, Math.max(8, ...view.sections.flatMap((section) => section.entries.map((entry) => displayWidth(clean(entry.id, 40))))));
  for (const section of view.sections) {
    if (section.entries.length === 0) continue;
    lines.push(`  ${t.bold(clean(section.title, 40))} ${t.muted(`(${section.entries.length})`)}`);
    for (const entry of section.entries) {
      const tail = [entry.decider, entry.scope === "project" ? undefined : entry.scope].filter((part): part is string => part !== undefined && part !== "").map((part) => clean(part, 40)).join(", ");
      const title = truncate(clean(entry.title, 160), Math.max(10, ctx.width - idWidth - displayWidth(tail) - 12));
      lines.push(`    ${entry.stale === true ? t.warning(g.base.warn) : t.muted(g.base.bullet)} ${t.muted(padEnd(clean(entry.id, 40), idWidth))} ${title}${tail === "" ? "" : `  ${t.muted(tail)}`}${entry.stale === true ? ` ${t.warning("STALE")}` : ""}`);
    }
  }
  if (view.contradictions.length > 0) {
    lines.push(`  ${t.warning(`${g.base.warn} Possible contradictions`)} ${t.muted(`(${view.contradictions.length}, unreviewed)`)}`);
    for (const line of view.contradictions.slice(0, 6)) lines.push(`    ${truncate(clean(line, 240), ctx.width - 6)}`);
  }
  if (view.sections.every((section) => section.entries.length === 0) && view.contradictions.length === 0) lines.push(t.muted("  nothing remembered for this project yet"));
  if (view.pending > 0) lines.push(`  ${t.accent(`${view.pending} proposal${view.pending === 1 ? "" : "s"} waiting`)} ${t.muted("/memory review")}`);
  for (const hint of view.hints) lines.push(t.muted(`  ${clean(hint, 200)}`));
  return finish(lines, ctx);
}

export function renderMemoryProposal(view: MemoryProposalView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const box = g.box;
  const width = Math.min(ctx.width, 84);
  const inner = width - 4;
  const title = truncate(`Memory proposal ${view.position}/${view.total} ${g.base.sep} ${clean(view.noteKind, 20)}${view.deferred === true ? " (deferred)" : ""}`, inner - 4);
  const lines = [t.accent(`${box.tl}${box.h} ${title} ${box.h.repeat(Math.max(0, width - 5 - displayWidth(title)))}${box.tr}`)];
  const row = (label: string, text: string, tone: "text" | "muted" | "warning" = "text"): void => {
    wrap(text, inner - 9).forEach((part, index) => {
      const body = padEnd(part, inner - 9);
      lines.push(`${t.accent(box.v)} ${t.muted(padEnd(index === 0 ? label : "", 8))} ${paint(t, tone, body)} ${t.accent(box.v)}`);
    });
  };
  row("Note", clean(view.title, 300));
  if (view.body !== undefined && view.body.trim() !== "") row("", clean(view.body, 600), "muted");
  row("Why", clean(view.rationale, 400));
  row("Source", clean(view.source, 300), "muted");
  if (view.scope !== undefined) row("Scope", clean(view.scope, 120), "muted");
  if (view.conflicts.length === 0) row("Conflict", "none found in the vault", "muted");
  for (const [index, conflict] of view.conflicts.entries()) row(index === 0 ? "Conflict" : "", clean(conflict, 300), "warning");
  lines.push(t.accent(`${box.bl}${box.h.repeat(width - 2)}${box.br}`));
  return finish(lines, ctx);
}

const KIND_TAG: Readonly<Record<string, string>> = { decision: "dec", assumption: "asm", question: "que", evidence: "evd", concept: "cpt", preference: "prf", project: "prj" };

function nodeState(node: MemoryGraphView["nodes"][number]): TaskState {
  if (node.contradicted === true) return "changes_requested";
  if (node.stale === true || ["superseded", "rejected", "invalidated", "revoked", "deprecated", "archived", "stale", "unavailable"].includes(node.status)) return "cancelled";
  if (["open", "proposed"].includes(node.status)) return "ready";
  return "completed";
}

/**
 * The memory graph reuses the plan-graph layout (layered boxes, routed edges, stacked fallback when
 * it does not fit): a note is a box `id` / `kind · status`, an edge points from a note to what it
 * relates to. Typed edges and contradictions are listed under the graph.
 */
/** The memory graph as a plan view: the layout and the K1.7 selection model (`moveSelection`) reuse it. */
export function memoryGraphPlan(view: MemoryGraphView, sep = "·"): OrchestrationView {
  const byTarget = new Map<string, string[]>();
  for (const edge of view.edges) byTarget.set(edge.from, [...(byTarget.get(edge.from) ?? []), edge.to]);
  const tasks: OrchestrationTaskView[] = view.nodes.map((node) => ({
    key: node.id,
    role: `${KIND_TAG[node.kind] ?? node.kind} ${sep} ${node.status}${node.focus === true ? " (focus)" : ""}`,
    state: nodeState(node),
    // Edges run from what a note relates to (above) into the note (below).
    dependsOn: byTarget.get(node.id) ?? [],
  }));
  return { kind: "orchestration", tasks, done: true };
}

export interface MemoryGraphOptions {
  /** The selected note (interactive graph). */
  readonly selected?: string | undefined;
  /** Replaces the header hint on the right. */
  readonly hint?: string | undefined;
}

export function renderMemoryGraph(view: MemoryGraphView, ctx: ViewContext, options: MemoryGraphOptions = {}): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const header = [`${g.base.bullet} Memory graph`, `${view.nodes.length} note${view.nodes.length === 1 ? "" : "s"}`, `${view.edges.length} link${view.edges.length === 1 ? "" : "s"}`];
  const lines =
    view.nodes.length === 0
      ? [t.accent(header.join(` ${g.base.sep} `)), t.muted("  no notes in this scope yet")]
      : renderGraph(memoryGraphPlan(view, g.base.sep), ctx, { header, bare: true, selected: options.selected, hint: options.hint });
  lines.push(t.muted(`  ${truncate(clean(view.scope, 200), ctx.width - 4)}${view.hidden === undefined ? "" : ` ${g.base.sep} ${view.hidden} more not shown`}`));
  const typed = view.edges.filter((edge) => edge.type !== "link");
  const titles = new Map(view.nodes.map((node) => [node.id, node.title]));
  for (const edge of typed.slice(0, 12)) {
    const text = `  ${clean(edge.from, 40)} ${edge.type.replaceAll("_", " ")} ${clean(edge.to, 40)}  ${clean(titles.get(edge.to), 60)}`;
    lines.push(edge.type === "contradicts" ? t.warning(truncate(text, ctx.width)) : t.muted(truncate(text, ctx.width)));
  }
  if (typed.length > 12) lines.push(t.muted(`  … ${typed.length - 12} more relations`));
  const contradicted = view.nodes.filter((node) => node.contradicted === true).length;
  if (contradicted > 0) lines.push(t.warning(`  ${g.base.warn} ${contradicted} note${contradicted === 1 ? "" : "s"} in a possible contradiction (marked as changes requested)`));
  for (const hint of view.hints ?? []) lines.push(t.muted(`  ${clean(hint, 200)}`));
  return finish(lines, ctx);
}

/** A note opened from the interactive memory graph: head, frontmatter, relations, body and path. */
export function renderMemoryNote(view: MemoryNoteView, ctx: ViewContext, hint?: string): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const sep = ` ${g.base.sep} `;
  const lines = [t.accent(truncate(`${g.base.bullet} ${clean(view.id, 60)}${sep}${clean(view.noteKind, 20)} ${clean(view.status, 20)}`, ctx.width))];
  if (hint !== undefined) lines.push(t.muted(`  ${truncate(hint, ctx.width - 2)}`));
  lines.push(`  ${t.bold(truncate(clean(view.title, 200), ctx.width - 2))}`);
  const labelWidth = Math.min(12, Math.max(4, ...view.frontmatter.map(([label]) => displayWidth(label))));
  for (const [label, value] of view.frontmatter) lines.push(`  ${t.muted(padEnd(clean(label, 20), labelWidth))} ${truncate(clean(value, 200), Math.max(8, ctx.width - labelWidth - 3))}`);
  if (view.relations.length > 0) {
    lines.push(`  ${t.bold("Relations")}`);
    for (const relation of view.relations.slice(0, 16)) {
      const type = relation.type.replaceAll("_", " ");
      const edge = relation.direction === "out" ? `${type} ${clean(relation.id, 40)}` : `${clean(relation.id, 40)} ${type} this`;
      const text = `    ${g.base.bullet} ${edge}${relation.title === undefined ? "" : `  ${clean(relation.title, 80)}`}`;
      lines.push(relation.type === "contradicts" ? t.warning(truncate(text, ctx.width)) : truncate(text, ctx.width));
    }
    if (view.relations.length > 16) lines.push(t.muted(`    … ${view.relations.length - 16} more`));
  }
  const body = view.body.split(/\r?\n/);
  if (view.body.trim() !== "") {
    lines.push("");
    for (const line of body.slice(0, 40)) for (const part of wrap(clean(line, 2000), ctx.width - 4)) lines.push(`  ${part}`);
    if (body.length > 40) lines.push(t.muted(`  … ${body.length - 40} more lines`));
  }
  lines.push(t.muted(`  ${truncate(clean(view.path, 400), ctx.width - 2)}`));
  return finish(lines, ctx);
}
