import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeRelativePath } from "../../../domain/relative-path.ts";
import { digestSchema, sha256, type Digest, type Tool } from "../../contracts/index.ts";
import { applyHunks, parseUnifiedDiff, PatchError } from "../unified-diff.ts";
import { isMissing, resolveWorkspacePath, ToolScopeViolation } from "../workspace-path.ts";
import { messageOf } from "./read-tools.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, NormalizedMemo, okResult, recheckWritePath, scopeViolationResult } from "./shared.ts";

class StalePrecondition extends Error {}

const writeFileInput = z.strictObject({
  path: z.string().min(1).max(1024),
  content: z.string().max(4 * 1024 * 1024),
  /** sha256 of the current bytes; required when the file exists, omitted or null for a new file. */
  expected_digest: digestSchema.nullable().optional(),
});
type WriteFileInput = z.infer<typeof writeFileInput>;

export function createWriteFileTool(): Tool<WriteFileInput> {
  const metadata = builtinMetadata({
    name: "write_file",
    description: "Create a file, or overwrite one whose current sha256 matches expected_digest. Owned paths only; written atomically.",
    effect: "workspace-write",
    idempotent: false,
    network: "none",
    output_limit_bytes: 16 * 1024,
    timeout_ms: 30_000,
    cancellable: true,
    concurrency: "sequential",
    visible_to: ["implementer", "debugger"],
  });
  const memo = new NormalizedMemo<string>();
  return defineTool(metadata, writeFileInput, {
    async normalize(input, context) {
      const resolved = await resolveWorkspacePath(context.workspaceRoot, input.path, "write");
      memo.remember(context.toolCallId, resolved.relative);
      return actionOf(metadata, input, context, { paths: [{ path: resolved.relative, access: "write" }] });
    },
    async execute(input, context) {
      try {
        const approved = memo.take(context.toolCallId);
        const absolute = await recheckWritePath(context, input.path, approved);
        const relative = approved ?? input.path;
        const current = await readOptional(absolute);
        assertPrecondition(current, input.expected_digest ?? null, input.path);
        await atomicWrite(absolute, Buffer.from(input.content, "utf8"));
        return okResult(`${current === undefined ? "created" : "updated"} ${relative} (${Buffer.byteLength(input.content)} bytes)`, { changed_paths: [relative] });
      } catch (error: unknown) {
        return writeFailure(error);
      }
    },
  });
}

const applyPatchInput = z.strictObject({
  patch: z.string().min(1).max(4 * 1024 * 1024),
  /** Pre-image sha256 per touched path; null declares that the file must not exist yet. */
  expected: z.record(z.string().min(1).max(1024), digestSchema.nullable()),
});
type ApplyPatchInput = z.infer<typeof applyPatchInput>;

interface PlannedChange {
  readonly declared: string;
  readonly relative: string;
}

