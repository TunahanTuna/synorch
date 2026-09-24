import { randomBytes } from "node:crypto";
import {
  createId,
  MEMORY_ID_PREFIXES,
  MEMORY_KINDS,
  memoryProposalSchema,
  type AgentRole,
  type MemoryKind,
  type MemoryNote,
  type MemoryProposal,
  type RunId,
  type TaskId,
} from "../contracts/index.ts";
import type { MarkdownMemoryStore } from "./markdown-memory-store.ts";
import { INACTIVE_STATUSES } from "./relations.ts";

/**
 * The decision desk and memory ledger (obsidian/README.md §6.3, UX-08): turns a `memory_propose`
 * call into a reviewable proposal with sensible defaults, finds what a proposal may conflict with,
 * and reads the vault as a ledger (active decisions, open assumptions, possible contradictions).
 * Nothing here decides: accepting, editing, rejecting and deferring stay with the user.
 */

export interface ProposalInput {
  readonly kind: MemoryProposal["kind"];
  readonly target?: string | undefined;
  readonly rationale: string;
  readonly content: Readonly<Record<string, unknown>>;
}

export interface ProposalOrigin {
  readonly projectId: string;
  readonly branch: string | undefined;
  readonly runId: RunId | undefined;
  readonly taskId: TaskId | undefined;
  readonly role: AgentRole;
  readonly toolCallId: string;
  readonly now: Date;
}

const DEFAULT_STATUS: { readonly [K in MemoryKind]: string } = {
  project: "active",
  decision: "proposed",
  assumption: "open",
  question: "open",
  evidence: "current",
  concept: "active",
  preference: "active",
};

