import path from "node:path";

/**
 * The lexical half of path containment, shared by every layer that accepts a path from a file
 * the user or an agent wrote: frontmatter references, registry entries and evidence sources.
 *
 * Separators are normalized *before* the absolute-path tests, so a Windows-style `\\server\share`
 * or `C:\secrets` is recognized on POSIX too and cannot slip past a check that only knows `/`.
 * The realpath half — symbolic links and junctions — lives in `FileSystem.assertPathWithinRoot`
 * and is applied by the callers of `resolveSafeRelativePath`.
 */

/** Collapse separators and redundant `./` segments into a comparable POSIX-shaped path. */
export function normalizeRelativePath(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/$/, "");
  return normalized || ".";
}

/**
 * True when the value can never denote a location *outside* whichever directory it is resolved
 * against: no NUL byte, no drive letter, no UNC root, no leading separator after normalization,
 * and no `..` segment. `.` — the directory itself — satisfies this; a path that must name a file
 * below the directory uses `isSafeDescendantPath` instead.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0")) return false;
  const normalized = normalizeRelativePath(value);
  if (normalized.length === 0) return false;
  if (path.win32.parse(normalized).root !== "") return false;
  if (path.posix.isAbsolute(normalized)) return false;
  return !normalized.split("/").includes("..");
}

/** `isSafeRelativePath`, and strictly below the directory: `.` is not a file. */
export function isSafeDescendantPath(value: string): boolean {
  return isSafeRelativePath(value) && normalizeRelativePath(value) !== ".";
}
