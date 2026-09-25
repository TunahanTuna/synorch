import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../contracts/index.ts";
import { isTransientFsError, retryTransientFs } from "./json-file.ts";

export interface FileLockOptions {
  /** A lock older than this is considered abandoned (crashed holder) and taken over. */
  readonly staleMs?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 25;

/**
 * Cross-process mutual exclusion through an `O_EXCL` lock file holding the owner's pid and a random
 * token. Release removes the file only if it still carries our token. A lock whose holder process
 * is gone, or which is older than `staleMs`, is taken over.
 *
 * On Windows a just-released lock file stays delete-pending while any other handle (a waiter's
 * stale check, antivirus, the indexer) is still open on it; during that window `open(wx)`, `unlink`
 * and reads fail with EPERM/EACCES/EBUSY. On `open` that means "someone is on it" and is treated
 * like EEXIST (keep polling); `unlink` and the token read are retried with a bounded backoff.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const token = randomBytes(16).toString("hex");
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    if (options.signal?.aborted === true) {
      throw new HarnessError({ code: "cancelled", message: "lock wait aborted", workspace_effect: "none", retry_safe: true });
    }
    let transient: unknown;
    try {
      await createLockFile(lockPath, token);
      return () => releaseFileLock(lockPath, token);
    } catch (error: unknown) {
      if (isTransientFsError(error)) transient = error;
      else if (!isExists(error)) throw error;
    }
    if (transient === undefined && (await isAbandoned(lockPath, staleMs))) {
      await removeLockFile(lockPath).catch(() => undefined);
      continue;
    }
    if (Date.now() > deadline) {
      if (transient !== undefined) throw transient;
      throw new HarnessError({
        code: "internal",
        message: `timed out waiting for lock ${path.basename(lockPath)}`,
        workspace_effect: "none",
        retry_safe: true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? DEFAULT_POLL_MS));
  }
}

/** Creates the lock exclusively; a failed write never leaves a half-written lock file behind. */
async function createLockFile(lockPath: string, token: string): Promise<void> {
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() }));
    await handle.sync();
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await removeLockFile(lockPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

/** Removes the lock only while it still carries our token. Never throws: release runs in `finally` blocks. */
async function releaseFileLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = JSON.parse(await retryTransientFs(() => readFile(lockPath, "utf8"))) as { token?: unknown };
    if (current.token === token) await removeLockFile(lockPath, 10);
  } catch {
    return;
  }
}

async function removeLockFile(lockPath: string, attempts?: number): Promise<void> {
  try {
    await retryTransientFs(() => unlink(lockPath), attempts);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function isAbandoned(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const [info, text] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")]);
    if (Date.now() - info.mtimeMs > staleMs) return true;
    const owner = JSON.parse(text) as { pid?: unknown };
    return typeof owner.pid === "number" && owner.pid !== process.pid && !isAlive(owner.pid);
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/** In-process, per-key serialization: callers for the same key run one after another. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  public async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