/** The status a correction sets when the user retires a note: it stops steering future context. */
export const RETIRED_STATUS: { readonly [K in MemoryKind]: string } = {
  project: "archived",
  decision: "superseded",
  assumption: "invalidated",
  question: "resolved",
  evidence: "stale",
  concept: "deprecated",
  preference: "revoked",
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `dec-use-pnpm-workspaces-k3f2`: readable, unique enough, inside the id alphabet. */
export function memorySlugId(kind: MemoryKind, title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/[^0-9a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const suffix = randomBytes(3).toString("hex").slice(0, 4);
  return `${MEMORY_ID_PREFIXES[kind]}-${slug === "" ? "note" : slug}-${suffix}`;
}

/**
 * A `memory_propose` call as a pending proposal. The agent may send a full `note` frontmatter, or
 * just `{ kind, title, body }` (plus optional `scope`, `confidence`, `tags`, `source_ref`): the desk
 * fills id, project, dates and owner. A conversation turn has no run; the proposal names its role.
 */
export function buildProposal(input: ProposalInput, origin: ProposalOrigin): { readonly ok: true; readonly proposal: MemoryProposal } | { readonly ok: false; readonly message: string } {
  const content = input.content;
  const date = origin.now.toISOString().slice(0, 10);
  let note: Record<string, unknown> | undefined;
  let body = text(content.body);
  if (input.kind === "note") {
    const given = record(content.note) ?? {};
    const kindText = text(given.kind) ?? text(content.kind) ?? "decision";
    if (!(MEMORY_KINDS as readonly string[]).includes(kindText)) return { ok: false, message: `content.kind must be one of ${MEMORY_KINDS.join(", ")}` };
    const kind = kindText as MemoryKind;
    const title = text(content.title) ?? text(given.title) ?? body?.split(/\r?\n/)[0]?.replace(/^#\s*/, "").slice(0, 120);
    if (title === undefined) return { ok: false, message: "a note proposal needs content.title (one line) and content.body" };
    const wantBranch = (text(content.scope) ?? text(given.scope)) === "branch" && origin.branch !== undefined;
    const scope = wantBranch ? "branch" : (text(content.scope) ?? text(given.scope)) === "user" ? "user" : "project";
    const { title: _dropped, ...rest } = given;
    void _dropped;
    note = {
      schema_version: 1,
      kind,
      project_id: origin.projectId,
      status: DEFAULT_STATUS[kind],
      created_at: date,
      confidence: text(content.confidence) ?? "medium",
      // A preference is the user's own; everything else Synorch proposes is Synorch's until reviewed.
      owner: kind === "preference" ? "human" : "synorch",
      relations: [],
      ...rest,
      id: text(given.id) ?? memorySlugId(kind, title),
      scope,
      ...(scope === "branch" ? { branch: origin.branch } : {}),
      ...(text(content.source_ref) === undefined ? {} : { source_ref: text(content.source_ref) }),
      ...(Array.isArray(content.tags) ? { tags: content.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.toLowerCase()) } : {}),
    };
    if (scope !== "branch") delete note.branch;
    const cleanTitle = title.replace(/[\r\n]+/g, " ").trim();
    body = `# ${cleanTitle}${body === undefined || body === cleanTitle ? "" : `\n\n${body}`}`;
  }
  const producedBy = origin.role === "reviewer" ? "reviewer" : origin.role === "orchestrator" ? "orchestrator" : "worker";
  const parsed = memoryProposalSchema.safeParse({
    schema_version: 1,
    proposal_id: createId("proposal"),
    kind: input.kind,
    ...(note === undefined ? {} : { note }),
    ...(body === undefined ? {} : { body }),
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(content.relation === undefined ? {} : { relation: content.relation }),
    ...(typeof content.new_status === "string" ? { new_status: content.new_status } : {}),
    rationale: input.rationale,
    evidence: [{ kind: "tool-call", ref: origin.toolCallId, produced_by: producedBy }],
    created_by: {
      ...(origin.runId === undefined ? {} : { run_id: origin.runId }),
      ...(origin.taskId === undefined ? {} : { task_id: origin.taskId }),
      role: origin.role === "orchestrator" || origin.role === "session" || origin.role === "reviewer" ? origin.role : "worker",
    },
    created_at: origin.now.toISOString(),
    state: "pending",
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 2000) };
  return { ok: true, proposal: parsed.data };
}

/** One line for a proposal: what would change. */
export function proposalSubject(proposal: MemoryProposal): { readonly kind: string; readonly title: string; readonly body: string } {
  if (proposal.kind === "note") {
    const lines = (proposal.body ?? "").replace(/\r\n?/g, "\n").split("\n");
    const heading = lines.findIndex((line) => line.trim() !== "");
    const match = /^#\s+(.+)$/.exec(lines[heading] ?? "");
    const title = match?.[1]?.trim() ?? proposal.note?.id ?? "note";
    const body = (match === null ? lines : lines.slice(heading + 1)).join("\n").trim();
    return { kind: proposal.note?.kind ?? "note", title, body };
  }
  if (proposal.kind === "status-change") return { kind: "status change", title: `${proposal.target ?? "?"} → ${proposal.new_status ?? "?"}`, body: "" };
  return { kind: proposal.kind, title: `${proposal.target ?? "?"} ${proposal.relation?.type ?? "?"} ${proposal.relation?.target ?? "?"}`, body: "" };
}

/** Existing notes a proposal may duplicate or contradict (same kind, overlapping words; the target of a change). */
export async function proposalConflicts(store: MarkdownMemoryStore, proposal: MemoryProposal, projectId: string, branch: string | undefined): Promise<string[]> {
  const conflicts: string[] = [];
  if (proposal.target !== undefined) {
    const target = await store.get(proposal.target as never).catch(() => undefined);
    conflicts.push(target === undefined ? `target ${proposal.target} is not in the vault` : `changes ${target.frontmatter.id} "${target.title}" (${target.frontmatter.status})`);
  }
  if (proposal.kind === "note" && proposal.note !== undefined) {
    const subject = proposalSubject(proposal);
    const hits = await store
      .search({ projectId, branch, text: subject.title, kinds: [proposal.note.kind], includeInactive: false, limit: 3 })
      .catch(() => []);
    for (const hit of hits) {
      if (hit.note.frontmatter.id === proposal.note.id) continue;
      conflicts.push(`overlaps ${hit.note.frontmatter.id} "${hit.note.title}" (${hit.note.frontmatter.status}): accepting keeps both; retire one with /memory retire`);
    }
  }
  return conflicts;
}

export interface LedgerEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly status: string;
  readonly title: string;
  readonly path: string;
  readonly stale: boolean;
  readonly decider: string;
  readonly scope: string;
}

export interface MemoryLedger {
  readonly decisions: readonly LedgerEntry[];
  readonly preferences: readonly LedgerEntry[];
  readonly assumptions: readonly LedgerEntry[];
  readonly questions: readonly LedgerEntry[];
  readonly other: readonly LedgerEntry[];
  readonly contradictions: readonly string[];
  readonly pending: readonly MemoryProposal[];
  readonly stale: readonly string[];
}

function entryOf(note: MemoryNote, stale: boolean): LedgerEntry {
  const frontmatter = note.frontmatter;
  const decider = frontmatter.owner === "human" ? "you" : frontmatter.reviewed_at === undefined ? "Synorch (unreviewed)" : `reviewed ${frontmatter.reviewed_at}`;
  return {
    id: frontmatter.id,
    kind: frontmatter.kind,
    status: frontmatter.status,
    title: note.title,
    path: note.path,
    stale,
    decider,
    scope: frontmatter.scope === "branch" ? `branch ${frontmatter.branch ?? "?"}` : frontmatter.scope,
  };
}

/** The ledger for this project and branch: only current notes; retired ones stay in the vault as history. */
export async function readLedger(store: MarkdownMemoryStore, projectId: string, branch: string | undefined): Promise<MemoryLedger> {
  const recalled = await store.search({ projectId, branch, text: undefined, kinds: undefined, includeInactive: false, limit: 500 }).catch(() => []);
  const entries = recalled.filter((item) => !INACTIVE_STATUSES.includes(item.note.frontmatter.status)).map((item) => entryOf(item.note, item.stale));
  const status = await store.status().catch(() => undefined);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const contradictions: string[] = [];
  for (const candidate of status?.candidates ?? []) {
    if (candidate.kind !== "contradiction") continue;
    contradictions.push(`${candidate.source} "${byId.get(candidate.source)?.title ?? "?"}" vs ${candidate.target} "${byId.get(candidate.target)?.title ?? "?"}": ${candidate.rationale}`);
  }
  for (const item of recalled) {
    for (const relation of item.note.frontmatter.relations) {
      if (relation.type !== "contradicts") continue;
      contradictions.push(`${item.note.frontmatter.id} "${item.note.title}" contradicts ${relation.target} "${byId.get(relation.target)?.title ?? "?"}"`);
    }
  }
  return {
    decisions: entries.filter((entry) => entry.kind === "decision"),
    preferences: entries.filter((entry) => entry.kind === "preference"),
    assumptions: entries.filter((entry) => entry.kind === "assumption"),
    questions: entries.filter((entry) => entry.kind === "question"),
    other: entries.filter((entry) => !["decision", "preference", "assumption", "question"].includes(entry.kind)),
    contradictions,
    pending: await store.pending().catch(() => []),
    stale: status?.stale ?? [],
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** `memory: 3 decisions, 1 open assumption, 1 possible contradiction`; undefined for an empty vault. */
export function ledgerSummary(ledger: MemoryLedger): string | undefined {
  const parts: string[] = [];
  if (ledger.decisions.length > 0) parts.push(plural(ledger.decisions.length, "decision"));
  if (ledger.preferences.length > 0) parts.push(plural(ledger.preferences.length, "preference"));
  if (ledger.assumptions.length > 0) parts.push(`${ledger.assumptions.length} open assumption${ledger.assumptions.length === 1 ? "" : "s"}`);
  if (ledger.questions.length > 0) parts.push(`${ledger.questions.length} open question${ledger.questions.length === 1 ? "" : "s"}`);
  if (ledger.contradictions.length > 0) parts.push(plural(ledger.contradictions.length, "possible contradiction"));
  if (parts.length === 0 && ledger.pending.length === 0) return undefined;
  const pending = ledger.pending.length === 0 ? "" : `${parts.length === 0 ? "" : " · "}${plural(ledger.pending.length, "proposal")} waiting (/memory review)`;
  return `memory: ${parts.join(", ")}${pending}`;
}
