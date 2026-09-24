import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { IMAGE_MAX_BYTES, IMAGE_MEDIA_TYPES, workspaceDigest, type Attachment, type BlobRef } from "../contracts/index.ts";

/**
 * Message attachments (K1-U1 `Attachment`: `@path` mentions, pasted/dragged paths, clipboard
 * images). Files are inlined with their workspace digest, size-capped; a directory becomes a short
 * listing; images go to the blob store and are sent as `image` message parts when the route takes
 * image input (`images.send`), otherwise a clear notice says the image was not sent. Clipboard
 * temp files are deleted once read. In plain mode (no palette) `@path` tokens that name an existing file are attached the same way.
 * Paths outside the workspace and reserved paths (`.git`, `.synorch`) are refused.
 */

export const ATTACHMENT_FILE_LIMIT_BYTES = 64 * 1024;
export const ATTACHMENT_TOTAL_LIMIT_BYTES = 192 * 1024;
export const ATTACHMENTS_OPEN = "<synorch-attachments>";
export const ATTACHMENTS_CLOSE = "</synorch-attachments>";
const DIRECTORY_LISTING_LIMIT = 200;

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const RESERVED = /(^|\/)(\.git|\.synorch)(\/|$)/i;

export type ImageInputLevel = "supported" | "degraded" | "unsupported" | "unknown";

export interface AttachmentResult {
  /** The message with the attachment block appended (unchanged when nothing was attached). */
  readonly message: string;
  /** Short lines for the view (`Attached src/a.ts · 2.1 KB`, refusals, the image notice). */
  readonly notices: readonly { readonly level: "info" | "warning"; readonly text: string }[];
  /** Images stored in the blob store, to be sent as `image` parts after the message text. */
  readonly images: readonly BlobRef[];
}

export interface ImageSink {
  /** True when the route sends images to the model. */
  readonly send: boolean;
  /** Why images are not sent (shown in the notice) when `send` is false. */
  readonly reason: string;
  put(bytes: Uint8Array, mediaType: string): Promise<BlobRef>;
}

export interface AttachmentOptions {
  readonly workspaceRoot: string;
  readonly model: string;
  /** Where images go; without it images are refused with a notice. */
  readonly images?: ImageSink;
}

interface Requested {
  readonly kind: "file" | "directory" | "image";
  readonly absolute: string;
  readonly display: string;
  readonly temporary?: boolean;
}

/** `@path` tokens as typed (quotes stripped); the text itself is left unchanged. */
export function mentionedPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@((?:"[^"]+")|[^\s,;:!?)]+)/g)) {
    const raw = (match[1] ?? "").replace(/^"|"$/g, "");
    if (raw !== "" && !found.includes(raw)) found.push(raw);
  }
  return found;
}

/** True when the message could carry an image (so the route's capability is worth looking up). */
export function mayContainImage(text: string, attachments: readonly Attachment[]): boolean {
  return attachments.some((entry) => entry.kind === "image") || /@\S+\.(png|jpe?g|gif|webp)\b/i.test(text);
}

