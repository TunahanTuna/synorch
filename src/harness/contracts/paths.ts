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

export interface PathMatchOptions {
  readonly caseInsensitive: boolean;
}

const segmentPatternCache = new Map<string, RegExp>();

/**
 * The one glob matcher for workspace-relative scopes (policy, tools, orchestration). `**` spans any
 * number of segments (including none), `*` and `?` stay inside one segment, `[...]` and `{a,b}`
 * work per segment, and a pattern without glob characters covers the path itself and everything
 * below it. Callers choose case sensitivity: matching a *grant* case-sensitively means a
 * case-insensitive volume can only ever narrow what is allowed; a *denial* (forbidden, reserved)
 * is matched case-insensitively.
 */
export function matchesPathPattern(candidate: string, pattern: string, options: PathMatchOptions): boolean {
  const pathSegments = patternSegments(candidate);
  const globSegments = patternSegments(pattern);
  if (globSegments.length === 1 && globSegments[0] === ".") return true;
  if (!GLOB_CHARACTERS.test(pattern)) {
    if (globSegments.length > pathSegments.length) return false;
    return globSegments.every((segment, index) => sameSegment(segment, pathSegments[index] ?? "", options));
  }
  return matchSegments(pathSegments, 0, globSegments, 0, options);
}

export function matchesAnyPathPattern(candidate: string, patterns: readonly string[], options: PathMatchOptions): boolean {
  return patterns.some((pattern) => matchesPathPattern(candidate, pattern, options));
}

/**
 * True when `candidate` is a directory on the way to something a pattern covers: listing or
 * searching `src` is a read inside scope when the scope is `src/auth/**`.
 */
export function isAncestorOfAnyPattern(candidate: string, patterns: readonly string[], options: PathMatchOptions): boolean {
  const pathSegments = patternSegments(candidate);
  if (pathSegments.length === 1 && pathSegments[0] === ".") return patterns.length > 0;
  return patterns.some((pattern) => {
    const prefix = staticPrefix(pattern);
    if (prefix.length < pathSegments.length) return false;
    return pathSegments.every((segment, index) => sameSegment(prefix[index] ?? "", segment, options));
  });
}

/** A concrete path that passes through `.git` or `.synorch`, compared case-insensitively. */
export function hasReservedSegment(candidate: string): boolean {
  return isReservedWritePattern(candidate);
}

function sameSegment(left: string, right: string, options: PathMatchOptions): boolean {
  return options.caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function matchSegments(
  pathSegments: readonly string[],
  pathIndex: number,
  globSegments: readonly string[],
  globIndex: number,
  options: PathMatchOptions,
): boolean {
  if (globIndex === globSegments.length) return pathIndex === pathSegments.length;
  const segment = globSegments[globIndex] ?? "";
  if (segment === "**") {
    for (let next = pathIndex; next <= pathSegments.length; next += 1) {
      if (matchSegments(pathSegments, next, globSegments, globIndex + 1, options)) return true;
    }
    return false;
  }
  if (pathIndex === pathSegments.length) return false;
  if (!segmentRegExp(segment, options).test(pathSegments[pathIndex] ?? "")) return false;
  return matchSegments(pathSegments, pathIndex + 1, globSegments, globIndex + 1, options);
}

function segmentRegExp(segment: string, options: PathMatchOptions): RegExp {
  const key = `${options.caseInsensitive ? "i" : "s"}:${segment}`;
  const cached = segmentPatternCache.get(key);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(`^${segmentSource(segment)}$`, options.caseInsensitive ? "iu" : "u");
  segmentPatternCache.set(key, compiled);
  return compiled;
}

function segmentSource(segment: string): string {
  let source = "";
  let braceDepth = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? "";
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else if (character === "[") {
      const close = segment.indexOf("]", index + 1);
      if (close === -1) source += "\\[";
      else {
        const body = segment.slice(index + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
        source += `[${body}]`;
        index = close;
      }
    } else if (character === "{") {
      braceDepth += 1;
      source += "(?:";
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
    } else if (character === "," && braceDepth > 0) source += "|";
    else source += character.replace(/[.+^$()|\\/\]}]/g, "\\$&");
  }
  return source + ")".repeat(braceDepth);
}
