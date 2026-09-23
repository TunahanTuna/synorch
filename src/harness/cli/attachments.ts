import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { workspaceDigest, type Attachment } from "../contracts/index.ts";

/**
 * Message attachments (K1-U1 `Attachment`: `@path` mentions, pasted/dragged paths, clipboard
 * images). Files are inlined with their workspace digest, size-capped; a directory becomes a short
 * listing; images are sent only when the route reports `image_input: supported` — the message
 * channel is text today, so even then the model gets a reference and a clear notice says so. In
 * plain mode (no palette) `@path` tokens that name an existing file are attached the same way.
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
}

export interface AttachmentOptions {
  readonly workspaceRoot: string;
  /** The conversation route's image input capability (`supported` forwards images). */
  readonly imageInput: ImageInputLevel;
  readonly model: string;
}

interface Requested {
  readonly kind: "file" | "directory" | "image";
  readonly absolute: string;
  readonly display: string;
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
  const requested: Requested[] = explicit.map((entry) => ({ kind: entry.kind, absolute: path.resolve(root, entry.path), display: entry.displayPath || entry.label }));
  for (const mention of mentionedPaths(text)) {
    const absolute = path.resolve(root, mention);
    if (requested.some((entry) => entry.absolute === absolute)) continue;
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined || relativeInside(root, absolute) === undefined) continue;
    const media = IMAGE_EXTENSIONS[path.extname(absolute).toLowerCase()];
    requested.push({ kind: info.isDirectory() ? "directory" : media !== undefined ? "image" : "file", absolute, display: mention });
  }
  if (requested.length === 0) return { message: text, notices };

  const blocks: string[] = [];
  let total = 0;
  for (const entry of requested) {
    if (entry.kind === "image") {
      notices.push({
        level: "warning",
        text:
          options.imageInput === "supported"
            ? `${entry.display}: images are not sent yet (the message channel is text); ${options.model} got a reference only`
            : `${entry.display}: ${options.model} does not take image input (${options.imageInput}); the image was not sent`,
      });
      blocks.push(`<image name="${attribute(entry.display)}" sent="false" reason="image input unavailable"/>`);
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
  if (blocks.length === 0) return { message: text, notices };
  return { message: `${text}\n\n${ATTACHMENTS_OPEN}\n${blocks.join("\n")}\n${ATTACHMENTS_CLOSE}`, notices };
}
