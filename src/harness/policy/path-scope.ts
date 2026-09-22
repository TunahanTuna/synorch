import { normalizeRelativePath } from "../../domain/relative-path.ts";
import { RESERVED_WRITE_SEGMENTS, staticPrefix } from "../contracts/index.ts";

/**
 * Workspace-relative glob matching for policy scopes. Patterns are POSIX-shaped: `**` spans any
 * number of segments (including none), `*` and `?` stay inside one segment, `[...]` and `{a,b}`
 * work per segment. A pattern without glob characters covers the path itself and everything
 * below it. Matching a *grant* (write scope) is case-sensitive, so a case-insensitive volume can
 * only ever narrow what is allowed; matching a *denial* (forbidden, reserved) is case-insensitive.
 */

export interface MatchOptions {
  readonly caseInsensitive: boolean;
}

const GLOB_CHARACTERS = /[*?[\]{}]/;
const segmentCache = new Map<string, RegExp>();

export function matchesPattern(candidate: string, pattern: string, options: MatchOptions): boolean {
  const pathSegments = splitSegments(candidate);
  const patternSegments = splitSegments(pattern);
  if (patternSegments.length === 1 && patternSegments[0] === ".") return true;
  if (!GLOB_CHARACTERS.test(pattern)) {
    if (patternSegments.length > pathSegments.length) return false;
    return patternSegments.every((segment, index) => sameSegment(segment, pathSegments[index] ?? "", options));
  }
  return matchSegments(pathSegments, 0, patternSegments, 0, options);
}

export function matchesAny(candidate: string, patterns: readonly string[], options: MatchOptions): boolean {
  return patterns.some((pattern) => matchesPattern(candidate, pattern, options));
}

/**
 * True when `candidate` is a directory on the way to something a pattern grants: listing or
 * searching `src` is a read inside scope when the scope is `src/auth/**`.
 */
export function isAncestorOfAny(candidate: string, patterns: readonly string[], options: MatchOptions): boolean {
  const pathSegments = splitSegments(candidate);
  if (pathSegments.length === 1 && pathSegments[0] === ".") return patterns.length > 0;
  return patterns.some((pattern) => {
    const prefix = staticPrefix(pattern);
    if (prefix.length < pathSegments.length) return false;
    return pathSegments.every((segment, index) => sameSegment(prefix[index] ?? "", segment, options));
  });
}

export function hasReservedSegment(candidate: string): boolean {
  const reserved: readonly string[] = RESERVED_WRITE_SEGMENTS;
  return splitSegments(candidate).some((segment) => reserved.includes(segment.toLowerCase()));
}

function splitSegments(value: string): string[] {
  return normalizeRelativePath(value).split("/");
}

function sameSegment(left: string, right: string, options: MatchOptions): boolean {
  return options.caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function matchSegments(
  pathSegments: readonly string[],
  pathIndex: number,
  patternSegments: readonly string[],
  patternIndex: number,
  options: MatchOptions,
): boolean {
  if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
  const segment = patternSegments[patternIndex] ?? "";
  if (segment === "**") {
    for (let next = pathIndex; next <= pathSegments.length; next += 1) {
      if (matchSegments(pathSegments, next, patternSegments, patternIndex + 1, options)) return true;
    }
    return false;
  }
  if (pathIndex === pathSegments.length) return false;
  if (!segmentRegExp(segment, options).test(pathSegments[pathIndex] ?? "")) return false;
  return matchSegments(pathSegments, pathIndex + 1, patternSegments, patternIndex + 1, options);
}

function segmentRegExp(segment: string, options: MatchOptions): RegExp {
  const key = `${options.caseInsensitive ? "i" : "s"}:${segment}`;
  const cached = segmentCache.get(key);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(`^${segmentSource(segment)}$`, options.caseInsensitive ? "iu" : "u");
  segmentCache.set(key, compiled);
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
