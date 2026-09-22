import { readdir } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { isSafeRelativePath } from "../../domain/relative-path.ts";
import { formatZodIssues } from "../../domain/zod-issues.ts";
import {
  AUTO_PERSIST_KINDS,
  digestText,
  HarnessError,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  memoryIdSchema,
  memoryNoteFrontmatterSchema,
  memoryProposalSchema,
  proposalIdSchema,
  type Digest,
  type MemoryDecisionOutcome,
  type MemoryId,
  type MemoryKind,
  type MemoryNote,
  type MemoryNoteFrontmatter,
  type MemoryProposal,
  type MemoryQuery,
  type MemoryStore,
  type ProposalId,
  type RecalledMemory,
} from "../contracts/index.ts";
import { buildIndex, indexMatchesFiles, readIndex, scoreText, writeIndex, type IndexedNote, type MemoryIndex } from "./memory-index.ts";
import { parseNoteFile, serializeNote, splitTitle } from "./note-format.ts";
import { redactSecrets, redactValue } from "./redaction.ts";
import { findCandidates, INACTIVE_STATUSES, type MemoryCandidate } from "./relations.ts";
import {
  ensureVaultScaffold,
  fromVaultPath,
  isMissing,
  KIND_DIRECTORIES,
  listNoteFiles,
  QUEUE_DIRECTORY,
  readTextIfExists,
  writeAtomic,
} from "./vault.ts";

/**
 * The file-backed `MemoryStore` (ADR-16/17). Notes are Markdown files the user may edit at any
 * time; every write re-reads the file and refuses to replace content it has not seen.
 */

/** Longest note body accepted: notes carry distilled claims and pointers, never raw output. */
export const MAX_NOTE_BODY_CHARS = 16_000;

type PersistedAudit = NonNullable<MemoryDecisionOutcome["persisted"]>;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u009b]/;

export interface MemoryStoreOptions {
  /** Workspace that relative `source_ref` values resolve against for stale detection. */
  readonly workspaceRoot?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export type SourceState = "none" | "fresh" | "changed" | "missing" | "unverifiable";

export interface MemoryConflictDetails {
  readonly memoryId: string;
  readonly path: string;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
}

/** The note changed on disk since the digest the writer last saw; nothing was written. */
export class MemoryConflictError extends HarnessError {
  public readonly details: MemoryConflictDetails;

  public constructor(details: MemoryConflictDetails) {
    super({
      code: "store_write_failed",
      message:
        details.actual === undefined
          ? `memory note ${details.memoryId} was removed since it was read; nothing was written`
          : details.expected === undefined
            ? `memory note ${details.memoryId} already exists at ${details.path}; nothing was written`
            : `memory note ${details.memoryId} changed on disk since it was read; nothing was written`,
      ids: { memory_id: details.memoryId, path: details.path },
      workspace_effect: "none",
      retry_safe: false,
      next_command: `syn memory show ${details.memoryId}`,
    });
    this.details = details;
  }
}

function usage(message: string, nextCommand?: string): HarnessError {
  return new HarnessError({
    code: "usage_invalid",
    message,
    workspace_effect: "none",
    retry_safe: false,
    ...(nextCommand === undefined ? {} : { next_command: nextCommand }),
  });
}

export interface RelatedView {
  readonly note: MemoryNote;
  readonly outgoing: readonly { readonly type: string; readonly target: string; readonly title: string | undefined }[];
  readonly incoming: readonly { readonly type: string; readonly source: string; readonly title: string }[];
  readonly linksOut: readonly { readonly path: string; readonly id: string | undefined }[];
  readonly linksIn: readonly { readonly path: string; readonly id: string }[];
  readonly candidates: readonly MemoryCandidate[];
}

export interface MemoryStatus {
  readonly root: string;
  readonly notes: number;
  readonly byKind: Readonly<Partial<Record<MemoryKind, Readonly<Record<string, number>>>>>;
  readonly pending: number;
  readonly stale: readonly string[];
  readonly invalid: MemoryIndex["invalid"];
  readonly duplicates: MemoryIndex["duplicates"];
  readonly brokenLinks: MemoryIndex["broken_links"];
  readonly candidates: readonly MemoryCandidate[];
}

export type NoteInput = Omit<MemoryNote, "path" | "digest">;

export class MarkdownMemoryStore implements MemoryStore {
  public readonly root: string;
  private readonly workspaceRoot: string | undefined;
  private readonly now: () => Date;

