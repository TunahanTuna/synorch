import { z } from "zod";
import { AGENT_MODEL_TIERS } from "../../domain/canonical-contracts.ts";
import { digestSchema } from "./digest.ts";
import { attemptIdSchema } from "./ids.ts";

/** Wire format version shared by events, frames and packets unless a contract says otherwise. */
export const HARNESS_SCHEMA_VERSION = 1 as const;

export const AGENT_ROLES = ["orchestrator", "explorer", "implementer", "debugger", "reviewer"] as const;
export const WORKER_ROLES = ["explorer", "implementer", "debugger", "reviewer"] as const;
/** Roles that never own product paths for writing. */
export const READ_ONLY_ROLES = ["explorer", "reviewer"] as const;

export const agentRoleSchema = z.enum(AGENT_ROLES);
export const workerRoleSchema = z.enum(WORKER_ROLES);
export type AgentRole = (typeof AGENT_ROLES)[number];
export type WorkerRole = (typeof WORKER_ROLES)[number];

/** The canonical manifest tiers minus `any`: a runtime route always resolves to a concrete tier. */
export const modelTierSchema = z.enum(AGENT_MODEL_TIERS).exclude(["any"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const RISK_CLASSES = ["trivial", "standard", "high-risk"] as const;
export const riskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = (typeof RISK_CLASSES)[number];

export const timestampSchema = z.iso.datetime({ offset: true });
export const calendarDateSchema = z.iso.date();

export const nonEmptyTextSchema = z.string().trim().min(1);

export const ACTOR_KINDS = ["user", "orchestrator", "worker", "system", "policy", "provider"] as const;

export const actorSchema = z.strictObject({
  kind: z.enum(ACTOR_KINDS),
  role: agentRoleSchema.optional(),
  attempt_id: attemptIdSchema.optional(),
});
export type Actor = z.infer<typeof actorSchema>;

export const blobRefSchema = z.strictObject({
  digest: digestSchema,
  size_bytes: z.int().min(0),
  media_type: z.string().min(1).max(127),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

/**
 * Evidence kinds. The `harness-*` kinds are facts the harness computed itself (ADR-18): the result
 * of running the packet's verification commands in the attempt workspace, and the pinned diff.
 */
export const HARNESS_EVIDENCE_KINDS = ["harness-verification", "harness-diff"] as const;
export const EVIDENCE_KINDS = ["tool-call", "test-run", "artifact", "file", "event", "review", ...HARNESS_EVIDENCE_KINDS] as const;
export const EVIDENCE_PRODUCERS = ["worker", "reviewer", "orchestrator", "user", "harness"] as const;

/**
 * A pointer to proof. Evidence is never free text: it names something the event log can resolve.
 * `harness-*` kinds are produced by the harness and nothing else; the harness produces no other kind.
 */
export const evidenceRefSchema = z
  .strictObject({
    kind: z.enum(EVIDENCE_KINDS),
    ref: nonEmptyTextSchema,
    digest: digestSchema.optional(),
    produced_by: z.enum(EVIDENCE_PRODUCERS),
  })
  .superRefine((evidence, context) => {
    const harnessKind = (HARNESS_EVIDENCE_KINDS as readonly string[]).includes(evidence.kind);
    if (harnessKind !== (evidence.produced_by === "harness")) {
      context.addIssue({ code: "custom", path: ["produced_by"], message: "harness-* evidence is produced by the harness, and only by it" });
    }
  });
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
