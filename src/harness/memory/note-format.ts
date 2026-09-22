import { parse, stringify } from "yaml";
import { formatZodIssues } from "../../domain/zod-issues.ts";
import { memoryNoteFrontmatterSchema, type MemoryNoteFrontmatter } from "../contracts/index.ts";

/**
 * The on-disk note format: a YAML properties block, one `# Title` line and a free Markdown body.
 * Plain enough for any editor; Obsidian shows the block as Properties.
 */

const DELIMITER = "---";

const FRONTMATTER_ORDER: readonly (keyof MemoryNoteFrontmatter)[] = [
  "schema_version",
  "id",
  "kind",
  "project_id",
  "scope",
  "branch",
  "status",
  "created_at",
  "updated_at",
  "reviewed_at",
  "source_run",
  "source_task",
  "source_ref",
  "source_digest",
  "confidence",
  "owner",
  "relations",
  "tags",
];

export interface ParsedNoteFile {
  readonly frontmatter: MemoryNoteFrontmatter;
  readonly title: string;
  readonly body: string;
}

export type NoteParseResult =
  | ({ readonly ok: true } & ParsedNoteFile)
  | { readonly ok: false; readonly message: string };

export function parseNoteFile(content: string): NoteParseResult {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== DELIMITER) return { ok: false, message: "note has no frontmatter block" };
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closing === -1) return { ok: false, message: "frontmatter block is never closed with '---'" };
  let data: unknown;
  try {
    data = parse(lines.slice(1, closing).join("\n"));
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const parsed = memoryNoteFrontmatterSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: formatZodIssues(parsed.error) };
  const { title, body } = splitTitle(lines.slice(closing + 1).join("\n"));
  return { ok: true, frontmatter: parsed.data, title: title ?? parsed.data.id, body };
}

/** Splits the first `# ` heading off a Markdown text; everything else is the body. */
export function splitTitle(text: string): { readonly title: string | undefined; readonly body: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.trim().length > 0);
  const heading = index === -1 ? undefined : /^#\s+(\S.*?)\s*$/.exec(lines[index] ?? "");
  if (heading === undefined || heading === null) return { title: undefined, body: text.trim() };
  return { title: heading[1], body: lines.slice(index + 1).join("\n").trim() };
}

export function serializeNote(note: ParsedNoteFile): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_ORDER) {
    const value = note.frontmatter[key];
    if (value !== undefined) ordered[key] = value;
  }
  const yaml = stringify(ordered, { lineWidth: 0 });
  const body = note.body.trim();
  return `${DELIMITER}\n${yaml}${DELIMITER}\n\n# ${note.title.trim()}\n${body.length > 0 ? `\n${body}\n` : ""}`;
}
