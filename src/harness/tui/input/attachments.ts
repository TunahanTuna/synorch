import { statSync } from "node:fs";
import path from "node:path";
import type { Attachment } from "../../contracts/index.ts";
import type { ClipboardImage } from "./clipboard.ts";

/**
 * Attachments of the message being typed. Images get a `[image N]` chip in the editor text; `@path`
 * mentions stay as typed. On submit `collect(text)` returns the images whose chip is still in the
 * text plus every mention that names an existing path, so deleting a chip drops its image.
 */

const MENTIONS = /(?:^|[\s(,])@(?:"([^"]+)"|([^\s"]+))/g;

export function imageLabel(index: number): string {
  return `[image ${index}]`;
}

export class AttachmentTray {
  private readonly root: string;
  private readonly images: Attachment[] = [];
  private nextImage = 1;

  public constructor(root: string) {
    this.root = path.resolve(root);
  }

  public get pendingImages(): readonly Attachment[] {
    return this.images;
  }

  public addImage(image: ClipboardImage, source: "clipboard" | "paste-path"): Attachment {
    const index = this.nextImage;
    this.nextImage += 1;
    const attachment: Attachment = {
      id: `image-${index}`,
      kind: "image",
      label: imageLabel(index),
      path: image.path,
      displayPath: source === "clipboard" ? "clipboard image" : this.display(image.path),
      source,
      mediaType: image.mediaType,
      bytes: image.bytes,
      ...(source === "clipboard" ? { temporary: true } : {}),
    };
    this.images.push(attachment);
    return attachment;
  }

  /** Attachments referenced by the submitted text; clears the tray for the next message. */
  public collect(text: string): Attachment[] {
    const result: Attachment[] = this.images.filter((image) => text.includes(image.label));
    const seen = new Set<string>();
    let fileIndex = 1;
    for (const match of text.matchAll(MENTIONS)) {
      const raw = (match[1] ?? match[2] ?? "").replace(/[.,;:!?)]+$/, "");
      if (raw === "") continue;
      const absolute = path.resolve(this.root, raw);
      if (seen.has(absolute)) continue;
      let kind: "file" | "directory";
      try {
        const info = statSync(absolute);
        if (info.isDirectory()) kind = "directory";
        else if (info.isFile()) kind = "file";
        else continue;
      } catch {
        continue;
      }
      seen.add(absolute);
      result.push({
        id: `${kind}-${fileIndex}`,
        kind,
        label: match[1] === undefined ? `@${raw}` : `@"${raw}"`,
        path: absolute,
        displayPath: this.display(absolute),
        source: "mention",
      });
      fileIndex += 1;
    }
    this.images.length = 0;
    this.nextImage = 1;
    return result;
  }

  private display(absolute: string): string {
    const relative = path.relative(this.root, absolute);
    return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative.split(path.sep).join("/");
  }
}
