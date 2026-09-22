import { z } from "zod";
import { calendarDateSchema, evidenceRefSchema, nonEmptyTextSchema, timestampSchema } from "./common.ts";
import { digestSchema } from "./digest.ts";
import type { SessionEventOf } from "./events.ts";
import { projectIdSchema, proposalIdSchema, runIdSchema, taskIdSchema, type RunId } from "./ids.ts";

/**
 * Markdown memory store (ADR-16/17). Notes are plain Markdown with YAML frontmatter under
 * `~/.synorch/memory/<project-id>/` by default; Obsidian is an optional viewer. The session event
 * log stays the source of evidence; a note is a reviewable projection that points back to it.
 */

export const MEMORY_KINDS = ["project", "decision", "assumption", "question", "evidence", "concept", "preference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_ID_PREFIXES: { readonly [K in MemoryKind]: string } = {
  project: "prj",
  decision: "dec",
  assumption: "asm",
  question: "que",
  evidence: "evd",
  concept: "cpt",
  preference: "prf",
};

export const MEMORY_STATUSES: { readonly [K in MemoryKind]: readonly [string, ...string[]] } = {
  project: ["active", "archived"],
  decision: ["proposed", "accepted", "superseded", "rejected"],
  assumption: ["open", "verified", "invalidated"],
  question: ["open", "resolved"],
  evidence: ["current", "stale", "unavailable"],
  concept: ["active", "deprecated"],
  preference: ["active", "revoked"],
};

/** Written without review (ADR-17). Their statuses are non-authoritative by construction. */
export const AUTO_PERSIST_KINDS = ["evidence", "concept", "assumption", "question"] as const;
/** Enter the review queue first; the orchestrator may accept them in autonomous mode (audited). */
export const REVIEW_REQUIRED_KINDS = ["decision", "preference"] as const;

export const MEMORY_RELATION_TYPES = ["supports", "contradicts", "depends_on", "supersedes", "affects", "originated_from"] as const;
export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

export const memoryIdSchema = z
  .string()
  .regex(/^(prj|dec|asm|que|evd|cpt|prf)-[0-9a-z][0-9a-z-]{2,62}$/, "memory id must be <kind-prefix>-<slug>")
  .brand<"MemoryId">();
export type MemoryId = z.infer<typeof memoryIdSchema>;

export const memoryRelationSchema = z.strictObject({
  type: z.enum(MEMORY_RELATION_TYPES),
  target: memoryIdSchema,
});
export type MemoryRelation = z.infer<typeof memoryRelationSchema>;

export const memoryNoteFrontmatterSchema = z
  .strictObject({
    schema_version: z.literal(1),
    id: memoryIdSchema,
    kind: z.enum(MEMORY_KINDS),
    project_id: projectIdSchema,
    scope: z.enum(["project", "branch", "user"]),
    branch: z.string().min(1).max(255).optional(),
    status: z.string().min(1),
    created_at: calendarDateSchema,
    updated_at: calendarDateSchema.optional(),
    reviewed_at: calendarDateSchema.optional(),
    source_run: runIdSchema.optional(),
    source_task: taskIdSchema.optional(),
    source_ref: z.string().min(1).max(1024).optional(),
    source_digest: digestSchema.optional(),
    confidence: z.enum(["high", "medium", "low"]),
    owner: z.enum(["human", "synorch"]),
    relations: z.array(memoryRelationSchema),
    tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9/_-]*$/, "tags are lower-case")).optional(),
  })
  .superRefine((note, context) => {
    if (!note.id.startsWith(`${MEMORY_ID_PREFIXES[note.kind]}-`)) {
      context.addIssue({ code: "custom", path: ["id"], message: `a ${note.kind} id starts with ${MEMORY_ID_PREFIXES[note.kind]}-` });
    }
    if (!MEMORY_STATUSES[note.kind].includes(note.status)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `${note.kind} status must be one of ${MEMORY_STATUSES[note.kind].join(", ")}`,
      });
    }
    if ((note.scope === "branch") !== (note.branch !== undefined)) {
      context.addIssue({ code: "custom", path: ["branch"], message: "branch is required exactly for branch scope" });
    }
    if (note.kind === "evidence" && (note.source_ref === undefined || note.source_digest === undefined)) {
      context.addIssue({ code: "custom", path: ["source_ref"], message: "evidence needs source_ref and source_digest" });
    }
    const authoritative =
      (note.kind === "decision" && note.status === "accepted") || (note.kind === "preference" && note.status === "active");
    if (authoritative && note.owner === "synorch" && note.reviewed_at === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reviewed_at"],
        message: "an authoritative decision or preference written by Synorch must record the review that accepted it",
      });
    }
    if (note.relations.some((relation) => relation.target === note.id)) {
      context.addIssue({ code: "custom", path: ["relations"], message: "a note cannot relate to itself" });
    }
  });
export type MemoryNoteFrontmatter = z.infer<typeof memoryNoteFrontmatterSchema>;

