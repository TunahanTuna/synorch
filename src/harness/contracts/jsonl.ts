import { z } from "zod";
import { timestampSchema } from "./common.ts";
import { EXIT_CODES, harnessErrorSchema } from "./errors.ts";
import { runIdSchema, sessionIdSchema, taskIdSchema } from "./ids.ts";
import { sessionEventSchema } from "./events.ts";
import { modelStreamEventSchema, usageSchema } from "./model.ts";
import { policyModeSchema } from "./policy.ts";
import { TASK_STATES } from "./state.ts";

/**
 * Machine mode (`--mode jsonl`, alias `--json` on runtime commands). stdout carries only these
 * frames, one per line, separated by a single LF; everything human goes to stderr. The first frame
 * is `hello`, the last is exactly one `result` or `error`. Frames are one-way: approvals and steering
 * over stdin belong to a separate RPC mode that is out of scope for v1.
 */

export const JSONL_PROTOCOL = "synorch.jsonl" as const;
export const JSONL_SCHEMA_VERSION = 1 as const;

const exitCodeValues = Object.values(EXIT_CODES) as [number, ...number[]];
const exitCodeSchema = z.int().refine((value) => exitCodeValues.includes(value), "unknown exit code");

const frameBase = {
  schema_version: z.literal(JSONL_SCHEMA_VERSION),
  run_id: runIdSchema,
  seq: z.int().min(1),
  timestamp: timestampSchema,
};

export const jsonlFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...frameBase,
    type: z.literal("hello"),
    data: z.strictObject({
      protocol: z.literal(JSONL_PROTOCOL),
      harness_version: z.string().min(1),
      session_id: sessionIdSchema,
      policy_mode: policyModeSchema,
      stream_deltas: z.boolean(),
    }),
  }),
  z.strictObject({ ...frameBase, type: z.literal("event"), data: sessionEventSchema }),
  z.strictObject({ ...frameBase, type: z.literal("delta"), data: modelStreamEventSchema }),
  z.strictObject({
    ...frameBase,
    type: z.literal("result"),
    data: z.strictObject({
      status: z.enum(["succeeded", "failed", "cancelled", "rejected"]),
      exit_code: exitCodeSchema,
      summary: z.string().min(1),
      tasks: z.array(z.strictObject({ task_id: taskIdSchema, state: z.enum(TASK_STATES) })),
      usage: usageSchema.optional(),
    }),
  }),
  z.strictObject({
    ...frameBase,
    type: z.literal("error"),
    data: harnessErrorSchema.extend({ exit_code: exitCodeSchema }),
  }),
]);
export type JsonlFrame = z.infer<typeof jsonlFrameSchema>;

export function encodeJsonlFrame(frame: JsonlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Splits a stream on LF only. `readline` is unsuitable because it also breaks on U+2028/U+2029,
 * which JSON strings may contain unescaped. A trailing CR is tolerated for Windows pipes.
 */
export function splitJsonlLines(chunk: string): { readonly lines: readonly string[]; readonly rest: string } {
  const parts = chunk.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0), rest };
}

/** Checks the stream-level invariants: hello first, dense seq, exactly one terminal frame, last. */
export function validateFrameSequence(frames: readonly JsonlFrame[]): readonly string[] {
  const problems: string[] = [];
  if (frames[0]?.type !== "hello") problems.push("the first frame must be hello");
  const terminal = frames.filter((frame) => frame.type === "result" || frame.type === "error");
  if (terminal.length !== 1) problems.push("exactly one result or error frame is required");
  const last = frames.at(-1);
  if (last !== undefined && last.type !== "result" && last.type !== "error") problems.push("the terminal frame must be last");
  frames.forEach((frame, index) => {
    if (frame.seq !== index + 1) problems.push(`frame ${index} has seq ${frame.seq}, expected ${index + 1}`);
    if (frame.run_id !== frames[0]?.run_id) problems.push(`frame ${index} belongs to another run`);
  });
  return problems;
}
