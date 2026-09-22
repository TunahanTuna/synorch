import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AGENT_ROLES, matchesPathPattern as matchesPattern, type Tool, type ToolExecutionContext } from "../../contracts/index.ts";
import { resolveWorkspacePath } from "../workspace-path.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, okResult, readableByPolicy, scopeViolationResult } from "./shared.ts";

const READ_LIMIT_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const SEARCH_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const SEARCH_LINE_LIMIT = 2000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".synorch"]);

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
    description: "Read a text file inside the read scope. Optional 1-based line offset and line limit.",
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
        const { bytes, truncated } = await readHead(resolved.absolute, READ_LIMIT_BYTES);
        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          return okResult(`${resolved.relative} is a binary file (${info.size} bytes); content not shown.`);
        }
        const text = bytes.toString("utf8");
        const lines = text.split(/\r?\n/);
        const start = (input.offset ?? 1) - 1;
        const selected = input.limit === undefined && start === 0 ? text : lines.slice(start, input.limit === undefined ? undefined : start + input.limit).join("\n");
        return okResult(selected, { truncated: truncated || (input.limit !== undefined && start + input.limit < lines.length) });
      } catch (error: unknown) {
        return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
      }
    },
  });
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
              if (!SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(childAbsolute, child);
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
  return context.policy.read_scope.some((pattern) => pattern.toLowerCase().startsWith(`${relative.toLowerCase()}/`));
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
