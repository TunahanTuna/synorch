import path from "node:path";
import { MEMORY_KINDS, proposalIdSchema, type MemoryDecisionOutcome, type MemoryKind, type MemoryProposal, type SessionEventDraft } from "../contracts/index.ts";
import type { HarnessView, MemoryEntryView, MemoryLedgerView } from "../contracts/views.ts";
import {
  ledgerSummary,
  memoryGraph,
  obsidianOpenUri,
  proposalConflicts,
  proposalSubject,
  readLedger,
  RETIRED_STATUS,
  type LedgerEntry,
  type MarkdownMemoryStore,
  type ObsidianLauncher,
} from "../memory/index.ts";

/**
 * `/memory` in the conversation (K2, UX-08, obsidian/README.md §6.3): the ledger, the decision desk
 * (`/memory review`: accept / edit / reject / defer each proposal), correction control
 * (`/memory edit|retire <id>`), `/memory open [id]` (Obsidian URI, CLI fallback) and
 * `/memory graph`. Every decision is appended to the conversation log as `memory/*` events.
 */

export interface MemoryDeskHost {
  readonly store: MarkdownMemoryStore;
  readonly projectId: string;
  readonly branch: string | undefined;
  readonly obsidian: ObsidianLauncher;
  print(lines: readonly string[]): void;
  /** Shows a card; returns false when no view host is attached (the caller prints instead). */
  show(view: HarnessView): boolean;
  ask(question: string, options: readonly string[] | undefined): Promise<string>;
  /** Appends an audit event to the conversation log when one is open. */
  append(type: SessionEventDraft["type"], data: unknown): Promise<void>;
}

const USAGE = [
  "/memory                    the ledger: active decisions, preferences, open assumptions, contradictions",
  "/memory review             the decision desk: accept / edit / reject / defer each proposal",
  "/memory accept|reject|defer <n | proposal-id> [reason]",
  "/memory show <id>          one note with its source and freshness",
  "/memory edit <id>          correct a note's title or text (it becomes yours)",
  "/memory retire <id>        stop a note from steering future context (kept as history)",
  "/memory open [id]          open the note (or the vault) in Obsidian",
  "/memory graph [--around <id>] [--depth n] [--kind <kind>] [--all] [--obsidian]",
];

function entryView(entry: LedgerEntry): MemoryEntryView {
  return { id: entry.id, title: entry.title, status: entry.status, decider: entry.decider, scope: entry.scope, ...(entry.stale ? { stale: true } : {}) };
}

export async function ledgerView(host: Pick<MemoryDeskHost, "store" | "projectId" | "branch">): Promise<MemoryLedgerView> {
  const ledger = await readLedger(host.store, host.projectId, host.branch);
  return {
    kind: "memory",
    vault: host.store.root,
    summary: ledgerSummary(ledger)?.replace(/^memory: /, "") ?? "empty",
    sections: [
      { title: "Decisions", entries: ledger.decisions.map(entryView) },
      { title: "Preferences", entries: ledger.preferences.map(entryView) },
      { title: "Open assumptions", entries: ledger.assumptions.map(entryView) },
      { title: "Open questions", entries: ledger.questions.map(entryView) },
      { title: "Other notes", entries: ledger.other.map(entryView) },
    ],
    contradictions: ledger.contradictions,
    pending: ledger.pending.length,
    hints: ["/memory review · /memory edit <id> · /memory retire <id> · /memory open [id] · /memory graph"],
  };
}

function ledgerLines(view: MemoryLedgerView): string[] {
  const lines = [`Memory ${view.summary} · vault ${view.vault}`];
  for (const section of view.sections) {
    if (section.entries.length === 0) continue;
    lines.push(`${section.title}:`, ...section.entries.map((entry) => `  ${entry.id}  ${entry.title}  (${entry.decider ?? ""})${entry.stale === true ? " STALE" : ""}`));
  }
  if (view.contradictions.length > 0) lines.push("Possible contradictions:", ...view.contradictions.map((line) => `  ${line}`));
  if (view.pending > 0) lines.push(`${view.pending} proposal(s) waiting · /memory review`);
  return lines;
}

async function audit(host: MemoryDeskHost, outcome: MemoryDecisionOutcome): Promise<void> {
  await host.append("memory/proposal_decided", outcome.decided).catch(() => undefined);
  if (outcome.persisted !== undefined) await host.append("memory/persisted", outcome.persisted).catch(() => undefined);
}

function sourceLine(proposal: MemoryProposal): string {
  const who = proposal.created_by.role === "session" || proposal.created_by.run_id === undefined ? "the conversation" : proposal.created_by.role === "orchestrator" ? "the orchestrator" : `a ${proposal.created_by.role ?? "worker"}`;
  const evidence = proposal.evidence.map((item) => `${item.kind === "tool-call" ? "tool call" : item.kind}`).join(", ");
  return `proposed by ${who} (${evidence}) · ${proposal.created_at.slice(0, 16).replace("T", " ")}`;
}

