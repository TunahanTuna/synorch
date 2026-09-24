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
import { checkVerificationOutcome, HARNESS_VERIFICATION_STATUSES, REPAIR_KINDS, VERIFICATION_COMMAND_CLASSES, repairProblemsSchema, toolRefOrdinalSchema } from "./evidence.ts";
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
import { CONTEXT_BLOCK_SOURCES, modelMessageSchema, modelRouteSchema, providerErrorSchema, quotaSnapshotSchema, routeDecisionSchema, STOP_REASONS, TRUST_LEVELS, usageSchema } from "./model.ts";
import { planSchema } from "./packets.ts";
import { pathPatternSchema } from "./paths.ts";
import {
  approvalDecisionSchema,
  approvalRequestSchema,
  effectivePolicySchema,
  normalizedActionSchema,
  policyDecisionSchema,
  policyModeSchema,
  TRUST_GRANT_SOURCES,
  TRUST_USE_SOURCES,
} from "./policy.ts";
import {
  ATTEMPT_STATES,
  PLAN_STATES,
  RUN_STATES,
  TASK_STATES,
} from "./state.ts";
import { ISOLATION_FALLBACK_REASONS } from "./runtime.ts";
import { PROCESS_TERMINATIONS, SANDBOX_ENFORCEMENT, toolResultSchema } from "./tools.ts";

/**
 * The session event log is the single source of truth. Every line of a segment (after the header)
 * is one envelope. `seq` is dense and strictly increasing per session; it, not the timestamp, is
 * the order. Payloads are discriminated by `type`; `event_version` versions each payload
 * independently so one family can evolve without a log-wide migration.
 */

