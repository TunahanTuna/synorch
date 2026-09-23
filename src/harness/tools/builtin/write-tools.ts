import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeRelativePath } from "../../../domain/relative-path.ts";
import { digestSchema, workspaceDigest, type AttemptFileLedger, type Digest, type Tool } from "../../contracts/index.ts";
import { ledgerKey } from "../file-ledger.ts";
import { applyHunks, contentOfAddedFile, parsePatch, PatchError, type FilePatch } from "../patch.ts";
import { conformContent, decodeTextFile, encodeTextFile, TextEncodingError, uniformEol, type DecodedText } from "../text-file.ts";
import { isMissing, resolveWorkspacePath, ToolScopeViolation } from "../workspace-path.ts";
import { messageOf } from "./read-tools.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, NormalizedMemo, okResult, recheckWritePath, scopeViolationResult } from "./shared.ts";

class StalePrecondition extends Error {}
/** The precondition cannot be defaulted: the file exists and this attempt has not seen it. */
class MissingPrecondition extends Error {}

const writeFileInput = z.strictObject({
  path: z.string().min(1).max(1024),
  content: z.string().max(4 * 1024 * 1024),
  /**
   * Workspace digest of the current bytes (the `digest` in read_file's header). Optional: it
   * defaults to the digest this attempt last read or wrote for the path. `null` requires that the
   * file does not exist yet.
   */
  expected_digest: digestSchema.nullable().optional(),
});
type WriteFileInput = z.infer<typeof writeFileInput>;

export function createWriteFileTool(): Tool<WriteFileInput> {
  const metadata = builtinMetadata({
    name: "write_file",
    description:
      "Create a file or replace its whole content (owned paths only, written atomically). Overwriting needs the file's digest: it defaults to your last read_file/write of that path in this attempt, or pass expected_digest. An existing file keeps its line endings and BOM.",
    effect: "workspace-write",
    idempotent: false,
    network: "none",
    output_limit_bytes: 16 * 1024,
    timeout_ms: 30_000,
    cancellable: true,
    concurrency: "sequential",
    visible_to: ["implementer", "debugger", "session"],
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
        const expected = expectedFor(input.expected_digest, relative, current, context.files);
        assertPrecondition(current, expected, relative);
        const existing = current === undefined ? undefined : decodeTextFile(current, relative);
        const bytes = conformContent(input.content, existing);
        await atomicWrite(absolute, bytes);
        const digest = workspaceDigest(bytes);
        context.files?.noteWrite(relative, digest);
        const kept = existing === undefined ? "" : keptFormatNote(existing, input.content);
        return okResult(`${current === undefined ? "created" : "updated"} ${relative} (${bytes.length} bytes${kept}) · digest ${digest}`, {
          changed_paths: [relative],
          digest,
        });
      } catch (error: unknown) {
        return writeFailure(error);
      }
    },
  });
}

const applyPatchInput = z.strictObject({
  patch: z.string().min(1).max(4 * 1024 * 1024),
  /**
   * Optional pre-image digest per touched path (`null`: the file must not exist yet). A path left
   * out defaults to the digest this attempt last read or wrote for it; a new file needs nothing.
   */
  expected: z.record(z.string().min(1).max(1024), digestSchema.nullable()).optional(),
  /** Shorthand for a patch that touches exactly one file. */
  expected_digest: digestSchema.nullable().optional(),
});
type ApplyPatchInput = z.infer<typeof applyPatchInput>;

interface PlannedChange {
  readonly declared: string;
  readonly relative: string;
}

