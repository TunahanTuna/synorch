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

export const EVIDENCE_KINDS = ["tool-call", "test-run", "artifact", "file", "event", "review"] as const;
export const EVIDENCE_PRODUCERS = ["worker", "reviewer", "orchestrator", "user"] as const;

/** A pointer to proof. Evidence is never free text: it names something the event log can resolve. */
export const evidenceRefSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  ref: nonEmptyTextSchema,
  digest: digestSchema.optional(),
  produced_by: z.enum(EVIDENCE_PRODUCERS),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
