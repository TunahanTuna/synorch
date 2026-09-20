import { z } from "zod";
import { SYNORCH_GENERATOR_NAME } from "./product.ts";

export const scopeSchema = z.enum(["workspace", "repository"]);
export type StructureScope = z.infer<typeof scopeSchema>;

export const modelDefaultsSchema = z.object({
  orchestrator: z.string().min(1),
  complex_worker: z.string().min(1),
  fast_worker: z.string().min(1),
});

export const modelProfileSchema = z.object({
  schema_version: z.literal(1),
  provider: z.enum(["openai", "claude"]),
  defaults: modelDefaultsSchema,
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const manifestSchema = z.object({
  schema_version: z.literal(1),
  generator: z.object({
    name: z.union([z.literal(SYNORCH_GENERATOR_NAME), z.literal("ai-structure")]),
    version: z.string().min(1),
  }),
  scope: scopeSchema,
  routing: z.object({
    mode: z.enum(["automatic", "manual"]),
    require_session_confirmation: z.boolean(),
    silent_fallback: z.boolean(),
  }),
  model_profiles: z.object({
    openai: z.string().min(1),
    claude: z.string().min(1),
  }),
});
export type Manifest = z.infer<typeof manifestSchema>;

const verifiedCommandSchema = z.object({
  value: z.string(),
  cwd: z.string().min(1),
  source: z.string(),
  confidence: z.literal("verified"),
});

export const projectEvidenceSchema = z.object({
  kind: z.enum(["manifest", "language", "framework", "package_manager", "build_tool", "dependency"]),
  value: z.string().min(1),
  source: z.string().min(1),
  confidence: z.literal("verified"),
});
export type ProjectEvidence = z.infer<typeof projectEvidenceSchema>;

const projectStackSchema = z.object({
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  package_manager: z.string().nullable(),
  build_tool: z.string().nullable(),
});

export const projectModuleSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  manifests: z.array(z.string()),
  stack: projectStackSchema,
  commands: z.record(z.string(), verifiedCommandSchema),
  evidence: z.array(projectEvidenceSchema),
});
export type ProjectModule = z.infer<typeof projectModuleSchema>;

const registeredBaseSkillSchema = z.object({
  id: z.string().min(1),
  relative_path: z.string().min(1),
});

const matchedSkillEvidenceSchema = z.object({
  module_id: z.string().min(1),
  module_path: z.string().min(1),
  fact: projectEvidenceSchema,
});

const registeredTechnologySkillSchema = z.object({
  id: z.string().min(1),
  pack_id: z.string().min(1),
  source_id: z.string().min(1).nullable().default(null),
  relative_path: z.string().min(1),
  reasons: z.array(z.string().min(1)),
});

const selectedTechnologyPackSchema = z.object({
  id: z.string().min(1),
  skill_ids: z.array(z.string().min(1)),
  matched_evidence: z.array(matchedSkillEvidenceSchema),
});

export const skillRegistrySchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string().min(1),
  base_skills: z.array(registeredBaseSkillSchema),
  technology_skills: z.array(registeredTechnologySkillSchema),
  selected_packs: z.array(selectedTechnologyPackSchema),
});
export type SkillRegistry = z.infer<typeof skillRegistrySchema>;

export const projectRecordSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  detected_at: z.string().datetime({ offset: true }),
  repository: z.object({
    git: z.boolean(),
  }),
  stack: projectStackSchema,
  commands: z.record(z.string(), verifiedCommandSchema),
  manifests: z.array(z.string()),
  evidence: z.array(projectEvidenceSchema),
  modules: z.array(projectModuleSchema),
  skill_registry: z.string().min(1),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const workspaceSchema = z.object({
  schema_version: z.literal(1),
  scope: scopeSchema,
  projects: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      record: z.string().min(1),
    }),
  ),
});
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