export function createApplyPatchTool(): Tool<ApplyPatchInput> {
  const metadata = builtinMetadata({
    name: "apply_patch",
    description: "Apply a unified diff to owned files; every touched path states its expected pre-image sha256 (null for new files).",
    effect: "workspace-write",
    idempotent: false,
    network: "none",
    output_limit_bytes: 65_536,
    timeout_ms: 30_000,
    cancellable: true,
    concurrency: "sequential",
    visible_to: ["implementer", "debugger", "orchestrator"],
  });
  const memo = new NormalizedMemo<readonly PlannedChange[]>();
  return defineTool(metadata, applyPatchInput, {
    async normalize(input, context) {
      const touched = touchedPaths(input.patch);
      const planned: PlannedChange[] = [];
      for (const declared of touched) {
        const resolved = await resolveWorkspacePath(context.workspaceRoot, declared, "write");
        planned.push({ declared, relative: resolved.relative });
      }
      memo.remember(context.toolCallId, planned);
      return actionOf(metadata, input, context, { paths: planned.map((change) => ({ path: change.relative, access: "write" as const })) });
    },
    async execute(input, context) {
      const planned = memo.take(context.toolCallId);
      try {
        const patches = parseUnifiedDiff(input.patch);
        const expected = new Map(Object.entries(input.expected).map(([key, value]) => [normalizeRelativePath(key), value]));
        const files = new Map<string, FileState>();
        const stateFor = async (declared: string): Promise<FileState> => {
          const known = files.get(declared);
          if (known !== undefined) return known;
          const approved = planned?.find((change) => change.declared === declared)?.relative;
          const absolute = await recheckWritePath(context, declared, approved);
          const key = normalizeRelativePath(declared);
          if (!expected.has(key)) throw new StalePrecondition(`no expected digest declared for ${declared}`);
          const previous = await readOptional(absolute);
          assertPrecondition(previous, expected.get(key) ?? null, declared);
          const state: FileState = { absolute, relative: approved ?? key, previous, content: previous };
          files.set(declared, state);
          return state;
        };
        for (const patch of patches) {
          const before = patch.oldPath === null ? undefined : await stateFor(patch.oldPath);
          const after = patch.newPath === null ? undefined : await stateFor(patch.newPath);
          const source = before?.content?.toString("utf8") ?? "";
          if (before !== undefined && before !== after) before.content = undefined;
          if (after !== undefined) after.content = Buffer.from(applyHunks(source, patch.hunks, patch.newPath ?? ""), "utf8");
        }
        const states = [...files.values()];
        await commitAll(states);
        const changed = states.map((state) => state.relative);
        return okResult(`applied ${patches.reduce((sum, patch) => sum + patch.hunks.length, 0)} hunk(s) to ${changed.join(", ")}`, { changed_paths: changed });
      } catch (error: unknown) {
        return writeFailure(error);
      }
    },
  });
}

interface FileState {
  readonly absolute: string;
  readonly relative: string;
  readonly previous: Buffer | undefined;
  content: Buffer | undefined;
}

function touchedPaths(patch: string): string[] {
  const patches = parseUnifiedDiff(patch);
  const paths = new Set<string>();
  for (const file of patches) {
    if (file.oldPath !== null) paths.add(file.oldPath);
    if (file.newPath !== null) paths.add(file.newPath);
  }
  return [...paths];
}

async function commitAll(writes: readonly FileState[]): Promise<void> {
  const done: FileState[] = [];
  try {
    for (const write of writes) {
      if (write.content === undefined) {
        if (write.previous !== undefined) await unlink(write.absolute);
      } else await atomicWrite(write.absolute, write.content);
      done.push(write);
    }
  } catch (error: unknown) {
    for (const write of done.reverse()) {
      if (write.previous === undefined) await unlink(write.absolute).catch(() => undefined);
      else await atomicWrite(write.absolute, write.previous).catch(() => undefined);
    }
    throw error;
  }
}

function assertPrecondition(current: Buffer | undefined, expected: Digest | null, label: string): void {
  if (current === undefined) {
    if (expected !== null) throw new StalePrecondition(`${label} does not exist but an expected digest was given`);
    return;
  }
  if (expected === null) throw new StalePrecondition(`${label} already exists; pass its current sha256 as the expected digest`);
  const actual = sha256(new Uint8Array(current));
  if (actual !== expected) throw new StalePrecondition(`${label} changed: expected ${expected}, found ${actual}`);
}

async function readOptional(absolute: string): Promise<Buffer | undefined> {
  try {
    return await readFile(absolute);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * Temp file in the target directory, then rename. Rename replaces the directory entry, so a hard
 * link planted after the check cannot redirect the write, and a half-written file is never seen.
 */
async function atomicWrite(absolute: string, content: Buffer): Promise<void> {
  const directory = path.dirname(absolute);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(absolute)}.${randomUUID()}.synorch-tmp`);
  await writeFile(temporary, content, { flag: "wx" });
  try {
    const existing = await lstat(absolute).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new ToolScopeViolation(`${absolute} became a link before the write`, "write-outside-scope");
    await rename(temporary, absolute);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function writeFailure(error: unknown) {
  if (error instanceof StalePrecondition) return errorResult("stale_precondition", error.message);
  if (error instanceof PatchError) return errorResult("invalid_arguments", error.message);
  return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
}
