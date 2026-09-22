import { CANONICAL_SIZE_CEILINGS, type CanonicalSizeLayer } from "../domain/canonical-contracts.ts";
import type { Diagnostic } from "./doctor-service.ts";

/** One diagnostic code per layer, so an overrun names the budget it broke. */
export const SIZE_CODES: Readonly<Record<CanonicalSizeLayer, string>> = {
  entrypoint: "size.entrypoint",
  constitution: "size.constitution",
  protocol: "size.protocol",
  agentManifest: "size.agent-manifest",
  baseSkill: "size.base-skill",
  skillReference: "size.skill-reference",
};

/**
 * The single place a per-layer byte ceiling is checked. Size overruns are warnings, never
 * errors (CANONICAL-CONTENT-DEPTH-PLAN W5, design D13): a file that is too long is a budget
 * problem, not a broken contract. The blocking 15KB rule on a generated `SKILL.md` is a
 * separate contract rule and keeps its own error.
 *
 * Both the canonical and the generated namespace call this, so the two severities cannot
 * drift apart again. `code` lets a caller keep its own diagnostic vocabulary.
 */
export function checkByteCeiling(
  relativePath: string,
  content: string,
  layer: CanonicalSizeLayer,
  diagnostics: Diagnostic[],
  code: string = SIZE_CODES[layer],
): void {
  const ceiling = CANONICAL_SIZE_CEILINGS[layer];
  const size = Buffer.byteLength(content, "utf8");
  if (size <= ceiling) return;
  diagnostics.push({
    severity: "warning",
    code,
    message: `File is ${size} bytes, above the ${ceiling} byte ceiling for this layer.`,
    path: relativePath,
  });
}
