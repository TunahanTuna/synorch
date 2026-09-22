import { randomBytes } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  sessionLeaseSchema,
  StoreFailure,
  type SessionId,
  type SessionLease,
} from "../contracts/index.ts";
import { errnoCode, isMissing, PRIVATE_FILE_MODE, renameWithRetry, syncDirectory, writeAll, writeFileDurably } from "./durable-file.ts";

export interface LeaseSettings {
  readonly clock: () => Date;
  readonly pid: number;
  readonly host: string;
  readonly ttlMs: number;
  readonly heartbeatMs: number;
}

export type LeaseInspection =
  | { readonly state: "absent" }
  | { readonly state: "live"; readonly lease: SessionLease | undefined }
  | { readonly state: "stale"; readonly lease: SessionLease | undefined; readonly reason: string };

/** The single writer's hold on `lock.json`: created with O_EXCL, renewed by heartbeat, bound to a random token. */
export class SessionLeaseHandle {
  readonly #file: string;
  readonly #settings: LeaseSettings;
  #lease: SessionLease;
  #timer: NodeJS.Timeout | undefined;
  #renewing: Promise<void> | undefined;
  #lostReason: string | undefined;

  private constructor(file: string, lease: SessionLease, settings: LeaseSettings) {
    this.#file = file;
    this.#lease = lease;
    this.#settings = settings;
  }

  public get lease(): SessionLease {
    return this.#lease;
  }

  public get lostReason(): string | undefined {
    return this.#lostReason;
  }

