/**
 * Strict unified diff reading and application for `apply_patch`. There is no fuzz: every context
 * and removed line must match exactly where the hunk header says, otherwise the patch fails and
 * nothing is written. Line endings of the original file are preserved.
 */

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export interface FilePatch {
  /** Workspace-relative path before the change, or null for a new file. */
  readonly oldPath: string | null;
  /** Workspace-relative path after the change, or null for a deletion. */
  readonly newPath: string | null;
  readonly hunks: readonly DiffHunk[];
}

export class PatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(text: string): FilePatch[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const patches: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("--- ")) {
      index += 1;
      continue;
    }
    const next = lines[index + 1] ?? "";
    if (!next.startsWith("+++ ")) throw new PatchError(`expected '+++' after '${line}'`);
    const oldPath = headerPath(line.slice(4));
    const newPath = headerPath(next.slice(4));
    if (oldPath === null && newPath === null) throw new PatchError("a file patch cannot go from /dev/null to /dev/null");
    index += 2;
    const hunks: DiffHunk[] = [];
    while (index < lines.length && (lines[index] ?? "").startsWith("@@")) {
      const match = HUNK_HEADER.exec(lines[index] ?? "");
      if (match === null) throw new PatchError(`malformed hunk header '${lines[index]}'`);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      index += 1;
      const body: string[] = [];
      let seenOld = 0;
      let seenNew = 0;
      while (index < lines.length && (seenOld < oldLines || seenNew < newLines || (lines[index] ?? "").startsWith("\\"))) {
        const bodyLine = lines[index] ?? "";
        const marker = bodyLine[0];
        if (marker === " " || bodyLine === "") {
          seenOld += 1;
          seenNew += 1;
          body.push(bodyLine === "" ? " " : bodyLine);
        } else if (marker === "-") {
          seenOld += 1;
          body.push(bodyLine);
        } else if (marker === "+") {
          seenNew += 1;
          body.push(bodyLine);
        } else if (marker === "\\") body.push(bodyLine);
        else break;
        index += 1;
      }
      if (seenOld !== oldLines || seenNew !== newLines) throw new PatchError(`hunk line counts do not match its header in ${newPath ?? oldPath}`);
      hunks.push({ oldStart: Number(match[1]), oldLines, newStart: Number(match[3]), newLines, lines: body });
    }
    if (hunks.length === 0 && oldPath !== null && newPath !== null) throw new PatchError(`no hunks for ${newPath}`);
    patches.push({ oldPath, newPath, hunks });
  }
  if (patches.length === 0) throw new PatchError("the patch contains no file changes");
  return patches;
}

export function applyHunks(original: string, hunks: readonly DiffHunk[], label: string): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = original.length === 0 || original.endsWith("\n");
  const source = original.length === 0 ? [] : original.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let finalNewline = endsWithNewline;
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > source.length) throw new PatchError(`hunk at line ${hunk.oldStart} is out of order or beyond the end of ${label}`);
    output.push(...source.slice(cursor, start));
    let position = start;
    let lastSide: "old" | "new" | "both" = "both";
    for (const line of hunk.lines) {
      const marker = line[0];
      const content = line.slice(1);
      if (marker === "\\") {
        if (lastSide !== "old") finalNewline = false;
        continue;
      }
      if (marker === " " || marker === "-") {
        if (source[position] !== content) throw new PatchError(`context mismatch in ${label} at line ${position + 1}`);
        position += 1;
        if (marker === " ") output.push(content);
        lastSide = marker === " " ? "both" : "old";
      } else {
        output.push(content);
        lastSide = "new";
      }
    }
    cursor = position;
  }
  output.push(...source.slice(cursor));
  if (output.length === 0) return "";
  return output.join(eol) + (finalNewline ? eol : "");
}

function headerPath(raw: string): string | null {
  const value = raw.split("\t")[0]?.trim() ?? "";
  if (value === "/dev/null") return null;
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return unquoted.replace(/^[ab]\//, "");
}
