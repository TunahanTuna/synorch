import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath, normalizeRelativePath } from "../../domain/relative-path.ts";
import type { HardRail, PathEscape, PathEscapeReason } from "../contracts/index.ts";

/**
 * A path a tool refused to normalize because it cannot be expressed inside the workspace at all:
 * `..` escapes, absolute paths elsewhere, UNC/device paths, links that resolve outside, dangling
 * links and multiply linked files. Thrown from `normalize`, the gateway records it as a
 * `NormalizedAction.escapes` entry so the PolicyEngine denies it in a recorded `tool/policy_decided`
 * (`write-outside-scope` for writes); thrown from `execute`, it ends the call `path_outside_scope`.
 */
export class ToolScopeViolation extends Error {
  public readonly rail: HardRail | undefined;
  public readonly escape: PathEscape;

  public constructor(message: string, rail: HardRail | undefined, escape?: { readonly requested: string; readonly reason: PathEscapeReason }) {
    super(message);
    this.name = "ToolScopeViolation";
    this.rail = rail;
    this.escape = {
      requested: (escape?.requested ?? "").replaceAll("\0", "\\0").slice(0, 1024),
      access: rail === undefined ? "read" : "write",
      reason: escape?.reason ?? "changed-after-decision",
    };
  }
}

export interface ResolvedWorkspacePath {
  /** Canonical workspace-relative POSIX path, the form policy scopes are matched against. */
  readonly relative: string;
  /** Canonical absolute path with every existing link resolved. */
  readonly absolute: string;
  readonly exists: boolean;
}

const UNC_OR_DEVICE = /^(?:\\\\|\/\/)/;
/** Win32 file and device namespaces (`\\?\`, `\\.\`) in either slash direction. */
const WIN32_NAMESPACE = /^[\\/]{2}[?.][\\/]/;
/** Reserved DOS device names, with or without an extension (`NUL`, `con.txt`, `COM1.tar.gz`). */
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
/** An 8.3 short-name alias (`PROGRA~1`, `LONGFI~2.TXT`). */
const SHORT_NAME = /~\d/;
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/**
 * Lexical forms Windows would silently rewrite or reinterpret, rejected before any matching:
 * trailing dots or spaces (`src.`, `a /b`), colons (alternate data streams `file:stream`,
 * drive-relative `C:x`) and reserved device names (`NUL`, `con.txt`). The drive of an absolute
 * path is the only colon allowed.
 */
function lexicalRefusal(value: string): { readonly message: string; readonly reason: PathEscapeReason } | undefined {
  if (WIN32_NAMESPACE.test(value)) return { message: "uses a Win32 file or device namespace prefix", reason: "unc-or-device" };
  const body = DRIVE_PREFIX.test(value) ? value.slice(2) : value;
  for (const segment of body.split(/[\\/]/)) {
    if (segment.length === 0 || segment === "." || segment === "..") continue;
    if (segment.includes(":")) return { message: "has a colon in a path segment (alternate data stream or drive-relative path)", reason: "invalid-path" };
    if (segment.endsWith(".") || segment.endsWith(" ")) return { message: "has a path segment ending in a dot or space", reason: "invalid-path" };
    if (DEVICE_NAME.test(segment.split(".")[0]?.trimEnd() ?? "")) return { message: "names a reserved device", reason: "unc-or-device" };
  }
  return undefined;
}

/**
 * The realpath half of containment, evaluated at action time. Every existing segment is resolved
 * with `realpath` (symbolic links and junctions) and must stay under the canonical root; the
 * canonical case on case-insensitive volumes comes from the file system, not from the caller.
 * A write to an existing file with more than one hard link is refused because the other names
 * may live outside the scope.
 */
export async function resolveWorkspacePath(
  workspaceRoot: string,
  candidate: string,
  access: "read" | "write",
): Promise<ResolvedWorkspacePath> {
  const rail: HardRail | undefined = access === "write" ? "write-outside-scope" : undefined;
  const fail = (message: string, reason: PathEscapeReason): never => {
    throw new ToolScopeViolation(`${candidate} ${message}`, rail, { requested: candidate, reason });
  };
  const value = candidate.trim();
  if (value.length === 0 || value.includes("\0")) fail("is not a valid path", "invalid-path");
  if (UNC_OR_DEVICE.test(value)) fail("is a UNC or device path outside the workspace", "unc-or-device");
  const refusal = lexicalRefusal(value);
  if (refusal !== undefined) fail(refusal.message, refusal.reason);

  const lexicalRoot = path.resolve(workspaceRoot);
  const lexical = path.resolve(lexicalRoot, value);
  if (!contains(lexicalRoot, lexical)) fail("resolves outside the workspace", "outside-workspace");

  const canonicalRoot = await realpath(lexicalRoot);
  const segments = path.relative(lexicalRoot, lexical).split(path.sep).filter((segment) => segment.length > 0);
  let current = lexicalRoot;
  let canonical = canonicalRoot;
  const missing: string[] = [];
  for (const segment of segments) {
    if (missing.length > 0) {
      missing.push(segment);
      continue;
    }
    current = path.join(current, segment);
    try {
      await lstat(current);
    } catch (error: unknown) {
      if (isMissing(error)) {
        missing.push(segment);
        continue;
      }
      throw error;
    }
    try {
      canonical = await realpath(current);
    } catch (error: unknown) {
      if (isMissing(error)) fail("is a dangling link", "dangling-link");
      throw error;
    }
    if (!contains(canonicalRoot, canonical)) fail("escapes the workspace through a symbolic link or junction", "link-escape");
    if (SHORT_NAME.test(segment) && path.basename(canonical).toLowerCase() !== segment.toLowerCase()) {
      fail("uses an 8.3 short name for a different long name", "invalid-path");
    }
  }

  const absolute = missing.length > 0 ? path.join(canonical, ...missing) : canonical;
  const relative = normalizeRelativePath(path.relative(canonicalRoot, absolute).split(path.sep).join("/"));
  if (!isSafeRelativePath(relative)) fail("resolves outside the workspace", "outside-workspace");
  if (access === "write" && missing.length === 0) {
    const info = await stat(absolute);
    if (info.isFile() && info.nlink > 1) fail("has more than one hard link; its other names may be outside the scope", "hard-link");
  }
  return { relative, absolute, exists: missing.length === 0 };
}

export function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
