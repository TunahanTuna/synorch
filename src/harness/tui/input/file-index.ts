import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Workspace paths for `@` completion. Inside a git repository the list is `git ls-files --cached
 * --others --exclude-standard` (tracked + untracked, `.gitignore` respected), which stays fast on
 * large repositories; elsewhere a bounded directory walk skips the usual heavy folders. The list is
 * built once, served from memory and refreshed in the background when older than `ttlMs`.
 */

export interface IndexedPath {
  /** Workspace-relative, `/`-separated; directories end with `/`. */
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly lower: string;
  readonly baseLower: string;
  readonly depth: number;
}

export type PathLister = (root: string, signal?: AbortSignal) => Promise<readonly string[]>;

export interface WorkspaceFileIndexOptions {
  readonly root: string;
  readonly ttlMs?: number;
  readonly lister?: PathLister;
  readonly now?: () => number;
}

const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", "out", "target", ".next", ".turbo", ".cache", "coverage", "vendor", "__pycache__", ".venv", "venv"]);
const WALK_LIMIT = 20_000;

export const gitLister: PathLister = (root, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8", ...(signal === undefined ? {} : { signal }) },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout.split("\0").filter((entry) => entry !== ""));
      },
    );
  });

export const walkLister: PathLister = async (root) => {
  const found: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && found.length < WALK_LIMIT) {
    const relative = queue.shift() ?? "";
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) queue.push(child);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        found.push(child);
        if (found.length >= WALK_LIMIT) break;
      }
    }
  }
  return found;
};

/** git first, the walk when the folder is not a repository (or git is missing). */
export const defaultLister: PathLister = async (root, signal) => {
  try {
    return await gitLister(root, signal);
  } catch {
    return walkLister(root, signal);
  }
};

export function buildIndex(files: readonly string[]): IndexedPath[] {
  const directories = new Set<string>();
  const result: IndexedPath[] = [];
  for (const raw of files) {
    const file = raw.replace(/\\/g, "/");
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) directories.add(`${parts.slice(0, depth).join("/")}/`);
    result.push(entryFor(file, "file"));
  }
  for (const directory of directories) result.push(entryFor(directory, "directory"));
  return result;
}

function entryFor(file: string, kind: "file" | "directory"): IndexedPath {
  const trimmed = kind === "directory" ? file.slice(0, -1) : file;
  const slash = trimmed.lastIndexOf("/");
  return {
    path: file,
    kind,
    lower: file.toLowerCase(),
    baseLower: trimmed.slice(slash + 1).toLowerCase(),
    depth: trimmed.split("/").length - 1,
  };
}

/** Lower is better; undefined when the query does not match. */
export function scorePath(entry: IndexedPath, query: string): number | undefined {
  const base = entry.baseLower.indexOf(query);
  if (base !== -1) return (entry.baseLower === query ? 0 : 100) + base * 2 + entry.depth * 3 + entry.path.length * 0.1;
  const anywhere = entry.lower.indexOf(query);
  if (anywhere !== -1) return 1000 + anywhere + entry.path.length * 0.1;
  let at = 0;
  let gaps = 0;
  let last = -1;
  for (let index = 0; index < entry.lower.length && at < query.length; index += 1) {
    if (entry.lower[index] === query[at]) {
      if (last !== -1) gaps += index - last - 1;
      last = index;
      at += 1;
    }
  }
  if (at < query.length) return undefined;
  return 2000 + gaps + entry.path.length * 0.1;
}

/** Top `limit` matches; an empty query lists the shallowest entries, directories first. */
export function searchIndex(entries: readonly IndexedPath[], rawQuery: string, limit = 50): IndexedPath[] {
  const query = rawQuery.toLowerCase().replace(/\\/g, "/");
  if (query === "") {
    return entries
      .filter((entry) => entry.depth === 0)
      .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1))
      .slice(0, limit);
  }
  // A query ending in `/` browses that directory.
  if (query.endsWith("/")) {
    const inside = entries.filter((entry) => entry.lower.startsWith(query) && entry.lower !== query && entry.depth === query.split("/").length - 1);
    if (inside.length > 0) return inside.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1)).slice(0, limit);
  }
  const scored: { entry: IndexedPath; score: number }[] = [];
  for (const entry of entries) {
    const score = scorePath(entry, query);
    if (score !== undefined) scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((item) => item.entry);
}

export class WorkspaceFileIndex {
  public readonly root: string;
  private readonly ttlMs: number;
  private readonly lister: PathLister;
  private readonly now: () => number;
  private entries: IndexedPath[] | undefined;
  private builtAt = 0;
  private building: Promise<IndexedPath[]> | undefined;

  public constructor(options: WorkspaceFileIndexOptions) {
    this.root = path.resolve(options.root);
    this.ttlMs = options.ttlMs ?? 30_000;
    this.lister = options.lister ?? defaultLister;
    this.now = options.now ?? (() => Date.now());
  }

  /** Starts building in the background (called when the editor opens). */
  public warm(): void {
    void this.load().catch(() => undefined);
  }

  /** Current entries; stale lists are served immediately while a refresh runs. */
  public async load(): Promise<readonly IndexedPath[]> {
    if (this.entries !== undefined) {
      if (this.now() - this.builtAt > this.ttlMs) void this.rebuild().catch(() => undefined);
      return this.entries;
    }
    return this.rebuild();
  }

  public async search(query: string, limit = 50): Promise<IndexedPath[]> {
    return searchIndex(await this.load(), query, limit);
  }

  /** Synchronous lookup of a workspace-relative path in the last built list. */
  public lookup(relative: string): IndexedPath | undefined {
    const wanted = relative.replace(/\\/g, "/");
    return this.entries?.find((entry) => entry.path === wanted || entry.path === `${wanted}/`);
  }

  private rebuild(): Promise<IndexedPath[]> {
    this.building ??= this.lister(this.root)
      .then((files) => {
        this.entries = buildIndex(files);
        this.builtAt = this.now();
        return this.entries;
      })
      .finally(() => {
        this.building = undefined;
      });
    return this.building;
  }
}