  public constructor(root: string, options: MemoryStoreOptions = {}) {
    this.root = path.resolve(root);
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined : path.resolve(options.workspaceRoot);
    this.now = options.now ?? (() => new Date());
  }

  public async get(id: MemoryId): Promise<MemoryNote | undefined> {
    const entry = (await this.loadIndex()).notes.find((note) => note.id === id);
    return entry === undefined ? undefined : this.readNote(entry.path);
  }

  public async search(query: MemoryQuery): Promise<readonly RecalledMemory[]> {
    const index = await this.loadIndex();
    const text = query.text?.trim() ?? "";
    const hits: { entry: IndexedNote; score: number; fields: readonly string[]; offBranch: boolean; inactive: boolean }[] = [];
    for (const entry of index.notes) {
      if (entry.project_id !== query.projectId && entry.scope !== "user") continue;
      if (query.kinds !== undefined && !query.kinds.includes(entry.kind)) continue;
      const offBranch = entry.scope === "branch" && entry.branch !== query.branch;
      const inactive = INACTIVE_STATUSES.includes(entry.status);
      if ((offBranch || inactive) && !query.includeInactive) continue;
      const match = text.length > 0 ? scoreText(entry, text) : { score: 0, fields: [] };
      if (text.length > 0 && match.score === 0) continue;
      hits.push({ entry, score: match.score, fields: match.fields, offBranch, inactive });
    }
    hits.sort(
      (left, right) =>
        Number(left.offBranch || left.inactive) - Number(right.offBranch || right.inactive) ||
        right.score - left.score ||
        (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0),
    );
    const results: RecalledMemory[] = [];
    for (const hit of hits.slice(0, Math.max(0, query.limit))) {
      const note = await this.readNote(hit.entry.path);
      if (note === undefined) continue;
      const source = await this.sourceState(note.frontmatter);
      const sourceStale = source === "changed" || source === "missing" || note.frontmatter.status === "stale";
      const reasons = [
        hit.fields.length === 0 ? "matches the scope filter" : hit.fields.includes("id") && hit.score >= 1000 ? "exact id match" : `matched "${text}" in ${hit.fields.join(", ")}`,
        note.frontmatter.scope === "branch"
          ? hit.offBranch
            ? `scoped to branch ${note.frontmatter.branch ?? "?"}, not ${query.branch ?? "the current checkout"}; not current here`
            : `scoped to branch ${note.frontmatter.branch ?? "?"}`
          : `${note.frontmatter.scope} scope`,
        `${note.frontmatter.kind} ${note.frontmatter.status}${hit.inactive ? " (historical only)" : ""}`,
        ...(source === "changed" ? [`source ${note.frontmatter.source_ref ?? ""} changed since it was recorded`] : []),
        ...(source === "missing" ? [`source ${note.frontmatter.source_ref ?? ""} is missing`] : []),
        ...(source === "unverifiable" ? ["source not verifiable here"] : []),
      ];
      results.push({ note, reason: reasons.join("; "), stale: sourceStale || hit.offBranch || hit.inactive });
    }
    return results;
  }

  public async persist(note: NoteInput, expectedDigest: string | undefined): Promise<MemoryNote> {
    const kind = note.frontmatter.kind;
    if (!(AUTO_PERSIST_KINDS as readonly string[]).includes(kind)) {
      throw new HarnessError({
        code: "policy_denied",
        message: `${kind} notes are not written directly; queue a proposal for review (ADR-17)`,
        ids: { memory_id: note.frontmatter.id },
        workspace_effect: "none",
        retry_safe: false,
        next_command: "syn memory review",
      });
    }
    return this.writeNote(note, expectedDigest);
  }

