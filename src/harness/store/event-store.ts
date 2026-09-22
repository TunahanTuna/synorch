import { open } from "node:fs/promises";
import {
  createId,
  HARNESS_SCHEMA_VERSION,
  parseSessionEvent,
  StoreFailure,
  type EventReadItem,
  type EventStore,
  type QuarantinedTail,
  type ReadOnlyEventStore,
  type SegmentHeader,
  type SessionEvent,
  type SessionEventDraft,
  type SessionId,
  type SessionManifest,
} from "../contracts/index.ts";
import { errnoCode, PRIVATE_FILE_MODE, syncDirectory, writeAll } from "./durable-file.ts";
import { segmentPath, segmentsDirectory } from "./layout.ts";
import type { SessionLeaseHandle } from "./lease.ts";
import { encodeLine, MAX_EVENT_LINE_BYTES, scanSegments, type ScanItem } from "./segments.ts";

/** The JSONL implementation of `EventStore`, plus what `openForWrite` quarantined. */
export interface SegmentedEventStore extends EventStore {
  readonly manifest: SessionManifest;
  readonly quarantinedTail: QuarantinedTail | undefined;
  /** Runs one lease heartbeat now; the timer does the same every `LEASE_HEARTBEAT_MS`. */
  heartbeat(): Promise<void>;
}

export interface SessionLocation {
  readonly directory: string;
  readonly manifest: SessionManifest;
}

export type LocateSession = (sessionId: SessionId) => Promise<SessionLocation>;

export interface WriterSettings {
  readonly clock: () => Date;
  readonly writerVersion: string;
  readonly segmentMaxBytes: number;
}

export interface WriterPosition {
  readonly lastSeq: number;
  readonly segment: number;
  readonly segmentBytes: number;
  readonly segmentEvents: number;
}

/** First seq a session's own segments start at: 1, or right after the fork point. */
export function firstOwnSeq(manifest: SessionManifest): number {
  return manifest.parent === undefined ? 1 : manifest.parent.up_to_seq + 1;
}

/**
 * Reads a session including its fork ancestry: ancestor events up to `parent.up_to_seq` first
 * (never their torn tails), then the session's own segments.
 */
export async function* readSessionItems(
  location: SessionLocation,
  locate: LocateSession,
  fromSeq: number,
  toSeq: number,
  reportTornTail: boolean,
): AsyncGenerator<ScanItem> {
  const { manifest } = location;
  if (manifest.parent !== undefined && fromSeq <= manifest.parent.up_to_seq) {
    const parent = await locate(manifest.parent.session_id);
    yield* readSessionItems(parent, locate, fromSeq, Math.min(toSeq, manifest.parent.up_to_seq), false);
  }
  const firstSeq = firstOwnSeq(manifest);
  if (toSeq < firstSeq) return;
  yield* scanSegments(segmentsDirectory(location.directory), {
    sessionId: manifest.session_id,
    firstSeq,
    fromSeq: Math.max(fromSeq, firstSeq),
    toSeq,
    reportTornTail,
  });
}

export function toReadItem(item: ScanItem): EventReadItem {
  return item.kind === "event" ? item.result : { status: "torn-tail", segment: item.segment, bytes: item.bytes };
}

export class JsonlReadOnlyEventStore implements ReadOnlyEventStore {
  public readonly sessionId: SessionId;
  readonly #location: SessionLocation;
  readonly #locate: LocateSession;

  public constructor(location: SessionLocation, locate: LocateSession) {
    this.sessionId = location.manifest.session_id;
    this.#location = location;
    this.#locate = locate;
  }

  public async *read(fromSeq = 1, toSeq = Number.POSITIVE_INFINITY): AsyncIterable<EventReadItem> {
    for await (const item of readSessionItems(this.#location, this.#locate, fromSeq, toSeq, true)) {
      yield toReadItem(item);
    }
  }
}

type FileHandle = Awaited<ReturnType<typeof open>>;

export class JsonlEventStore implements SegmentedEventStore {
  public readonly sessionId: SessionId;
  public readonly manifest: SessionManifest;
  public readonly quarantinedTail: QuarantinedTail | undefined;
  readonly #location: SessionLocation;
  readonly #locate: LocateSession;
  readonly #lease: SessionLeaseHandle;
  readonly #settings: WriterSettings;
  #handle: FileHandle;
  #lastSeq: number;
  #segment: number;
  #segmentBytes: number;
  #segmentEvents: number;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #failure: string | undefined;

  private constructor(
    location: SessionLocation,
    locate: LocateSession,
    lease: SessionLeaseHandle,
    settings: WriterSettings,
    handle: FileHandle,
    position: WriterPosition,
    quarantined: QuarantinedTail | undefined,
  ) {
    this.sessionId = location.manifest.session_id;
    this.manifest = location.manifest;
    this.quarantinedTail = quarantined;
    this.#location = location;
    this.#locate = locate;
    this.#lease = lease;
    this.#settings = settings;
    this.#handle = handle;
    this.#lastSeq = position.lastSeq;
    this.#segment = position.segment;
    this.#segmentBytes = position.segmentBytes;
    this.#segmentEvents = position.segmentEvents;
  }

