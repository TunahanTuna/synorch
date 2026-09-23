import { z } from "zod";
import { EVIDENCE_KINDS, EVIDENCE_PRODUCERS, evidenceRefSchema, nonEmptyTextSchema } from "./common.ts";
import { acceptanceCriterionIdSchema, toolCallIdSchema } from "./ids.ts";
import { pathPatternSchema } from "./paths.ts";
import { PROCESS_TERMINATIONS, type ToolResult } from "./tools.ts";

/**
 * Harness-computed evidence (ADR-18). The harness computes the truth (verification command
 * results, the diff, which tool calls ran), the model supplies the narrative and pointers. Pointers
 * are resolved tolerantly and every resolution is recorded with the method that matched.
 */

/**
 * Short tool ref. Every tool result shown to a model starts with `[#n] `, where `n` is the call's
 * ordinal among the tool calls of its attempt (of its session when there is no attempt), from 1, in
 * `tool/call_proposed` order. The gateway assigns it and records it in `tool/call_proposed.ref`;
 * `#n` maps back to exactly one `ToolCallId`. Models cite `#n` as evidence.
 */
export const toolRefOrdinalSchema = z.int().min(1).max(999_999);

export function formatToolRef(ordinal: number): string {
  return `#${ordinal}`;
}

const SHORT_REF = /^\s*`?\[?#([1-9]\d{0,5})\]?`?(?![0-9A-Za-z_])/;