async function resolveProposal(host: MemoryDeskHost, reference: string): Promise<MemoryProposal | undefined> {
  const pending = await host.store.pending();
  if (/^\d+$/.test(reference)) return pending[Number(reference) - 1];
  const id = proposalIdSchema.safeParse(reference);
  return id.success ? pending.find((proposal) => proposal.proposal_id === id.data) : undefined;
}

async function decide(host: MemoryDeskHost, proposal: MemoryProposal, state: "accepted" | "rejected" | "deferred", reason: string): Promise<string> {
  const outcome = await host.store.decide(proposal.proposal_id, { by: "user", at: new Date().toISOString(), reason }, state);
  await audit(host, outcome);
  const subject = proposalSubject(proposal);
  if (state === "accepted") return `✓ Remembered ${outcome.persisted?.memory_id ?? ""}: ${subject.title}${outcome.persisted === undefined ? "" : ` (${outcome.persisted.path})`}`;
  return state === "rejected" ? `Rejected: ${subject.title} (nothing written)` : `Deferred: ${subject.title} (stays in /memory review)`;
}

/** `/memory review`: one card per proposal, then accept / edit / reject / defer / stop. */
async function review(host: MemoryDeskHost): Promise<void> {
  const pending = await host.store.pending();
  if (pending.length === 0) {
    host.print(["No memory proposals waiting. The agent proposes decisions and preferences as you work; /memory shows what is remembered."]);
    return;
  }
  for (const [index, proposal] of pending.entries()) {
    const subject = proposalSubject(proposal);
    const conflicts = await proposalConflicts(host.store, proposal, host.projectId, host.branch);
    const scope = proposal.note === undefined ? undefined : proposal.note.scope === "branch" ? `branch ${proposal.note.branch ?? "?"}` : proposal.note.scope;
    const card: HarnessView = {
      kind: "memory-proposal",
      position: index + 1,
      total: pending.length,
      noteKind: subject.kind,
      title: subject.title,
      ...(subject.body === "" ? {} : { body: subject.body }),
      rationale: proposal.rationale,
      source: sourceLine(proposal),
      ...(scope === undefined ? {} : { scope }),
      conflicts,
      ...(proposal.state === "deferred" ? { deferred: true } : {}),
    };
    if (!host.show(card)) {
      host.print([`Proposal ${index + 1}/${pending.length} [${subject.kind}] ${subject.title}`, ...(subject.body === "" ? [] : [`  ${subject.body}`]), `  why: ${proposal.rationale}`, `  ${sourceLine(proposal)}`, ...conflicts.map((conflict) => `  conflict: ${conflict}`)]);
    }
    const answer = (await host.ask("Remember this?", ["Accept", "Edit", "Reject", "Defer", "Stop reviewing"]).catch(() => "5")).trim().toLowerCase();
    if (/^(1|a|accept|y|yes|evet|kabul)/.test(answer)) host.print([await decide(host, proposal, "accepted", "accepted by the user at the decision desk")]);
    else if (/^(2|e|edit|düzenle)/.test(answer) && proposal.kind === "note") {
      const title = (await host.ask(`New title (Enter keeps "${subject.title}")`, undefined).catch(() => "")).trim();
      const body = (await host.ask("New text (Enter keeps the current text)", undefined).catch(() => "")).trim();
      const amended = await host.store.amendProposal(proposal.proposal_id, { ...(title === "" ? {} : { title }), ...(body === "" ? {} : { body }) });
      host.print([await decide(host, amended, "accepted", "edited and accepted by the user at the decision desk")]);
    } else if (/^(3|r|reject|n|no|hayır|reddet)/.test(answer)) host.print([await decide(host, proposal, "rejected", "rejected by the user at the decision desk")]);
    else if (/^(4|d|defer|later|ertele)/.test(answer)) host.print([await decide(host, proposal, "deferred", "deferred by the user at the decision desk")]);
    else {
      const left = pending.length - index;
      host.print([`Stopped · ${left} proposal${left === 1 ? "" : "s"} still waiting (/memory review)`]);
      return;
    }
  }
}

async function noteOrFail(host: MemoryDeskHost, reference: string | undefined): Promise<Awaited<ReturnType<MarkdownMemoryStore["get"]>>> {
  if (reference === undefined || reference === "") {
    host.print(["A memory id is needed, for example /memory show dec-use-pnpm-a1b2 (/memory lists them)."]);
    return undefined;
  }
  const note = await host.store.get(reference as never).catch(() => undefined);
  if (note === undefined) host.print([`No memory note ${reference} (/memory lists them).`]);
  return note;
}

function flag(words: readonly string[], name: string): string | undefined {
  const index = words.indexOf(name);
  return index === -1 ? undefined : words[index + 1];
}

