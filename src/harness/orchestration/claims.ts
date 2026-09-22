import { z } from "zod";
import {
  acceptanceCriterionIdSchema,
  COMPLETION_STATUSES,
  evidenceRefSchema,
  FINDING_SEVERITIES,
  nonEmptyTextSchema,
  pathPatternSchema,
} from "../contracts/index.ts";

/**
 * What a worker or reviewer *claims* in its final message. Claims are parsed from the last fenced
 * JSON block of the final assistant message. Identity, changed paths, the artifact digest and tool
 * call ids are never taken from a claim: the harness computes them from the log and the real diff.
 */

export const workerClaimSchema = z.object({
  status: z.enum(COMPLETION_STATUSES),
  summary: nonEmptyTextSchema,
  acceptance_evidence: z
    .array(z.object({ criterion_id: acceptanceCriterionIdSchema, evidence: z.array(evidenceRefSchema).min(1) }))
    .default([]),
  commands_run: z
    .array(z.object({ command: z.string().min(1), exit_code: z.int(), evidence: evidenceRefSchema }))
    .default([]),
  decisions_made: z.array(nonEmptyTextSchema).default([]),
  skipped_checks: z.array(z.object({ check: z.string().min(1), reason: nonEmptyTextSchema })).default([]),
  unresolved_risks: z.array(nonEmptyTextSchema).default([]),
  recommended_context_updates: z.array(nonEmptyTextSchema).default([]),
  root_cause: z.string().min(1).optional(),
});
export type WorkerClaim = z.infer<typeof workerClaimSchema>;

export const reviewerClaimSchema = z.object({
  criteria: z
    .array(
      z.object({
        criterion_id: acceptanceCriterionIdSchema,
        verdict: z.enum(["met", "not_met", "unverifiable"]),
        evidence: z.array(evidenceRefSchema).default([]),
        note: z.string().optional(),
      }),
    )
    .min(1),
  findings: z
    .array(
      z.object({
        id: z.string().regex(/^F-[1-9]\d*$/),
        severity: z.enum(FINDING_SEVERITIES),
        summary: nonEmptyTextSchema,
        path: pathPatternSchema.optional(),
        line: z.int().positive().optional(),
        reproduction: z.string().min(1).optional(),
        recommendation: z.string().min(1).optional(),
      }),
    )
    .default([]),
  decision: z.enum(["accept", "revise", "block"]),
});
export type ReviewerClaim = z.infer<typeof reviewerClaimSchema>;

/** The last ```json fenced block, or the whole text when it is a bare JSON object. */
export function extractJsonBlock(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = fences.map((match) => match[1] ?? "").reverse();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

export type ClaimResult<T> =
  | { readonly ok: true; readonly claim: T }
  | { readonly ok: false; readonly problems: readonly string[] };

export function parseClaim<T>(schema: z.ZodType<T>, text: string | undefined): ClaimResult<T> {
  if (text === undefined || text.trim() === "") return { ok: false, problems: ["the final message is empty"] };
  const raw = extractJsonBlock(text);
  if (raw === undefined) return { ok: false, problems: ["the final message has no JSON block"] };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`) };
  }
  return { ok: true, claim: parsed.data };
}

export const WORKER_REPORT_INSTRUCTIONS = [
  "When you are done, reply with exactly one ```json block containing:",
  '{"status": "completed|partial|failed|blocked|needs_context", "summary": "...",',
  ' "acceptance_evidence": [{"criterion_id": "AC-1", "evidence": [{"kind": "tool-call|test-run|file|artifact|event", "ref": "<tool call id, path or event>", "produced_by": "worker"}]}],',
  ' "commands_run": [{"command": "...", "exit_code": 0, "evidence": {"kind": "tool-call", "ref": "<tool call id>", "produced_by": "worker"}}],',
  ' "decisions_made": [], "skipped_checks": [], "unresolved_risks": [], "recommended_context_updates": []}',
  "Changed files and the diff are computed by the harness; do not list them. Evidence must name tool call ids from this attempt.",
].join("\n");

export const REVIEWER_REPORT_INSTRUCTIONS = [
  "Reply with exactly one ```json block containing:",
  '{"criteria": [{"criterion_id": "AC-1", "verdict": "met|not_met|unverifiable", "evidence": [{"kind": "test-run", "ref": "<your tool call id>", "produced_by": "reviewer"}]}],',
  ' "findings": [{"id": "F-1", "severity": "blocker|major|minor|info", "summary": "..."}], "decision": "accept|revise|block"}',
  "A met verdict needs evidence you produced yourself in this review (your own tool call ids). Worker evidence alone is not enough.",
].join("\n");
