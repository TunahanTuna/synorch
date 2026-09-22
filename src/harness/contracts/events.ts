import { z } from "zod";
import {
  actorSchema,
  blobRefSchema,
  nonEmptyTextSchema,
  riskClassSchema,
  timestampSchema,
  workerRoleSchema,
  HARNESS_SCHEMA_VERSION,
} from "./common.ts";
import { digestSchema } from "./digest.ts";
import {
  approvalIdSchema,
  attemptIdSchema,
  eventIdSchema,
  planIdSchema,
  projectIdSchema,
  proposalIdSchema,
  requestIdSchema,
  runIdSchema,
  sessionIdSchema,
  stepIdSchema,
  taskIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "./ids.ts";
import { memoryIdSchema, MEMORY_KINDS } from "./memory.ts";
import { modelMessageSchema, modelRouteSchema, providerErrorSchema, quotaSnapshotSchema, routeDecisionSchema, STOP_REASONS, TRUST_LEVELS, usageSchema, SYSTEM_BLOCK_SOURCES } from "./model.ts";
import { planSchema } from "./packets.ts";
import { pathPatternSchema } from "./paths.ts";
import {
  approvalDecisionSchema,
  approvalRequestSchema,
  effectivePolicySchema,
  normalizedActionSchema,
  policyDecisionSchema,
  policyModeSchema,
} from "./policy.ts";
import {
  ATTEMPT_STATES,
  PLAN_STATES,
  RUN_STATES,
  TASK_STATES,
} from "./state.ts";
import { SANDBOX_ENFORCEMENT, toolResultSchema } from "./tools.ts";

/**
 * The session event log is the single source of truth. Every line of a segment (after the header)
 * is one envelope. `seq` is dense and strictly increasing per session; it, not the timestamp, is
 * the order. Payloads are discriminated by `type`; `event_version` versions each payload
 * independently so one family can evolve without a log-wide migration.
 */

const envelopeBaseSchema = z.strictObject({
  schema_version: z.literal(HARNESS_SCHEMA_VERSION),
  event_id: eventIdSchema,
  session_id: sessionIdSchema,
  seq: z.int().min(1),
  event_version: z.int().min(1),
  timestamp: timestampSchema,
  actor: actorSchema,
  run_id: runIdSchema.optional(),
  task_id: taskIdSchema.optional(),
  attempt_id: attemptIdSchema.optional(),
  causation_seq: z.int().min(1).optional(),
});

function eventOf<const T extends string, D extends z.ZodType>(type: T, data: D) {
  return envelopeBaseSchema.extend({ type: z.literal(type), data });
}

function transition<const S extends readonly [string, ...string[]]>(states: S) {
  return { from: z.enum(states), to: z.enum(states), reason: nonEmptyTextSchema };
}

const inlineOrBlobMessage = z
  .strictObject({
    role: z.enum(["user", "assistant", "tool"]),
    request_id: requestIdSchema.optional(),
    message: modelMessageSchema.optional(),
    blob: blobRefSchema.optional(),
  })
  .superRefine((record, context) => {
    if ((record.message === undefined) === (record.blob === undefined)) {
      context.addIssue({ code: "custom", path: ["message"], message: "exactly one of message or blob" });
    }
    if (record.message !== undefined && record.message.role !== record.role) {
      context.addIssue({ code: "custom", path: ["message", "role"], message: "message role must match the record role" });
    }
    for (const [index, part] of (record.message?.content ?? []).entries()) {
      if (part.type === "tool_call" && part.tool_call_id === undefined) {
        context.addIssue({
          code: "custom",
          path: ["message", "content", index, "tool_call_id"],
          message: "a recorded tool call must carry the runtime ToolCallId",
        });
      }
    }
  });

export const sessionEventSchema = z.discriminatedUnion("type", [
  eventOf(
    "session/opened",
    z.strictObject({
      writer: z.strictObject({ name: z.literal("synorch"), version: z.string().min(1) }),
      project_id: projectIdSchema,
      workspace_root: z.string().min(1),
      cwd: z.string().min(1),
      platform: z.enum(["win32", "darwin", "linux", "other"]),
      git: z.strictObject({ branch: z.string().optional(), head: z.string().optional() }).nullable(),
      policy_mode: policyModeSchema,
      parent: z.strictObject({ session_id: sessionIdSchema, up_to_seq: z.int().min(1) }).optional(),
    }),
  ),
  eventOf(
    "session/resumed",
    z.strictObject({
      previous_last_seq: z.int().min(0),
      recovered: z.array(
        z.strictObject({
          machine: z.enum(["run", "task", "attempt", "toolCall", "approval", "step"]),
          id: z.string().min(1),
          from: z.string().min(1),
          to: z.string().min(1),
        }),
      ),
    }),
  ),
  eventOf("session/closed", z.strictObject({ reason: z.enum(["user", "completed", "error", "signal"]) })),
  eventOf(
    "run/created",
    z.strictObject({
      goal: nonEmptyTextSchema,
      policy_mode: policyModeSchema,
      headless: z.boolean(),
      budget: z.strictObject({
        max_wall_time_seconds: z.int().positive().optional(),
        max_cost_usd: z.number().positive().optional(),
      }),
    }),
  ),
  eventOf("run/state_changed", z.strictObject(transition(RUN_STATES))),
  eventOf("policy/snapshot", z.strictObject({ policy: effectivePolicySchema, digest: digestSchema })),
  eventOf("route/decided", z.strictObject({ decision: routeDecisionSchema })),
  eventOf("plan/proposed", z.strictObject({ plan: planSchema, digest: digestSchema })),
  eventOf(
    "plan/state_changed",
    z.strictObject({ plan_id: planIdSchema, digest: digestSchema, ...transition(PLAN_STATES), approval_id: approvalIdSchema.optional() }),
  ),
  eventOf("approval/requested", z.strictObject({ request: approvalRequestSchema })),
  eventOf("approval/decided", z.strictObject({ decision: approvalDecisionSchema })),
  eventOf("approval/invalidated", z.strictObject({ approval_id: approvalIdSchema, reason: nonEmptyTextSchema })),
  eventOf(
    "task/created",
    z.strictObject({
      task_id: taskIdSchema,
      plan_id: planIdSchema,
      key: z.string().min(1),
      role: workerRoleSchema,
      depends_on: z.array(taskIdSchema),
      owned_paths: z.array(pathPatternSchema),
      risk: riskClassSchema,
    }),
  ),
  eventOf("task/state_changed", z.strictObject({ task_id: taskIdSchema, ...transition(TASK_STATES) })),
  eventOf(
    "task/packet_issued",
    z.strictObject({ task_id: taskIdSchema, kind: z.enum(["full", "delta"]), packet_digest: digestSchema, blob: blobRefSchema }),
  ),
  eventOf(
    "attempt/started",
    z.strictObject({
      attempt_id: attemptIdSchema,
      task_id: taskIdSchema,
      role: workerRoleSchema,
      route: modelRouteSchema,
      packet_digest: digestSchema,
      isolation: z.strictObject({
        mode: z.enum(["worktree", "scoped-dir", "shared-read-only"]),
        path: z.string().min(1).optional(),
        base_commit: z.string().min(1).optional(),
      }),
    }),
  ),
  eventOf("attempt/state_changed", z.strictObject({ attempt_id: attemptIdSchema, ...transition(ATTEMPT_STATES) })),
  eventOf(
    "attempt/completion_recorded",
    z.strictObject({
      attempt_id: attemptIdSchema,
      task_id: taskIdSchema,
      status: z.enum(["completed", "partial", "failed", "blocked", "needs_context"]),
      completion_digest: digestSchema,
      blob: blobRefSchema,
    }),
  ),
  eventOf(
    "review/recorded",
    z.strictObject({
      task_id: taskIdSchema,
      reviewer_attempt_id: attemptIdSchema,
      review_digest: digestSchema,
      decision: z.enum(["accept", "revise", "block"]),
      blob: blobRefSchema,
    }),
  ),
  eventOf(
    "turn/started",
    z.strictObject({ turn_id: turnIdSchema, trigger: z.enum(["user", "orchestrator", "steer", "follow-up", "dispatch"]) }),
  ),
  eventOf(
    "turn/ended",
    z.strictObject({
      turn_id: turnIdSchema,
      outcome: z.enum(["completed", "max_steps", "cancelled", "failed", "awaiting_approval", "budget_exceeded"]),
    }),
  ),
  eventOf("step/started", z.strictObject({ step_id: stepIdSchema, turn_id: turnIdSchema, request_id: requestIdSchema })),
  eventOf("step/ended", z.strictObject({ step_id: stepIdSchema, state: z.enum(["settled", "aborted", "errored"]) })),
  eventOf("message/recorded", inlineOrBlobMessage),
  eventOf(
    "model/request_prepared",
    z.strictObject({
      request_id: requestIdSchema,
      step_id: stepIdSchema,
      route: modelRouteSchema,
      envelope_digest: digestSchema,
      envelope_blob: blobRefSchema,
      tool_set_digest: digestSchema,
      context: z.array(
        z.strictObject({
          block_id: z.string().min(1),
          source: z.enum([...SYSTEM_BLOCK_SOURCES, "history", "tool-result"]),
          trust: z.enum(TRUST_LEVELS),
          tokens_estimate: z.int().min(0),
          truncated: z.boolean(),
        }),
      ),
    }),
  ),
  eventOf(
    "model/response_settled",
    z.strictObject({ request_id: requestIdSchema, stop_reason: z.enum(STOP_REASONS), usage: usageSchema.optional() }),
  ),
  eventOf(
    "model/response_failed",
    z.strictObject({ request_id: requestIdSchema, error: providerErrorSchema, partial_blob: blobRefSchema.optional() }),
  ),
  eventOf(
    "provider/usage",
    z.strictObject({ request_id: requestIdSchema, usage: usageSchema, quota: quotaSnapshotSchema.optional() }),
  ),
  eventOf(
    "tool/call_proposed",
    z.strictObject({
      tool_call_id: toolCallIdSchema,
      request_id: requestIdSchema.optional(),
      provider_call_id: z.string().min(1),
      tool_name: z.string().min(1),
      args_digest: digestSchema,
      args_blob: blobRefSchema.optional(),
    }),
  ),
  eventOf(
    "tool/policy_decided",
    z.strictObject({ tool_call_id: toolCallIdSchema, action: normalizedActionSchema, decision: policyDecisionSchema }),
  ),
  eventOf(
    "tool/execution_started",
    z.strictObject({ tool_call_id: toolCallIdSchema, sandbox_enforcement: z.enum(SANDBOX_ENFORCEMENT) }),
  ),
  eventOf(
    "tool/result_recorded",
    z.strictObject({
      tool_call_id: toolCallIdSchema,
      state: z.enum(["succeeded", "failed", "denied", "cancelled"]),
      result: toolResultSchema,
      duration_ms: z.int().min(0),
    }),
  ),
  eventOf(
    "tool/interrupted",
    z.strictObject({ tool_call_id: toolCallIdSchema, outcome: z.literal("unknown"), idempotent: z.boolean() }),
  ),
  eventOf(
    "context/compacted",
    z.strictObject({
      from_seq: z.int().min(1),
      to_seq: z.int().min(1),
      first_kept_seq: z.int().min(1),
      method: z.literal("summary-v1"),
      model_id: z.string().min(1).optional(),
      tokens_before: z.int().min(0),
      tokens_after: z.int().min(0),
      summary_blob: blobRefSchema,
      trigger: z.enum(["threshold", "overflow", "manual"]),
    }),
  ),
  eventOf(
    "context/source_changed",
    z.strictObject({
      task_id: taskIdSchema.optional(),
      path: pathPatternSchema,
      expected: digestSchema,
      actual: digestSchema.nullable(),
    }),
  ),
  eventOf(
    "memory/persisted",
    z.strictObject({ memory_id: memoryIdSchema, kind: z.enum(MEMORY_KINDS), path: z.string().min(1), digest: digestSchema }),
  ),
  eventOf(
    "memory/proposed",
    z.strictObject({ proposal_id: proposalIdSchema, kind: z.enum(["note", "relation", "contradiction", "status-change"]), target: memoryIdSchema.optional() }),
  ),
  eventOf(
    "memory/proposal_decided",
    z.strictObject({
      proposal_id: proposalIdSchema,
      state: z.enum(["accepted", "rejected", "deferred"]),
      decided_by: z.enum(["user", "orchestrator"]),
      reason: nonEmptyTextSchema,
    }),
  ),
  eventOf(
    "budget/exceeded",
    z.strictObject({
      scope: z.enum(["run", "task"]),
      metric: z.enum(["cost_usd", "wall_time_seconds", "steps", "tool_calls"]),
      limit: z.number().min(0),
      used: z.number().min(0),
      action: z.enum(["stop-new-requests", "cancel-active"]),
    }),
  ),
  eventOf("steer/queued", z.strictObject({ text: nonEmptyTextSchema })),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent["type"];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;

/** Current payload version per type. A reader meeting a higher version reports `unsupported`. */
export const EVENT_VERSIONS: { readonly [T in SessionEventType]: number } = Object.fromEntries(
  sessionEventSchema.options.map((option) => [option.shape.type.value, 1]),
) as { readonly [T in SessionEventType]: number };

export const SESSION_EVENT_TYPES = Object.keys(EVENT_VERSIONS) as SessionEventType[];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a writer hands to `EventStore.append`; the store assigns identity, order and time. */
export type SessionEventDraft = DistributiveOmit<SessionEvent, "schema_version" | "event_id" | "session_id" | "seq" | "timestamp">;

export type EventParseResult =
  | { readonly status: "ok"; readonly event: SessionEvent }
  | { readonly status: "unsupported"; readonly type: string; readonly event_version: number | undefined }
  | { readonly status: "invalid"; readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] };

/**
 * Reads one decoded line. Unknown types and newer payload versions are `unsupported`, never
 * silently skipped or coerced; a known type that fails validation is `invalid` (corruption).
 */
export function parseSessionEvent(raw: unknown): EventParseResult {
  if (typeof raw === "object" && raw !== null) {
    const type = (raw as { type?: unknown }).type;
    const version = (raw as { event_version?: unknown }).event_version;
    const known = typeof type === "string" ? (EVENT_VERSIONS as Readonly<Record<string, number>>)[type] : undefined;
    if (typeof type === "string" && (known === undefined || (typeof version === "number" && version > known))) {
      return { status: "unsupported", type, event_version: typeof version === "number" ? version : undefined };
    }
  }
  const parsed = sessionEventSchema.safeParse(raw);
  if (parsed.success) return { status: "ok", event: parsed.data };
  return { status: "invalid", issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) };
}
