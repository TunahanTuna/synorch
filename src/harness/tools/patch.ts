import { dominantEol, stripBom, type DecodedText, type LineEnding, type TextLine } from "./text-file.ts";

/**
 * Patch reading and application for `apply_patch` (ADR-18 D3). Two input formats are accepted:
 *
 * - a unified diff (`--- a/<path>` / `+++ b/<path>` then `@@` hunks), with or without line counts
 *   in the `@@` headers (`@@ -3,2 +3,2 @@`, `@@ -3 +3 @@`, bare `@@`);
 * - the `*** Begin Patch` format models are trained on (`*** Update File:`, `*** Add File:`,
 *   `*** Delete File:`, `*** Move to:`, `@@ <anchor>` lines, `*** End of File`, `*** End Patch`).
 *
 * A hunk is located by its context and removed lines, never by the line number alone: the numbers
 * of a unified header are only a hint that picks the nearest match. Matching is exact first, then
 * ignores trailing whitespace, then surrounding whitespace; lines the hunk keeps as context are
 * always written back from the file, so a tolerant match never rewrites an untouched line. Every
 * line keeps its own terminator; inserted lines take the terminator of the line they replace or
 * sit next to. Nothing is written unless every hunk of every file applies.
 */

export class PatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export type PatchLineOp = " " | "-" | "+";

export interface PatchLine {
  readonly op: PatchLineOp;
  readonly text: string;
}

export interface PatchHunk {
  /** 1-based old-side start line of a numbered unified header: a location hint only. */
  readonly oldStart: number | undefined;
  readonly oldLines: number | undefined;
  /** `@@ <text>` anchors (`*** Begin Patch` format): lines to find, in order, before the hunk. */
  readonly anchors: readonly string[];
  readonly lines: readonly PatchLine[];
  /** `*** End of File`: the hunk ends at the end of the file. */
  readonly endOfFile: boolean;
  /** `\ No newline at end of file` after an old-side / new-side line. */
  readonly oldNoEol: boolean;
  readonly newNoEol: boolean;
}

export interface FilePatch {
  readonly kind: "update" | "add" | "delete";
  /** Workspace path as written in the patch (the source path of a move). */
  readonly path: string;
  /** Destination of a move or rename; undefined when the file stays where it is. */
  readonly moveTo: string | undefined;
  readonly hunks: readonly PatchHunk[];
}

export const PATCH_FORMAT_HELP = [
  "apply_patch accepts (1) the '*** Begin Patch' format or (2) a unified diff with '--- a/<path>' and '+++ b/<path>' headers and '@@' hunks (line counts optional). Hunks are found by their context lines, so copy them exactly from read_file. Example:",
  "*** Begin Patch",
  "*** Update File: src/app.ts",
  "@@",
  " export function retries() {",
  "-  return 1;",
  "+  return 3;",
  "*** End Patch",
  "(also '*** Add File: <path>' with '+' lines, '*** Delete File: <path>').",
].join("\n");

function formatError(message: string): PatchError {
  return new PatchError(`${message}\n${PATCH_FORMAT_HELP}`);
}

const V4A_FILE_HEADER = /^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/;
const V4A_MARKER = /^\*\*\* (Begin Patch|End Patch|End of File|Move to:)/;
const NUMBERED_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_METADATA = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |Index: |={4,})/;

export function parsePatch(text: string): FilePatch[] {
  const lines = stripFences(stripBom(text).replace(/\r\n?/g, "\n").split("\n"));
  const isV4a = lines.some((line) => line.trim() === "*** Begin Patch" || V4A_FILE_HEADER.test(line.trim()));
  const patches = isV4a ? parseV4a(lines) : parseUnified(lines);
  if (patches.length === 0) {
    throw formatError(
      lines.some((line) => line.startsWith("@@"))
        ? "the patch has hunks but no file header naming the file to change"
        : "the patch contains no file changes",
    );
  }
  return patches;
}

