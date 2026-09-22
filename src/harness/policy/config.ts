import { z } from "zod";
import { formatZodIssues } from "../../domain/zod-issues.ts";
import { HarnessError, pathPatternSchema, policyModeSchema } from "../contracts/index.ts";

/**
 * The policy block of a user (`~/.synorch/config.yaml`) or workspace configuration. The user
 * layer may grant (allowlists, network); the workspace layer lives in the repository and may only
 * narrow what the user layer grants. Unknown keys inside `policy` are rejected so a typo cannot
 * silently fail open.
 */
export const policyConfigSchema = z.strictObject({
  mode: policyModeSchema.optional(),
  require_full_sandbox: z.boolean().optional(),
  forbidden: z.array(pathPatternSchema).optional(),
  external_write_allowlist: z.array(z.string().trim().min(1).max(500)).optional(),
  network: z
    .strictObject({
      mode: z.enum(["deny", "allowlist", "allow"]),
      hosts: z.array(z.string().min(1).max(253)).default([]),
    })
    .optional(),
});
export type PolicyConfig = z.infer<typeof policyConfigSchema>;

const configEnvelopeSchema = z.looseObject({ policy: policyConfigSchema.optional() });

export function readPolicyConfig(raw: unknown, layer: "user" | "workspace"): PolicyConfig {
  if (raw === undefined || raw === null) return {};
  const parsed = configEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HarnessError({
      code: "config_invalid",
      message: `Invalid ${layer} policy configuration: ${formatZodIssues(parsed.error)}`.slice(0, 2000),
      workspace_effect: "none",
      retry_safe: false,
    });
  }
  return parsed.data.policy ?? {};
}
