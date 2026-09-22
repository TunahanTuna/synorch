import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { sha256 } from "./digest.ts";

/**
 * Runtime identifiers. Every id is `<prefix>_<ULID>` and carries a zod brand, so a `TaskId` can
 * never be passed where an `AttemptId` is expected. The ULID keeps ids sortable by creation time,
 * but ordering inside a session is always the event `seq`, never the id or the clock.
 */

const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PREFIXES = {
  run: "run",
  plan: "plan",
  task: "task",
  attempt: "att",
  session: "ses",
  turn: "turn",
  step: "step",
  request: "req",
  toolCall: "call",
  approval: "apr",
  event: "evt",
  proposal: "prop",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_${ULID_BODY}$`);
}

function idString(kind: IdKind) {
  return z.string().regex(idPattern(kind), `must be ${ID_PREFIXES[kind]}_<ULID>`);
}

export const runIdSchema = idString("run").brand<"RunId">();
export const planIdSchema = idString("plan").brand<"PlanId">();
export const taskIdSchema = idString("task").brand<"TaskId">();
export const attemptIdSchema = idString("attempt").brand<"AttemptId">();
export const sessionIdSchema = idString("session").brand<"SessionId">();
export const turnIdSchema = idString("turn").brand<"TurnId">();
export const stepIdSchema = idString("step").brand<"StepId">();
export const requestIdSchema = idString("request").brand<"RequestId">();
export const toolCallIdSchema = idString("toolCall").brand<"ToolCallId">();
export const approvalIdSchema = idString("approval").brand<"ApprovalId">();
export const eventIdSchema = idString("event").brand<"EventId">();
export const proposalIdSchema = idString("proposal").brand<"ProposalId">();

export type RunId = z.infer<typeof runIdSchema>;
export type PlanId = z.infer<typeof planIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type TurnId = z.infer<typeof turnIdSchema>;
export type StepId = z.infer<typeof stepIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type ToolCallId = z.infer<typeof toolCallIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type ProposalId = z.infer<typeof proposalIdSchema>;

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A provider is a service or local endpoint (`openai`, `anthropic`), never a model. */
export const providerIdSchema = z
  .string()
  .max(64)
  .regex(KEBAB_CASE, "provider id must be kebab-case")
  .brand<"ProviderId">();
export type ProviderId = z.infer<typeof providerIdSchema>;

/** The provider's real model id, verbatim; the runtime never rewrites it. */
export const modelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\S+$/, "model id must not contain whitespace")
  .brand<"ModelId">();
export type ModelId = z.infer<typeof modelIdSchema>;

/** Stable project identity used for per-user storage roots: `<slug>-<8 hex>`. */
export const projectIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/, "project id must be <kebab-slug>-<8 hex>")
  .brand<"ProjectId">();
export type ProjectId = z.infer<typeof projectIdSchema>;

/** Acceptance criteria are addressed as `AC-<n>` inside one packet or plan task. */
export const acceptanceCriterionIdSchema = z.string().regex(/^AC-[1-9]\d*$/, "must be AC-<n>");

const ID_SCHEMAS = {
  run: runIdSchema,
  plan: planIdSchema,
  task: taskIdSchema,
  attempt: attemptIdSchema,
  session: sessionIdSchema,
  turn: turnIdSchema,
  step: stepIdSchema,
  request: requestIdSchema,
  toolCall: toolCallIdSchema,
  approval: approvalIdSchema,
  event: eventIdSchema,
  proposal: proposalIdSchema,
} as const;

export type IdOf<K extends IdKind> = z.infer<(typeof ID_SCHEMAS)[K]>;

/** Encode a 48-bit millisecond timestamp and 80 random bits as a 26-character Crockford ULID. */
export function encodeUlid(timeMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > 2 ** 48 - 1) {
    throw new RangeError("ULID time must be a 48-bit non-negative integer");
  }
  if (random.length !== 10) {
    throw new RangeError("ULID randomness must be exactly 10 bytes");
  }
  let time = "";
  let remaining = timeMs;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD_ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let entropy = "";
  for (let index = 0; index < 16; index += 1) {
    entropy = CROCKFORD_ALPHABET[Number(bits & 31n)] + entropy;
    bits >>= 5n;
  }
  return time + entropy;
}

export function createId<K extends IdKind>(
  kind: K,
  timeMs: number = Date.now(),
  random: Uint8Array = randomBytes(10),
): IdOf<K> {
  return ID_SCHEMAS[kind].parse(`${ID_PREFIXES[kind]}_${encodeUlid(timeMs, random)}`) as IdOf<K>;
}

/**
 * `<basename-slug>-<first 8 hex of sha256(root)>`. The root is the resolved workspace root; on
 * Windows it is lower-cased first because the file system is case-insensitive there, so the same
 * folder opened as `C:\Repo` and `c:\repo` maps to one project.
 */
export function deriveProjectId(workspaceRoot: string, platform: NodeJS.Platform): ProjectId {
  const flavor = platform === "win32" ? path.win32 : path.posix;
  const normalized = flavor.resolve(workspaceRoot).replaceAll("\\", "/");
  const keyed = platform === "win32" ? normalized.toLowerCase() : normalized;
  const slug =
    flavor
      .basename(flavor.resolve(workspaceRoot))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "workspace";
  const hash = sha256(keyed).slice("sha256:".length, "sha256:".length + 8);
  return projectIdSchema.parse(`${slug}-${hash}`);
}
