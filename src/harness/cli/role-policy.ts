import {
  effectivePolicySchema,
  TOOL_EFFECTS,
  type AgentRole,
  type EffectivePolicy,
  type PolicyEngine,
} from "../contracts/index.ts";
import type { RoleDefinition } from "./canonical.ts";

/**
 * Role definitions from the canonical agent manifests narrow the computed policy; they never widen
 * it. `writes_product_files: false` removes a worker's write scope, a narrower orchestrator
 * `control_plane_write_scope` replaces `.ai/tasks/**`, and the manifest is recorded as an extra
 * `role` layer, which also makes the manifest file a policy source no tool may write.
 */

const DECISION_RANK = { deny: 0, ask: 1, allow: 2 } as const;

export function narrowPolicy(policy: EffectivePolicy, definition: RoleDefinition | undefined): EffectivePolicy {
  if (definition === undefined || definition.role !== policy.role) return policy;
  let writeScope = [...policy.write_scope];
  if (policy.role === "orchestrator") {
    const scope = definition.controlPlaneWriteScope;
    if (scope !== undefined && writeScope.length > 0 && !writeScope.includes(scope)) writeScope = [scope];
  } else if (!definition.writesProductFiles) {
    writeScope = [];
  }
  const effects = { ...policy.effects };
  if (writeScope.length === 0) effects["workspace-write"] = "deny";
  const narrowed = effectivePolicySchema.parse({
    ...policy,
    write_scope: writeScope,
    effects,
    layers: [...policy.layers, { layer: "role", source: definition.source, digest: definition.digest }],
  });
  assertNotWider(narrowed, policy);
  return narrowed;
}

/** A defensive check: a narrowed policy that grants anything the original did not is a bug. */
export function assertNotWider(narrowed: EffectivePolicy, original: EffectivePolicy): void {
  for (const effect of TOOL_EFFECTS) {
    if (DECISION_RANK[narrowed.effects[effect]] > DECISION_RANK[original.effects[effect]]) {
      throw new Error(`role narrowing widened ${effect} from ${original.effects[effect]} to ${narrowed.effects[effect]}`);
    }
  }
  const covered = (pattern: string): boolean =>
    original.write_scope.some((base) => base === pattern || (base.endsWith("/**") && pattern.startsWith(base.slice(0, -2))));
  for (const pattern of narrowed.write_scope) {
    if (!covered(pattern)) throw new Error(`role narrowing widened the write scope with ${pattern}`);
  }
}

/** The policy engine every runtime component uses: the real engine, then the role narrowing. */
export function withRoleDefinitions(engine: PolicyEngine, roles: ReadonlyMap<AgentRole, RoleDefinition>): PolicyEngine {
  return {
    compute: (inputs) => narrowPolicy(engine.compute(inputs), roles.get(inputs.role)),
    evaluate: (action, policy) => engine.evaluate(action, policy),
  };
}
