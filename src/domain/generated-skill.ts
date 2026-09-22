import { z } from "zod";
import { skillContractSchema } from "./canonical-contracts.ts";
import {
  OBSERVATION_PROMOTION_THRESHOLD,
  digestSchema,
} from "./observation-ledger.ts";
import { isSafeDescendantPath } from "./relative-path.ts";

/** Generated project skills live in their own namespace and are never touched by `sync`. */
export const GENERATED_SKILL_DIRECTORY = ".ai/skills/project";

/** Blocking size ceiling for a generated `SKILL.md`, in bytes. */
export const GENERATED_SKILL_MAX_BYTES = 15_360;

/** Blocking budget: the number of project skills that may be `active` at the same time. */
export const GENERATED_SKILL_ACTIVE_BUDGET = 12;

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO calendar date (YYYY-MM-DD)");

/**
 * A reference must stay inside the skill's own directory. The lexical rule is shared with the
 * doctors (`isSafeRelativePath`), so a UNC root, a drive letter, a leading separator in either
 * separator style and any `..` segment are rejected here rather than only at the file system.
 */
const referencePathSchema = z
  .string()
  .min(1)
  .refine(isSafeDescendantPath, "must be a relative path inside the skill directory");

export const generatedSkillEvidenceSchema = z.object({
  claim: z.string().min(1),
  source: z.string().min(1),
  digest: digestSchema,
});
export type GeneratedSkillEvidence = z.infer<typeof generatedSkillEvidenceSchema>;

/**
 * Canonical Skill Contract v1 (`skillContractSchema`) plus the provenance fields of
 * design §5. Only two inherited fields are overridden, both to tighten them: a generated
 * skill must state `priority: skill` explicitly rather than inherit the shared default,
 * because the ceiling is a security property a reviewer has to be able to read in the file
 * itself; and its `references` must be provably relative, since nothing else validates the
 * reference paths of a skill outside the canonical set.
 */
export const generatedSkillFrontmatterSchema = skillContractSchema
  .extend({
    references: z.array(referencePathSchema).optional(),
    priority: z.literal("skill"),
    origin: z.literal("generated"),
    status: z.enum(["proposed", "active", "stale", "retired"]),
    generated_at: isoDateSchema,
    verified_at: isoDateSchema,
    confirmations: z.int().min(1),
    /**
     * `threshold` is the ordinary three-confirmation path; `user-correction` is the fast path
     * from D6 and is the only way a skill may carry fewer than three confirmations.
     */
    promotion: z.enum(["threshold", "user-correction"]),
    confirmed_by: z.array(z.string().min(1)).min(1),
    evidence: z.array(generatedSkillEvidenceSchema).min(1),
    supersedes: z.array(z.string().min(1)),
  })
  .superRefine((frontmatter, context) => {
    if (
      frontmatter.promotion === "threshold" &&
      frontmatter.confirmations < OBSERVATION_PROMOTION_THRESHOLD
    ) {
      context.addIssue({
        code: "custom",
        message:
          `confirmations must be at least ${OBSERVATION_PROMOTION_THRESHOLD} unless ` +
          "promotion is user-correction",
        path: ["confirmations"],
      });
    }
    if (frontmatter.confirmations !== frontmatter.confirmed_by.length) {
      context.addIssue({
        code: "custom",
        message: "confirmations must equal the number of confirming task ids",
        path: ["confirmations"],
      });
    }
    if (new Set(frontmatter.confirmed_by).size !== frontmatter.confirmed_by.length) {
      context.addIssue({
        code: "custom",
        message: "confirmed_by must contain distinct task ids",
        path: ["confirmed_by"],
      });
    }
  });
export type GeneratedSkillFrontmatter = z.infer<typeof generatedSkillFrontmatterSchema>;