  public async propose(proposal: MemoryProposal): Promise<void> {
    const parsed = memoryProposalSchema.safeParse(redactValue(proposal));
    if (!parsed.success) throw usage(`invalid memory proposal: ${formatZodIssues(parsed.error)}`);
    if (parsed.data.state !== "pending") throw usage("a new proposal must be pending");
    const file = this.proposalFile(parsed.data.proposal_id);
    if ((await readTextIfExists(file)) !== undefined) throw usage(`proposal ${parsed.data.proposal_id} already exists`, "syn memory review");
    await ensureVaultScaffold(this.root);
    await writeAtomic(file, stringify(parsed.data, { lineWidth: 0 }));
  }

  /** Proposals still awaiting a final decision: `pending` and `deferred`, oldest first. */
  public async pending(): Promise<readonly MemoryProposal[]> {
    return (await this.proposals()).filter((proposal) => proposal.state === "pending" || proposal.state === "deferred");
  }

  public async proposal(proposalId: ProposalId): Promise<MemoryProposal | undefined> {
    const content = await readTextIfExists(this.proposalFile(proposalId));
    if (content === undefined) return undefined;
    const parsed = memoryProposalSchema.safeParse(parse(content));
    return parsed.success ? parsed.data : undefined;
  }

  /** Applies a decision; returns the `memory/proposal_decided` and `memory/persisted` payloads for the event log. */
  public async decide(
    proposalId: ProposalId,
    decision: NonNullable<MemoryProposal["decision"]>,
    state: "accepted" | "rejected" | "deferred",
  ): Promise<MemoryDecisionOutcome> {
    const current = await this.proposal(proposalId);
    if (current === undefined) throw usage(`unknown or unreadable proposal ${proposalId}`, "syn memory review");
    if (current.state === "accepted" || current.state === "rejected") throw usage(`proposal ${proposalId} was already ${current.state}`);
    const parsed = memoryProposalSchema.safeParse({ ...current, state, decision: redactValue(decision) });
    if (!parsed.success) throw usage(`invalid decision: ${formatZodIssues(parsed.error)}`);
    const decided = parsed.data;
    const persisted = state === "accepted" ? await this.apply(decided) : undefined;
    await writeAtomic(this.proposalFile(proposalId), stringify(decided, { lineWidth: 0 }));
    const record = decided.decision ?? decision;
    return {
      proposal: decided,
      decided: { proposal_id: decided.proposal_id, state, decided_by: record.by, reason: record.reason },
      persisted,
      runId: record.by === "orchestrator" ? record.run_id : undefined,
    };
  }

  public async reindex(): Promise<{ readonly notes: number; readonly broken_links: number }> {
    const index = await this.rebuildIndex();
    return { notes: index.notes.length, broken_links: index.broken_links.length };
  }

  /** Rebuilds `.index/` from the notes and returns the full result, broken links included. */
  public async rebuildIndex(): Promise<MemoryIndex> {
    const index = await buildIndex(this.root);
    if (await this.rootExists()) await writeIndex(this.root, index);
    return index;
  }

  public async candidates(id?: string): Promise<readonly MemoryCandidate[]> {
    const all = findCandidates((await this.loadIndex()).notes);
    return id === undefined ? all : all.filter((candidate) => candidate.source === id || candidate.target === id);
  }

  public async related(id: MemoryId): Promise<RelatedView | undefined> {
    const index = await this.loadIndex();
    const entry = index.notes.find((note) => note.id === id);
    if (entry === undefined) return undefined;
    const note = await this.readNote(entry.path);
    if (note === undefined) return undefined;
    const byId = new Map(index.notes.map((item) => [item.id, item]));
    const byPath = new Map(index.notes.map((item) => [item.path.toLowerCase(), item]));
    return {
      note,
      outgoing: entry.relations.map((relation) => ({ type: relation.type, target: relation.target, title: byId.get(relation.target)?.title })),
      incoming: index.notes.flatMap((item) =>
        item.relations.filter((relation) => relation.target === id).map((relation) => ({ type: relation.type, source: item.id, title: item.title })),
      ),
      linksOut: entry.links.map((link) => ({ path: link, id: byPath.get(link.toLowerCase())?.id })),
      linksIn: index.notes.filter((item) => item.links.some((link) => link.toLowerCase() === entry.path.toLowerCase())).map((item) => ({ path: item.path, id: item.id })),
      candidates: await this.candidates(id),
    };
  }

