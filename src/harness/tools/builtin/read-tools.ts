import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AGENT_ROLES,
  digestSchema,
  foldPathCase,
  isAncestorOfAnyPattern,
  isCaseInsensitivePlatform,
  matchesPathPattern as matchesPattern,
  workspaceDigest,
  type Digest,
  type Tool,
  type ToolExecutionContext,
} from "../../contracts/index.ts";
import { resolveWorkspacePath } from "../workspace-path.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, okResult, readableByPolicy, scopeViolationResult } from "./shared.ts";

const READ_LIMIT_BYTES = 1024 * 1024;
/** What read_file shows the model inline (ADR-18, audit F18); the gateway's 16 KiB cap is the hard bound. */
const READ_DISPLAY_LIMIT_BYTES = 14 * 1024;
const READ_DISPLAY_HEAD_BYTES = 11 * 1024;
const READ_DISPLAY_TAIL_BYTES = 2 * 1024;
const DIGEST_IN_MEMORY_BYTES = 16 * 1024 * 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const BINARY_SNIFF_BYTES = 8000;
const SEARCH_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const SEARCH_LINE_LIMIT = 2000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".synorch"].map((name) => foldPathCase(name)));

const relativePathInput = z.string().min(1).max(1024);

const readFileInput = z.strictObject({
  path: relativePathInput,
  offset: z.int().min(1).optional(),
  limit: z.int().min(1).max(20_000).optional(),
});
type ReadFileInput = z.infer<typeof readFileInput>;

export function createReadFileTool(): Tool<ReadFileInput> {
  const metadata = builtinMetadata({
    name: "read_file",
    description:
      "Read a text file inside the read scope. Optional 1-based line offset and line limit. The first line is a header with the file's digest, which write_file/apply_patch use as their precondition.",
    effect: "read",
    idempotent: true,
    network: "none",
    output_limit_bytes: READ_LIMIT_BYTES,
    timeout_ms: 30_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: [...AGENT_ROLES],
  });
  return defineTool(metadata, readFileInput, {
    async normalize(input, context) {
      const resolved = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
      return actionOf(metadata, input, context, { paths: [{ path: resolved.relative, access: "read" }] });
    },
    async execute(input, context) {
      try {
        const resolved = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
        if (!readableByPolicy(resolved.relative, context)) return errorResult("path_outside_scope", `${resolved.relative} is outside the read scope`);
        const info = await stat(resolved.absolute);
        if (!info.isFile()) return errorResult("invalid_arguments", `${resolved.relative} is not a file`);
        const digest = await digestFile(resolved.absolute, info.size);
        context.files?.noteRead(resolved.relative, digest);
        const { bytes, truncated: headOnly } = await readHead(resolved.absolute, READ_LIMIT_BYTES);
        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          return okResult(`${resolved.relative} · digest ${digest} · binary file (${info.size} bytes); content not shown.`, { digest });
        }
        const view = renderFileView(resolved.relative, digest, bytes, headOnly, info.size, input.offset, input.limit);
        const blob = view.omitted ? await context.blobs.put(new Uint8Array(Buffer.from(view.selected, "utf8")), "text/plain; charset=utf-8") : undefined;
        return okResult(view.text, { truncated: view.truncated, digest, ...(blob === undefined ? {} : { blob }) });
      } catch (error: unknown) {
        return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
      }
    },
  });
}

interface FileView {
  readonly text: string;
  /** The selected lines in full (the blob content when the view omits some of them). */
  readonly selected: string;
  readonly truncated: boolean;
  readonly omitted: boolean;
}

/**
 * The model-facing view of a file: a header line `<path> · digest sha256:<hex> · lines <a>-<b> of
 * <n>` (the digest is the precondition `write_file`/`apply_patch` default to), then the selected
 * lines joined by `\n` (a BOM is not shown; CR-only files split correctly). A selection larger than
 * `READ_DISPLAY_LIMIT_BYTES` is shown head + tail with the omitted line range named, so the model
 * can page through it with offset/limit; the full selection goes to a blob.
 */
