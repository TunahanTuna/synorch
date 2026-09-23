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
  const reserved = RESERVED_WRITE_SEGMENTS.map((segment) => foldPathCase(segment));
  return patternSegments(pattern).some((segment) => reserved.includes(foldPathCase(segment)));
}

/** Platforms whose default volumes (NTFS, APFS/HFS+) compare file names case-insensitively. */
export const CASE_INSENSITIVE_PLATFORMS = ["win32", "darwin"] as const;

export function isCaseInsensitivePlatform(platform: string): boolean {
  return (CASE_INSENSITIVE_PLATFORMS as readonly string[]).includes(platform);
}

/**
 * Unicode form every workspace path is compared in (ADR-19): NFC. macOS may hand back NFD names
 * (`s` + U+0327) for a file the packet names in NFC (U+015F); both are the same path.
 */
export function normalizePathUnicode(path: string): string {
  return path.normalize("NFC");
}

/**
 * The one case-folding policy for paths on case-insensitive platforms (ADR-19): NFC, then a
 * length-preserving, locale-independent per-code-point upper-casing (a code point whose upper case
 * is not a single code point is kept). It approximates the ordinal-ignore-case comparison NTFS and
 * APFS apply, and it never applies Turkish tailoring: `i`/`I` fold together, `ı`/`I` fold together,
 * `İ` folds only to itself, so `şehir` and `ŞEHİR` are different names (as they are on NTFS).
 * Every comparison that treats paths case-insensitively (scope grants and denials, reserved
 * segments, overlap, diff-vs-owned checks) uses this function and nothing else.
 */
export function foldPathCase(path: string): string {
  let folded = "";
  for (const character of normalizePathUnicode(path)) {
    const upper = character.toUpperCase();
    folded += [...upper].length === 1 ? upper : character;
  }
  return folded;
}

/**
 * Conservative overlap test: two patterns may match a common path when one static prefix is a
 * segment-wise prefix of the other, compared case-insensitively because Windows and default macOS
 * volumes are case-insensitive. False positives serialize work; false negatives would let two
 * writers race, so the test only ever errs towards "overlaps".
 */
export function pathPatternsOverlap(left: string, right: string): boolean {
  const a = foldPathCase(normalizeRelativePath(left));
  const b = foldPathCase(normalizeRelativePath(right));
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
  const pathSegments = patternSegments(normalizePathUnicode(candidate));
  const globSegments = patternSegments(normalizePathUnicode(pattern));
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
  const pathSegments = patternSegments(normalizePathUnicode(candidate));
  if (pathSegments.length === 1 && pathSegments[0] === ".") return patterns.length > 0;
  return patterns.some((pattern) => {
    const prefix = staticPrefix(normalizePathUnicode(pattern));
    if (prefix.length < pathSegments.length) return false;
    return pathSegments.every((segment, index) => sameSegment(prefix[index] ?? "", segment, options));
  });
}

/** A concrete path that passes through `.git` or `.synorch`, compared case-insensitively. */
export function hasReservedSegment(candidate: string): boolean {
  return isReservedWritePattern(candidate);
}

function sameSegment(left: string, right: string, options: PathMatchOptions): boolean {
  return options.caseInsensitive ? foldPathCase(left) === foldPathCase(right) : left === right;
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
  const actual = pathSegments[pathIndex] ?? "";
  if (!segmentRegExp(segment, options).test(options.caseInsensitive ? foldPathCase(actual) : actual)) return false;
  return matchSegments(pathSegments, pathIndex + 1, globSegments, globIndex + 1, options);
}

function segmentRegExp(segment: string, options: PathMatchOptions): RegExp {
  const key = `${options.caseInsensitive ? "i" : "s"}:${segment}`;
  const cached = segmentPatternCache.get(key);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(`^${segmentSource(options.caseInsensitive ? foldPathCase(segment) : segment)}$`, "u");
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
