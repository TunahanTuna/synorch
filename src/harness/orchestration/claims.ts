import type { z } from "zod";
import {
  REPORT_TOOL_NAMES,
  reviewReportInputSchema,
  taskReportInputSchema,
  type ReportToolName,
  type ReviewReportInput,
  type TaskReportInput,
} from "../contracts/index.ts";
import { latestReport, type AttemptLog } from "./attempt-log.ts";

/**
 * What a worker or reviewer *claims*. The channel is the structured report tool (`task_report`,
 * `review_report`): its input is validated by the gateway and recorded in the attempt log, and the
 * last succeeded call wins. A final fenced JSON block is accepted only as a fallback when no report
 * call succeeded; it is parsed with the same contract schema. Either way the claim carries only
 * narrative and evidence pointers: identity, changed paths, the artifact digest and tool call ids
 * come from the log and the real diff, and every pointer is verified against the log.
 */

export const workerClaimSchema = taskReportInputSchema;
export type WorkerClaim = TaskReportInput;
export const reviewerClaimSchema = reviewReportInputSchema;
export type ReviewerClaim = ReviewReportInput;

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
  | { readonly ok: true; readonly claim: T; readonly channel: "tool" | "json-block" }
  | { readonly ok: false; readonly problems: readonly string[] };

function validate<T>(schema: z.ZodType<T>, raw: unknown, channel: "tool" | "json-block"): ClaimResult<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`) };
  }
  return { ok: true, claim: parsed.data, channel };
}

/** Parses a claim from a final message's JSON block (the fallback channel). */
export function parseClaim<T>(schema: z.ZodType<T>, text: string | undefined): ClaimResult<T> {
  if (text === undefined || text.trim() === "") return { ok: false, problems: ["no report tool call and the final message is empty"] };
  const raw = extractJsonBlock(text);
  if (raw === undefined) return { ok: false, problems: ["no report tool call and the final message has no JSON block"] };
  return validate(schema, raw, "json-block");
}

/** Reads the claim from the last succeeded report tool call, falling back to the final JSON block. */
export function readClaim<T>(schema: z.ZodType<T>, log: AttemptLog, tool: ReportToolName): ClaimResult<T> {
  const reported = latestReport(log, tool);
  if (reported !== undefined) return validate(schema, reported, "tool");
  return parseClaim(schema, log.finalAssistantText);
}

export const WORKER_REPORT_INSTRUCTIONS = [
  `When you are done, call the \`${REPORT_TOOL_NAMES.task}\` tool exactly once as your last action with your status, summary and`,
  'acceptance_evidence per criterion (evidence kinds: tool-call|test-run|file; ref = the [#n] shown before a tool result of this attempt, written "#n"; produced_by: worker).',
  "The harness runs the packet's verification commands itself after your turn and computes the diff; do not list changed files. If a ref does not resolve, the tool tells you which refs are valid.",
  "If the tool is unavailable, reply with the same object in one ```json block.",
].join("\n");

export const REVIEWER_REPORT_INSTRUCTIONS = [
  `Finish by calling the \`${REPORT_TOOL_NAMES.review}\` tool exactly once with a verdict (met|not_met|unverifiable) per criterion,`,
  "findings (F-<n>, blocker|major|minor|info) and decision accept|revise|block. If the tool is unavailable, reply with the same object in one ```json block.",
  'A met verdict needs independent evidence: a tool call you made in this review (ref "#n", produced_by: reviewer) or a passed harness-verification record not marked [supporting only] (its ref, produced_by: harness). Worker evidence, a harness-diff or a read-only check alone is not enough; with no such record, run the check yourself.',
].join("\n");
