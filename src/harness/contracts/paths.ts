import { z } from "zod";
import { isSafeRelativePath, normalizeRelativePath } from "../../domain/relative-path.ts";

/**
 * Workspace-relative path patterns used by plans, packets and policies. Patterns are POSIX-shaped
 * globs (`src/auth/**`). The lexical checks here run at schema time; the realpath/junction half is
 * enforced by the tool gateway at the moment of each action.
 */

const GLOB_CHARACTERS = /[*?[\]{}]/;

/** Segments no worker may ever own for writing, whatever its packet says. */
export const RESERVED_WRITE_SEGMENTS = [".git", ".synorch"] as const;

/** The only prefix an orchestrator may write under inside the workspace. */
export const CONTROL_PLANE_WRITE_PREFIX = ".ai/tasks/";

export const pathPatternSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeRelativePath, "must be a workspace-relative path without '..', drive or root")
  .transform(normalizeRelativePath);

export function patternSegments(pattern: string): string[] {
  return normalizeRelativePath(pattern).split("/");
}

/** Leading literal segments before the first segment that contains a glob character. */
export function staticPrefix(pattern: string): string[] {
  const prefix: string[] = [];
  for (const segment of patternSegments(pattern)) {
    if (GLOB_CHARACTERS.test(segment)) break;
    prefix.push(segment);
  }
  return prefix;
}

/** A pattern that would grant the whole workspace: `.`, `*`, `**`, `**\/*` and similar. */
export function isWholeWorkspacePattern(pattern: string): boolean {
  const normalized = normalizeRelativePath(pattern);
  return normalized === "." || staticPrefix(normalized).length === 0;
}

export function isReservedWritePattern(pattern: string): boolean {
  const reserved: readonly string[] = RESERVED_WRITE_SEGMENTS;
  return patternSegments(pattern).some((segment) => reserved.includes(segment.toLowerCase()));
}

/**
 * Conservative overlap test: two patterns may match a common path when one static prefix is a
 * segment-wise prefix of the other, compared case-insensitively because Windows and default macOS
 * volumes are case-insensitive. False positives serialize work; false negatives would let two
 * writers race, so the test only ever errs towards "overlaps".
 */
export function pathPatternsOverlap(left: string, right: string): boolean {
  const a = normalizeRelativePath(left).toLowerCase();
  const b = normalizeRelativePath(right).toLowerCase();
  if (a === b) return true;
  const aStatic = staticPrefix(a);
  const bStatic = staticPrefix(b);
  const aIsLiteral = aStatic.length === patternSegments(a).length;
  const bIsLiteral = bStatic.length === patternSegments(b).length;
  if (aIsLiteral && bIsLiteral) {
    return isSegmentPrefix(aStatic, bStatic) || isSegmentPrefix(bStatic, aStatic);
  }
  const shorter = aStatic.length <= bStatic.length ? aStatic : bStatic;
  const longer = shorter === aStatic ? bStatic : aStatic;
  return isSegmentPrefix(shorter, longer);
}

function isSegmentPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  if (prefix.length > value.length) return false;
  return prefix.every((segment, index) => segment === value[index]);
}
