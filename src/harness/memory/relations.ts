import {
  createId,
  memoryIdSchema,
  memoryProposalSchema,
  type EvidenceRef,
  type MemoryProposal,
  type MemoryRelationType,
  type RunId,
  type TaskId,
} from "../contracts/index.ts";
import type { IndexedNote } from "./memory-index.ts";

/**
 * Rule-based relation and contradiction candidates (obsidian/README.md §6.1 step 2): the same
 * memory id or the same source path seen from two notes. A candidate is never a fact; it becomes
 * one only through a queued proposal and a recorded decision.
 */

export const INACTIVE_STATUSES: readonly string[] = ["superseded", "rejected", "invalidated", "unavailable", "deprecated", "revoked", "archived", "resolved"];

export type CandidateRule = "mentions-id" | "same-source" | "shared-affects";

export interface MemoryCandidate {
  readonly kind: "relation" | "contradiction";
  readonly rule: CandidateRule;
  /** The note that would carry the relation. */
  readonly source: string;
  readonly target: string;
  readonly relation: { readonly type: MemoryRelationType; readonly target: string };
  readonly rationale: string;
  readonly evidence: readonly EvidenceRef[];
}

function isAuthoritative(note: IndexedNote): boolean {
  return (note.kind === "decision" && (note.status === "accepted" || note.status === "proposed")) || (note.kind === "preference" && note.status === "active");
}

function sourcePath(note: IndexedNote): string | undefined {
  return note.source_ref?.replace(/[@#].*$/, "").replaceAll("\\", "/").trim() || undefined;
}

function related(left: IndexedNote, right: IndexedNote): boolean {
  return left.relations.some((relation) => relation.target === right.id) || right.relations.some((relation) => relation.target === left.id);
}

function noteEvidence(note: IndexedNote): EvidenceRef {
  return { kind: "file", ref: `memory:${note.path}`, produced_by: "orchestrator" };
}

export function findCandidates(notes: readonly IndexedNote[]): MemoryCandidate[] {
  const active = notes.filter((note) => !INACTIVE_STATUSES.includes(note.status));
  const byId = new Map(active.map((note) => [note.id, note]));
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: MemoryCandidate): void => {
    const key = candidate.kind === "contradiction" ? [candidate.source, candidate.target].sort().join("|") : `${candidate.source}>${candidate.target}`;
    if (seen.has(`${candidate.kind}:${key}`)) return;
    seen.add(`${candidate.kind}:${key}`);
    candidates.push(candidate);
  };

  for (const note of active) {
    for (const mentioned of note.mentions) {
      const target = byId.get(mentioned);
      if (target === undefined || related(note, target)) continue;
      add({
        kind: "relation",
        rule: "mentions-id",
        source: note.id,
        target: target.id,
        relation: { type: "affects", target: target.id },
        rationale: `${note.id} names ${target.id} in its text but records no relation to it.`,
        evidence: [noteEvidence(note), noteEvidence(target)],
      });
    }
  }

  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const left = active[leftIndex];
      const right = active[rightIndex];
      if (left === undefined || right === undefined || left.id === right.id) continue;
      const leftSource = sourcePath(left);
      if (leftSource !== undefined && leftSource === sourcePath(right) && !related(left, right)) {
        const evidence: EvidenceRef[] = [{ kind: "file", ref: leftSource, produced_by: "orchestrator" }, noteEvidence(left), noteEvidence(right)];
        if (isAuthoritative(left) && isAuthoritative(right)) {
          add({
            kind: "contradiction",
            rule: "same-source",
            source: left.id,
            target: right.id,
            relation: { type: "contradicts", target: right.id },
            rationale: `${left.id} and ${right.id} are both binding and derive from ${leftSource}; confirm they agree.`,
            evidence,
          });
        } else {
          const [from, to] = right.kind === "evidence" && left.kind !== "evidence" ? [left, right] : left.kind === "evidence" && right.kind !== "evidence" ? [right, left] : [left, right];
          add({
            kind: "relation",
            rule: "same-source",
            source: from.id,
            target: to.id,
            relation: { type: to.kind === "evidence" ? "originated_from" : "affects", target: to.id },
            rationale: `${from.id} and ${to.id} both cite ${leftSource}.`,
            evidence,
          });
        }
      }
      if (isAuthoritative(left) && isAuthoritative(right) && left.kind === right.kind && !related(left, right)) {
        const shared = left.relations
          .filter((relation) => relation.type === "affects")
          .map((relation) => relation.target)
          .find((target) => right.relations.some((relation) => relation.type === "affects" && relation.target === target));
        if (shared !== undefined) {
          add({
            kind: "contradiction",
            rule: "shared-affects",
            source: left.id,
            target: right.id,
            relation: { type: "contradicts", target: right.id },
            rationale: `${left.id} and ${right.id} both affect ${shared}; two binding ${left.kind}s on one subject may conflict.`,
            evidence: [noteEvidence(left), noteEvidence(right)],
          });
        }
      }
    }
  }
  return candidates;
}

/** Turns a candidate into a pending, schema-valid proposal for the review queue. */
export function candidateToProposal(
  candidate: MemoryCandidate,
  createdBy: { readonly run_id: RunId; readonly task_id?: TaskId | undefined },
  now: Date,
): MemoryProposal {
  return memoryProposalSchema.parse({
    schema_version: 1,
    proposal_id: createId("proposal", now.getTime()),
    kind: candidate.kind,
    target: memoryIdSchema.parse(candidate.source),
    relation: { type: candidate.relation.type, target: candidate.relation.target },
    rationale: candidate.rationale,
    evidence: candidate.evidence,
    created_by: createdBy.task_id === undefined ? { run_id: createdBy.run_id } : { run_id: createdBy.run_id, task_id: createdBy.task_id },
    created_at: now.toISOString(),
    state: "pending",
  });
}
