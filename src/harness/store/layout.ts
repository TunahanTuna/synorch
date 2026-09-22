import path from "node:path";
import type { Digest } from "../contracts/index.ts";

export const MANIFEST_FILE = "session.json";
export const LOCK_FILE = "lock.json";
export const SEGMENTS_DIRECTORY = "segments";

export function sessionsRoot(home: string): string {
  return path.join(home, "sessions");
}

export function projectDirectory(home: string, projectId: string): string {
  return path.join(sessionsRoot(home), projectId);
}

export function sessionDirectory(home: string, projectId: string, sessionId: string): string {
  return path.join(projectDirectory(home, projectId), sessionId);
}

export function segmentsDirectory(sessionDir: string): string {
  return path.join(sessionDir, SEGMENTS_DIRECTORY);
}

export function segmentFileName(segment: number): string {
  return `${String(segment).padStart(6, "0")}.jsonl`;
}

export function segmentPath(sessionDir: string, segment: number): string {
  return path.join(segmentsDirectory(sessionDir), segmentFileName(segment));
}

export function blobPath(home: string, digest: Digest): string {
  const hex = digest.slice("sha256:".length);
  return path.join(home, "blobs", "sha256", hex.slice(0, 2), hex.slice(2));
}
