import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import {
  createId,
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  SEGMENT_MAX_BYTES,
  sessionIdSchema,
  sessionManifestSchema,
  StoreFailure,
  type EventStore,
  type ProjectId,
  type ReadOnlyEventStore,
  type SessionId,
  type SessionManifest,
  type SessionStore,
  type SessionSummary,
} from "../contracts/index.ts";
import { errnoCode, isMissing, PRIVATE_DIRECTORY_MODE, syncDirectory, writeFileDurably } from "./durable-file.ts";
import {
  firstOwnSeq,
  JsonlEventStore,
  JsonlReadOnlyEventStore,
  type QuarantinedTail,
  type SessionLocation,
  type WriterPosition,
  type WriterSettings,
} from "./event-store.ts";
import { LOCK_FILE, MANIFEST_FILE, projectDirectory, segmentPath, segmentsDirectory, sessionDirectory, sessionsRoot } from "./layout.ts";
import { inspectLease, SessionLeaseHandle, type LeaseSettings } from "./lease.ts";
import { listSegments, scanSegments } from "./segments.ts";

export interface SessionStoreOptions {
  /** Time source for timestamps, lease expiry and ids. Defaults to the system clock. */
  readonly clock?: () => Date;
  /** `writer.version` recorded in segment headers. Defaults to the package version. */
  readonly writerVersion?: string;
  /** Rotation threshold; defaults to `SEGMENT_MAX_BYTES` (8 MiB). */
  readonly segmentMaxBytes?: number;
  readonly lease?: {
    readonly ttlMs?: number;
    readonly heartbeatMs?: number;
    readonly pid?: number;
    readonly host?: string;
  };
}

/** Creates the segmented JSONL session store rooted at `home` (`~/.synorch` or `$SYNORCH_HOME`). */
export function createSessionStore(home: string, options: SessionStoreOptions = {}): SessionStore {
  return new JsonlSessionStore(home, options);
}

interface OwnScan {
  readonly position: WriterPosition | undefined;
  readonly lastEventAt: string | undefined;
  readonly unsupported: string | undefined;
  readonly corrupt: string | undefined;
  readonly tornTail: { readonly segment: number; readonly start: number; readonly bytes: number; readonly headerOnly: boolean } | undefined;
}

class JsonlSessionStore implements SessionStore {
  readonly #home: string;
  readonly #clock: () => Date;
  readonly #writer: WriterSettings;
  readonly #lease: LeaseSettings;
  readonly #locations = new Map<SessionId, SessionLocation>();

