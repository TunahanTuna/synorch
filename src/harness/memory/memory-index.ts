import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  digestText,
  MEMORY_KINDS,
  MEMORY_RELATION_TYPES,
  memoryIdSchema,
  type MemoryKind,
  type MemoryRelationType,
} from "../contracts/index.ts";
import { parseNoteFile } from "./note-format.ts";
import { fromVaultPath, INDEX_DIRECTORY, listNoteFiles, readTextIfExists, writeAtomic, type VaultFile } from "./vault.ts";

/**
 * The derived full-text and link index under `.index/`. It is a cache in the strict sense: it is
 * rebuilt from the notes whenever it is missing, unreadable or out of date with the files, so
 * deleting it never loses information.
 */

export const INDEX_VERSION = 1;
export const INDEX_FILE = `${INDEX_DIRECTORY}/index.json`;

const MEMORY_ID_PATTERN = /\b(?:prj|dec|asm|que|evd|cpt|prf)-[0-9a-z][0-9a-z-]{2,62}\b/g;

export interface IndexedNote {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly digest: string;
  readonly id: string;
  readonly kind: MemoryKind;
  readonly status: string;
  readonly scope: "project" | "branch" | "user";
  readonly branch?: string | undefined;
  readonly project_id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly source_ref?: string | undefined;
  readonly source_digest?: string | undefined;
  readonly relations: readonly { readonly type: MemoryRelationType; readonly target: string }[];
  /** Vault paths of local Markdown links in the body. */
  readonly links: readonly string[];
  /** Memory ids named in the body text without being a relation. */
  readonly mentions: readonly string[];
  readonly title_terms: readonly string[];
  readonly terms: Readonly<Record<string, number>>;
}

export interface BrokenLink {
  readonly from: string;
  readonly target: string;
  readonly kind: "link" | "relation";
}

export interface InvalidNote {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly message: string;
}

export interface MemoryIndex {
  readonly version: typeof INDEX_VERSION;
  readonly notes: readonly IndexedNote[];
  readonly invalid: readonly InvalidNote[];
  readonly duplicates: readonly { readonly id: string; readonly paths: readonly string[] }[];
  readonly broken_links: readonly BrokenLink[];
}

const memoryIndexSchema = z.object({
  version: z.literal(INDEX_VERSION),
  notes: z.array(
    z.object({
      path: z.string(),
      size: z.number(),
      mtimeMs: z.number(),
      digest: z.string(),
      id: z.string(),
      kind: z.enum(MEMORY_KINDS),
      status: z.string(),
      scope: z.enum(["project", "branch", "user"]),
      branch: z.string().optional(),
      project_id: z.string(),
      title: z.string(),
      tags: z.array(z.string()),
      source_ref: z.string().optional(),
      source_digest: z.string().optional(),
      relations: z.array(z.object({ type: z.enum(MEMORY_RELATION_TYPES), target: z.string() })),
      links: z.array(z.string()),
      mentions: z.array(z.string()),
      title_terms: z.array(z.string()),
      terms: z.record(z.string(), z.number()),
    }),
  ),
  invalid: z.array(z.object({ path: z.string(), size: z.number(), mtimeMs: z.number(), message: z.string() })),
  duplicates: z.array(z.object({ id: z.string(), paths: z.array(z.string()) })),
  broken_links: z.array(z.object({ from: z.string(), target: z.string(), kind: z.enum(["link", "relation"]) })),
});

export function tokenize(text: string): string[] {
  return (text.normalize("NFKC").toLocaleLowerCase("tr").match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => term.length > 1);
}

function termCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const term of tokenize(text)) counts[term] = (counts[term] ?? 0) + 1;
  return counts;
}

function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** Local Markdown links to `.md` files, resolved to vault paths; URLs and anchors are skipped. */
export function extractNoteLinks(notePath: string, body: string): string[] {
  const links = new Set<string>();
  for (const match of stripCode(body).matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    let target = raw.split("#")[0] ?? "";
    try {
      target = decodeURIComponent(target).replaceAll("\\", "/");
    } catch {
      continue;
    }
    if (!target.toLowerCase().endsWith(".md")) continue;
    const resolved = target.startsWith("/")
      ? path.posix.normalize(target.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(notePath), target));
    if (resolved.startsWith("../")) continue;
    links.add(resolved);
  }
  return [...links];
}

function mentionedIds(body: string, own: string): string[] {
  const ids = new Set<string>();
  for (const match of stripCode(body).matchAll(MEMORY_ID_PATTERN)) {
    if (match[0] !== own && memoryIdSchema.safeParse(match[0]).success) ids.add(match[0]);
  }
  return [...ids];
}

