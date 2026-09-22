/**
 * ConPTY loses viewport tracking when a single write exceeds roughly 32-64 KB (research §2, OMP
 * `chunkForConPTY`). Every interactive write is therefore split into pieces of at most 16 KiB of
 * UTF-8, preferring to end a piece after an LF and never splitting a surrogate pair.
 */

export const CONPTY_MAX_WRITE_BYTES = 16 * 1024;

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function chunkForConPty(data: string, maxBytes: number = CONPTY_MAX_WRITE_BYTES): string[] {
  if (data.length === 0) return [];
  if (Buffer.byteLength(data, "utf8") <= maxBytes) return [data];
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  let lastNewlineEnd = -1;
  let index = 0;
  while (index < data.length) {
    const codePoint = data.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const size = utf8Length(codePoint);
    if (bytes + size > maxBytes) {
      const end = lastNewlineEnd > start ? lastNewlineEnd : index;
      chunks.push(data.slice(start, end));
      start = end;
      index = end;
      bytes = 0;
      lastNewlineEnd = -1;
      continue;
    }
    bytes += size;
    index += width;
    if (codePoint === 0x0a) lastNewlineEnd = index;
  }
  if (start < data.length) chunks.push(data.slice(start));
  return chunks;
}