  /** Opens the append handle at a validated position; creates segment 1 when the session has none yet. */
  public static async open(
    location: SessionLocation,
    locate: LocateSession,
    lease: SessionLeaseHandle,
    settings: WriterSettings,
    position: WriterPosition | undefined,
    quarantined: QuarantinedTail | undefined,
  ): Promise<JsonlEventStore> {
    if (position === undefined) {
      const first = firstOwnSeq(location.manifest);
      const created = await createSegment(location, settings, 1, first);
      return new JsonlEventStore(location, locate, lease, settings, created.handle, {
        lastSeq: first - 1,
        segment: 1,
        segmentBytes: created.bytes,
        segmentEvents: 0,
      }, quarantined);
    }
    const handle = await open(segmentPath(location.directory, position.segment), "a");
    return new JsonlEventStore(location, locate, lease, settings, handle, position, quarantined);
  }

  public get lastSeq(): number {
    return this.#lastSeq;
  }

  public append(draft: SessionEventDraft): Promise<SessionEvent> {
    return this.#serialize(() => this.#appendNow(draft));
  }

  /** Reads what this writer has durably appended; the in-flight line (if any) is never visible. */
  public async *read(fromSeq = 1, toSeq = Number.POSITIVE_INFINITY): AsyncIterable<EventReadItem> {
    const limit = Math.min(toSeq, this.#lastSeq);
    if (limit < fromSeq) return;
    for await (const item of readSessionItems(this.#location, this.#locate, fromSeq, limit, false)) {
      yield toReadItem(item);
    }
  }

  public close(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#closed) return;
      this.#closed = true;
      try {
        await this.#handle.close();
      } finally {
        await this.#lease.release();
      }
    });
  }

  public heartbeat(): Promise<void> {
    return this.#lease.renew();
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #appendNow(draft: SessionEventDraft): Promise<SessionEvent> {
    if (this.#closed) throw new StoreFailure("write_failed", `session ${this.sessionId} is closed`);
    if (this.#failure !== undefined) throw new StoreFailure("write_failed", `session ${this.sessionId} stopped accepting writes: ${this.#failure}`);
    try {
      await this.#lease.verify();
    } catch (error: unknown) {
      this.#failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
    const seq = this.#lastSeq + 1;
    const now = this.#settings.clock();
    const identity = {
      schema_version: HARNESS_SCHEMA_VERSION,
      event_id: createId("event", now.getTime()),
      session_id: this.sessionId,
      seq,
      timestamp: now.toISOString(),
    };
    const candidate = { ...identity, ...draft, ...identity };
    const parsed = parseSessionEvent(candidate);
    if (parsed.status !== "ok") {
      const detail = parsed.status === "invalid" ? parsed.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") : `unsupported ${parsed.type} v${parsed.event_version ?? "?"}`;
      throw new StoreFailure("write_failed", `event ${draft.type} rejected: ${detail}`);
    }
    const line = encodeLine(parsed.event);
    if (line.byteLength > MAX_EVENT_LINE_BYTES) {
      throw new StoreFailure("write_failed", `event ${draft.type} is ${line.byteLength} bytes; store large payloads as blobs`);
    }
    try {
      if (this.#segmentEvents > 0 && this.#segmentBytes + line.byteLength > this.#settings.segmentMaxBytes) {
        await this.#rotate(seq);
      }
      await writeAll(this.#handle, line);
      await this.#handle.datasync();
    } catch (error: unknown) {
      this.#failure = `append of seq ${seq} failed: ${errnoCode(error) ?? (error instanceof Error ? error.message : String(error))}`;
      throw new StoreFailure("write_failed", this.#failure);
    }
    this.#segmentBytes += line.byteLength;
    this.#segmentEvents += 1;
    this.#lastSeq = seq;
    return parsed.event;
  }

  async #rotate(firstSeq: number): Promise<void> {
    const next = this.#segment + 1;
    const created = await createSegment(this.#location, this.#settings, next, firstSeq);
    await this.#handle.close();
    this.#handle = created.handle;
    this.#segment = next;
    this.#segmentBytes = created.bytes;
    this.#segmentEvents = 0;
  }
}

async function createSegment(
  location: SessionLocation,
  settings: WriterSettings,
  segment: number,
  firstSeq: number,
): Promise<{ readonly handle: FileHandle; readonly bytes: number }> {
  const header: SegmentHeader = {
    kind: "segment",
    schema_version: 1,
    session_id: location.manifest.session_id,
    segment,
    first_seq: firstSeq,
    created_at: settings.clock().toISOString(),
    writer: { name: "synorch", version: settings.writerVersion },
  };
  const line = encodeLine(header);
  const handle = await open(segmentPath(location.directory, segment), "wx", PRIVATE_FILE_MODE);
  try {
    await writeAll(handle, line);
    await handle.datasync();
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
  await syncDirectory(segmentsDirectory(location.directory));
  return { handle, bytes: line.byteLength };
}
