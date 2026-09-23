import {
  packetDigest,
  type CompletionPacket,
  type Digest,
  type EvidenceRef,
  type ReviewPacket,
  type TaskContextPacket,
} from "../contracts/index.ts";
import type { AttemptLog } from "./attempt-log.ts";
import { findScopeViolations, normalizeWorkspacePath } from "./paths.ts";

/**
 * Evidence is a pointer the log can resolve, never prose. A worker's evidence resolves against its
 * own attempt; a reviewer's `produced_by: reviewer` evidence resolves only against the reviewer's
 * own attempt, so a reviewer cannot pass off the implementer's tool calls as its own. A compaction
 * summary never counts as evidence (ADR-11).
 */

export interface EvidenceIndex {
  readonly log: AttemptLog;
  readonly artifactDigest: Digest | undefined;
  readonly changedPaths: readonly string[];
  /** Digest of a file in the attempt's workspace, or undefined when it does not exist. */
  fileDigest(path: string): Promise<Digest | undefined>;
}

const EVENT_REF = /^(?:(ses_[0-9A-HJKMNP-TV-Z]{26})#)?(\d+)$/;

/** Returns why the reference does not resolve, or undefined when it does. */
export async function resolveEvidence(ref: EvidenceRef, index: EvidenceIndex): Promise<string | undefined> {
  if (ref.digest !== undefined && index.log.compactionBlobs.has(ref.digest)) {
    return `${ref.kind}:${ref.ref} is a compaction summary, which is never evidence`;
  }
  switch (ref.kind) {
    case "tool-call":
    case "test-run": {
      const call = index.log.toolCalls.get(ref.ref);
      if (call === undefined) return `${ref.kind}:${ref.ref} is not a tool call of this attempt`;
      if (call.state !== "succeeded") return `${ref.kind}:${ref.ref} ended ${call.state}`;
      if (ref.kind === "test-run" && call.exitCode !== undefined && call.exitCode !== 0) {
        return `test-run:${ref.ref} exited ${call.exitCode}`;
      }
      return undefined;
    }
    case "artifact": {
      const target = ref.digest ?? ref.ref;
      if (index.log.compactionBlobs.has(target)) return `artifact:${target} is a compaction summary, which is never evidence`;
      if (index.artifactDigest === undefined || target !== index.artifactDigest) return `artifact:${target} is not the pinned artifact`;
      return undefined;
    }
    case "file": {
      const path = normalizeWorkspacePath(ref.ref.split("#")[0] ?? "");
      if (path === undefined || path === ".") return `file:${ref.ref} is not a workspace path`;
      const digest = await index.fileDigest(path);
      if (digest === undefined) return `file:${path} does not exist`;
      if (ref.digest !== undefined && ref.digest !== digest) return `file:${path} changed since it was cited`;
      return undefined;
    }
    case "event": {
      const match = EVENT_REF.exec(ref.ref);
      if (match === null) return `event:${ref.ref} is not <session>#<seq>`;
      if (match[1] !== undefined && match[1] !== index.log.sessionId) return `event:${ref.ref} belongs to another session`;
      const type = index.log.eventTypes.get(Number(match[2]));
      if (type === undefined) return `event:${ref.ref} does not exist`;
      if (type === "context/compacted") return `event:${ref.ref} is a compaction summary, which is never evidence`;
      return undefined;
    }
    case "review":
      return `review:${ref.ref} is a review pointer, not first-hand evidence`;
  }
}

export interface CompletionVerification {
  /** `revise`: only evidence is missing; `reject`: scope or integrity is violated. */
  readonly decision: "pass" | "revise" | "reject";
  readonly problems: readonly string[];
  readonly unevidenced: readonly string[];
}

export interface CompletionVerificationOptions {
  /**
   * Triage acceptance of a read-only task (the orchestrator accepted its findings): these criteria
   * are waived, and a `partial`/`needs_context` status is accepted. Every other check still applies.
   */
  readonly waivedCriteria?: readonly string[];
}

/** Orchestrator-side verification of a completed attempt against the real diff and the log. */
export async function verifyCompletion(
  packet: TaskContextPacket,
  completion: CompletionPacket,
  index: EvidenceIndex,
  platform: NodeJS.Platform = process.platform,
  options: CompletionVerificationOptions = {},
): Promise<CompletionVerification> {
  const rejections: string[] = [];
  const revisions: string[] = [];
  const waived = new Set(options.waivedCriteria ?? []);
  const triaged = options.waivedCriteria !== undefined;
  if (completion.task_id !== packet.task_id) rejections.push("completion belongs to another task");
  if (completion.packet_digest !== packetDigest(packet)) rejections.push("completion answers another packet version");
  const accepted = completion.status === "completed" || (triaged && packet.write_mode !== "owned-paths" && (completion.status === "partial" || completion.status === "needs_context"));
  if (!accepted) rejections.push(`status is ${completion.status}`);

  const changed = index.changedPaths;
  if (packet.write_mode !== "owned-paths" && changed.length > 0) {
    rejections.push(`${packet.write_mode} attempt changed files: ${changed.join(", ")}`);
  }
  for (const violation of findScopeViolations(changed, { owned: packet.scope.owned_paths, forbidden: packet.scope.forbidden_paths }, platform)) {
    if (packet.write_mode === "owned-paths") rejections.push(`changed ${violation.path} (${violation.reason})`);
  }
  const reported = new Set(completion.changed_paths.map((change) => change.path));
  if (reported.size !== changed.length || changed.some((path) => !reported.has(path))) {
    rejections.push("reported changed paths differ from the real diff");
  }
  if (changed.length > 0 && completion.artifact_digest !== index.artifactDigest) {
    rejections.push("artifact digest does not match the workspace");
  }
  if (packet.write_mode === "rca-only" && completion.root_cause === undefined) {
    revisions.push("an rca-only attempt must report root_cause");
  }

  const known = new Set(packet.acceptance_criteria.map((criterion) => criterion.id));
  const unevidenced: string[] = [];
  for (const criterion of packet.acceptance_criteria) {
    if (waived.has(criterion.id)) continue;
    const entry = completion.acceptance_evidence.find((candidate) => candidate.criterion_id === criterion.id);
    const resolved: string[] = [];
    const failures: string[] = [];
    for (const evidence of entry?.evidence ?? []) {
      const problem = evidence.produced_by === "worker" ? await resolveEvidence(evidence, index) : `${evidence.kind}:${evidence.ref} is not worker evidence`;
      if (problem === undefined) resolved.push(evidence.ref);
      else failures.push(problem);
    }
    if (resolved.length === 0) {
      unevidenced.push(criterion.id);
      revisions.push(`${criterion.id} has no resolvable evidence${failures.length > 0 ? ` (${failures.join("; ")})` : ""}`);
    }
  }
  for (const entry of completion.acceptance_evidence) {
    if (!known.has(entry.criterion_id)) revisions.push(`evidence for unknown criterion ${entry.criterion_id}`);
  }
  for (const command of completion.commands_run) {
    const problem = await resolveEvidence(command.evidence, index);
    if (problem !== undefined) revisions.push(`command "${command.command}": ${problem}`);
  }
  for (const required of packet.verification.commands) {
    const ran = completion.commands_run.find((command) => command.command === required);
    const skipped = completion.skipped_checks.some((check) => check.check === required);
    if (ran === undefined && !skipped) revisions.push(`verification command "${required}" was neither run nor explicitly skipped`);
    else if (ran !== undefined && ran.exit_code !== 0) revisions.push(`verification command "${required}" exited ${ran.exit_code}`);
  }

  if (rejections.length > 0) return { decision: "reject", problems: [...rejections, ...revisions], unevidenced };
  if (revisions.length > 0) return { decision: "revise", problems: revisions, unevidenced };
  return { decision: "pass", problems: [], unevidenced };
}

export interface ReviewVerification {
  /** `invalid`: the review itself cannot be trusted (wrong artifact, unresolvable reviewer evidence). */
  readonly decision: "accept" | "revise" | "block" | "invalid";
  readonly problems: readonly string[];
}

export async function verifyReview(
  review: ReviewPacket,
  packet: TaskContextPacket,
  completion: CompletionPacket,
  indexes: { readonly worker: EvidenceIndex; readonly reviewer: EvidenceIndex },
): Promise<ReviewVerification> {
  const invalid: string[] = [];
  const revise: string[] = [];
  if (review.task_id !== packet.task_id) invalid.push("review belongs to another task");
  if (review.reviewed_attempt_id !== completion.attempt_id) invalid.push("review names another attempt");
  if (review.reviewed_artifact_digest !== indexes.worker.artifactDigest) invalid.push("review is not bound to the pinned artifact");
  if (review.completion_digest !== packetDigest(completion)) invalid.push("review is bound to another completion packet");
  for (const [position, criterion] of review.criteria.entries()) {
    for (const evidence of criterion.evidence) {
      const index = evidence.produced_by === "reviewer" ? indexes.reviewer : evidence.produced_by === "worker" ? indexes.worker : undefined;
      if (index === undefined) {
        invalid.push(`criteria[${position}]: ${evidence.produced_by} evidence is not accepted in a review`);
        continue;
      }
      const problem = await resolveEvidence(evidence, index);
      if (problem !== undefined) invalid.push(`criteria[${position}] ${criterion.criterion_id}: ${problem}`);
    }
  }
  for (const criterion of packet.acceptance_criteria) {
    const verdict = review.criteria.find((candidate) => candidate.criterion_id === criterion.id);
    if (verdict === undefined) revise.push(`${criterion.id} was not assessed`);
    else if (verdict.verdict !== "met") revise.push(`${criterion.id} is ${verdict.verdict}`);
    else if (!verdict.evidence.some((evidence) => evidence.produced_by === "reviewer")) revise.push(`${criterion.id} has no reviewer evidence`);
  }
  if (invalid.length > 0) return { decision: "invalid", problems: invalid };
  if (review.decision === "block") return { decision: "block", problems: revise };
  if (review.decision === "revise" || revise.length > 0) {
    return { decision: "revise", problems: revise.length > 0 ? revise : ["the reviewer requested changes"] };
  }
  return { decision: "accept", problems: [] };
}

/** ADR-09: standard and high-risk tasks close only through an accepting review. */
export function reviewRequired(packet: Pick<TaskContextPacket, "risk" | "role">): boolean {
  return packet.risk !== "trivial" && packet.role !== "reviewer";
}

/** The single gate for `→ completed`: a required review must exist and must be an accept. */
export function mayComplete(packet: Pick<TaskContextPacket, "risk" | "role">, review: ReviewVerification | undefined): boolean {
  if (!reviewRequired(packet)) return true;
  return review !== undefined && review.decision === "accept";
}
