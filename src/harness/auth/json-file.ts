import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Reads a JSON file; `undefined` when it does not exist. Malformed JSON throws so it is never overwritten blindly. */
export async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as unknown;
}

/**
 * Atomic replace: a `0600` temp file in the same directory (created `0700`), fsync, rename. On
 * Windows the mode bits are ignored and the file inherits the user profile's ACL.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(temporary, filePath);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  if (process.platform !== "win32") await chmod(filePath, 0o600);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  await retryTransientFs(() => rename(from, to));
}

const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Windows reports EPERM/EACCES/EBUSY while another handle (a concurrent reader, antivirus, the
 * indexer) holds a file, or while it is still delete-pending after an unlink. Those clear within
 * milliseconds, so the operation is retried with a bounded exponential backoff (about 1.3s in
 * total at the default 8 attempts) before the error is surfaced.
 */
export async function retryTransientFs<T>(operation: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= attempts || !isTransientFsError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}

export function isTransientFsError(error: unknown): boolean {
  return TRANSIENT_FS_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}