function stripFences(lines: string[]): string[] {
  const result = [...lines];
  const first = result.findIndex((line) => line.trim() !== "");
  if (first !== -1 && /^```/.test(result[first]?.trim() ?? "")) result.splice(first, 1);
  let last = result.length - 1;
  while (last >= 0 && (result[last] ?? "").trim() === "") last -= 1;
  if (last >= 0 && (result[last] ?? "").trim() === "```") result.splice(last, 1);
  return result;
}

// ---------------------------------------------------------------------------------------------
// *** Begin Patch format

function parseV4a(lines: readonly string[]): FilePatch[] {
  const patches: FilePatch[] = [];
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  let index = begin === -1 ? lines.findIndex((line) => V4A_FILE_HEADER.test(line.trim())) : begin + 1;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    if (line === "*** End Patch") break;
    if (line === "") {
      index += 1;
      continue;
    }
    const header = V4A_FILE_HEADER.exec(line);
    if (header === null) throw formatError(`unexpected line ${quote(raw)} in the patch; expected '*** Update File: <path>', '*** Add File: <path>' or '*** Delete File: <path>'`);
    const kind = header[1] as "Update" | "Add" | "Delete";
    const target = cleanPath(header[2] ?? "");
    index += 1;
    if (kind === "Delete") {
      patches.push({ kind: "delete", path: target, moveTo: undefined, hunks: [] });
      continue;
    }
    if (kind === "Add") {
      const added: PatchLine[] = [];
      let trailingBlank = 0;
      let newNoEol = false;
      while (index < lines.length && !isV4aBoundary(lines[index] ?? "")) {
        const body = lines[index] ?? "";
        if (body.startsWith("+")) {
          added.push({ op: "+", text: body.slice(1) });
          trailingBlank = 0;
        } else if (body.startsWith("\\")) newNoEol = true;
        else if (body === "") {
          added.push({ op: "+", text: "" });
          trailingBlank += 1;
        } else throw formatError(`every line of '*** Add File: ${target}' must start with '+'; found ${quote(body)}`);
        index += 1;
      }
      added.splice(added.length - trailingBlank, trailingBlank);
      patches.push({ kind: "add", path: target, moveTo: undefined, hunks: [hunkOf(added, { newNoEol })] });
      continue;
    }
    let moveTo: string | undefined;
    const move = /^\*\*\* Move to:\s*(.+?)\s*$/.exec((lines[index] ?? "").trim());
    if (move !== null) {
      moveTo = cleanPath(move[1] ?? "");
      index += 1;
    }
    const hunks: PatchHunk[] = [];
    while (index < lines.length && !isV4aFileBoundary(lines[index] ?? "")) {
      const anchors: string[] = [];
      while ((lines[index] ?? "").startsWith("@@")) {
        const anchor = (lines[index] ?? "").slice(2).replace(/@@\s*$/, "").trim();
        if (anchor !== "") anchors.push(anchor);
        index += 1;
      }
      const body = readBody(lines, index, "v4a", target);
      if (body.next === index && anchors.length === 0) {
        throw formatError(`unexpected line ${quote(lines[index] ?? "")} in '*** Update File: ${target}'`);
      }
      index = body.next;
      if (body.lines.length > 0 || anchors.length > 0) hunks.push({ ...hunkOf(body.lines, body), anchors });
    }
    if (hunks.every((hunk) => hunk.lines.length === 0) && moveTo === undefined) throw formatError(`'*** Update File: ${target}' has no changes`);
    patches.push({ kind: "update", path: target, moveTo, hunks: hunks.filter((hunk) => hunk.lines.length > 0) });
  }
  return patches;
}

function isV4aFileBoundary(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "*** End Patch" || V4A_FILE_HEADER.test(trimmed);
}

function isV4aBoundary(line: string): boolean {
  return isV4aFileBoundary(line) || line.startsWith("@@") || V4A_MARKER.test(line.trim());
}

// ---------------------------------------------------------------------------------------------
// Unified diff