  /** Acquires the lease, taking over one that expired or whose holder process is gone. */
  public static async acquire(file: string, sessionId: SessionId, settings: LeaseSettings): Promise<SessionLeaseHandle> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lease = newLease(sessionId, settings);
      if (await createExclusive(file, lease)) {
        const handle = new SessionLeaseHandle(file, lease, settings);
        handle.#startHeartbeat();
        return handle;
      }
      const inspection = await inspectLease(file, settings);
      if (inspection.state === "absent") continue;
      if (inspection.state === "live") throw lockedFailure(sessionId, inspection.lease);
      await takeOver(file, inspection.lease);
    }
    throw lockedFailure(sessionId, undefined);
  }

  /** Confirms `lock.json` still carries this writer's token, renewing when the lease is close to expiry. */
  public async verify(): Promise<void> {
    if (this.#lostReason !== undefined) throw this.#lostFailure();
    const now = this.#settings.clock().getTime();
    if (now + this.#settings.heartbeatMs >= Date.parse(this.#lease.expires_at)) {
      await this.renew();
    } else {
      await this.#checkToken();
    }
    if (this.#lostReason !== undefined) throw this.#lostFailure();
  }

  /** One heartbeat: re-reads the token and extends `expires_at`; a foreign token marks the lease lost. */
  public async renew(): Promise<void> {
    if (this.#renewing !== undefined) return this.#renewing;
    this.#renewing = this.#renewNow().finally(() => {
      this.#renewing = undefined;
    });
    return this.#renewing;
  }

  public async release(): Promise<void> {
    this.#stopHeartbeat();
    await this.#renewing?.catch(() => undefined);
    if (this.#lostReason !== undefined) return;
    this.#lostReason = "released";
    const current = await readLeaseFile(this.#file);
    if (current.lease?.holder.token !== this.#lease.holder.token) return;
    await unlink(this.#file).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }

  async #renewNow(): Promise<void> {
    if (this.#lostReason !== undefined) return;
    await this.#checkToken();
    if (this.#lostReason !== undefined) return;
    const now = this.#settings.clock();
    const renewed = sessionLeaseSchema.parse({
      ...this.#lease,
      heartbeat_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.#settings.ttlMs).toISOString(),
    });
    try {
      await writeFileDurably(this.#file, `${JSON.stringify(renewed)}\n`);
      this.#lease = renewed;
    } catch (error: unknown) {
      if (this.#settings.clock().getTime() >= Date.parse(this.#lease.expires_at)) {
        this.#markLost(`lease could not be renewed before expiry: ${errnoCode(error) ?? String(error)}`);
      }
    }
  }

  async #checkToken(): Promise<void> {
    let current: LeaseFileRead;
    try {
      current = await readLeaseFile(this.#file);
    } catch {
      return;
    }
    if (current.missing) {
      this.#markLost("lock.json was removed by another process");
    } else if (current.lease?.holder.token !== this.#lease.holder.token) {
      const holder = current.lease?.holder;
      this.#markLost(holder === undefined ? "lock.json was replaced" : `lease taken over by pid ${holder.pid} on ${holder.host}`);
    }
  }

  #markLost(reason: string): void {
    this.#lostReason = reason;
    this.#stopHeartbeat();
  }

  #lostFailure(): StoreFailure {
    return new StoreFailure("write_failed", `session ${this.#lease.session_id} is no longer held by this writer: ${this.#lostReason ?? "unknown"}`);
  }

  #startHeartbeat(): void {
    this.#timer = setInterval(() => {
      void this.renew().catch(() => undefined);
    }, this.#settings.heartbeatMs);
    this.#timer.unref();
  }

  #stopHeartbeat(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** Reads `lock.json` and classifies it; used by `openForWrite` and by `list` for the `locked` flag. */
export async function inspectLease(file: string, settings: Pick<LeaseSettings, "clock" | "host" | "ttlMs">): Promise<LeaseInspection> {
  const current = await readLeaseFile(file);
  if (current.missing) return { state: "absent" };
  const now = settings.clock().getTime();
  if (current.lease === undefined) {
    const young = current.mtimeMs !== undefined && now - current.mtimeMs < settings.ttlMs;
    return young ? { state: "live", lease: undefined } : { state: "stale", lease: undefined, reason: "unreadable lock file" };
  }
  if (now >= Date.parse(current.lease.expires_at)) return { state: "stale", lease: current.lease, reason: "lease expired" };
  if (current.lease.holder.host === settings.host && current.lease.holder.pid !== process.pid && !processAlive(current.lease.holder.pid)) {
    return { state: "stale", lease: current.lease, reason: "holder process exited" };
  }
  return { state: "live", lease: current.lease };
}

interface LeaseFileRead {
  readonly missing: boolean;
  readonly lease: SessionLease | undefined;
  readonly mtimeMs: number | undefined;
}

async function readLeaseFile(file: string): Promise<LeaseFileRead> {
  let text: string;
  let mtimeMs: number | undefined;
  try {
    text = await readFile(file, "utf8");
    mtimeMs = (await stat(file).catch(() => undefined))?.mtimeMs;
  } catch (error: unknown) {
    if (isMissing(error)) return { missing: true, lease: undefined, mtimeMs: undefined };
    throw error;
  }
  try {
    const parsed = sessionLeaseSchema.safeParse(JSON.parse(text));
    return { missing: false, lease: parsed.success ? parsed.data : undefined, mtimeMs };
  } catch {
    return { missing: false, lease: undefined, mtimeMs };
  }
}

function newLease(sessionId: SessionId, settings: LeaseSettings): SessionLease {
  const now = settings.clock();
  return sessionLeaseSchema.parse({
    schema_version: 1,
    session_id: sessionId,
    holder: { pid: settings.pid, host: settings.host, token: randomBytes(16).toString("hex") },
    acquired_at: now.toISOString(),
    heartbeat_at: now.toISOString(),
    expires_at: new Date(now.getTime() + settings.ttlMs).toISOString(),
  });
}

async function createExclusive(file: string, lease: SessionLease): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "wx", PRIVATE_FILE_MODE);
  } catch (error: unknown) {
    if (errnoCode(error) === "EEXIST") return false;
    throw new StoreFailure("write_failed", `cannot create ${file}: ${errnoCode(error) ?? String(error)}`);
  }
  try {
    await writeAll(handle, Buffer.from(`${JSON.stringify(lease)}\n`, "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
  return true;
}

/**
 * Moves a stale `lock.json` aside under a unique name. Only one contender's rename can succeed; if
 * the file moved aside turns out not to be the stale lease that was inspected (another writer won
 * the race meanwhile), it is put back and the caller re-inspects.
 */
async function takeOver(file: string, stale: SessionLease | undefined): Promise<void> {
  const aside = `${file}.stale-${randomBytes(6).toString("hex")}`;
  try {
    await renameWithRetry(file, aside);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  const moved = await readLeaseFile(aside);
  if (stale !== undefined && moved.lease !== undefined && moved.lease.holder.token !== stale.holder.token) {
    await renameWithRetry(aside, file).catch(() => undefined);
    return;
  }
  await unlink(aside).catch(() => undefined);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errnoCode(error) !== "ESRCH";
  }
}

function lockedFailure(sessionId: SessionId, lease: SessionLease | undefined): StoreFailure {
  const holder = lease === undefined ? "another writer" : `pid ${lease.holder.pid} on ${lease.holder.host} (lease until ${lease.expires_at})`;
  return new StoreFailure("session_locked", `session ${sessionId} is locked by ${holder}`);
}