/** Repository identity of a trusted workspace (SEC-N1): `git:` or `dir:` and a SHA-256 hex digest. */
const trustIdentitySchema = z.string().regex(/^(git|dir):[0-9a-f]{64}$/);
const trustRootSchema = z.string().min(1).max(4096);

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
      /** v2: repository-layer configuration keys the runtime ignored (trust layering, SEC-C1). */
      config_ignored: z
        .array(z.strictObject({ layer: z.enum(["workspace", "project"]), path: z.string().min(1), key: z.string().min(1).max(64) }))
        .min(1)
        .max(32)
        .optional(),
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
      /** v2: the torn final line the writer quarantined when it opened the session. */
      torn_tail: z.strictObject({ segment: z.int().min(1), bytes: z.int().min(1) }).optional(),
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
  /**
   * K1.7: the orchestrator handed a task to a worker (or reviewer) attempt; the main chat shows it
   * as a delegation line. `attempt` is the task's 1-based attempt ordinal (reviews included).
   */
  eventOf(
    "task/delegated",
    z.strictObject({
      task_id: taskIdSchema,
      attempt_id: attemptIdSchema,
      key: z.string().min(1),
      role: workerRoleSchema,
      provider_id: z.string().min(1),
      model_id: z.string().min(1),
      objective: z.string().min(1).max(4000),
      attempt: z.int().min(1),
    }),
  ),
  /** K1.7: the user messaged a running worker directly; delivered to that attempt at its next step boundary. */
  eventOf("task/user_message", z.strictObject({ task_id: taskIdSchema, attempt_id: attemptIdSchema, text: z.string().trim().min(1).max(8000) })),
  /** K1.7: the user paused, resumed or cancelled one worker attempt. */
  eventOf("attempt/user_control", z.strictObject({ attempt_id: attemptIdSchema, task_id: taskIdSchema, action: z.enum(["pause", "resume", "cancel"]) })),
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
        /** v3: the workspace of an earlier attempt of the same task, reset and reused (ADR-19). */
        reused: z.boolean().optional(),
        /** v3: a worktree could not be created and the attempt fell back to `scoped-dir`. */
        fallback: z
          .strictObject({ from: z.literal("worktree"), reason: z.enum(ISOLATION_FALLBACK_REASONS), detail: z.string().min(1).max(2000) })
          .optional(),
        /** v3: dirty or untracked read inputs copied from the main tree into the worktree. */
        overlaid: z.array(pathPatternSchema).max(512).optional(),
        /** v3: ignored dependency directories linked into the worktree (read-only by policy). */
        dependency_links: z.array(pathPatternSchema).max(32).optional(),
        /** v3: submodule (gitlink) paths of the base commit; never populated, never writable. */
        submodules: z.array(pathPatternSchema).max(256).optional(),
      }),
      /** v2: the attempt's own session, where its turns, tool calls and report live. */
      session_id: sessionIdSchema.optional(),
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
    "attempt/verification_ran",
    z
      .strictObject({
        attempt_id: attemptIdSchema,
        task_id: taskIdSchema,
        /** 1-based position of the command in the packet's `verification.commands`. */
        ordinal: z.int().min(1).max(100),
        command: z.string().min(1).max(4000),
        /** The argv the harness ran; absent when the command could not be expressed as argv. */
        argv: z.array(z.string()).min(1).max(256).optional(),
        /** How the harness classified the command (`VERIFICATION_COMMAND_CLASSES`); absent on older events. */
        command_class: z.enum(VERIFICATION_COMMAND_CLASSES).optional(),
        status: z.enum(HARNESS_VERIFICATION_STATUSES),
        termination: z.enum(PROCESS_TERMINATIONS).optional(),
        exit_code: z.int().nullable(),
        duration_ms: z.int().min(0),
        /** Head and tail of stdout+stderr, redacted; the full output is `output_blob`. */
        output_excerpt: z.string().max(4096),
        output_blob: blobRefSchema.optional(),
        /** Pinned artifact the command verified (the attempt's diff when it ran). */
        artifact_digest: digestSchema.optional(),
        reason: z.string().min(1).max(500).optional(),
      })
      .superRefine(checkVerificationOutcome),
  ),
  eventOf(
    "attempt/repair_requested",
    z.strictObject({
      attempt_id: attemptIdSchema,
      task_id: taskIdSchema,
      kind: z.enum(REPAIR_KINDS),
      /** 1-based repair round of this attempt; never above `budget`. */
      round: z.int().min(1),
      /** The task's `evidence_repairs` budget when the round was requested. */
      budget: z.int().min(0),
      problems: repairProblemsSchema,
    }).refine((repair) => repair.round <= repair.budget, { path: ["round"], message: "a repair round cannot exceed its budget" }),
  ),
  eventOf(
    "task/integrated",
    z.strictObject({
      task_id: taskIdSchema,
      attempt_id: attemptIdSchema,
      artifact_digest: digestSchema,
      paths: z.array(pathPatternSchema),
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
          source: z.enum(CONTEXT_BLOCK_SOURCES),
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
      /** v2: the short ref ordinal (`[#n]`) of this call within its attempt (ADR-18). */
      ref: toolRefOrdinalSchema.optional(),
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
  eventOf("trust/granted", z.strictObject({ workspace_root: trustRootSchema, repo_identity: trustIdentitySchema, source: z.enum(TRUST_GRANT_SOURCES) })),
  eventOf("trust/revoked", z.strictObject({ workspace_root: trustRootSchema, repo_identity: trustIdentitySchema })),
  eventOf(
    "trust/used",
    z.strictObject({
      workspace_root: trustRootSchema,
      repo_identity: trustIdentitySchema,
      source: z.enum(TRUST_USE_SOURCES),
      sandbox_enforcement: z.enum(SANDBOX_ENFORCEMENT),
    }),
  ),
  /**
   * ADR-21 D6: the conversation agent's per-edit checkpoint. `before` is the pre-image blob (null:
   * the file did not exist), `after` the workspace digest the edit left (null: deleted). `/undo`
   * restores `before` only while the file still has the `after` digest.
   */
  eventOf(
    "checkpoint/recorded",
    z.strictObject({
      turn_id: turnIdSchema.optional(),
      tool_call_id: toolCallIdSchema,
      files: z
        .array(z.strictObject({ path: pathPatternSchema, before: blobRefSchema.nullable(), after: digestSchema.nullable() }))
        .min(1)
        .max(64),
    }),
  ),
  eventOf(
    "checkpoint/restored",
    z.strictObject({
      checkpoint_seq: z.int().min(1),
      restored: z.array(pathPatternSchema).max(64),
      skipped: z.array(z.strictObject({ path: pathPatternSchema, reason: z.string().min(1).max(500) })).max(64),
    }),
  ),
  /** `/allow <prefix>`: the user extended the conversation agent's exec allowlist for this workspace (user scope). */
  eventOf("command/allowed", z.strictObject({ workspace_root: trustRootSchema, prefix: z.string().min(1).max(500) })),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent["type"];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;

/**
 * Payload fields added after version 1, per type: the version that introduced each one. A writer
 * always stamps `EVENT_VERSIONS[type]`; a reader accepts every older version, and an older-version
 * event that carries a newer field is `invalid` (it cannot have been written by that version).
 */
export const EVENT_FIELD_VERSIONS = {
  "session/opened": { config_ignored: 2 },
  "session/resumed": { torn_tail: 2 },
  "attempt/started": {
    session_id: 2,
    "isolation.reused": 3,
    "isolation.fallback": 3,
    "isolation.overlaid": 3,
    "isolation.dependency_links": 3,
    "isolation.submodules": 3,
  },
  "tool/call_proposed": { ref: 2 },
  "tool/result_recorded": { "result.digest": 2 },
  "tool/policy_decided": { "action.escapes": 2 },
  "policy/snapshot": { "policy.exec_confinement": 2, "policy.verification_commands": 2, "policy.workspace_trusted": 3 },
} as const satisfies { readonly [T in SessionEventType]?: Readonly<Record<string, number>> };

/** Current payload version per type. A reader meeting a higher version reports `unsupported`. */
export const EVENT_VERSIONS: { readonly [T in SessionEventType]: number } = Object.fromEntries(
  sessionEventSchema.options.map((option) => {
    const type = option.shape.type.value;
    const fields: Readonly<Record<string, number>> = (EVENT_FIELD_VERSIONS as Readonly<Record<string, Readonly<Record<string, number>>>>)[type] ?? {};
    return [type, Math.max(1, ...Object.values(fields))];
  }),
) as { readonly [T in SessionEventType]: number };

function fieldAt(data: unknown, dotted: string): unknown {
  let current: unknown = data;
  for (const key of dotted.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function newerFieldIssues(event: SessionEvent): { readonly path: readonly PropertyKey[]; readonly message: string }[] {
  const fields: Readonly<Record<string, number>> = (EVENT_FIELD_VERSIONS as Readonly<Record<string, Readonly<Record<string, number>>>>)[event.type] ?? {};
  return Object.entries(fields)
    .filter(([field, since]) => event.event_version < since && fieldAt(event.data, field) !== undefined)
    .map(([field, since]) => ({ path: ["data", ...field.split(".")], message: `${field} requires event_version >= ${since}` }));
}

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
  if (parsed.success) {
    const issues = newerFieldIssues(parsed.data);
    return issues.length === 0 ? { status: "ok", event: parsed.data } : { status: "invalid", issues };
  }
  return { status: "invalid", issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) };
}