function parseUnified(lines: readonly string[]): FilePatch[] {
  const patches: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!isUnifiedFileHeader(lines, index)) {
      index += 1;
      continue;
    }
    const oldPath = headerPath((lines[index] ?? "").slice(4));
    const newPath = headerPath((lines[index + 1] ?? "").slice(4));
    if (oldPath === null && newPath === null) throw formatError("a file patch cannot go from /dev/null to /dev/null");
    index += 2;
    const hunks: PatchHunk[] = [];
    while (index < lines.length && (lines[index] ?? "").startsWith("@@")) {
      const headerLine = lines[index] ?? "";
      const numbered = NUMBERED_HUNK.exec(headerLine);
      index += 1;
      if (numbered !== null) {
        const oldStart = Number(numbered[1]);
        const oldLines = numbered[2] === undefined ? 1 : Number(numbered[2]);
        const newLines = numbered[4] === undefined ? 1 : Number(numbered[4]);
        const counted = readCountedBody(lines, index, oldLines, newLines);
        const body = counted ?? readBody(lines, index, "unified", newPath ?? oldPath ?? "");
        index = body.next;
        hunks.push({ ...hunkOf(body.lines, body), oldStart, oldLines });
        continue;
      }
      const anchor = headerLine.slice(2).replace(/@@\s*$/, "").trim();
      const body = readBody(lines, index, "unified", newPath ?? oldPath ?? "");
      index = body.next;
      hunks.push({ ...hunkOf(body.lines, body), anchors: anchor === "" ? [] : [anchor] });
    }
    const label = newPath ?? oldPath ?? "";
    if (oldPath === null) patches.push({ kind: "add", path: label, moveTo: undefined, hunks });
    else if (newPath === null) patches.push({ kind: "delete", path: oldPath, moveTo: undefined, hunks: [] });
    else {
      if (hunks.length === 0 && oldPath === newPath) throw formatError(`no hunks for ${newPath}`);
      patches.push({ kind: "update", path: oldPath, moveTo: oldPath === newPath ? undefined : newPath, hunks });
    }
  }
  return patches;
}

function isUnifiedFileHeader(lines: readonly string[], index: number): boolean {
  return (lines[index] ?? "").startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ");
}