export async function buildIndex(root: string, files?: readonly VaultFile[]): Promise<MemoryIndex> {
  const listed = files ?? (await listNoteFiles(root));
  const notes: IndexedNote[] = [];
  const invalid: InvalidNote[] = [];
  for (const file of listed) {
    const content = await readTextIfExists(fromVaultPath(root, file.path));
    if (content === undefined) continue;
    const parsed = parseNoteFile(content);
    if (!parsed.ok) {
      invalid.push({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, message: parsed.message });
      continue;
    }
    const { frontmatter, title, body } = parsed;
    notes.push({
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      digest: digestText(content),
      id: frontmatter.id,
      kind: frontmatter.kind,
      status: frontmatter.status,
      scope: frontmatter.scope,
      branch: frontmatter.branch,
      project_id: frontmatter.project_id,
      title,
      tags: [...(frontmatter.tags ?? [])],
      source_ref: frontmatter.source_ref,
      source_digest: frontmatter.source_digest,
      relations: frontmatter.relations.map((relation) => ({ type: relation.type, target: relation.target })),
      links: extractNoteLinks(file.path, body),
      mentions: mentionedIds(body, frontmatter.id),
      title_terms: tokenize(title),
      terms: termCounts(body),
    });
  }

  const byId = new Map<string, string[]>();
  for (const note of notes) byId.set(note.id, [...(byId.get(note.id) ?? []), note.path]);
  const duplicates = [...byId.entries()].filter(([, paths]) => paths.length > 1).map(([id, paths]) => ({ id, paths }));

  const notePaths = new Set(notes.map((note) => note.path.toLowerCase()));
  const brokenLinks: BrokenLink[] = [];
  for (const note of notes) {
    for (const link of note.links) {
      if (notePaths.has(link.toLowerCase())) continue;
      const exists = await stat(fromVaultPath(root, link)).then(
        (info) => info.isFile(),
        () => false,
      );
      if (!exists) brokenLinks.push({ from: note.path, target: link, kind: "link" });
    }
    for (const relation of note.relations) {
      if (!byId.has(relation.target)) brokenLinks.push({ from: note.path, target: relation.target, kind: "relation" });
    }
  }
  return { version: INDEX_VERSION, notes, invalid, duplicates, broken_links: brokenLinks };
}

export async function readIndex(root: string): Promise<MemoryIndex | undefined> {
  const content = await readTextIfExists(fromVaultPath(root, INDEX_FILE));
  if (content === undefined) return undefined;
  try {
    const parsed = memoryIndexSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeIndex(root: string, index: MemoryIndex): Promise<void> {
  await writeAtomic(fromVaultPath(root, INDEX_FILE), `${JSON.stringify(index)}\n`);
}

/** True when the index describes exactly the files on disk (path, size and mtime). */
export function indexMatchesFiles(index: MemoryIndex, files: readonly VaultFile[]): boolean {
  const known = new Map<string, { readonly size: number; readonly mtimeMs: number }>();
  for (const entry of [...index.notes, ...index.invalid]) known.set(entry.path, entry);
  if (known.size !== files.length) return false;
  return files.every((file) => {
    const entry = known.get(file.path);
    return entry !== undefined && entry.size === file.size && entry.mtimeMs === file.mtimeMs;
  });
}

export interface TextMatch {
  readonly score: number;
  readonly fields: readonly string[];
}

/** Keyword scoring: exact id beats title, title beats tags, tags beat body frequency. Every term must match. */
export function scoreText(note: IndexedNote, text: string): TextMatch {
  if (text.trim().toLowerCase() === note.id) return { score: 1000, fields: ["id"] };
  const terms = tokenize(text);
  if (terms.length === 0) return { score: 0, fields: [] };
  const tagTerms = new Set(note.tags.flatMap((tag) => tokenize(tag)));
  const idTerms = new Set(tokenize(note.id));
  const fields = new Set<string>();
  let score = 0;
  for (const term of terms) {
    const before = score;
    if (note.title_terms.includes(term)) {
      score += 5;
      fields.add("title");
    }
    if (tagTerms.has(term)) {
      score += 3;
      fields.add("tags");
    }
    if (idTerms.has(term)) {
      score += 2;
      fields.add("id");
    }
    const count = note.terms[term] ?? 0;
    if (count > 0) {
      score += Math.min(count, 5);
      fields.add("body");
    }
    if (score === before) return { score: 0, fields: [] };
  }
  return { score, fields: [...fields] };
}
