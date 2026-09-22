import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MEMORY_ROOT_SEGMENTS, type MemoryConfig, type MemoryKind } from "../contracts/index.ts";

/**
 * Vault layout (contracts/memory.md §1) and the file primitives the store builds on. The vault is
 * an ordinary folder of Markdown files; it opens as an Obsidian vault as-is, and nothing here
 * depends on Obsidian being installed.
 */

export const KIND_DIRECTORIES: { readonly [K in MemoryKind]: string } = {
  project: "project",
  decision: "decisions",
  assumption: "assumptions",
  question: "questions",
  evidence: "evidence",
  concept: "concepts",
  preference: "preferences",
};

export const QUEUE_DIRECTORY = "queue";
export const INDEX_DIRECTORY = ".index";
export const VIEWS_DIRECTORY = "views";

/** Folders a note scan never enters: derived data, the queue, views and editor state. */
const SKIPPED_DIRECTORIES = new Set([QUEUE_DIRECTORY, VIEWS_DIRECTORY, "node_modules"]);

/**
 * ADR-16: `memory.root` wins (relative values resolve against `home`, `~` expands to it);
 * otherwise `<home>/.synorch/memory/<project-id>/`.
 */
export function resolveMemoryRoot(config: MemoryConfig | undefined, projectId: string, home: string): string {
  const configured = config?.root?.trim();
  if (configured !== undefined && configured.length > 0) {
    const expanded = configured === "~" || /^~[\\/]/.test(configured) ? path.join(home, configured.slice(1)) : configured;
    return path.resolve(home, expanded);
  }
  return path.join(home, ...DEFAULT_MEMORY_ROOT_SEGMENTS, projectId);
}

export function toVaultPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

export function fromVaultPath(root: string, vaultPath: string): string {
  return path.join(root, ...vaultPath.split("/"));
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Temp file in the same directory, then rename: readers see the old or the new file, never half. */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface VaultFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Every `.md` note below the root, excluding the root README, dot folders, queue and views. */
export async function listNoteFiles(root: string): Promise<readonly VaultFile[]> {
  const files: VaultFile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (depth === 0 && entry.name.toLowerCase() === "readme.md") continue;
      const info = await stat(full);
      files.push({ path: toVaultPath(root, full), size: info.size, mtimeMs: info.mtimeMs });
    }
  };
  await walk(root, 0);
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

const VAULT_README = `# Synorch hafızası

Bu klasör Synorch'un yerel hafızasıdır: YAML properties taşıyan düz Markdown notları.
Obsidian ile vault olarak açılabilir; Obsidian zorunlu değildir, tüm işlemler \`syn memory\` ile çalışır.

- \`decisions/\`, \`assumptions/\`, \`questions/\`, \`evidence/\`, \`concepts/\`, \`preferences/\`, \`project/\`: notlar (\`<id>.md\`).
- \`queue/\`: inceleme bekleyen öneriler (\`syn memory review\`, \`accept\`, \`reject\`).
- \`views/\`: örnek Obsidian Bases görünümleri.
- \`.index/\`: türetilmiş arama indeksi; silinebilir, \`syn memory reindex\` yeniden kurar.

Notları elle düzenleyebilirsiniz. Synorch dışarıdan değişmiş bir notu ezmez; çakışma bildirir.
Bağlantılar standart Markdown bağlantılarıdır; kalıcı referans \`id\` alanıdır.
`;

const DECISIONS_BASE = `filters:
  and:
    - 'kind == "decision"'
properties:
  status:
    displayName: Durum
  reviewed_at:
    displayName: İncelendi
views:
  - type: table
    name: Kararlar
    order:
      - file.name
      - status
      - scope
      - branch
      - confidence
      - reviewed_at
      - source_run
`;

const REVIEW_QUEUE_BASE = `filters:
  or:
    - 'status == "proposed"'
    - 'status == "open"'
    - 'status == "stale"'
views:
  - type: table
    name: İnceleme
    order:
      - file.name
      - kind
      - status
      - confidence
      - source_ref
      - created_at
`;

/** Creates README and example Bases views once; never touches files that already exist. */
export async function ensureVaultScaffold(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const seeds: readonly (readonly [string, string])[] = [
    ["README.md", VAULT_README],
    [`${VIEWS_DIRECTORY}/decisions.base`, DECISIONS_BASE],
    [`${VIEWS_DIRECTORY}/review-queue.base`, REVIEW_QUEUE_BASE],
  ];
  for (const [relative, content] of seeds) {
    const file = fromVaultPath(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}

/** The checked-out branch of the Git work tree at `cwd` (worktrees included), read from HEAD. */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
  let directory = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(directory, ".git");
    const info = await stat(dotGit).catch(() => undefined);
    if (info !== undefined) {
      let gitDir = dotGit;
      if (info.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec((await readTextIfExists(dotGit)) ?? "");
        if (pointer?.[1] === undefined) return undefined;
        gitDir = path.resolve(directory, pointer[1].trim());
      }
      const head = await readTextIfExists(path.join(gitDir, "HEAD"));
      return /^ref:\s*refs\/heads\/(.+)$/m.exec(head ?? "")?.[1]?.trim();
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
