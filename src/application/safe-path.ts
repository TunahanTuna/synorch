import path from "node:path";
import { isSafeRelativePath, normalizeRelativePath } from "../domain/relative-path.ts";

export interface SafeRelativePath {
  /** The candidate, separator-normalized; suitable for a diagnostic message. */
  readonly relative: string;
  readonly absolute: string;
  /** Case-folded form, for prefix comparisons on case-insensitive file systems. */
  readonly comparison: string;
}

/**
 * Resolve a path declared in a generated or hand-written file against `root`, refusing anything
 * that could denote a location outside it. This is the single lexical containment check the
 * doctors share; `FileSystem.assertPathWithinRoot` adds the realpath half afterwards.
 *
 * `requiredPrefix`, when given, additionally constrains the result to a strict descendant of
 * that directory.
 */
export function resolveSafeRelativePath(
  root: string,
  candidate: string,
  requiredPrefix?: string,
): SafeRelativePath | undefined {
  if (!isSafeRelativePath(candidate)) return undefined;

  const normalized = normalizeRelativePath(candidate);
  const absolute = path.resolve(root, ...normalized.split("/"));
  const relativeToRoot = path.relative(root, absolute);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(".." + path.sep) ||
    path.isAbsolute(relativeToRoot)
  ) {
    return undefined;
  }

  const comparison = normalizeForComparison(normalized);
  if (
    requiredPrefix !== undefined &&
    !isStrictDescendant(comparison, normalizeForComparison(requiredPrefix))
  ) {
    return undefined;
  }
  return { relative: normalized, absolute, comparison };
}

export function isStrictDescendant(candidate: string, directory: string): boolean {
  return candidate.startsWith(directory + "/");
}

export function normalizeForComparison(value: string): string {
  return normalizeRelativePath(value).toLowerCase();
}
