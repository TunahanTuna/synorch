/**
 * Byte-faithful text handling for the edit tools (ADR-18 D3). A file is decoded strictly as UTF-8
 * (never lossily), split into lines that each keep their own terminator (`\r\n`, `\n`, a lone
 * `\r`, or none on the last line), and re-encoded so every line the edit did not touch comes back
 * byte-identical. A UTF-8 byte order mark is kept per file and ignored while matching.
 */

export type LineEnding = "\r\n" | "\n" | "\r" | "";

export interface TextLine {
  readonly content: string;
  readonly eol: LineEnding;
}

export interface DecodedText {
  readonly bom: boolean;
  readonly lines: readonly TextLine[];
}

const UTF8_BOM = "﻿";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A file the edit tools refuse to touch because they could not write it back faithfully. */
export class TextEncodingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TextEncodingError";
  }
}

/** Strict UTF-8 decode; invalid bytes (a legacy code page such as cp1254, UTF-16, binary) are refused. */
export function decodeUtf8Strict(bytes: Uint8Array, label: string): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new TextEncodingError(
      `${label} is not valid UTF-8 (a legacy code page such as Windows-1254, UTF-16 or binary); refusing to edit it because rewriting it would corrupt bytes you did not change. Convert the file to UTF-8 first or leave it unchanged.`,
    );
  }
}

export function decodeTextFile(bytes: Uint8Array, label: string): DecodedText {
  const text = decodeUtf8Strict(bytes, label);
  const bom = text.startsWith(UTF8_BOM);
  return { bom, lines: splitLines(bom ? text.slice(1) : text) };
}

export function encodeTextFile(decoded: DecodedText): Buffer {
  return Buffer.from((decoded.bom ? UTF8_BOM : "") + joinLines(decoded.lines), "utf8");
}

export function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  const terminator = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = terminator.exec(text); match !== null; match = terminator.exec(text)) {
    lines.push({ content: text.slice(start, match.index), eol: match[0] as LineEnding });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ content: text.slice(start), eol: "" });
  return lines;
}

export function joinLines(lines: readonly TextLine[]): string {
  return lines.map((line) => line.content + line.eol).join("");
}

/** The single terminator every terminated line uses, or undefined for a mixed file or one without any. */
export function uniformEol(lines: readonly TextLine[]): Exclude<LineEnding, ""> | undefined {
  let found: Exclude<LineEnding, ""> | undefined;
  for (const line of lines) {
    if (line.eol === "") continue;
    if (found === undefined) found = line.eol;
    else if (found !== line.eol) return undefined;
  }
  return found;
}

/** The most common terminator (ties prefer `\n`, then `\r\n`), `\n` for a file without any. */
export function dominantEol(lines: readonly TextLine[]): Exclude<LineEnding, ""> {
  const counts = { "\n": 0, "\r\n": 0, "\r": 0 };
  for (const line of lines) if (line.eol !== "") counts[line.eol] += 1;
  if (counts["\r\n"] > counts["\n"] && counts["\r\n"] >= counts["\r"]) return "\r\n";
  if (counts["\r"] > counts["\n"] && counts["\r"] > counts["\r\n"]) return "\r";
  return "\n";
}

export function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

/**
 * The bytes `write_file` stores for `content` over an existing file: when the existing file uses
 * one line ending throughout, every line ending of the new content becomes that one (a model
 * writing LF over a CRLF file keeps CRLF); a mixed or terminator-free file leaves the content as
 * given. A byte order mark on the existing file is kept.
 */
export function conformContent(content: string, existing: DecodedText | undefined): Buffer {
  if (existing === undefined) return Buffer.from(content, "utf8");
  const eol = uniformEol(existing.lines);
  const body = stripBom(content);
  const converted = eol === undefined ? body : body.replace(/\r\n|\n|\r/g, eol);
  return Buffer.from((existing.bom || content.startsWith(UTF8_BOM) ? UTF8_BOM : "") + converted, "utf8");
}
