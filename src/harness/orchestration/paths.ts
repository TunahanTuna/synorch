import {
  CONTROL_PLANE_WRITE_PREFIX,
  isReservedWritePattern,
  pathPatternSchema,
} from "../contracts/index.ts";

/**
 * Glob matching for workspace-relative ownership patterns. Matching decides whether a path is
 * *owned*, so it errs towards "not owned": comparison is case-sensitive except on Windows, where
 * the file system itself is case-insensitive. A literal pattern owns itself and everything below
 * it, so `src/auth` and `src/auth/**` grant the same files.
 */

const GLOB = /[*?[\]{}]/;

export function normalizeWorkspacePath(value: string): string | undefined {
  const parsed = pathPatternSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function patternToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = "";
  const segments = pattern.split("/");
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    let part = "";
    for (const character of segment) {
      if (character === "*") part += "[^/]*";
      else if (character === "?") part += "[^/]";
      else part += escapeRegExp(character);
    }
    source += part + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
}

export function matchesPattern(path: string, pattern: string, platform: NodeJS.Platform = process.platform): boolean {
  const candidate = normalizeWorkspacePath(path);
  const normalizedPattern = normalizeWorkspacePath(pattern);
  if (candidate === undefined || normalizedPattern === undefined) return false;
  const caseInsensitive = platform === "win32";
  if (!GLOB.test(normalizedPattern)) {
    const a = caseInsensitive ? candidate.toLowerCase() : candidate;
    const b = caseInsensitive ? normalizedPattern.toLowerCase() : normalizedPattern;
    return a === b || a.startsWith(`${b}/`);
  }
  return patternToRegExp(normalizedPattern, caseInsensitive).test(candidate);
}

export function matchesAny(path: string, patterns: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  return patterns.some((pattern) => matchesPattern(path, pattern, platform));
}

export function isLiteralPattern(pattern: string): boolean {
  return !GLOB.test(pattern);
}

/** True for a path the orchestrator may write: strictly under `.ai/tasks/`, never reserved. */
export function isControlPlanePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === undefined || isReservedWritePattern(normalized)) return false;
  return normalized.startsWith(CONTROL_PLANE_WRITE_PREFIX) && normalized.length > CONTROL_PLANE_WRITE_PREFIX.length;
}

export interface ScopeViolation {
  readonly path: string;
  readonly reason: "outside-owned" | "forbidden" | "reserved" | "invalid";
}

/** Checks `changed ⊆ owned` against the real diff, never against a worker's claim. */
export function findScopeViolations(
  changed: readonly string[],
  scope: { readonly owned: readonly string[]; readonly forbidden: readonly string[] },
  platform: NodeJS.Platform = process.platform,
): readonly ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const path of changed) {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === undefined) violations.push({ path, reason: "invalid" });
    else if (isReservedWritePattern(normalized)) violations.push({ path, reason: "reserved" });
    else if (matchesAny(normalized, scope.forbidden, platform)) violations.push({ path, reason: "forbidden" });
    else if (!matchesAny(normalized, scope.owned, platform)) violations.push({ path, reason: "outside-owned" });
  }
  return violations;
}
