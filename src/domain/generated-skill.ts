import { z } from "zod";
import { OBSERVATION_PROMOTION_THRESHOLD } from "./observation-ledger.ts";

/** Generated project skills live in their own namespace and are never touched by `sync`. */
export const GENERATED_SKILL_DIRECTORY = ".ai/skills/project";

/** Blocking size ceiling for a generated `SKILL.md`, in bytes. */
export const GENERATED_SKILL_MAX_BYTES = 15_360;

/** Blocking budget: the number of project skills that may be `active` at the same time. */
export const GENERATED_SKILL_ACTIVE_BUDGET = 12;

/** Body sections the Canonical Skill Contract requires of every skill. */
export const REQUIRED_SKILL_SECTIONS = [
  "When this applies",
  "When it does not",
  "Required inputs",
  "Procedure",
  "Tools",
  "Verification",
  "Stop and escalate",
  "Output contract",
] as const;

const kebabCaseSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be kebab-case");

const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a three-part semantic version");

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO calendar date (YYYY-MM-DD)");

const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{16,64}$/, "must be sha256:<hex>, at least 16 hex characters");

/** A reference must stay inside the skill's own directory. */
const referencePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.replaceAll("\\", "/").split("/").includes(".."),
    "must be a relative path inside the skill directory",
  );

export const generatedSkillEvidenceSchema = z.object({
  claim: z.string().min(1),
  source: z.string().min(1),
  digest: digestSchema,
});
export type GeneratedSkillEvidence = z.infer<typeof generatedSkillEvidenceSchema>;

/**
 * Canonical Skill Contract v1 base fields, inlined here for the first slice. Integration
 * re-bases this object onto `skillContractSchema.extend(...)` from `./canonical-contracts.ts`
 * once the shared contract module lands; the field set below is that contract plus §5.
 */
export const generatedSkillFrontmatterSchema = z
  .object({
    name: kebabCaseSchema,
    description: z.string().min(1),
    version: semverSchema,
    not_for: z.string().min(1).optional(),
    inputs: z.array(z.string().min(1)).optional(),
    tools: z.array(z.string().min(1)).optional(),
    outputs: z.string().min(1).optional(),
    references: z.array(referencePathSchema).optional(),
    /** Priority ceiling: a generated skill can never claim constitutional or protocol authority. */
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

export interface SkillDocument {
  readonly frontmatter: string;
  readonly body: string;
}

/**
 * Minimal frontmatter splitter: the YAML block fenced by `---` at the very start of the file.
 * Integration replaces this single call with the shared parser in `infrastructure/frontmatter.ts`.
 */
export function splitFrontmatter(content: string): SkillDocument | undefined {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const afterFence = normalized.slice(end + 4);
  if (afterFence.length > 0 && !afterFence.startsWith("\n")) return undefined;
  return {
    frontmatter: normalized.slice(4, end + 1),
    body: afterFence.startsWith("\n") ? afterFence.slice(1) : afterFence,
  };
}
