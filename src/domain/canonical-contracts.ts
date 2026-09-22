import { z } from "zod";

/**
 * Canonical Agent Manifest v1 and Canonical Skill Contract v1.
 *
 * These schemas describe the machine-checkable frontmatter of the generated
 * `.ai/agents/<id>/AGENT.md` and `.ai/skills/<id>/SKILL.md` files. They are the
 * single source of truth for `doctor` and for any module that produces or
 * extends canonical content: both object schemas are intentionally left open to
 * `.extend()` so downstream contracts (for example generated, non-canonical
 * skills) can add fields without redefining the base shape.
 */

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The only value a canonical or generated skill may declare for `priority`. */
export const SKILL_PRIORITIES = ["skill"] as const;

/** Capability tiers a worker dispatch may request for a role. */
export const AGENT_MODEL_TIERS = [
  "orchestrator",
  "complex_worker",
  "fast_worker",
  "any",
] as const;

/** The report shapes a role is allowed to return. */
export const AGENT_REPORT_CONTRACTS = [
  "completion-packet",
  "evidence-report",
  "review-report",
  "final-report",
] as const;

/**
 * The literal token an agent uses to allow the technology skills carried by the
 * task packet, whose ids are only known after project discovery.
 */
export const TECHNOLOGY_SKILL_TOKEN = "technology:*";

const nonEmptyString = z.string().trim().min(1);

export const skillContractSchema = z.object({
  name: z.string().regex(KEBAB_CASE, "Skill name must be kebab-case."),
  description: nonEmptyString,
  version: z.string().regex(SEMVER, "Skill version must be a semantic version."),
  not_for: nonEmptyString.optional(),
  inputs: z.array(nonEmptyString).optional(),
  tools: z.array(nonEmptyString).optional(),
  outputs: nonEmptyString.optional(),
  references: z.array(nonEmptyString).optional(),
  priority: z.enum(SKILL_PRIORITIES).default("skill"),
});

export const agentManifestSchema = z.object({
  name: z.string().regex(KEBAB_CASE, "Agent name must be kebab-case."),
  role: nonEmptyString,
  writes_product_files: z.boolean(),
  model_tier: z.enum(AGENT_MODEL_TIERS),
  allowed_skills: z.array(nonEmptyString).min(1),
  reports: z.enum(AGENT_REPORT_CONTRACTS),
  forbidden_skills: z.array(nonEmptyString).optional(),
  control_plane_write_scope: nonEmptyString.optional(),
});

export type SkillContract = z.infer<typeof skillContractSchema>;
export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type AgentModelTier = (typeof AGENT_MODEL_TIERS)[number];
export type AgentReportContract = (typeof AGENT_REPORT_CONTRACTS)[number];

/** H2 headings every canonical skill body must carry, in no required order. */
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

/** H2 headings every canonical agent manifest body must carry. */
export const REQUIRED_AGENT_SECTIONS = [
  "Purpose",
  "Authority",
  "Required inputs",
  "Procedure",
  "Escalation",
  "Report contract",
  "Completion conditions",
] as const;

/** The section whose body must be a numbered list in both kinds. */
export const NUMBERED_PROCEDURE_SECTION = "Procedure";

/**
 * Byte ceilings per layer. They encode the load-frequency asymmetry: content
 * loaded every session is held flat, content loaded on match may be deep.
 */
export const CANONICAL_SIZE_CEILINGS = {
  entrypoint: 2_500,
  constitution: 1_500,
  protocol: 2_000,
  agentManifest: 3_000,
  baseSkill: 6_000,
  skillReference: 15_000,
} as const;

export type CanonicalSizeLayer = keyof typeof CANONICAL_SIZE_CEILINGS;