function renderFileView(relative: string, digest: Digest, bytes: Buffer, headOnly: boolean, size: number, offset: number | undefined, limit: number | undefined): FileView {
  const decoded = bytes.toString("utf8");
  const valid = headOnly || isValidUtf8(bytes);
  const text = decoded.startsWith("﻿") ? decoded.slice(1) : decoded;
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const total = text.length === 0 ? 0 : lines.length;
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = Math.min(total, limit === undefined ? total : start + limit);
  const notes: string[] = [];
  if (!valid) notes.push("not valid UTF-8: shown lossily; write_file/apply_patch will refuse to edit it");
  if (headOnly) notes.push(`only the first ${READ_LIMIT_BYTES} of ${size} bytes were read`);
  const range = total === 0 ? "empty file" : start >= total ? `offset ${start + 1} is past the end (${total} lines)` : `lines ${start + 1}-${end} of ${total}${headOnly ? "+" : ""}`;
  const header = `${relative} · digest ${digest} · ${range}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`;
  const selectedLines = start >= total ? [] : lines.slice(start, end);
  const selected = selectedLines.join("\n");
  const partial = headOnly || start > 0 || end < total;
  if (Buffer.byteLength(selected, "utf8") <= READ_DISPLAY_LIMIT_BYTES) {
    return { text: selectedLines.length === 0 ? header : `${header}\n${selected}`, selected, truncated: partial, omitted: false };
  }
  const head: string[] = [];
  let used = 0;
  for (const line of selectedLines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > READ_DISPLAY_HEAD_BYTES) break;
    head.push(line);
    used += cost;
  }
  if (head.length === 0) head.push(clipUtf8(selectedLines[0] ?? "", READ_DISPLAY_HEAD_BYTES));
  const tail: string[] = [];
  used = 0;
  for (let index = selectedLines.length - 1; index >= head.length; index -= 1) {
    const line = selectedLines[index] ?? "";
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > READ_DISPLAY_TAIL_BYTES) break;
    tail.unshift(line);
    used += cost;
  }
  const firstOmitted = start + head.length + 1;
  const lastOmitted = start + selectedLines.length - tail.length;
  const marker = `… [lines ${firstOmitted}-${lastOmitted} omitted; truncated; use offset/limit to read them, e.g. offset ${firstOmitted} limit ${Math.min(lastOmitted - firstOmitted + 1, 300)}] …`;
  return { text: [header, ...head, marker, ...tail].join("\n"), selected, truncated: true, omitted: true };
}

function clipUtf8(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** `workspaceDigest` of the whole file (ADR-19), streamed so a large file is never held in memory. */
async function digestFile(absolute: string, size: number): Promise<Digest> {
  if (size <= DIGEST_IN_MEMORY_BYTES) return workspaceDigest(new Uint8Array(await readFile(absolute)));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
  return digestSchema.parse(`sha256:${hash.digest("hex")}`);
}

const listDirInput = z.strictObject({
  path: relativePathInput.default("."),
  depth: z.int().min(1).max(4).default(1),
  max_entries: z.int().min(1).max(5000).default(500),
});
type ListDirInput = z.infer<typeof listDirInput>;

export function createListDirTool(): Tool<ListDirInput> {
  const metadata = builtinMetadata({
    name: "list_dir",
    description: "List a directory inside the read scope. Directories end with '/', links with '@' and are not followed.",
    effect: "read",
    idempotent: true,
    network: "none",
    output_limit_bytes: 256 * 1024,
    timeout_ms: 30_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: [...AGENT_ROLES],
  });
  return defineTool(metadata, listDirInput, {
    async normalize(input, context) {
      const resolved = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
      return actionOf(metadata, input, context, { paths: [{ path: resolved.relative, access: "read" }] });
    },
    async execute(input, context) {
      try {
        const resolved = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
        const lines: string[] = [];
        let truncated = false;
        const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
          const entries = (await readdir(absolute, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            if (context.signal.aborted) return;
            const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
            if (!readableByPolicy(child, context) && !isDirectoryOnTheWay(child, context)) continue;
            if (lines.length >= input.max_entries) {
              truncated = true;
              return;
            }
            const suffix = entry.isSymbolicLink() ? "@" : entry.isDirectory() ? "/" : "";
            lines.push(`${"  ".repeat(depth - 1)}${child}${suffix}`);
            if (entry.isDirectory() && !entry.isSymbolicLink() && depth < input.depth) await walk(path.join(absolute, entry.name), child, depth + 1);
          }
        };
        await walk(resolved.absolute, resolved.relative, 1);
        return okResult(lines.join("\n") || "(empty)", { truncated });
      } catch (error: unknown) {
        return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
      }
    },
  });
}

const searchInput = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => compiles(value), "pattern must be a valid regular expression"),
  path: relativePathInput.default("."),
  glob: z.string().min(1).max(200).optional(),
  case_insensitive: z.boolean().default(false),
  max_results: z.int().min(1).max(2000).default(200),
});
type SearchInput = z.infer<typeof searchInput>;