  public constructor(home: string, options: SessionStoreOptions) {
    this.#home = path.resolve(home);
    this.#clock = options.clock ?? (() => new Date());
    this.#writer = {
      clock: this.#clock,
      writerVersion: options.writerVersion ?? SYNORCH_VERSION,
      segmentMaxBytes: options.segmentMaxBytes ?? SEGMENT_MAX_BYTES,
    };
    this.#lease = {
      clock: this.#clock,
      pid: options.lease?.pid ?? process.pid,
      host: options.lease?.host ?? hostname(),
      ttlMs: options.lease?.ttlMs ?? LEASE_TTL_MS,
      heartbeatMs: options.lease?.heartbeatMs ?? LEASE_HEARTBEAT_MS,
    };
  }

  public async create(input: Omit<SessionManifest, "schema_version">): Promise<EventStore> {
    const parsed = sessionManifestSchema.safeParse({ schema_version: 1, ...input });
    if (!parsed.success) {
      throw new StoreFailure("write_failed", `invalid session manifest: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    const manifest = parsed.data;
    if (manifest.parent !== undefined) await this.#assertForkPoint(manifest.parent.session_id, manifest.parent.up_to_seq);
    if ((await this.#tryLocate(manifest.session_id)) !== undefined) {
      throw new StoreFailure("write_failed", `session ${manifest.session_id} already exists`);
    }
    const directory = sessionDirectory(this.#home, manifest.project_id, manifest.session_id);
    try {
      await mkdir(projectDirectory(this.#home, manifest.project_id), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
      await mkdir(segmentsDirectory(directory), { mode: PRIVATE_DIRECTORY_MODE });
      await syncDirectory(projectDirectory(this.#home, manifest.project_id));
      await writeFileDurably(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error: unknown) {
      const reason = errnoCode(error) === "EEXIST" ? "already exists" : `could not be created: ${errnoCode(error) ?? String(error)}`;
      throw new StoreFailure("write_failed", `session ${manifest.session_id} ${reason}`);
    }
    const location: SessionLocation = { directory, manifest };
    this.#locations.set(manifest.session_id, location);
    const lease = await SessionLeaseHandle.acquire(path.join(directory, LOCK_FILE), manifest.session_id, this.#lease);
    try {
      return await JsonlEventStore.open(location, (id) => this.#locate(id), lease, this.#writer, undefined, undefined);
    } catch (error: unknown) {
      await lease.release().catch(() => undefined);
      throw asWriteFailure(error, manifest.session_id);
    }
  }

  public async openForWrite(sessionId: SessionId): Promise<EventStore> {
    const location = await this.#locate(sessionId);
    const lease = await SessionLeaseHandle.acquire(path.join(location.directory, LOCK_FILE), sessionId, this.#lease);
    try {
      const scan = await scanOwn(location);
      if (scan.corrupt !== undefined) throw new StoreFailure("session_corrupt", `session ${sessionId} is corrupt: ${scan.corrupt}`);
      if (scan.unsupported !== undefined) {
        throw new StoreFailure("unsupported_version", `session ${sessionId} was written by a newer version (${scan.unsupported}); it can only be opened read-only`);
      }
      let position = scan.position;
      let quarantined: QuarantinedTail | undefined;
      if (scan.tornTail !== undefined) {
        quarantined = await quarantineTail(location, scan.tornTail);
        if (scan.tornTail.headerOnly) position = await this.#positionAfterDroppedSegment(location, scan.tornTail.segment);
      }
      return await JsonlEventStore.open(location, (id) => this.#locate(id), lease, this.#writer, position, quarantined);
    } catch (error: unknown) {
      await lease.release().catch(() => undefined);
      throw asWriteFailure(error, sessionId);
    }
  }

  public async openForRead(sessionId: SessionId): Promise<ReadOnlyEventStore> {
    return new JsonlReadOnlyEventStore(await this.#locate(sessionId), (id) => this.#locate(id));
  }

  public async fork(sessionId: SessionId, upToSeq: number): Promise<EventStore> {
    const parent = await this.#locate(sessionId);
    return this.create({
      session_id: createId("session", this.#clock().getTime()),
      project_id: parent.manifest.project_id,
      workspace_root: parent.manifest.workspace_root,
      created_at: this.#clock().toISOString(),
      parent: { session_id: sessionId, up_to_seq: upToSeq },
      ...(parent.manifest.title === undefined ? {} : { title: parent.manifest.title }),
    });
  }

  public async list(projectId: ProjectId): Promise<readonly SessionSummary[]> {
    let names: string[];
    try {
      names = await readdir(projectDirectory(this.#home, projectId));
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const summaries: SessionSummary[] = [];
    for (const name of names) {
      const parsedId = sessionIdSchema.safeParse(name);
      if (!parsedId.success) continue;
      const directory = sessionDirectory(this.#home, projectId, name);
      const manifest = await readManifest(directory);
      if (manifest === undefined || manifest.session_id !== parsedId.data || manifest.project_id !== projectId) continue;
      this.#locations.set(manifest.session_id, { directory, manifest });
      const tail = await summarizeTail({ directory, manifest });
      const lease = await inspectLease(path.join(directory, LOCK_FILE), this.#lease);
      summaries.push({ manifest, lastSeq: tail.lastSeq, lastEventAt: tail.lastEventAt, locked: lease.state === "live" });
    }
    return summaries.sort(
      (left, right) =>
        left.manifest.created_at.localeCompare(right.manifest.created_at) || left.manifest.session_id.localeCompare(right.manifest.session_id),
    );
  }

  async #assertForkPoint(parentId: SessionId, upToSeq: number): Promise<void> {
    const parent = await this.#locate(parentId);
    const { lastSeq } = await summarizeTail(parent);
    if (!Number.isInteger(upToSeq) || upToSeq < 1 || upToSeq > lastSeq) {
      throw new StoreFailure("write_failed", `cannot fork ${parentId} at seq ${upToSeq}; its last seq is ${lastSeq}`);
    }
  }

  async #positionAfterDroppedSegment(location: SessionLocation, dropped: number): Promise<WriterPosition | undefined> {
    if (dropped <= 1) return undefined;
    const scan = await scanOwn(location);
    if (scan.corrupt !== undefined || scan.tornTail !== undefined) {
      throw new StoreFailure("session_corrupt", `session ${location.manifest.session_id} is corrupt after quarantine`);
    }
    return scan.position;
  }

  async #locate(sessionId: SessionId): Promise<SessionLocation> {
    const location = await this.#tryLocate(sessionId);
    if (location === undefined) throw new StoreFailure("session_not_found", `session ${sessionId} does not exist under ${sessionsRoot(this.#home)}`);
    return location;
  }

  async #tryLocate(sessionId: SessionId): Promise<SessionLocation | undefined> {
    const cached = this.#locations.get(sessionId);
    if (cached !== undefined) return cached;
    if (!sessionIdSchema.safeParse(sessionId).success) return undefined;
    let projects: string[];
    try {
      projects = await readdir(sessionsRoot(this.#home));
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    for (const project of projects) {
      const directory = sessionDirectory(this.#home, project, sessionId);
      const manifest = await readManifest(directory);
      if (manifest === undefined || manifest.session_id !== sessionId) continue;
      const location = { directory, manifest };
      this.#locations.set(sessionId, location);
      return location;
    }
    return undefined;
  }
}

async function readManifest(directory: string): Promise<SessionManifest | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(directory, MANIFEST_FILE), "utf8");
  } catch (error: unknown) {
    if (isMissing(error) || errnoCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
  try {
    const parsed = sessionManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Full validation of a session's own segments: the writer's position, torn tail, corruption, newer versions. */
async function scanOwn(location: SessionLocation): Promise<OwnScan> {
  const first = firstOwnSeq(location.manifest);
  let lastSeq = first - 1;
  let segment = 0;
  let segmentEvents = 0;
  let lastEventAt: string | undefined;
  let unsupported: string | undefined;
  let corrupt: string | undefined;
  let tornTail: OwnScan["tornTail"];
  for await (const item of scanSegments(segmentsDirectory(location.directory), {
    sessionId: location.manifest.session_id,
    firstSeq: first,
    fromSeq: first,
    toSeq: Number.POSITIVE_INFINITY,
    reportTornTail: true,
  })) {
    if (item.kind === "torn-tail") {
      tornTail = item;
      continue;
    }
    if (item.segment !== segment) {
      segment = item.segment;
      segmentEvents = 0;
    }
    segmentEvents += 1;
    lastSeq = item.position;
    if (item.result.status === "invalid") {
      corrupt ??= `seq ${item.position}: ${item.result.issues.map((issue) => issue.message).join("; ")}`;
    } else if (item.result.status === "unsupported") {
      unsupported ??= `${item.result.type} v${item.result.event_version ?? "?"} at seq ${item.position}`;
    } else {
      lastEventAt = item.result.event.timestamp;
    }
  }
  const lastSegment = (await listSegments(segmentsDirectory(location.directory))).at(-1)?.segment ?? 0;
  if (lastSegment === 0) return { position: undefined, lastEventAt, unsupported, corrupt, tornTail };
  if (segment !== lastSegment) segmentEvents = 0;
  const bytes = (await stat(segmentPath(location.directory, lastSegment))).size - (tornTail !== undefined && !tornTail.headerOnly ? tornTail.bytes : 0);
  return {
    position: { lastSeq, segment: lastSegment, segmentBytes: bytes, segmentEvents },
    lastEventAt,
    unsupported,
    corrupt,
    tornTail,
  };
}

/** Last seq and time from the last segment only; bounded by one segment's size. */
async function summarizeTail(location: SessionLocation): Promise<{ readonly lastSeq: number; readonly lastEventAt: string | undefined }> {
  let lastSeq = firstOwnSeq(location.manifest) - 1;
  let lastEventAt: string | undefined;
  for await (const item of scanSegments(segmentsDirectory(location.directory), {
    sessionId: location.manifest.session_id,
    firstSeq: firstOwnSeq(location.manifest),
    fromSeq: 1,
    toSeq: Number.POSITIVE_INFINITY,
    reportTornTail: false,
    lastSegmentOnly: true,
  })) {
    if (item.kind !== "event") continue;
    lastSeq = item.position;
    if (item.result.status === "ok") lastEventAt = item.result.event.timestamp;
  }
  return { lastSeq, lastEventAt };
}

/**
 * Copies the torn byte range to `<segment>.torn-<n>` (durably) before cutting it from the segment,
 * so a crash in between only yields a duplicate quarantine file, never lost bytes. A segment whose
 * header itself is torn is removed entirely.
 */
async function quarantineTail(location: SessionLocation, torn: NonNullable<OwnScan["tornTail"]>): Promise<QuarantinedTail> {
  const file = segmentPath(location.directory, torn.segment);
  const directory = segmentsDirectory(location.directory);
  let quarantineFile: string | undefined;
  if (torn.bytes > 0) {
    const bytes = Buffer.alloc(torn.bytes);
    const handle = await open(file, "r");
    try {
      await handle.read(bytes, 0, torn.bytes, torn.start);
    } finally {
      await handle.close();
    }
    const base = path.basename(file);
    const existing = (await readdir(directory)).filter((name) => name.startsWith(`${base}.torn-`));
    const next = existing.reduce((max, name) => Math.max(max, Number.parseInt(name.slice(base.length + 6), 10) || 0), 0) + 1;
    quarantineFile = path.join(directory, `${base}.torn-${next}`);
    await writeFileDurably(quarantineFile, bytes);
  }
  if (torn.headerOnly) {
    await unlink(file);
  } else {
    const handle = await open(file, "r+");
    try {
      await handle.truncate(torn.start);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(directory);
  return { segment: torn.segment, bytes: torn.bytes, file: quarantineFile };
}

function asWriteFailure(error: unknown, sessionId: SessionId): StoreFailure {
  if (error instanceof StoreFailure) return error;
  return new StoreFailure("write_failed", `session ${sessionId} could not be opened for writing: ${errnoCode(error) ?? (error instanceof Error ? error.message : String(error))}`);
}
