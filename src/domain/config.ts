import { z } from "zod";

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
    name: z.literal("ai-structure"),
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

export const projectRecordSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  detected_at: z.string().datetime({ offset: true }),
  repository: z.object({
    git: z.boolean(),
  }),
  stack: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    package_manager: z.string().nullable(),
  }),
  commands: z.record(
    z.string(),
    z.object({
      value: z.string(),
      source: z.string(),
      confidence: z.literal("verified"),
    }),
  ),
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