export function createApplyPatchTool(): Tool<ApplyPatchInput> {
  const metadata = builtinMetadata({
    name: "apply_patch",
    description:
      "Edit owned files with a patch: the '*** Begin Patch' format (*** Update File / *** Add File / *** Delete File, '@@' hunks) or a unified diff (line counts optional). Hunks are located by their context lines. Preconditions default to your last read_file of each path. Line endings and BOM are preserved.",
    effect: "workspace-write",
    idempotent: false,
    network: "none",
    output_limit_bytes: 65_536,
    timeout_ms: 30_000,
    cancellable: true,
    concurrency: "sequential",
    visible_to: ["implementer", "debugger", "orchestrator", "session"],
  });
  const memo = new NormalizedMemo<readonly PlannedChange[]>();
  return defineTool(metadata, applyPatchInput, {
    async normalize(input, context) {
      const planned: PlannedChange[] = [];
      for (const declared of touchedPaths(parsePatch(input.patch))) {
        const resolved = await resolveWorkspacePath(context.workspaceRoot, declared, "write");
        planned.push({ declared, relative: resolved.relative });
      }
      memo.remember(context.toolCallId, planned);
      return actionOf(metadata, input, context, { paths: planned.map((change) => ({ path: change.relative, access: "write" as const })) });
    },
    async execute(input, context) {
      const planned = memo.take(context.toolCallId);
      try {
        const patches = parsePatch(input.patch);
        const touched = touchedPaths(patches);
        if (input.expected_digest !== undefined && touched.length !== 1) {
          throw new PatchError(`expected_digest is only for a patch that touches one file; this one touches ${touched.join(", ")}. Pass expected: {"<path>": "<digest>"} instead, or omit it to use your last read of each file.`);
        }
        const explicit = new Map<string, Digest | null>();
        for (const [key, value] of Object.entries(input.expected ?? {})) explicit.set(ledgerKey(normalizeRelativePath(key)), value);
        const files = new Map<string, FileState>();
        const stateFor = async (declared: string, creating = false): Promise<FileState> => {
          const known = files.get(declared);
          if (known !== undefined) return known;
          const approved = planned?.find((change) => change.declared === declared)?.relative;
          const absolute = await recheckWritePath(context, declared, approved);
          const relative = approved ?? normalizeRelativePath(declared);
          const previous = await readOptional(absolute);
          const stated =
            input.expected_digest !== undefined
              ? input.expected_digest
              : explicit.has(ledgerKey(relative))
                ? explicit.get(ledgerKey(relative))
                : explicit.get(ledgerKey(normalizeRelativePath(declared)));
          assertPrecondition(previous, creating ? (stated ?? null) : expectedFor(stated, relative, previous, context.files), relative);
          const state: FileState = { absolute, relative, previous, decoded: undefined, exists: previous !== undefined, touched: false };
          files.set(declared, state);
          return state;
        };
        const decodedOf = (state: FileState): DecodedText => {
          if (!state.exists) throw new PatchError(`${state.relative} does not exist; create it with '*** Add File: ${state.relative}' (or a '--- /dev/null' diff)`);
          state.decoded ??= decodeTextFile(state.previous ?? new Uint8Array(), state.relative);
          return state.decoded;
        };
        let hunkCount = 0;
        for (const patch of patches) {
          const source = await stateFor(patch.path, patch.kind === "add");
          if (patch.kind === "add") {
            if (source.exists) throw new PatchError(`${source.relative} already exists; change it with '*** Update File: ${source.relative}'`);
            source.decoded = contentOfAddedFile(patch);
            source.exists = true;
            source.touched = true;
            continue;
          }
          if (patch.kind === "delete") {
            if (!source.exists) throw new PatchError(`${source.relative} does not exist, so it cannot be deleted`);
            source.decoded = undefined;
            source.exists = false;
            source.touched = true;
            continue;
          }
          const updated = applyHunks(decodedOf(source), patch.hunks, source.relative);
          hunkCount += patch.hunks.length;
          if (patch.moveTo === undefined) {
            source.decoded = updated;
            source.touched = true;
            continue;
          }
          const destination = await stateFor(patch.moveTo, true);
          if (destination.exists && destination !== source) throw new PatchError(`cannot move ${source.relative} to ${destination.relative}: the destination exists`);
          source.decoded = undefined;
          source.exists = false;
          source.touched = true;
          destination.decoded = updated;
          destination.exists = true;
          destination.touched = true;
        }
        const states = [...files.values()].filter((state) => state.touched);
        const writes = states.map((state) => ({ ...state, content: state.exists && state.decoded !== undefined ? encodeTextFile(state.decoded) : undefined }));
        await commitAll(writes);
        const summary: string[] = [];
        let singleDigest: Digest | undefined;
        for (const write of writes) {
          const digest = write.content === undefined ? undefined : workspaceDigest(write.content);
          context.files?.noteWrite(write.relative, digest);
          if (writes.length === 1) singleDigest = digest;
          const verb = write.content === undefined ? "deleted" : write.previous === undefined ? "created" : "updated";
          summary.push(`${verb} ${write.relative}${digest === undefined ? "" : ` · digest ${digest}`}`);
        }
        const changed = writes.map((write) => write.relative);
        return okResult(`applied ${hunkCount} hunk(s)\n${summary.join("\n")}`, { changed_paths: changed, ...(singleDigest === undefined ? {} : { digest: singleDigest }) });
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
  decoded: DecodedText | undefined;
  exists: boolean;
  touched: boolean;
}

interface PendingWrite {
  readonly absolute: string;
  readonly previous: Buffer | undefined;
  readonly content: Buffer | undefined;
}

function touchedPaths(patches: readonly FilePatch[]): string[] {
  const paths = new Set<string>();
  for (const patch of patches) {
    paths.add(patch.path);
    if (patch.moveTo !== undefined) paths.add(patch.moveTo);
  }
  return [...paths];
}

async function commitAll(writes: readonly PendingWrite[]): Promise<void> {
  const done: PendingWrite[] = [];
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

/**
 * The precondition to check: the one the call states, else the digest this attempt last saw for
 * the path, else "must not exist" for a file that is not there. An existing file the attempt has
 * never seen cannot be defaulted.
 */
function expectedFor(stated: Digest | null | undefined, relative: string, current: Buffer | undefined, files: AttemptFileLedger | undefined): Digest | null {
  if (stated !== undefined) return stated;
  const seen = files?.lastSeen(relative);
  if (seen !== undefined) return seen;
  if (current === undefined) return null;
  throw new MissingPrecondition(
    `${relative} already exists and has not been read in this attempt: read_file it first (the digest in its header becomes the default precondition), then retry. You can also pass its digest explicitly.`,
  );
}

function assertPrecondition(current: Buffer | undefined, expected: Digest | null, label: string): void {
  if (current === undefined) {
    if (expected !== null) throw new StalePrecondition(`${label} no longer exists (expected digest ${expected}); re-read the directory and retry, or create it as a new file.`);
    return;
  }
  const actual = workspaceDigest(new Uint8Array(current));
  if (expected === null) throw new StalePrecondition(`${label} already exists (current digest ${actual}); re-read it with read_file and retry.`);
  if (actual !== expected) {
    throw new StalePrecondition(`${label} changed since it was read: expected digest ${expected}, current digest ${actual}. Re-read the file with read_file and retry the edit against its current content.`);
  }
}

function keptFormatNote(existing: DecodedText, content: string): string {
  const notes: string[] = [];
  const eol = uniformEol(existing.lines);
  if (eol === "\r\n" && /(^|[^\r])\n/.test(content)) notes.push("CRLF line endings kept");
  else if (eol === "\n" && /\r/.test(content)) notes.push("LF line endings kept");
  else if (eol === "\r" && /\n/.test(content)) notes.push("CR line endings kept");
  if (existing.bom && !content.startsWith("﻿")) notes.push("BOM kept");
  return notes.length === 0 ? "" : `; ${notes.join(", ")}`;
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
  if (error instanceof PatchError || error instanceof TextEncodingError || error instanceof MissingPrecondition) return errorResult("invalid_arguments", error.message);
  return scopeViolationResult(error) ?? errorResult("execution_failed", messageOf(error));
}