async function graph(host: MemoryDeskHost, words: readonly string[]): Promise<void> {
  if (words.includes("--obsidian")) {
    const uri = obsidianOpenUri(path.join(host.store.root, "README.md"));
    const opened = (await host.obsidian.available()) && (await host.obsidian.open(uri));
    host.print([opened ? `Opened the vault in Obsidian · press Ctrl+G (Cmd+G) there for its graph view` : `Obsidian is not installed here · the vault is ${host.store.root} (open it as a vault in Obsidian for its graph view)`]);
    return;
  }
  const kinds = words.flatMap((word, index) => (words[index - 1] === "--kind" ? word.split(",") : [])).filter((kind): kind is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(kind));
  const around = flag(words, "--around");
  const depth = Number(flag(words, "--depth") ?? "2");
  const view = await memoryGraph(host.store, { projectId: host.projectId, branch: host.branch, kinds, ...(around === undefined ? {} : { around }), depth: Number.isFinite(depth) ? depth : 2, all: words.includes("--all") });
  if (!host.show(view)) {
    host.print([`Memory graph · ${view.nodes.length} notes · ${view.edges.length} links · ${view.scope}`, ...view.nodes.map((node) => `  ${node.id} (${node.kind} ${node.status})${node.contradicted === true ? " !contradiction" : ""}: ${node.title}`), ...view.edges.map((edge) => `  ${edge.from} ${edge.type} ${edge.to}`)]);
  }
}

export async function runMemoryDesk(host: MemoryDeskHost, argument: string): Promise<void> {
  const words = argument.split(/\s+/).filter((word) => word !== "");
  const [verb = "", reference, ...rest] = words;
  switch (verb.toLowerCase()) {
    case "": {
      const view = await ledgerView(host);
      if (!host.show(view)) host.print(ledgerLines(view));
      return;
    }
    case "review":
    case "desk":
      await review(host);
      return;
    case "accept":
    case "reject":
    case "defer": {
      const proposal = reference === undefined ? undefined : await resolveProposal(host, reference);
      if (proposal === undefined) {
        host.print([`No waiting proposal ${reference ?? ""} · /memory review lists them`]);
        return;
      }
      const state = verb === "accept" ? "accepted" : verb === "reject" ? "rejected" : "deferred";
      host.print([await decide(host, proposal, state, rest.join(" ").trim() || `${state} by the user via /memory ${verb}`)]);
      return;
    }
    case "show": {
      const note = await noteOrFail(host, reference);
      if (note === undefined) return;
      const source = await host.store.sourceState(note.frontmatter);
      const fm = note.frontmatter;
      host.print([
        `${fm.id} · ${fm.kind} ${fm.status} · ${fm.scope}${fm.branch === undefined ? "" : ` ${fm.branch}`} · confidence ${fm.confidence} · owner ${fm.owner}${fm.reviewed_at === undefined ? "" : ` · reviewed ${fm.reviewed_at}`}`,
        ...(fm.source_ref === undefined ? [] : [`source ${fm.source_ref} (${source === "none" ? "no digest" : source})`]),
        `# ${note.title}`,
        ...(note.body === "" ? [] : note.body.split(/\r?\n/)),
        `${host.store.absolutePath(note.path)}`,
      ]);
      return;
    }
    case "edit": {
      const note = await noteOrFail(host, reference);
      if (note === undefined) return;
      const title = (await host.ask(`New title (Enter keeps "${note.title}")`, undefined).catch(() => "")).trim();
      const body = (await host.ask("New text (Enter keeps the current text)", undefined).catch(() => "")).trim();
      if (title === "" && body === "") {
        host.print(["Unchanged."]);
        return;
      }
      const written = await host.store.correct(note.frontmatter.id, { ...(title === "" ? {} : { title }), ...(body === "" ? {} : { body }) }, note.digest);
      await host.append("memory/persisted", { memory_id: written.frontmatter.id, kind: written.frontmatter.kind, path: written.path, digest: written.digest });
      host.print([`✓ Corrected ${written.frontmatter.id}: ${written.title} (now yours)`]);
      return;
    }
    case "retire":
    case "revoke":
    case "forget": {
      const note = await noteOrFail(host, reference);
      if (note === undefined) return;
      const status = RETIRED_STATUS[note.frontmatter.kind];
      const written = await host.store.correct(note.frontmatter.id, { status }, note.digest);
      await host.append("memory/persisted", { memory_id: written.frontmatter.id, kind: written.frontmatter.kind, path: written.path, digest: written.digest });
      host.print([`✓ Retired ${written.frontmatter.id} (${status}): it no longer steers new requests; the note stays in the vault as history`]);
      return;
    }
    case "open": {
      const note = reference === undefined ? undefined : await noteOrFail(host, reference);
      if (reference !== undefined && note === undefined) return;
      const file = note === undefined ? path.join(host.store.root, "README.md") : host.store.absolutePath(note.path);
      const uri = obsidianOpenUri(file);
      if ((await host.obsidian.available()) && (await host.obsidian.open(uri))) host.print([`Opened in Obsidian: ${note?.frontmatter.id ?? "the vault"}`]);
      else host.print([`Obsidian is not installed here · ${file}`, ...(note === undefined ? [] : [`# ${note.title}`, ...note.body.split(/\r?\n/).slice(0, 20)])]);
      return;
    }
    case "graph":
      await graph(host, words.slice(1));
      return;
    default:
      host.print(USAGE);
  }
}