function headerPath(raw: string): string | null {
  const value = (raw.split("\t")[0] ?? "").trim();
  if (value === "/dev/null") return null;
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return cleanPath(unquoted.replace(/^[ab]\//, ""));
}

function cleanPath(value: string): string {
  const trimmed = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (trimmed.length === 0) throw formatError("a file header names no path");
  return trimmed;
}

// ---------------------------------------------------------------------------------------------
// Hunk bodies

interface Body {
  readonly lines: PatchLine[];
  readonly next: number;
  readonly endOfFile: boolean;
  readonly oldNoEol: boolean;
  readonly newNoEol: boolean;
}

function hunkOf(lines: readonly PatchLine[], flags: Partial<Pick<Body, "endOfFile" | "oldNoEol" | "newNoEol">>): PatchHunk {
  return {
    oldStart: undefined,
    oldLines: undefined,
    anchors: [],
    lines: lines.map((line) => ({ op: line.op, text: stripBom(line.text) })),
    endOfFile: flags.endOfFile ?? false,
    oldNoEol: flags.oldNoEol ?? false,
    newNoEol: flags.newNoEol ?? false,
  };
}

function isBodyStop(lines: readonly string[], index: number, format: "v4a" | "unified"): boolean {
  const line = lines[index] ?? "";
  if (line.startsWith("@@")) return true;
  if (format === "v4a") return line.startsWith("*** ");
  return isUnifiedFileHeader(lines, index) || GIT_METADATA.test(line);
}

/**
 * A numbered hunk read by its counts, the way `patch` does; undefined when the counts do not fit
 * the text (a model miscounted), in which case the caller reads the body by its markers instead.
 */
function readCountedBody(lines: readonly string[], start: number, oldLines: number, newLines: number): Body | undefined {
  const body: PatchLine[] = [];
  let seenOld = 0;
  let seenNew = 0;
  let index = start;
  let lastOp: PatchLineOp | undefined;
  let oldNoEol = false;
  let newNoEol = false;
  while (index < lines.length && (seenOld < oldLines || seenNew < newLines)) {
    const line = lines[index] ?? "";
    if (isBodyStop(lines, index, "unified")) return undefined;
    const marker = line[0];
    if (marker === " " || line === "") {
      seenOld += 1;
      seenNew += 1;
      body.push({ op: " ", text: line.slice(1) });
      lastOp = " ";
    } else if (marker === "-") {
      seenOld += 1;
      body.push({ op: "-", text: line.slice(1) });
      lastOp = "-";
    } else if (marker === "+") {
      seenNew += 1;
      body.push({ op: "+", text: line.slice(1) });
      lastOp = "+";
    } else if (marker === "\\") {
      ({ oldNoEol, newNoEol } = noEolFlags(lastOp, oldNoEol, newNoEol));
    } else return undefined;
    index += 1;
  }
  if (seenOld !== oldLines || seenNew !== newLines) return undefined;
  while ((lines[index] ?? "").startsWith("\\")) {
    ({ oldNoEol, newNoEol } = noEolFlags(lastOp, oldNoEol, newNoEol));
    index += 1;
  }
  const following = lines[index];
  if (following !== undefined && following !== "" && !isBodyStop(lines, index, "unified") && /^[ +-]/.test(following)) return undefined;
  return { lines: body, next: index, endOfFile: false, oldNoEol, newNoEol };
}

function readBody(lines: readonly string[], start: number, format: "v4a" | "unified", label: string): Body {
  const body: PatchLine[] = [];
  const fromEmpty: boolean[] = [];
  let index = start;
  let lastOp: PatchLineOp | undefined;
  let endOfFile = false;
  let oldNoEol = false;
  let newNoEol = false;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (format === "v4a" && line.trim() === "*** End of File") {
      endOfFile = true;
      index += 1;
      break;
    }
    if (isBodyStop(lines, index, format)) break;
    const marker = line[0];
    if (line === "") {
      body.push({ op: " ", text: "" });
      fromEmpty.push(true);
    } else if (marker === " " || marker === "-" || marker === "+") {
      body.push({ op: marker, text: line.slice(1) });
      fromEmpty.push(false);
      lastOp = marker;
    } else if (marker === "\\") {
      ({ oldNoEol, newNoEol } = noEolFlags(lastOp, oldNoEol, newNoEol));
    } else if (format === "unified") break;
    else throw formatError(`unexpected line ${quote(line)} in a hunk for ${label}; hunk lines start with ' ' (context), '-' (remove) or '+' (add)`);
    index += 1;
  }
  while (fromEmpty.at(-1) === true) {
    fromEmpty.pop();
    body.pop();
  }
  return { lines: body, next: index, endOfFile, oldNoEol, newNoEol };
}

function noEolFlags(lastOp: PatchLineOp | undefined, oldNoEol: boolean, newNoEol: boolean): { oldNoEol: boolean; newNoEol: boolean } {
  if (lastOp === "-") return { oldNoEol: true, newNoEol };
  if (lastOp === "+") return { oldNoEol, newNoEol: true };
  return { oldNoEol: true, newNoEol: true };
}

// ---------------------------------------------------------------------------------------------
// Application

/** Content of a file the patch creates: `\n` line endings, a final newline unless marked otherwise. */
export function contentOfAddedFile(patch: FilePatch): DecodedText {
  const added = patch.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.op !== "-"));
  const noEol = patch.hunks.some((hunk) => hunk.newNoEol);
  return {
    bom: false,
    lines: added.map((line, index) => ({ content: line.text, eol: index === added.length - 1 && noEol ? "" : "\n" })),
  };
}

type Comparator = (fileLine: string, patchLine: string) => boolean;

const COMPARATORS: readonly Comparator[] = [
  (fileLine, patchLine) => fileLine === patchLine,
  (fileLine, patchLine) => fileLine.trimEnd() === patchLine.trimEnd(),
  (fileLine, patchLine) => fileLine.trim() === patchLine.trim(),
];

