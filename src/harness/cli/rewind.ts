import { workspaceDigest, type BlobRef, type Digest, type SessionEvent, type SessionEventOf } from "../contracts/index.ts";

/**
 * K3 time travel: the points a conversation can be rewound to (each user message that started a
 * turn) and the file restore plan built from the `/undo` checkpoints recorded after such a point.
 * Only files the agent changed through its own checkpoints are ever touched, and a file whose
 * current content is not what the agent left there is skipped (the user changed it since).
 */

export interface RewindPoint {
  /** Seq of the `turn/started` event of the turn this message opened. */
  readonly turnSeq: number;
  /** Fork point: the last seq before that turn; 0 when the message was the conversation's first event. */
  readonly forkSeq: number;
  /** The message as the user typed it (Synorch notes and attachment blocks removed). */
  readonly text: string;
  readonly at: string;
}

/** Strips the harness note prefix and the inlined attachment block from a recorded user message. */
export function typedText(raw: string): string {
  return (raw.replace(/^\[Synorch note:[^\]]*\]\s*/u, "").split("<synorch-attachments>")[0] ?? "").trim();
}

/** Every user-triggered turn's opening message, oldest first. */
export function rewindPoints(events: readonly SessionEvent[]): RewindPoint[] {
  const points: RewindPoint[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const started = events[index];
    if (started?.type !== "turn/started" || started.data.trigger !== "user") continue;
    let message: SessionEventOf<"message/recorded"> | undefined;
    for (let next = index + 1; next < events.length; next += 1) {
      const candidate = events[next];
      if (candidate?.type === "turn/started") break;
      if (candidate?.type === "message/recorded" && candidate.data.role === "user") {
        message = candidate;
        break;
      }
    }
    if (message?.data.message === undefined) continue;
    const text = typedText(message.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" "));
    points.push({ turnSeq: started.seq, forkSeq: started.seq - 1, text, at: message.timestamp });
  }
  return points;
}

export interface RestoreFile {
  readonly path: string;
  /** Content at the fork point; null means the file did not exist then. */
  readonly before: BlobRef | null;
  /** What the agent's last edit left; the file is restored only when it still has this content. */
  readonly expected: Digest | null;
}

export interface RestorePlan {
  readonly files: readonly RestoreFile[];
  /** The checkpoints this plan undoes (recorded as restored in the conversation they belong to). */
  readonly checkpoints: readonly SessionEventOf<"checkpoint/recorded">[];
}

/** The agent's un-undone checkpoints after `forkSeq`, folded per file: first `before`, last `after`. */
export function planRestore(events: readonly SessionEvent[], forkSeq: number): RestorePlan {
  const restored = new Set(events.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
  const checkpoints = events.filter((event): event is SessionEventOf<"checkpoint/recorded"> => event.type === "checkpoint/recorded" && event.seq > forkSeq && !restored.has(event.seq));
  const files = new Map<string, { before: BlobRef | null; expected: Digest | null }>();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.data.files) {
      const known = files.get(file.path);
      files.set(file.path, { before: known === undefined ? file.before : known.before, expected: file.after });
    }
  }
  return { files: [...files].map(([file, entry]) => ({ path: file, ...entry })), checkpoints };
}

export interface RestoreIO {
  /** Absolute path inside the workspace, or undefined when the recorded path escapes it. */
  resolve(relative: string): string | undefined;
  read(absolute: string): Promise<Uint8Array | undefined>;
  write(absolute: string, bytes: Uint8Array): Promise<void>;
  remove(absolute: string): Promise<void>;
  blob(ref: BlobRef): Promise<Uint8Array>;
}

export interface RestoreResult {
  readonly restored: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/** Files of the plan whose current content is not what the agent left (they would be kept). */
export async function restoreConflicts(plan: RestorePlan, io: Pick<RestoreIO, "resolve" | "read">): Promise<string[]> {
  const changed: string[] = [];
  for (const file of plan.files) {
    const absolute = io.resolve(file.path);
    const current = absolute === undefined ? undefined : await io.read(absolute);
    if (absolute === undefined || (current === undefined ? null : workspaceDigest(current)) !== file.expected) changed.push(file.path);
  }
  return changed;
}

/** Applies a plan; a file the user changed after the agent's last edit is kept as is and reported. */
export async function applyRestore(plan: RestorePlan, io: RestoreIO): Promise<RestoreResult> {
  const restored: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const file of plan.files) {
    const absolute = io.resolve(file.path);
    if (absolute === undefined) {
      skipped.push({ path: file.path, reason: "outside the workspace" });
      continue;
    }
    const current = await io.read(absolute);
    const digest = current === undefined ? null : workspaceDigest(current);
    if (digest !== file.expected) {
      skipped.push({ path: file.path, reason: "it changed after Synorch's last edit, so it was left as is" });
      continue;
    }
    if (file.before === null) {
      if (current !== undefined) await io.remove(absolute);
    } else await io.write(absolute, await io.blob(file.before));
    restored.push(file.path);
  }
  return { restored, skipped };
}
