import type { MemoryKind } from "../contracts/index.ts";
import type { MemoryGraphEdgeView, MemoryGraphNodeView, MemoryGraphView } from "../contracts/views.ts";
import type { MarkdownMemoryStore } from "./markdown-memory-store.ts";
import type { IndexedNote } from "./memory-index.ts";
import { findCandidates, INACTIVE_STATUSES } from "./relations.ts";

/**
 * `/memory graph` and `syn memory graph` (owner request, K2): the vault as a web of notes, like
 * Obsidian's graph view but in the terminal. Nodes are the notes in scope (project, branch, user);
 * edges are the typed relations plus local Markdown links. `--around <id> --depth n` keeps the
 * neighbourhood of one note; the size cap keeps the terminal layout readable.
 */

export interface MemoryGraphFilter {
  readonly projectId: string;
  readonly branch: string | undefined;
  readonly kinds?: readonly MemoryKind[] | undefined;
  readonly around?: string | undefined;
  readonly depth?: number | undefined;
  /** Include superseded, rejected, revoked… notes. */
  readonly all?: boolean | undefined;
  readonly limit?: number | undefined;
}

export const MEMORY_GRAPH_LIMIT = 40;

export function buildMemoryGraph(notes: readonly IndexedNote[], filter: MemoryGraphFilter): MemoryGraphView {
  const inScope = notes.filter((note) => {
    if (note.project_id !== filter.projectId && note.scope !== "user") return false;
    if (note.scope === "branch" && note.branch !== filter.branch) return false;
    if (filter.all !== true && INACTIVE_STATUSES.includes(note.status)) return false;
    return true;
  });
  const byPath = new Map(inScope.map((note) => [note.path.toLowerCase(), note]));
  const byId = new Map(inScope.map((note) => [note.id, note]));
  const edges: MemoryGraphEdgeView[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, type: string): void => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const key = `${from}>${to}>${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, type });
  };
  for (const note of inScope) {
    for (const relation of note.relations) addEdge(note.id, relation.target, relation.type);
    for (const link of note.links) {
      const target = byPath.get(link.toLowerCase());
      if (target !== undefined && !note.relations.some((relation) => relation.target === target.id)) addEdge(note.id, target.id, "link");
    }
  }
  const contradicted = new Set<string>();
  for (const edge of edges) if (edge.type === "contradicts") contradicted.add(edge.from).add(edge.to);
  for (const candidate of findCandidates(inScope)) if (candidate.kind === "contradiction") contradicted.add(candidate.source).add(candidate.target);

  let chosen = inScope.filter((note) => filter.kinds === undefined || filter.kinds.length === 0 || filter.kinds.includes(note.kind));
  const scope = [`project ${filter.projectId}`, ...(filter.branch === undefined ? [] : [`branch ${filter.branch}`])];
  if (filter.around !== undefined) {
    const depth = Math.max(1, Math.min(6, filter.depth ?? 2));
    const neighbours = new Map<string, Set<string>>();
    for (const edge of edges) {
      neighbours.set(edge.from, (neighbours.get(edge.from) ?? new Set()).add(edge.to));
      neighbours.set(edge.to, (neighbours.get(edge.to) ?? new Set()).add(edge.from));
    }
    const reached = new Set([filter.around]);
    let frontier = [filter.around];
    for (let step = 0; step < depth; step += 1) {
      const next: string[] = [];
      for (const id of frontier) for (const other of neighbours.get(id) ?? []) if (!reached.has(other)) (reached.add(other), next.push(other));
      frontier = next;
    }
    chosen = chosen.filter((note) => reached.has(note.id) || note.id === filter.around);
    scope.push(`around ${filter.around} (depth ${depth})`);
  }
  // Connected notes first: they are what a graph shows best.
  const degree = (id: string): number => edges.filter((edge) => edge.from === id || edge.to === id).length;
  chosen = [...chosen].sort((left, right) => degree(right.id) - degree(left.id) || (left.id < right.id ? -1 : 1));
  const limit = filter.limit ?? MEMORY_GRAPH_LIMIT;
  const shown = chosen.slice(0, limit);
  const ids = new Set(shown.map((note) => note.id));
  const nodes: MemoryGraphNodeView[] = shown.map((note) => ({
    id: note.id,
    kind: note.kind,
    status: note.status,
    title: note.title,
    ...(note.status === "stale" ? { stale: true } : {}),
    ...(contradicted.has(note.id) ? { contradicted: true } : {}),
    ...(note.id === filter.around ? { focus: true } : {}),
  }));
  const hidden = inScope.length - nodes.length;
  return {
    kind: "memory-graph",
    nodes,
    edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    scope: scope.join(" · "),
    ...(hidden > 0 ? { hidden } : {}),
    hints: ["/memory graph --around <id> [--depth n] · --kind <kind> · --all", "/memory show <id> · /memory open <id> · /memory graph --obsidian"],
  };
}

export async function memoryGraph(store: MarkdownMemoryStore, filter: MemoryGraphFilter): Promise<MemoryGraphView> {
  return buildMemoryGraph((await store.index()).notes, filter);
}