export function applyHunks(original: DecodedText, hunks: readonly PatchHunk[], label: string): DecodedText {
  const source = original.lines;
  const dominant = dominantEol(source);
  const output: { content: string; eol: LineEnding | undefined }[] = [];
  let cursor = 0;
  hunks.forEach((hunk, hunkIndex) => {
    const where = `hunk ${hunkIndex + 1} of ${label}`;
    let searchFrom = cursor;
    for (const anchor of hunk.anchors) {
      const found = findLine(source, anchor, searchFrom);
      if (found === -1) throw new PatchError(`context mismatch in ${where}: the '@@ ${anchor}' line was not found${searchFrom > 0 ? ` after line ${searchFrom}` : ""}. Re-read the file and copy the line exactly, or use a bare '@@'.`);
      searchFrom = found + 1;
    }
    const oldSide = hunk.lines.filter((line) => line.op !== "+").map((line) => line.text);
    const position = locate(source, oldSide, hunk, searchFrom, where);
    output.push(...source.slice(cursor, position));
    let at = position;
    let removedRun: TextLine[] = [];
    let addedInRun = 0;
    for (const line of hunk.lines) {
      if (line.op === " ") {
        const kept = source[at];
        if (kept !== undefined) output.push(kept);
        at += 1;
        removedRun = [];
        addedInRun = 0;
      } else if (line.op === "-") {
        const removed = source[at];
        if (removed !== undefined) removedRun.push(removed);
        at += 1;
      } else {
        const paired = removedRun[addedInRun] ?? removedRun.at(-1);
        const previous = output.at(-1)?.eol;
        const next = source[at]?.eol;
        const eol = [paired?.eol, previous, next].find((candidate): candidate is Exclude<LineEnding, ""> => candidate !== undefined && candidate !== "") ?? dominant;
        output.push({ content: line.text, eol });
        addedInRun += 1;
      }
    }
    cursor = at;
  });
  output.push(...source.slice(cursor));

  const endsWithNewline = source.length === 0 || source.at(-1)?.eol !== "";
  const finalNewline = hunks.some((hunk) => hunk.newNoEol) ? false : hunks.some((hunk) => hunk.oldNoEol) ? true : endsWithNewline;
  const lines: TextLine[] = output.map((line, index) => {
    const eol = line.eol ?? dominant;
    if (index < output.length - 1) return { content: line.content, eol: eol === "" ? dominant : eol };
    if (!finalNewline) return { content: line.content, eol: "" };
    return { content: line.content, eol: eol === "" ? (output.at(-2)?.eol || dominant) : eol };
  });
  return { bom: original.bom, lines };
}

function locate(source: readonly TextLine[], oldSide: readonly string[], hunk: PatchHunk, searchFrom: number, where: string): number {
  if (oldSide.length === 0) {
    if (hunk.oldStart !== undefined) {
      const hinted = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
      return Math.min(Math.max(hinted, searchFrom), source.length);
    }
    return hunk.anchors.length > 0 ? searchFrom : source.length;
  }
  for (const compare of COMPARATORS) {
    const candidates: number[] = [];
    for (let start = searchFrom; start + oldSide.length <= source.length; start += 1) {
      if (oldSide.every((text, offset) => compare(source[start + offset]?.content ?? "", text))) candidates.push(start);
    }
    if (candidates.length === 0) continue;
    if (hunk.endOfFile) {
      const atEnd = candidates.find((start) => start + oldSide.length === source.length);
      if (atEnd !== undefined) return atEnd;
    }
    if (hunk.oldStart !== undefined) {
      const hint = hunk.oldStart - 1;
      return candidates.reduce((best, candidate) => (Math.abs(candidate - hint) < Math.abs(best - hint) ? candidate : best));
    }
    return candidates[0] ?? searchFrom;
  }
  const first = oldSide[0] ?? "";
  const expectedAt = hunk.oldStart === undefined ? "" : ` (expected near line ${hunk.oldStart})`;
  throw new PatchError(
    `context mismatch in ${where}${expectedAt}: its ${oldSide.length} context/removed line(s) starting with ${quote(first)} were not found${searchFrom > 0 ? ` after line ${searchFrom}` : ""}. Re-read the file with read_file and copy the context and '-' lines exactly; hunks must be in file order.`,
  );
}

function findLine(source: readonly TextLine[], text: string, from: number): number {
  for (const compare of COMPARATORS) {
    for (let index = from; index < source.length; index += 1) {
      if (compare(source[index]?.content ?? "", text)) return index;
    }
  }
  return -1;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text);
}
