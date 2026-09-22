import {
  canonicalJson,
  digestOf,
  modelMessageSchema,
  modelRequestSchema,
  StoreFailure,
  type BlobRef,
  type BlobStore,
  type ModelMessage,
  type ModelRequest,
  type SessionEventOf,
} from "../contracts/index.ts";

const JSON_MEDIA_TYPE = "application/json";

/** Stores `value` as canonical JSON bytes, so the blob digest equals `digestOf(value)`. */
export function putCanonicalJson(blobs: BlobStore, value: unknown): Promise<BlobRef> {
  return blobs.put(Buffer.from(canonicalJson(value), "utf8"), JSON_MEDIA_TYPE);
}

/**
 * Rebuilds the exact model request of one step from the log and the blob store. The envelope blob
 * holds canonical JSON, so its bytes, `envelope_blob.digest` and `digestOf(request)` must all agree.
 */
export async function rebuildModelRequest(event: SessionEventOf<"model/request_prepared">, blobs: BlobStore): Promise<ModelRequest> {
  if (event.data.envelope_blob.digest !== event.data.envelope_digest) {
    throw new StoreFailure("session_corrupt", `request ${event.data.request_id}: envelope blob and envelope digest differ`);
  }
  const bytes = await blobs.get(event.data.envelope_blob.digest);
  const parsed = modelRequestSchema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (!parsed.success || digestOf(parsed.data) !== event.data.envelope_digest || parsed.data.request_id !== event.data.request_id) {
    throw new StoreFailure("session_corrupt", `request ${event.data.request_id}: envelope does not rebuild to its digest`);
  }
  return parsed.data;
}

/** Resolves a `message/recorded` payload whether it was stored inline or as a blob. */
export async function loadRecordedMessage(event: SessionEventOf<"message/recorded">, blobs: BlobStore): Promise<ModelMessage> {
  if (event.data.message !== undefined) return event.data.message;
  if (event.data.blob === undefined) throw new StoreFailure("session_corrupt", `message at seq ${event.seq} has neither content nor blob`);
  const bytes = await blobs.get(event.data.blob.digest);
  const parsed = modelMessageSchema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (!parsed.success || parsed.data.role !== event.data.role) {
    throw new StoreFailure("session_corrupt", `message blob at seq ${event.seq} is not a ${event.data.role} message`);
  }
  return parsed.data;
}
