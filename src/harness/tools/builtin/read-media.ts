import { readFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_MAX_BYTES, type Digest, type ImageMediaType, type ToolExecutionContext, type ToolResult } from "../../contracts/index.ts";
import { errorResult, okResult } from "./shared.ts";

/**
 * K4.2 `read_file` for images and PDFs. An image goes to the blob store and comes back as the
 * result's `blob` with its image media type; the driver shows it to vision-capable routes as an
 * image part right after the tool results (others get a note that it was not shown). A PDF is
 * turned into text page by page with pdf.js (via `unpdf`, a zero-dependency serverless build,
 * loaded only when a PDF is read); `pages` picks a range and the full selected text goes to a blob.
 */

const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const PDF_MAX_BYTES = 50 * 1024 * 1024;
const PDF_INLINE_CHARS = 13 * 1024;
const PDF_DEFAULT_PAGES = 20;

export type MediaKind = "image" | "pdf";

export function mediaKindOf(file: string): MediaKind | undefined {
  const extension = path.extname(file).toLowerCase();
  if (extension in IMAGE_TYPES) return "image";
  if (extension === ".pdf") return "pdf";
  return undefined;
}

/** True when `media_type` is an image the model adapters accept. */
export function isImageBlob(mediaType: string): mediaType is ImageMediaType {
  return Object.values(IMAGE_TYPES).includes(mediaType as ImageMediaType);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function readImage(relative: string, absolute: string, size: number, digest: Digest, context: ToolExecutionContext): Promise<ToolResult> {
  const mediaType = IMAGE_TYPES[path.extname(relative).toLowerCase()];
  if (mediaType === undefined) return errorResult("invalid_arguments", `${relative} is not a supported image type (png, jpg, gif, webp)`);
  if (size > IMAGE_MAX_BYTES) {
    return errorResult("invalid_arguments", `${relative} is ${formatBytes(size)}; images above ${formatBytes(IMAGE_MAX_BYTES)} are not sent (no downscaling); resize it first`);
  }
  const bytes = await readFile(absolute);
  if (!sniffImage(bytes, mediaType)) return errorResult("invalid_arguments", `${relative} does not look like a ${mediaType} file`);
  const blob = await context.blobs.put(new Uint8Array(bytes), mediaType);
  return okResult(`${relative} · digest ${digest} · image ${mediaType} · ${formatBytes(size)} · the image is attached after this result for vision-capable models`, { digest, blob });
}

function sniffImage(bytes: Buffer, mediaType: ImageMediaType): boolean {
  switch (mediaType) {
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8;
    case "image/gif":
      return bytes.subarray(0, 4).toString("latin1") === "GIF8";
    case "image/webp":
      return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  }
}

/** `3`, `2-5`, `1,4-6` → sorted unique 1-based page numbers within `total`. */
export function parsePages(spec: string | undefined, total: number): number[] | string {
  if (spec === undefined || spec.trim() === "") return Array.from({ length: Math.min(total, PDF_DEFAULT_PAGES) }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)?\s*)?$/.exec(part);
    if (match === null) return `pages must look like 3, 2-5 or 1,4-6 (got ${spec})`;
    const start = Number(match[1]);
    const end = match[2] === undefined ? (part.includes("-") ? total : start) : Number(match[2]);
    if (start < 1 || end < start) return `invalid page range ${part.trim()}`;
    for (let page = start; page <= Math.min(end, total); page += 1) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

interface PdfTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(page: number): Promise<{ getTextContent(): Promise<{ readonly items: readonly PdfTextItem[] }> }>;
  destroy?(): Promise<void>;
}

export async function readPdf(relative: string, absolute: string, size: number, digest: Digest, pagesSpec: string | undefined, context: ToolExecutionContext): Promise<ToolResult> {
  if (size > PDF_MAX_BYTES) return errorResult("invalid_arguments", `${relative} is ${formatBytes(size)}; PDFs above ${formatBytes(PDF_MAX_BYTES)} are not read`);
  const bytes = await readFile(absolute);
  let document: PdfDocument;
  try {
    const { getDocumentProxy } = await import("unpdf");
    document = (await getDocumentProxy(new Uint8Array(bytes))) as unknown as PdfDocument;
  } catch (error: unknown) {
    return errorResult("execution_failed", `${relative} could not be opened as a PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const total = document.numPages;
    const pages = parsePages(pagesSpec, total);
    if (typeof pages === "string") return errorResult("invalid_arguments", pages);
    if (pages.length === 0) return errorResult("invalid_arguments", `${relative} has ${total} page${total === 1 ? "" : "s"}; the requested pages are past the end`);
    const sections: string[] = [];
    for (const page of pages) {
      if (context.signal.aborted) return errorResult("cancelled", "reading the PDF was cancelled");
      const content = await (await document.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => `${item.str ?? ""}${item.hasEOL === true ? "\n" : ""}`)
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      sections.push(`--- page ${page} ---\n${text === "" ? "(no text on this page; it may be a scanned image)" : text}`);
    }
    const full = sections.join("\n\n");
    const range = pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}-${pages.at(-1)}${pages.length !== (pages.at(-1) ?? 0) - (pages[0] ?? 0) + 1 ? ` (${pages.length} selected)` : ""}`;
    const more = pagesSpec === undefined && total > pages.length ? `; ${total - pages.length} more page${total - pages.length === 1 ? "" : "s"}, pass pages (e.g. "${pages.length + 1}-${Math.min(total, pages.length * 2)}")` : "";
    const clipped = full.length > PDF_INLINE_CHARS;
    const header = `${relative} · digest ${digest} · PDF · ${total} page${total === 1 ? "" : "s"} · ${range}${more}${clipped ? "; text truncated here, the full selection is in the result blob; pass a narrower pages range" : ""}`;
    const blob = clipped ? await context.blobs.put(new Uint8Array(Buffer.from(full, "utf8")), "text/plain; charset=utf-8") : undefined;
    return okResult(`${header}\n${clipped ? `${full.slice(0, PDF_INLINE_CHARS)}\n…` : full}`, { digest, truncated: clipped || more !== "", ...(blob === undefined ? {} : { blob }) });
  } finally {
    await document.destroy?.().catch(() => undefined);
  }
}
