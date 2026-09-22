import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 8;
const IGNORED_DIRECTORY_SYNC_CODES: ReadonlySet<string> = new Set(["EISDIR", "EINVAL", "EPERM", "EBADF", "ENOTSUP"]);

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

export function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function isMissing(error: unknown): boolean {
  return errnoCode(error) === "ENOENT";
}

/**
 * Temp file in the target directory, fsync, rename over the target, fsync the directory. On
 * Windows a rename over a file another process holds open fails transiently with EPERM/EACCES/
 * EBUSY, so the rename is retried with a bounded backoff instead of spinning.
 */
export async function writeFileDurably(target: string, data: string | Uint8Array): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await renameWithRetry(temporary, target);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error: unknown) {
      if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME_CODES.has(errnoCode(error) ?? "")) throw error;
      await delay(5 * 2 ** attempt);
    }
  }
}

/** Makes a create/rename/unlink in `directory` durable. Windows cannot open directories; NTFS journals metadata. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!IGNORED_DIRECTORY_SYNC_CODES.has(errnoCode(error) ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

/** Writes every byte; a file handle may report a short write. */
export async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("short write: no bytes written");
    offset += bytesWritten;
  }
}
