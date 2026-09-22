import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  digestText,
  EVENT_VERSIONS,
  type Actor,
  type AttemptId,
  type BlobRef,
  type BlobStore,
  type Digest,
  type EventStore,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionEventType,
  type TaskId,
} from "../contracts/index.ts";
import { normalizeWorkspacePath } from "./paths.ts";

/** Typed, audited appends to the run log. Every orchestration fact goes through here. */

export interface RecordMeta {
  readonly taskId?: TaskId | undefined;
  readonly attemptId?: AttemptId | undefined;
  readonly actor?: Actor;
  readonly causationSeq?: number | undefined;
}

export interface RunRecorder {
  readonly log: EventStore;
  readonly runId: RunId;
  record<T extends SessionEventType>(type: T, data: SessionEventOf<T>["data"], meta?: RecordMeta): Promise<SessionEvent>;
  putJson(value: unknown, mediaType: string): Promise<BlobRef>;
}

export function createRunRecorder(log: EventStore, blobs: BlobStore, runId: RunId): RunRecorder {
  return {
    log,
    runId,
    async record(type, data, meta = {}) {
      const draft = {
        type,
        data,
        event_version: EVENT_VERSIONS[type],
        actor: meta.actor ?? { kind: "orchestrator", role: "orchestrator" },
        run_id: runId,
        ...(meta.taskId === undefined ? {} : { task_id: meta.taskId }),
        ...(meta.attemptId === undefined ? {} : { attempt_id: meta.attemptId }),
        ...(meta.causationSeq === undefined ? {} : { causation_seq: meta.causationSeq }),
      } as SessionEventDraft;
      return log.append(draft);
    },
    putJson(value, mediaType) {
      return blobs.put(Buffer.from(canonicalJson(value), "utf8"), mediaType);
    },
  };
}

export const PACKET_MEDIA_TYPE = "application/vnd.synorch.task-packet+json";
export const COMPLETION_MEDIA_TYPE = "application/vnd.synorch.completion+json";
export const REVIEW_MEDIA_TYPE = "application/vnd.synorch.review+json";

export type SourceDigestReader = (relativePath: string) => Promise<Digest | undefined>;

/** Digests a workspace file the way packets cite sources (`digestText`, LF-normalized). */
export function createWorkspaceSourceReader(workspaceRoot: string): SourceDigestReader {
  return async (relativePath) => {
    const normalized = normalizeWorkspacePath(relativePath);
    if (normalized === undefined || normalized === ".") return undefined;
    try {
      return digestText(await readFile(path.join(workspaceRoot, ...normalized.split("/")), "utf8"));
    } catch {
      return undefined;
    }
  };
}

export async function currentDigests(paths: readonly string[], reader: SourceDigestReader): Promise<Map<string, Digest | undefined>> {
  const current = new Map<string, Digest | undefined>();
  for (const relative of paths) current.set(relative, await reader(relative));
  return current;
}