function relativeInside(root: string, absolute: string): string | undefined {
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export async function resolveAttachments(text: string, explicit: readonly Attachment[], options: AttachmentOptions): Promise<AttachmentResult> {
  const root = options.workspaceRoot;
  const notices: { level: "info" | "warning"; text: string }[] = [];
  const requested: Requested[] = explicit.map((entry) => ({
    kind: entry.kind,
    absolute: path.resolve(root, entry.path),
    display: entry.kind === "image" ? entry.label || entry.displayPath : entry.displayPath || entry.label,
    temporary: entry.temporary === true,
  }));
  for (const mention of mentionedPaths(text)) {
    const absolute = path.resolve(root, mention);
    if (requested.some((entry) => entry.absolute === absolute)) continue;
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined || relativeInside(root, absolute) === undefined) continue;
    const media = IMAGE_EXTENSIONS[path.extname(absolute).toLowerCase()];
    requested.push({ kind: info.isDirectory() ? "directory" : media !== undefined ? "image" : "file", absolute, display: mention });
  }
  if (requested.length === 0) return { message: text, notices, images: [] };
  const images: BlobRef[] = [];

  const blocks: string[] = [];
  let total = 0;
  for (const entry of requested) {
    if (entry.kind === "image") {
      const sent = await attachImage(entry, options);
      notices.push(sent.notice);
      if (sent.blob !== undefined) {
        images.push(sent.blob);
        blocks.push(`<image name="${attribute(entry.display)}" index="${images.length}" media_type="${sent.blob.media_type}" bytes="${sent.blob.size_bytes}"/>`);
      } else {
        blocks.push(`<image name="${attribute(entry.display)}" sent="false" reason="${attribute(sent.reason)}"/>`);
      }
      continue;
    }
    const relative = relativeInside(root, entry.absolute);
    if (relative === undefined || RESERVED.test(relative)) {
      notices.push({ level: "warning", text: `Not attached ${entry.display}: outside the workspace or a reserved path` });
      continue;
    }
    if (entry.kind === "directory") {
      const names = await readdir(entry.absolute, { withFileTypes: true }).catch(() => undefined);
      if (names === undefined) {
        notices.push({ level: "warning", text: `Not attached ${relative}: it cannot be read` });
        continue;
      }
      const listed = names
        .filter((name) => !RESERVED.test(name.name))
        .slice(0, DIRECTORY_LISTING_LIMIT)
        .map((name) => `${name.name}${name.isDirectory() ? "/" : ""}`);
      blocks.push(`<directory path="${attribute(relative)}" entries="${names.length}">\n${listed.join("\n")}\n</directory>`);
      notices.push({ level: "info", text: `Attached ${relative}/ · ${names.length} entries` });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(entry.absolute);
    } catch {
      notices.push({ level: "warning", text: `Not attached ${relative}: it cannot be read` });
      continue;
    }
    if (bytes.subarray(0, 8192).includes(0)) {
      notices.push({ level: "warning", text: `Not attached ${relative}: binary file (${kilobytes(bytes.length)})` });
      continue;
    }
    const room = Math.min(ATTACHMENT_FILE_LIMIT_BYTES, ATTACHMENT_TOTAL_LIMIT_BYTES - total);
    if (room <= 0) {
      notices.push({ level: "warning", text: `Not attached ${relative}: the attachment limit (${kilobytes(ATTACHMENT_TOTAL_LIMIT_BYTES)}) is reached` });
      continue;
    }
    const truncated = bytes.length > room;
    const shown = truncated ? bytes.subarray(0, room) : bytes;
    total += shown.length;
    const digest = workspaceDigest(new Uint8Array(bytes));
    blocks.push(`<file path="${attribute(relative)}" digest="${digest}" bytes="${bytes.length}"${truncated ? ` truncated="true" shown="${shown.length}"` : ""}>\n${shown.toString("utf8")}\n</file>`);
    notices.push({ level: "info", text: `Attached ${relative} · ${kilobytes(bytes.length)}${truncated ? ` (first ${kilobytes(shown.length)})` : ""}` });
  }
  if (blocks.length === 0) return { message: text, notices, images };
  return { message: `${text}\n\n${ATTACHMENTS_OPEN}\n${blocks.join("\n")}\n${ATTACHMENTS_CLOSE}`, notices, images };
}

type Notice = { readonly level: "info" | "warning"; readonly text: string };

function sniffMediaType(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return undefined;
}

/** Reads one image into the blob store (deleting a clipboard temp file afterwards) or explains why not. */
async function attachImage(entry: Requested, options: AttachmentOptions): Promise<{ readonly notice: Notice; readonly blob?: BlobRef; readonly reason: string }> {
  const sink = options.images;
  try {
    if (sink === undefined || !sink.send) {
      const reason = sink?.reason ?? `${options.model} does not take image input`;
      return { notice: { level: "warning", text: `${entry.display}: ${reason}; the image was not sent` }, reason };
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(entry.absolute);
    } catch {
      return { notice: { level: "warning", text: `${entry.display}: the image cannot be read; it was not sent` }, reason: "unreadable" };
    }
    const mediaType = sniffMediaType(bytes) ?? IMAGE_EXTENSIONS[path.extname(entry.absolute).toLowerCase()];
    if (mediaType === undefined || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
      return { notice: { level: "warning", text: `${entry.display}: not a PNG, JPEG, GIF or WebP image; it was not sent` }, reason: "unsupported format" };
    }
    if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) {
      return { notice: { level: "warning", text: `${entry.display}: ${kilobytes(bytes.length)} is over the ${kilobytes(IMAGE_MAX_BYTES)} image limit; it was not sent` }, reason: "too large" };
    }
    const blob = await sink.put(new Uint8Array(bytes), mediaType);
    return { notice: { level: "info", text: `Attached ${entry.display} · ${mediaType.slice(6).toUpperCase()} ${kilobytes(bytes.length)}` }, blob, reason: "" };
  } finally {
    if (entry.temporary === true) await rm(entry.absolute, { force: true }).catch(() => undefined);
  }
}