  public async status(): Promise<MemoryStatus> {
    const index = await this.loadIndex();
    const byKind: Partial<Record<MemoryKind, Record<string, number>>> = {};
    for (const note of index.notes) {
      const counts = byKind[note.kind] ?? {};
      counts[note.status] = (counts[note.status] ?? 0) + 1;
      byKind[note.kind] = counts;
    }
    const stale: string[] = [];
    for (const note of index.notes) {
      if (note.status === "stale") {
        stale.push(note.id);
        continue;
      }
      const state = await this.sourceState(note);
      if (state === "changed" || state === "missing") stale.push(note.id);
    }
    return {
      root: this.root,
      notes: index.notes.length,
      byKind,
      pending: (await this.pending()).length,
      stale,
      invalid: index.invalid,
      duplicates: index.duplicates,
      brokenLinks: index.broken_links,
      candidates: findCandidates(index.notes),
    };
  }

  /** Where a stored note's vault-relative `path` lives on disk. */
  public absolutePath(vaultPath: string): string {
    return fromVaultPath(this.root, vaultPath);
  }

  public async sourceState(frontmatter: { readonly source_ref?: string | undefined; readonly source_digest?: string | undefined }): Promise<SourceState> {
    if (frontmatter.source_ref === undefined || frontmatter.source_digest === undefined) return "none";
    if (this.workspaceRoot === undefined) return "unverifiable";
    const reference = frontmatter.source_ref.replace(/[@#].*$/, "").trim();
    if (reference.length === 0 || !isSafeRelativePath(reference) || /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}/.test(reference)) return "unverifiable";
    const content = await readTextIfExists(path.join(this.workspaceRoot, reference)).catch(() => undefined);
    if (content === undefined) return "missing";
    return digestText(content) === frontmatter.source_digest ? "fresh" : "changed";
  }

  private async apply(proposal: MemoryProposal): Promise<PersistedAudit> {
    const decision = proposal.decision;
    if (decision === undefined) throw usage("an accepted proposal needs a decision");
    const date = decision.at.slice(0, 10);
    if (proposal.kind === "note") {
      const note = proposal.note;
      if (note === undefined) throw usage("a note proposal carries a note");
      const { title, body } = splitTitle(proposal.body ?? "");
      const frontmatter = {
        ...note,
        status: note.kind === "decision" && note.status === "proposed" ? "accepted" : note.status,
        reviewed_at: date,
        source_run: note.source_run ?? proposal.created_by.run_id,
      };
      return this.audit(await this.writeNote({ frontmatter, title: title ?? note.id, body }, undefined));
    }
    const targetId = proposal.target;
    if (targetId === undefined) throw usage(`a ${proposal.kind} proposal names its target`);
    const entry = (await this.loadIndex()).notes.find((note) => note.id === targetId);
    const target = entry === undefined ? undefined : await this.readNote(entry.path);
    if (target === undefined) throw usage(`proposal target ${targetId} does not exist`, `syn memory search ${targetId}`);
    let frontmatter: MemoryNoteFrontmatter = { ...target.frontmatter, updated_at: date };
    if (proposal.kind === "status-change") {
      const next = proposal.new_status ?? "";
      if (!MEMORY_STATUSES[target.frontmatter.kind].includes(next)) {
        throw usage(`${next} is not a ${target.frontmatter.kind} status (${MEMORY_STATUSES[target.frontmatter.kind].join(", ")})`);
      }
      frontmatter = { ...frontmatter, status: next, reviewed_at: date };
    } else {
      const relation = proposal.relation;
      if (relation === undefined) throw usage(`a ${proposal.kind} proposal carries a relation`);
      if (!frontmatter.relations.some((item) => item.type === relation.type && item.target === relation.target)) {
        frontmatter = { ...frontmatter, relations: [...frontmatter.relations, relation] };
      }
    }
    return this.audit(await this.writeNote({ frontmatter, title: target.title, body: target.body }, target.digest));
  }

  private audit(note: MemoryNote): PersistedAudit {
    return { memory_id: note.frontmatter.id, kind: note.frontmatter.kind, path: note.path, digest: note.digest };
  }

  private async writeNote(input: NoteInput, expectedDigest: string | undefined): Promise<MemoryNote> {
    const title = redactSecrets(input.title).text.trim();
    const body = redactSecrets(input.body).text.trim();
    const parsed = memoryNoteFrontmatterSchema.safeParse(redactValue(input.frontmatter));
    if (!parsed.success) throw usage(`invalid memory note: ${formatZodIssues(parsed.error)}`);
    const frontmatter = parsed.data;
    if (title.length === 0 || /[\r\n]/.test(title)) throw usage("a memory note title is one non-empty line");
    if (CONTROL_CHARACTERS.test(body) || CONTROL_CHARACTERS.test(title)) {
      throw usage("raw terminal or tool output is not stored in memory; persist a distilled summary with source_ref and source_digest");
    }
    if (body.length > MAX_NOTE_BODY_CHARS) {
      throw usage(`a memory note body is limited to ${MAX_NOTE_BODY_CHARS} characters; store a pointer (source_ref + source_digest), not raw output`);
    }

    await ensureVaultScaffold(this.root);
    const existing = (await this.loadIndex()).notes.find((note) => note.id === frontmatter.id);
    const vaultPath = existing?.path ?? `${KIND_DIRECTORIES[frontmatter.kind]}/${frontmatter.id}.md`;
    const file = fromVaultPath(this.root, vaultPath);
    const content = serializeNote({ frontmatter, title, body });
    const onDisk = await readTextIfExists(file);
    const actual = onDisk === undefined ? undefined : digestText(onDisk);
    if (actual !== expectedDigest) {
      throw new MemoryConflictError({ memoryId: frontmatter.id, path: vaultPath, expected: expectedDigest, actual });
    }
    await writeAtomic(file, content);
    return { frontmatter, title, body, path: vaultPath, digest: digestText(content) };
  }

  private async readNote(vaultPath: string): Promise<MemoryNote | undefined> {
    const content = await readTextIfExists(fromVaultPath(this.root, vaultPath));
    if (content === undefined) return undefined;
    const parsed = parseNoteFile(content);
    if (!parsed.ok) return undefined;
    return { frontmatter: parsed.frontmatter, title: parsed.title, body: parsed.body, path: vaultPath, digest: digestText(content) };
  }

  private async loadIndex(): Promise<MemoryIndex> {
    const files = await listNoteFiles(this.root);
    const cached = await readIndex(this.root);
    if (cached !== undefined && indexMatchesFiles(cached, files)) return cached;
    const index = await buildIndex(this.root, files);
    if (await this.rootExists()) await writeIndex(this.root, index);
    return index;
  }

  private async proposals(): Promise<MemoryProposal[]> {
    let names: string[];
    try {
      names = (await readdir(fromVaultPath(this.root, QUEUE_DIRECTORY))).filter((name) => name.endsWith(".yaml"));
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const proposals: MemoryProposal[] = [];
    for (const name of names.sort()) {
      const id = proposalIdSchema.safeParse(name.slice(0, -".yaml".length));
      if (!id.success) continue;
      const proposal = await this.proposal(id.data).catch(() => undefined);
      if (proposal !== undefined) proposals.push(proposal);
    }
    return proposals.sort((left, right) => (left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0));
  }

  private proposalFile(proposalId: string): string {
    return fromVaultPath(this.root, `${QUEUE_DIRECTORY}/${proposalId}.yaml`);
  }

  private async rootExists(): Promise<boolean> {
    return (await readdir(this.root).then(() => true, () => false));
  }
}

/** The I6 factory: a Markdown vault at `root`. Obsidian is never required. */
export function createMemoryStore(root: string, options: MemoryStoreOptions = {}): MarkdownMemoryStore {
  return new MarkdownMemoryStore(root, options);
}

export function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

export function parseMemoryId(value: string): MemoryId | undefined {
  const parsed = memoryIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
