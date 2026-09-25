import { z } from "zod";
import { timestampSchema, type BlobRef } from "./common.ts";
import type { Digest } from "./digest.ts";
import type { EventParseResult, SessionEvent, SessionEventDraft } from "./events.ts";
import { projectIdSchema, sessionIdSchema, type ProjectId, type SessionId } from "./ids.ts";

/**
 * Session storage (ADR-03): segmented append-only JSONL, one writer under a lock/lease, and a
 * content-addressed blob store for anything large. Layout under `~/.synorch/` (or
 * `$SYNORCH_HOME`):
 *
 *   sessions/<project-id>/<session-id>/
 *     session.json            manifest, written once at creation
 *     lock.json               lease of the single writer
 *     segments/000001.jsonl   header line + one event envelope per line
 *   blobs/sha256/<2 hex>/<62 hex>
 */

export const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
export const INLINE_PAYLOAD_MAX_BYTES = 16 * 1024;
export const LEASE_TTL_MS = 30_000;
export const LEASE_HEARTBEAT_MS = 10_000;
export const SEGMENT_FILE_PATTERN = /^\d{6}\.jsonl$/;

export const sessionManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  session_id: sessionIdSchema,
  project_id: projectIdSchema,
  workspace_root: z.string().min(1),
  created_at: timestampSchema,
  parent: z.strictObject({ session_id: sessionIdSchema, up_to_seq: z.int().min(1) }).optional(),
  title: z.string().max(200).optional(),
});
export type SessionManifest = z.infer<typeof sessionManifestSchema>;

export const segmentHeaderSchema = z.strictObject({
  kind: z.literal("segment"),
  schema_version: z.literal(1),
  session_id: sessionIdSchema,
  segment: z.int().min(1),
  first_seq: z.int().min(1),
  created_at: timestampSchema,
  writer: z.strictObject({ name: z.literal("synorch"), version: z.string().min(1) }),
});
export type SegmentHeader = z.infer<typeof segmentHeaderSchema>;

export const sessionLeaseSchema = z.strictObject({
  schema_version: z.literal(1),
  session_id: sessionIdSchema,
  holder: z.strictObject({ pid: z.int().positive(), host: z.string().min(1), token: z.string().min(16) }),
  acquired_at: timestampSchema,
  heartbeat_at: timestampSchema,
  expires_at: timestampSchema,
});
export type SessionLease = z.infer<typeof sessionLeaseSchema>;


export type StoreFailureCode =
  | "session_locked"
  | "session_not_found"
  | "session_corrupt"
  | "unsupported_version"
  | "write_failed"
  | "blob_missing"
  | "blob_digest_mismatch";

export class StoreFailure extends Error {
  public readonly code: StoreFailureCode;

  public constructor(code: StoreFailureCode, message: string) {
    super(message);
    this.name = "StoreFailure";
    this.code = code;
  }
}

export type EventReadItem =
  | EventParseResult
  | { readonly status: "torn-tail"; readonly segment: number; readonly bytes: number };

/** A torn final line the writer moved aside (`<segment>.torn-<n>`) when it opened the session. */
export interface QuarantinedTail {
  readonly segment: number;
  readonly bytes: number;
  readonly file: string | undefined;
}

/**
 * One session, opened by its single writer. `append` resolves only after the line is durably
 * flushed; if it rejects, callers must not start any new side-effecting tool call.
 */
export interface EventStore {
  readonly sessionId: SessionId;
  readonly lastSeq: number;
  /** Set by a durable store when `openForWrite` quarantined a torn tail; recovery reports it in `session/resumed`. */
  readonly quarantinedTail?: QuarantinedTail | undefined;
  append(draft: SessionEventDraft): Promise<SessionEvent>;
  read(fromSeq?: number, toSeq?: number): AsyncIterable<EventReadItem>;
  close(): Promise<void>;
}

export interface ReadOnlyEventStore {
  readonly sessionId: SessionId;
  read(fromSeq?: number, toSeq?: number): AsyncIterable<EventReadItem>;
}

export interface SessionSummary {
  readonly manifest: SessionManifest;
  readonly lastSeq: number;
  readonly lastEventAt: string | undefined;
  readonly locked: boolean;
}

export interface SessionStore {
  create(manifest: Omit<SessionManifest, "schema_version">): Promise<EventStore>;
  /** Acquires the lease or fails with `session_locked`, naming the current holder. */
  openForWrite(sessionId: SessionId): Promise<EventStore>;
  openForRead(sessionId: SessionId): Promise<ReadOnlyEventStore>;
  /** A new session whose history is the parent's events up to `upToSeq` (read through, not copied), then its own. */
  fork(sessionId: SessionId, upToSeq: number, options?: { readonly title?: string }): Promise<EventStore>;
  list(projectId: ProjectId): Promise<readonly SessionSummary[]>;
}

export interface BlobStore {
  put(bytes: Uint8Array, mediaType: string): Promise<BlobRef>;
  /** Verifies the digest on read; a mismatch is `blob_digest_mismatch`, never returned data. */
  get(digest: Digest): Promise<Uint8Array>;
  has(digest: Digest): Promise<boolean>;
}
