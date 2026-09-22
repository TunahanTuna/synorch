import { open, readdir } from "node:fs/promises";
import path from "node:path";
import {
  parseSessionEvent,
  segmentHeaderSchema,
  SEGMENT_FILE_PATTERN,
  type EventParseResult,
  type SegmentHeader,
  type SessionId,
} from "../contracts/index.ts";
import { isMissing } from "./durable-file.ts";

/** Hard cap for one event line; larger payloads belong in the blob store. */
export const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface SegmentLine {
  /** `undefined` when the line exceeded `MAX_EVENT_LINE_BYTES` and was not buffered. */
  readonly bytes: Buffer | undefined;
  readonly start: number;
  readonly end: number;
  readonly terminated: boolean;
}

export interface SegmentFile {
  readonly segment: number;
  readonly file: string;
}

export type ScanItem =
  | { readonly kind: "event"; readonly position: number; readonly segment: number; readonly result: EventParseResult }
  | { readonly kind: "torn-tail"; readonly segment: number; readonly start: number; readonly bytes: number; readonly headerOnly: boolean };

export interface ScanOptions {
  readonly sessionId: SessionId;
  /** The `first_seq` the first segment header must declare (1, or `parent.up_to_seq + 1` for a fork). */
  readonly firstSeq: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  /** Report an incomplete final line of the last segment as `torn-tail` instead of stopping silently. */
  readonly reportTornTail: boolean;
  /** Start at the last segment (summaries); positions still come from that segment's header. */
  readonly lastSegmentOnly?: boolean;
}

/** Streams LF-terminated lines with bounded memory; only `\n` separates lines (never U+2028/U+2029). */
export async function* readSegmentLines(file: string): AsyncGenerator<SegmentLine> {
  const handle = await open(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let parts: Buffer[] = [];
    let pending = 0;
    let oversized = false;
    let lineStart = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = view.indexOf(0x0a, cursor);
        const sliceEnd = newline === -1 ? bytesRead : newline;
        const piece = view.subarray(cursor, sliceEnd);
        if (!oversized && pending + piece.length > MAX_EVENT_LINE_BYTES) {
          oversized = true;
          parts = [];
        }
        if (!oversized) parts.push(Buffer.from(piece));
        pending += piece.length;
        if (newline === -1) break;
        const end = position + newline + 1;
        yield { bytes: oversized ? undefined : Buffer.concat(parts), start: lineStart, end, terminated: true };
        parts = [];
        pending = 0;
        oversized = false;
        lineStart = end;
        cursor = newline + 1;
      }
      position += bytesRead;
    }
    if (pending > 0) {
      yield { bytes: oversized ? undefined : Buffer.concat(parts), start: lineStart, end: position, terminated: false };
    }
  } finally {
    await handle.close();
  }
}

