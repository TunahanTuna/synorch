import { z } from "zod";

/** The ledger is the orchestrator's only writable distillation surface (`.ai/tasks/**`). */
export const OBSERVATION_LEDGER_PATH = ".ai/tasks/observations.yaml";

/** An unpromoted observation expires 90 days after its last confirmation. */
export const OBSERVATION_EXPIRY_DAYS = 90;

/** An unpromoted observation expires 20 completed tasks after its last confirmation. */
export const OBSERVATION_EXPIRY_TASKS = 20;

/** Promotion requires this many distinct confirming task ids unless a user correction fast-paths it. */
export const OBSERVATION_PROMOTION_THRESHOLD = 3;

const MILLISECONDS_PER_DAY = 86_400_000;

const identifierSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be kebab-case");

/** Calendar date without a time component, exactly as the design records it. */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO calendar date (YYYY-MM-DD)")
  .refine((value) => parseIsoDate(value) !== undefined, "must be a real calendar date");

/**
 * Digests are `sha256:<hex>` over the source file's bytes with line endings normalized to `\n`,
 * so the same working tree yields the same digest on every platform. A truncated prefix of at
 * least 16 hex characters is accepted because reports quote shortened digests.
 */
const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{16,64}$/, "must be sha256:<hex>, at least 16 hex characters");

export const OBSERVATION_KINDS = [
  "command-behavior",
  "convention",
  "ordering-constraint",
  "pitfall",
  "boundary",
] as const;

export const OBSERVATION_STATUSES = [
  "collecting",
  "ready-to-propose",
  "proposed",
  "promoted",
  "declined",
  "expired",
] as const;

export const observationSourceSchema = z.object({
  path: z.string().min(1),
  digest: digestSchema,
});
export type ObservationSource = z.infer<typeof observationSourceSchema>;

export const observationSchema = z
  .object({
    id: identifierSchema,
    claim: z.string().min(1),
    kind: z.enum(OBSERVATION_KINDS),
    /** No source, no observation: the evidence requirement is structural, not advisory. */
    sources: z.array(observationSourceSchema).min(1),
    confirmed_by: z.array(z.string().min(1)),
    count: z.int().min(0),
    origin: z.enum(["worker-discovery", "user-correction"]),
    first_seen_at: isoDateSchema,
    last_seen_at: isoDateSchema,
    /**
     * The value of the ledger's `tasks_seen` counter at the last confirmation. It is what makes
     * the "20 tasks without reconfirmation" rule decidable without a clock or a task history.
     */
    last_seen_task_index: z.int().min(0),
    status: z.enum(OBSERVATION_STATUSES),
  })
  .superRefine((observation, context) => {
    if (observation.count !== observation.confirmed_by.length) {
      context.addIssue({
        code: "custom",
        message: "count must equal the number of confirming task ids",
        path: ["count"],
      });
    }
    if (new Set(observation.confirmed_by).size !== observation.confirmed_by.length) {
      context.addIssue({
        code: "custom",
        message: "confirmed_by must contain distinct task ids",
        path: ["confirmed_by"],
      });
    }
  });
export type Observation = z.infer<typeof observationSchema>;

export const observationLedgerSchema = z
  .object({
    schema_version: z.literal(1),
    /**
     * Monotonic count of completed tasks. The orchestrator increments it exactly once per
     * completed task, in the same write that records or reconfirms observations.
     */
    tasks_seen: z.int().min(0),
    observations: z.array(observationSchema),
  })
  .superRefine((ledger, context) => {
    const identifiers = ledger.observations.map((observation) => observation.id);
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        message: "observation ids must be unique",
        path: ["observations"],
      });
    }
    for (const [index, observation] of ledger.observations.entries()) {
      if (observation.last_seen_task_index > ledger.tasks_seen) {
        context.addIssue({
          code: "custom",
          message: "last_seen_task_index cannot exceed the ledger tasks_seen counter",
          path: ["observations", index, "last_seen_task_index"],
        });
      }
    }
  });
export type ObservationLedger = z.infer<typeof observationLedgerSchema>;

export interface LedgerPruneResult {
  readonly ledger: ObservationLedger;
  /** Pruned observation ids, sorted, so callers and reports stay deterministic. */
  readonly expired: readonly string[];
}

export function createEmptyLedger(): ObservationLedger {
  return { schema_version: 1, tasks_seen: 0, observations: [] };
}

/**
 * Remove observations that never reached promotion and have gone quiet: 90 days since
 * `last_seen_at`, or 20 completed tasks since `last_seen_task_index`, whichever comes first.
 * `declined` is permanent and `promoted` is durable, so neither is ever pruned; `expired`
 * entries left behind by the orchestrator are swept out here.
 */
export function pruneExpiredObservations(
  ledger: ObservationLedger,
  now: Date,
): LedgerPruneResult {
  const kept: Observation[] = [];
  const expired: string[] = [];
  for (const observation of ledger.observations) {
    if (isExpiredObservation(observation, ledger.tasks_seen, now)) {
      expired.push(observation.id);
      continue;
    }
    kept.push(observation);
  }
  return {
    ledger: { ...ledger, observations: sortObservations(kept) },
    expired: [...expired].sort((left, right) => left.localeCompare(right)),
  };
}

export function isExpiredObservation(
  observation: Observation,
  tasksSeen: number,
  now: Date,
): boolean {
  if (observation.status === "expired") return true;
  if (observation.status !== "collecting" && observation.status !== "ready-to-propose") {
    return false;
  }
  return (
    daysSince(observation.last_seen_at, now) >= OBSERVATION_EXPIRY_DAYS ||
    tasksSeen - observation.last_seen_task_index >= OBSERVATION_EXPIRY_TASKS
  );
}

/** Deterministic ledger order, independent of the order in which observations were recorded. */
export function sortObservations(observations: readonly Observation[]): Observation[] {
  return [...observations].sort((left, right) => left.id.localeCompare(right.id));
}

/** Whole days elapsed since an ISO calendar date, measured in UTC. Unparseable dates never expire. */
function daysSince(isoDate: string, now: Date): number {
  const seen = parseIsoDate(isoDate);
  if (seen === undefined) return 0;
  return Math.floor((now.getTime() - seen) / MILLISECONDS_PER_DAY);
}

function parseIsoDate(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return timestamp;
}
