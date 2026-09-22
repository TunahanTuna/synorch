import { readFile } from "node:fs/promises";
import path from "node:path";
import { digestText, pathPatternSchema, type Digest } from "../contracts/index.ts";

/**
 * Workspace source digests for the freshness gate, and the ownership match that excludes a
 * worker's own owned paths from the in-flight check (the worker is expected to change those).
 */

export type SourceDigestReader = (relativePath: string) => Promise<Digest | undefined>;

export function createSourceReader(workspaceRoot: string): SourceDigestReader {
  return async (relativePath) => {
    const parsed = pathPatternSchema.safeParse(relativePath);
    if (!parsed.success || parsed.data === ".") return undefined;
    try {
      return digestText(await readFile(path.join(workspaceRoot, ...parsed.data.split("/")), "utf8"));
    } catch {
      return undefined;
    }
  };
}

const GLOB = /[*?[\]{}]/;

function toRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const segments = pattern.split("/");
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") return last ? ".*" : "(?:[^/]+/)*";
      const body = [...segment]
        .map((character) => (character === "*" ? "[^/]*" : character === "?" ? "[^/]" : character.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("");
      return body + (last ? "" : "/");
    })
    .join("");
  return new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
}

export function isOwnedPath(relativePath: string, owned: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const candidate = pathPatternSchema.safeParse(relativePath);
  if (!candidate.success) return false;
  const caseInsensitive = platform === "win32";
  return owned.some((raw) => {
    const pattern = pathPatternSchema.safeParse(raw);
    if (!pattern.success) return false;
    if (!GLOB.test(pattern.data)) {
      const a = caseInsensitive ? candidate.data.toLowerCase() : candidate.data;
      const b = caseInsensitive ? pattern.data.toLowerCase() : pattern.data;
      return a === b || a.startsWith(`${b}/`);
    }
    return toRegExp(pattern.data, caseInsensitive).test(candidate.data);
  });
}