export async function listSegments(segmentsDir: string): Promise<SegmentFile[]> {
  let names: string[];
  try {
    names = await readdir(segmentsDir);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names
    .filter((name) => SEGMENT_FILE_PATTERN.test(name))
    .map((name) => ({ segment: Number.parseInt(name.slice(0, 6), 10), file: path.join(segmentsDir, name) }))
    .sort((left, right) => left.segment - right.segment);
}

export async function readSegmentHeader(file: string): Promise<SegmentHeader | undefined> {
  for await (const line of readSegmentLines(file)) {
    if (!line.terminated || line.bytes === undefined) return undefined;
    const decoded = decodeJson(line.bytes);
    if (!decoded.ok) return undefined;
    const parsed = segmentHeaderSchema.safeParse(decoded.value);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}

export function encodeLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

type Decoded = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

function decodeJson(bytes: Buffer): Decoded {
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function invalid(message: string, path: readonly PropertyKey[] = []): EventParseResult {
  return { status: "invalid", issues: [{ path, message }] };
}

/**
 * Reads a session's own segments in order and validates the framing: header per segment,
 * consecutive segment numbers, dense `seq`, matching `session_id`. Only the final line of the last
 * segment may be incomplete (torn tail); any other damage is reported as an `invalid` item.
 */
export async function* scanSegments(segmentsDir: string, options: ScanOptions): AsyncGenerator<ScanItem> {
  const segments = await listSegments(segmentsDir);
  const startIndex = await chooseStartIndex(segments, options);
  let expected: number | undefined;
  for (let index = startIndex; index < segments.length; index += 1) {
    const current = segments[index];
    if (current === undefined) break;
    const lastSegment = index === segments.length - 1;
    if (current.segment !== index + 1) {
      yield { kind: "event", position: expected ?? options.firstSeq, segment: current.segment, result: invalid(`segment ${index + 1} is missing`) };
      return;
    }
    const state: LineState = { headerSeen: false, expected, stop: false };
    let held: SegmentLine | undefined;
    for await (const line of readSegmentLines(current.file)) {
      if (held !== undefined) {
        const item = interpretLine(held, false, current.segment, state, options);
        if (item !== undefined) yield item;
        if (state.stop) return;
      }
      held = line;
      if (state.headerSeen && state.expected !== undefined && state.expected > options.toSeq) return;
    }
    if (held !== undefined) {
      const item = interpretLine(held, lastSegment, current.segment, state, options);
      if (item !== undefined) yield item;
      if (state.stop) return;
    }
    if (!state.headerSeen) {
      if (lastSegment) {
        if (options.reportTornTail) yield { kind: "torn-tail", segment: current.segment, start: 0, bytes: 0, headerOnly: true };
        return;
      }
      yield { kind: "event", position: state.expected ?? options.firstSeq, segment: current.segment, result: invalid("segment has no header") };
      return;
    }
    expected = state.expected;
    if (expected !== undefined && expected > options.toSeq) return;
  }
}

interface LineState {
  headerSeen: boolean;
  expected: number | undefined;
  stop: boolean;
}

function interpretLine(
  line: SegmentLine,
  final: boolean,
  segment: number,
  state: LineState,
  options: ScanOptions,
): ScanItem | undefined {
  const decoded: Decoded = line.bytes === undefined ? { ok: false, message: "line exceeds the maximum event size" } : decodeJson(line.bytes);
  const torn = final && (!line.terminated || !decoded.ok);
  if (!state.headerSeen) {
    if (torn) {
      state.stop = true;
      return options.reportTornTail ? { kind: "torn-tail", segment, start: line.start, bytes: line.end - line.start, headerOnly: true } : undefined;
    }
    state.stop = true;
    if (!decoded.ok || !line.terminated) return { kind: "event", position: state.expected ?? options.firstSeq, segment, result: invalid(`segment ${segment} header is unreadable`) };
    const header = segmentHeaderSchema.safeParse(decoded.value);
    if (!header.success) return { kind: "event", position: state.expected ?? options.firstSeq, segment, result: invalid(`segment ${segment} header is invalid`) };
    const declared = header.data.first_seq;
    const required = state.expected ?? (segment === 1 ? options.firstSeq : undefined);
    const continues = required === undefined ? declared >= options.firstSeq : declared === required;
    if (header.data.session_id !== options.sessionId || header.data.segment !== segment || !continues) {
      return { kind: "event", position: required ?? declared, segment, result: invalid(`segment ${segment} header does not continue the session`) };
    }
    state.stop = false;
    state.headerSeen = true;
    state.expected = header.data.first_seq;
    return undefined;
  }
  const position = state.expected ?? options.firstSeq;
  if (torn) {
    state.stop = true;
    return options.reportTornTail ? { kind: "torn-tail", segment, start: line.start, bytes: line.end - line.start, headerOnly: false } : undefined;
  }
  state.expected = position + 1;
  if (position < options.fromSeq) return undefined;
  if (position > options.toSeq) {
    state.stop = true;
    return undefined;
  }
  if (!line.terminated) return { kind: "event", position, segment, result: invalid("line is not terminated") };
  if (!decoded.ok) return { kind: "event", position, segment, result: invalid(`malformed JSON: ${decoded.message}`) };
  const result = parseSessionEvent(decoded.value);
  if (result.status === "ok") {
    if (result.event.seq !== position) return { kind: "event", position, segment, result: invalid(`expected seq ${position}, found ${result.event.seq}`, ["seq"]) };
    if (result.event.session_id !== options.sessionId) return { kind: "event", position, segment, result: invalid("event belongs to another session", ["session_id"]) };
  }
  return { kind: "event", position, segment, result };
}

async function chooseStartIndex(segments: readonly SegmentFile[], options: ScanOptions): Promise<number> {
  if (segments.length === 0) return 0;
  if (options.lastSegmentOnly === true) return segments.length - 1;
  if (options.fromSeq <= options.firstSeq) return 0;
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const candidate = segments[index];
    if (candidate === undefined || candidate.segment !== index + 1) return 0;
    const header = await readSegmentHeader(candidate.file);
    if (header !== undefined && header.first_seq <= options.fromSeq) return index;
  }
  return 0;
}