export const PROPOSAL_KINDS = ["note", "relation", "contradiction", "status-change"] as const;

export const memoryProposalSchema = z
  .strictObject({
    schema_version: z.literal(1),
    proposal_id: proposalIdSchema,
    kind: z.enum(PROPOSAL_KINDS),
    note: memoryNoteFrontmatterSchema.optional(),
    body: z.string().optional(),
    target: memoryIdSchema.optional(),
    relation: memoryRelationSchema.optional(),
    new_status: z.string().min(1).optional(),
    rationale: nonEmptyTextSchema,
    evidence: z.array(evidenceRefSchema).min(1),
    created_by: z.strictObject({ run_id: runIdSchema, task_id: taskIdSchema.optional() }),
    created_at: timestampSchema,
    state: z.enum(["pending", "accepted", "rejected", "deferred"]),
    decision: z
      .strictObject({
        by: z.enum(["user", "orchestrator"]),
        at: timestampSchema,
        reason: nonEmptyTextSchema,
        run_id: runIdSchema.optional(),
      })
      .optional(),
  })
  .superRefine((proposal, context) => {
    const need = (field: "note" | "target" | "relation" | "new_status", when: boolean): void => {
      if (when && proposal[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: `${proposal.kind} proposals require ${field}` });
      }
    };
    need("note", proposal.kind === "note");
    need("target", proposal.kind !== "note");
    need("relation", proposal.kind === "relation" || proposal.kind === "contradiction");
    need("new_status", proposal.kind === "status-change");
    if (proposal.kind === "contradiction" && proposal.relation !== undefined && proposal.relation.type !== "contradicts") {
      context.addIssue({ code: "custom", path: ["relation", "type"], message: "a contradiction proposal carries a contradicts relation" });
    }
    if ((proposal.state === "pending") !== (proposal.decision === undefined)) {
      context.addIssue({ code: "custom", path: ["decision"], message: "a decision is present exactly when the proposal is no longer pending" });
    }
    if (proposal.decision?.by === "orchestrator" && proposal.decision.run_id === undefined) {
      context.addIssue({ code: "custom", path: ["decision", "run_id"], message: "an orchestrator decision records the run that made it" });
    }
  });
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;

/** Where personal memory lives unless overridden: `~/<segments>/<project-id>/`. */
export const DEFAULT_MEMORY_ROOT_SEGMENTS = [".synorch", "memory"] as const;

/**
 * The `memory` configuration section (ADR-16). `root` replaces the personal vault root for this
 * project (`~` expands to home, relative paths resolve against home); `team_root` names a shared
 * team vault, which is reserved: v1 accepts it but neither reads nor writes it.
 */
export const memoryConfigSchema = z.strictObject({
  root: z.string().trim().min(1).max(1024).optional(),
  team_root: z.string().trim().min(1).max(1024).optional(),
});
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

export interface MemoryQuery {
  readonly projectId: string;
  readonly branch: string | undefined;
  readonly text: string | undefined;
  readonly kinds: readonly MemoryKind[] | undefined;
  readonly includeInactive: boolean;
  readonly limit: number;
}

export interface MemoryNote {
  readonly frontmatter: MemoryNoteFrontmatter;
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly digest: z.infer<typeof digestSchema>;
}

export interface RecalledMemory {
  readonly note: MemoryNote;
  /** Why this note was selected: shown to the user and to the model next to the claim. */
  readonly reason: string;
  readonly stale: boolean;
}

/** The audit trail of one decision, as `memory/proposal_decided` and `memory/persisted` payloads. */
export interface MemoryDecisionOutcome {
  readonly proposal: MemoryProposal;
  readonly decided: SessionEventOf<"memory/proposal_decided">["data"];
  /** The note an accepted proposal created or changed; absent for rejected/deferred. */
  readonly persisted: SessionEventOf<"memory/persisted">["data"] | undefined;
  /** Set when the orchestrator decided: the run accountable for it (the event's `run_id`). */
  readonly runId: RunId | undefined;
}

export interface MemoryStore {
  readonly root: string;
  get(id: MemoryId): Promise<MemoryNote | undefined>;
  search(query: MemoryQuery): Promise<readonly RecalledMemory[]>;
  /** Writes only auto-persist kinds; fails with a conflict if the file changed since `expectedDigest`. */
  persist(note: Omit<MemoryNote, "path" | "digest">, expectedDigest: string | undefined): Promise<MemoryNote>;
  propose(proposal: MemoryProposal): Promise<void>;
  pending(): Promise<readonly MemoryProposal[]>;
  /**
   * Applies a decision and returns what the caller must append to the session log: the store
   * persists notes, it never writes events itself.
   */
  decide(
    proposalId: z.infer<typeof proposalIdSchema>,
    decision: NonNullable<MemoryProposal["decision"]>,
    state: "accepted" | "rejected" | "deferred",
  ): Promise<MemoryDecisionOutcome>;
  reindex(): Promise<{ readonly notes: number; readonly broken_links: number }>;
}