/** The ordinal of a leading `#n` / `[#n]` token (prose may follow it), or undefined. */
export function parseToolRef(text: string): number | undefined {
  const match = SHORT_REF.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The model-visible text of a tool result: `[#n] ` (when a ref exists), then the tool's text, then
 * `Error [<code>]: <message>` on its own line for an error. An empty successful result reads `ok`.
 * This is the one rendering; adapters send it verbatim.
 */
export function renderToolResultText(ref: number | undefined, result: Pick<ToolResult, "text" | "error">): string {
  const error = result.error === undefined ? undefined : `Error [${result.error.code}]: ${result.error.message}`;
  const body = error === undefined ? (result.text === "" ? "ok" : result.text) : result.text === "" ? error : `${result.text}\n${error}`;
  return ref === undefined ? body : `[${formatToolRef(ref)}] ${body}`;
}

/**
 * How a model-written evidence pointer was matched, in resolver order for `tool-call`, `test-run`
 * and `file` pointers: exact harness `ToolCallId`, `#n` short ref, provider call id, tool name plus
 * argument overlap (a leading `functions.` / `mcp__synorch__` prefix is ignored), then the first
 * path-like token. `artifact-digest` and `event-ref` match their own syntaxes; `harness-record`
 * resolves `harness-*` pointers; `harness-substitute` marks a criterion evidenced by harness facts
 * after the model's pointers stayed unresolved through the correction round.
 */
export const EVIDENCE_RESOLUTION_METHODS = [
  "tool-call-id",
  "short-ref",
  "provider-call-id",
  "tool-name-args",
  "path-token",
  "artifact-digest",
  "event-ref",
  "harness-record",
  "harness-substitute",
] as const;
export type EvidenceResolutionMethod = (typeof EVIDENCE_RESOLUTION_METHODS)[number];

/** The tolerant order for tool-call, test-run and file pointers; the first match wins. */
export const TOOL_EVIDENCE_RESOLUTION_ORDER = ["tool-call-id", "short-ref", "provider-call-id", "tool-name-args", "path-token"] as const satisfies readonly EvidenceResolutionMethod[];

/** One pointer's resolution, recorded in the completion or review packet. */
export const evidenceResolutionSchema = z
  .strictObject({
    /** Absent for a `commands_run` pointer. */
    criterion_id: acceptanceCriterionIdSchema.optional(),
    kind: z.enum(EVIDENCE_KINDS),
    /** The pointer exactly as the model wrote it (bounded). */
    ref: z.string().min(1).max(2000),
    produced_by: z.enum(EVIDENCE_PRODUCERS),
    status: z.enum(["resolved", "unresolved"]),
    method: z.enum(EVIDENCE_RESOLUTION_METHODS).optional(),
    tool_call_id: toolCallIdSchema.optional(),
    path: pathPatternSchema.optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .superRefine((resolution, context) => {
    const resolved = resolution.status === "resolved";
    if (resolved !== (resolution.method !== undefined)) {
      context.addIssue({ code: "custom", path: ["method"], message: "a method is recorded exactly when the pointer resolved" });
    }
    if (resolved === (resolution.reason !== undefined)) {
      context.addIssue({ code: "custom", path: ["reason"], message: "a reason is recorded exactly when the pointer did not resolve" });
    }
    if (!resolved && (resolution.tool_call_id !== undefined || resolution.path !== undefined)) {
      context.addIssue({ code: "custom", path: ["status"], message: "an unresolved pointer names no target" });
    }
  });
export type EvidenceResolution = z.infer<typeof evidenceResolutionSchema>;

/**
 * Outcome of one harness-run verification command. `passed`: it ran and exited 0; `failed`: it ran
 * (or was started) and did not exit 0; `not-run`: the harness could not run it (not expressible as
 * argv, refused by policy, no sandbox) and `reason` says why.
 */
export const HARNESS_VERIFICATION_STATUSES = ["passed", "failed", "not-run"] as const;
export type HarnessVerificationStatus = (typeof HARNESS_VERIFICATION_STATUSES)[number];

interface VerificationShape {
  readonly status: HarnessVerificationStatus;
  readonly termination?: (typeof PROCESS_TERMINATIONS)[number] | undefined;
  readonly exit_code: number | null;
  readonly reason?: string | undefined;
}

/** Shared by `harnessVerificationSchema` and the `attempt/verification_ran` event. */
export function checkVerificationOutcome(outcome: VerificationShape, context: z.RefinementCtx): void {
  const passed = outcome.termination === "exited" && outcome.exit_code === 0;
  if ((outcome.status === "passed") !== passed) {
    context.addIssue({ code: "custom", path: ["status"], message: "passed means the command exited with code 0" });
  }
  if ((outcome.status === "not-run") !== (outcome.termination === undefined)) {
    context.addIssue({ code: "custom", path: ["termination"], message: "a termination is recorded exactly when the command was started" });
  }
  if (outcome.status === "not-run" && (outcome.reason === undefined || outcome.exit_code !== null)) {
    context.addIssue({ code: "custom", path: ["reason"], message: "a command that was not run has a reason and no exit code" });
  }
}

/**
 * A harness verification result as the completion packet carries it. `evidence` is its pointer:
 * kind `harness-verification`, produced by `harness`, `ref` = `<session_id>#<seq>` of the
 * `attempt/verification_ran` event, `digest` = the output blob digest when output was stored.
 */
export const harnessVerificationSchema = z
  .strictObject({
    /** 1-based position of the command in the packet's `verification.commands`. */
    ordinal: z.int().min(1).max(100),
    command: z.string().min(1).max(4000),
    status: z.enum(HARNESS_VERIFICATION_STATUSES),
    termination: z.enum(PROCESS_TERMINATIONS).optional(),
    exit_code: z.int().nullable(),
    reason: z.string().min(1).max(500).optional(),
    evidence: evidenceRefSchema,
  })
  .superRefine((record, context) => {
    checkVerificationOutcome(record, context);
    if (record.evidence.kind !== "harness-verification") {
      context.addIssue({ code: "custom", path: ["evidence", "kind"], message: "a verification record points at harness-verification evidence" });
    }
  });
export type HarnessVerification = z.infer<typeof harnessVerificationSchema>;

/**
 * Everything the harness proved about an attempt without asking the model: the verification
 * commands it ran after the worker's turn, and the pinned diff (`harness-diff`, `ref` = artifact
 * digest, `changed_paths` = the real diff).
 */
export const harnessEvidenceSchema = z
  .strictObject({
    verification: z.array(harnessVerificationSchema).max(100),
    diff: z
      .strictObject({
        evidence: evidenceRefSchema,
        changed_paths: z.array(pathPatternSchema),
      })
      .optional(),
  })
  .superRefine((harness, context) => {
    if (harness.diff !== undefined && harness.diff.evidence.kind !== "harness-diff") {
      context.addIssue({ code: "custom", path: ["diff", "evidence", "kind"], message: "the diff record points at harness-diff evidence" });
    }
    const ordinals = new Set<number>();
    for (const [index, record] of harness.verification.entries()) {
      if (ordinals.has(record.ordinal)) context.addIssue({ code: "custom", path: ["verification", index, "ordinal"], message: "duplicate verification ordinal" });
      ordinals.add(record.ordinal);
    }
  });
export type HarnessEvidence = z.infer<typeof harnessEvidenceSchema>;

/**
 * In-session repair rounds (ADR-18 D2) recorded as `attempt/repair_requested`. `evidence-repair`:
 * the work stands but pointers stayed unresolved; `verification-repair`: a harness-run verification
 * command failed. Both resume the *same* attempt session and keep its workspace; both consume the
 * `evidence_repairs` budget. The one in-tool report correction is not a repair round.
 */
export const REPAIR_KINDS = ["evidence-repair", "verification-repair"] as const;
export type RepairKind = (typeof REPAIR_KINDS)[number];

/** A report tool rejected for unresolved evidence may be corrected this many times in the same session. */
export const REPORT_CORRECTION_ROUNDS = 1 as const;

/** Repair accounting a completion or review packet carries. */
export const repairCountsSchema = z.strictObject({
  report_corrections: z.int().min(0).max(REPORT_CORRECTION_ROUNDS),
  evidence_repairs: z.int().min(0).max(10),
  verification_repairs: z.int().min(0).max(10),
});
export type RepairCounts = z.infer<typeof repairCountsSchema>;

/**
 * Separate budgets per task (ADR-18 D2): fresh attempts after triage (`triage_retries`), in-session
 * repairs (`evidence_repairs`, shared by evidence and verification repairs) and implementer
 * revisions after a review (`review_revisions`). An exhausted budget consults the orchestrator
 * (`task_triage`); it never fails the task on its own.
 */
export const orchestrationBudgetsSchema = z.strictObject({
  triage_retries: z.int().min(0).max(5).default(1),
  evidence_repairs: z.int().min(0).max(5).default(2),
  review_revisions: z.int().min(0).max(5).default(2),
});
export type OrchestrationBudgets = z.infer<typeof orchestrationBudgetsSchema>;
export const DEFAULT_ORCHESTRATION_BUDGETS: OrchestrationBudgets = orchestrationBudgetsSchema.parse({});

/**
 * A valid pointer the correction message offers the model: `#n`, the tool, a short summary of its
 * arguments and outcome (e.g. `#5 exec node check.mjs -> exit 0`).
 */
export interface EvidenceCandidate {
  readonly ref: number;
  readonly toolName: string;
  readonly summary: string;
}

/** Line-level problem of a rejected report, rendered into the `invalid_arguments` result. */
export interface EvidenceProblem {
  readonly criterionId: string | undefined;
  readonly ref: string;
  readonly reason: string;
}

/**
 * The actionable correction text of a report tool rejected for evidence (ADR-18 D1): one line per
 * problem, then the valid refs. It goes into the tool result `text` (bounded to 16 KiB); the error
 * message stays a one-line summary.
 */
export function formatEvidenceCorrection(problems: readonly EvidenceProblem[], candidates: readonly EvidenceCandidate[], roundsLeft: number): string {
  const lines = problems.map((problem) => `- ${problem.criterionId ?? "commands_run"}: '${problem.ref}' ${problem.reason}`);
  const valid = candidates.map((candidate) => `  ${formatToolRef(candidate.ref)} ${candidate.toolName} ${candidate.summary}`);
  const text = [
    "Evidence pointers that do not resolve:",
    ...lines,
    valid.length === 0 ? "No tool call of this attempt can serve as evidence yet." : "Valid refs (cite as \"#n\"):",
    ...valid,
    roundsLeft > 0 ? `Call the report tool again with corrected refs (${roundsLeft} correction left).` : "No correction left; the harness records the report as it is.",
  ].join("\n");
  return text.length <= 16 * 1024 ? text : `${text.slice(0, 16 * 1024 - 20)}\n[truncated]`;
}

/** Bounded, non-empty problem list of a repair request. */
export const repairProblemsSchema = z.array(nonEmptyTextSchema.max(2000)).min(1).max(50);