export function createSearchTool(): Tool<SearchInput> {
  const metadata = builtinMetadata({
    name: "search",
    description: "Search file contents with a regular expression under a directory in the read scope; prints path:line:text.",
    effect: "read",
    idempotent: true,
    network: "none",
    output_limit_bytes: 512 * 1024,
    timeout_ms: 60_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: [...AGENT_ROLES],
  });
  return defineTool(metadata, searchInput, {
    async normalize(input, context) {
      const resolved = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
      return actionOf(metadata, input, context, { paths: [{ path: resolved.relative, access: "read" }] });
    },
    async execute(input, context) {
      try {
        const resolved = await resolveWorkspacePath(context.workspaceRoot, input.path, "read");
        const expression = new RegExp(input.pattern, input.case_insensitive ? "iu" : "u");
        const results: string[] = [];
        let truncated = false;
        const visit = async (absolute: string, relative: string): Promise<void> => {
          const entries = await readdir(absolute, { withFileTypes: true });
          for (const entry of entries) {
            if (context.signal.aborted || truncated) return;
            if (entry.isSymbolicLink()) continue;
            const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
            const childAbsolute = path.join(absolute, entry.name);
            if (entry.isDirectory()) {
              if (!SKIPPED_DIRECTORIES.has(foldPathCase(entry.name))) await visit(childAbsolute, child);
              continue;
            }
            if (!entry.isFile() || !readableByPolicy(child, context) || !globMatches(child, input.glob)) continue;
            truncated = await searchFile(childAbsolute, child, expression, results, input.max_results);
          }
        };
        const info = await stat(resolved.absolute);
        if (info.isFile()) {
          if (readableByPolicy(resolved.relative, context)) truncated = await searchFile(resolved.absolute, resolved.relative, expression, results, input.max_results);
        } else await visit(resolved.absolute, resolved.relative);
        return okResult(results.join("\n") || "(no matches)", { truncated });
      } catch (error: unknown) {
        return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
      }
    },
  });
}

async function searchFile(absolute: string, relative: string, expression: RegExp, results: string[], limit: number): Promise<boolean> {
  const info = await stat(absolute);
  if (info.size > SEARCH_FILE_LIMIT_BYTES) return false;
  const { bytes } = await readHead(absolute, SEARCH_FILE_LIMIT_BYTES);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return false;
  const lines = bytes.toString("utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const candidate = line.length > SEARCH_LINE_LIMIT ? line.slice(0, SEARCH_LINE_LIMIT) : line;
    if (!expression.test(candidate)) continue;
    if (results.length >= limit) return true;
    results.push(`${relative}:${index + 1}:${candidate.slice(0, 500)}`);
  }
  return false;
}

function globMatches(relative: string, glob: string | undefined): boolean {
  if (glob === undefined) return true;
  const target = glob.includes("/") ? relative : relative.split("/").pop() ?? relative;
  return matchesPattern(target, glob, { caseInsensitive: false });
}

function isDirectoryOnTheWay(relative: string, context: ToolExecutionContext): boolean {
  return isAncestorOfAnyPattern(relative, context.policy.read_scope, { caseInsensitive: isCaseInsensitivePlatform(process.platform) });
}

async function readHead(absolute: string, limit: number): Promise<{ readonly bytes: Buffer; readonly truncated: boolean }> {
  const handle = await open(absolute, "r");
  try {
    const info = await handle.stat();
    const size = Math.min(info.size, limit);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return { bytes: buffer.subarray(0, bytesRead), truncated: info.size > limit };
  } finally {
    await handle.close();
  }
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
