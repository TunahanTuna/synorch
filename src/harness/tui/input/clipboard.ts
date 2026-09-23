import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Clipboard images for the prompt. First the native helper pi-tui ships (Windows/macOS/X11, handed
 * in by the renderer so this module stays pi-tui free), then the platform tools:
 * Windows `powershell.exe Get-Clipboard -Format Image` (System.Windows.Forms fallback), macOS
 * `pngpaste` then `osascript`, Linux `wl-paste` on Wayland and `xclip` on X11. The image is written
 * to a temporary PNG (or the format it already had) that the attachment points at.
 */

export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ClipboardImage {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
}

/** pi-tui's `NativeClipboard.getImage` shape. */
export interface NativeImageSource {
  getImage(): Promise<Uint8Array | null | undefined>;
}

export type CommandRunner = (file: string, args: readonly string[], options: { readonly timeoutMs: number; readonly binary?: boolean }) => Promise<{ readonly ok: boolean; readonly stdout: Buffer }>;

export const runCommand: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "buffer", timeout: options.timeoutMs, windowsHide: true, maxBuffer: MAX_IMAGE_BYTES + 1024 }, (error, stdout) => {
      resolve({ ok: error === null, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "") });
    });
  });

export interface ClipboardEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly native?: NativeImageSource | undefined;
  readonly run?: CommandRunner;
  readonly tempDir?: string;
}

/** Magic-number sniffing; BMP is reported so callers can convert it. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return undefined;
}

function extensionFor(mediaType: string): string {
  return mediaType === "image/jpeg" ? ".jpg" : `.${mediaType.slice("image/".length)}`;
}

let counter = 0;

export function imageTempDir(base = os.tmpdir()): string {
  return path.join(base, "synorch-images");
}

function nextTempPath(directory: string, extension: string): string {
  counter += 1;
  return path.join(directory, `${process.pid}-${Date.now().toString(36)}-${counter}${extension}`);
}

async function saveBytes(directory: string, bytes: Uint8Array, mediaType: string): Promise<ClipboardImage> {
  await mkdir(directory, { recursive: true });
  const file = nextTempPath(directory, extensionFor(mediaType));
  await writeFile(file, bytes);
  return { path: file, mediaType, bytes: bytes.length };
}

async function fileImage(file: string): Promise<ClipboardImage | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) return undefined;
    const bytes = await readFile(file);
    const mediaType = sniffImage(bytes);
    if (mediaType === undefined || mediaType === "image/bmp") return undefined;
    return { path: file, mediaType, bytes: info.size };
  } catch {
    return undefined;
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function viaCommands(environment: ClipboardEnvironment, directory: string): Promise<ClipboardImage | undefined> {
  const run = environment.run ?? runCommand;
  await mkdir(directory, { recursive: true });
  if (environment.platform === "win32") {
    const target = nextTempPath(directory, ".png");
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Drawing",
      "$i=$null",
      "try { $i = Get-Clipboard -Format Image } catch { }",
      "if ($i -eq $null) { Add-Type -AssemblyName System.Windows.Forms; $i = [System.Windows.Forms.Clipboard]::GetImage() }",
      "if ($i -eq $null) { exit 3 }",
      `$i.Save(${psQuote(target)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join("; ");
    const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { timeoutMs: 8000 });
    return result.ok ? fileImage(target) : undefined;
  }
  if (environment.platform === "darwin") {
    const target = nextTempPath(directory, ".png");
    if ((await run("pngpaste", [target], { timeoutMs: 5000 })).ok) {
      const image = await fileImage(target);
      if (image !== undefined) return image;
    }
    const escaped = target.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = [
      `set f to open for access POSIX file "${escaped}" with write permission`,
      "try",
      "write (the clipboard as «class PNGf») to f",
      "end try",
      "close access f",
    ];
    await run("osascript", script.flatMap((line) => ["-e", line]), { timeoutMs: 5000 });
    const image = await fileImage(target);
    if (image === undefined) await unlink(target).catch(() => undefined);
    return image;
  }
  const attempts: [string, string[]][] = [];
  if ((environment.env.WAYLAND_DISPLAY ?? "") !== "") attempts.push(["wl-paste", ["--no-newline", "--type", "image/png"]]);
  attempts.push(["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]);
  for (const [file, args] of attempts) {
    const result = await run(file, args, { timeoutMs: 5000, binary: true });
    if (!result.ok || result.stdout.length === 0 || result.stdout.length > MAX_IMAGE_BYTES) continue;
    const mediaType = sniffImage(result.stdout);
    if (mediaType !== undefined && mediaType !== "image/bmp") return saveBytes(directory, result.stdout, mediaType);
  }
  return undefined;
}

/** Undefined when the clipboard holds no image (or no reader works on this machine). */
export async function readClipboardImage(environment: ClipboardEnvironment): Promise<ClipboardImage | undefined> {
  const directory = environment.tempDir ?? imageTempDir();
  if (environment.native !== undefined) {
    try {
      const bytes = await environment.native.getImage();
      if (bytes !== null && bytes !== undefined && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) {
        const mediaType = sniffImage(bytes);
        // The Windows helper returns BMP for DIB-only clipboards; PowerShell re-encodes those to PNG.
        if (mediaType !== undefined && mediaType !== "image/bmp") return saveBytes(directory, bytes, mediaType);
      }
    } catch {
      // fall through to the platform tools
    }
  }
  try {
    return await viaCommands(environment, directory);
  } catch {
    return undefined;
  }
}

/**
 * A pasted or dragged-in path to an image file: strips quotes, `file://` and the backslash escapes
 * macOS terminals add for spaces. Returns the absolute path when it names an existing image.
 */
export async function imagePathFromPaste(text: string, cwd: string): Promise<ClipboardImage | undefined> {
  let candidate = text.trim();
  if (candidate === "" || candidate.includes("\n")) return undefined;
  if ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'"))) candidate = candidate.slice(1, -1);
  if (candidate.startsWith("& ")) candidate = candidate.slice(2).replace(/^['"]|['"]$/g, "");
  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
      if (/^\/[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(1);
    } catch {
      return undefined;
    }
  }
  if (process.platform !== "win32") candidate = candidate.replace(/\\(.)/g, "$1");
  if (candidate.startsWith("~/")) candidate = path.join(os.homedir(), candidate.slice(2));
  const extension = path.extname(candidate).toLowerCase();
  if (IMAGE_MEDIA_TYPES[extension] === undefined) return undefined;
  return fileImage(path.resolve(cwd, candidate));
}
