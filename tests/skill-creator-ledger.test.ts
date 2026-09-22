import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmptyLedger,
  observationLedgerSchema,
  observationSchema,
  pruneExpiredObservations,
  type Observation,
  type ObservationLedger,
} from "../src/domain/observation-ledger.ts";

const DIGEST = "sha256:9f2c1d3b4a5e6f70";

test("an empty ledger is valid and carries both counters", () => {
  const ledger = createEmptyLedger();

  assert.deepEqual(ledger, { schema_version: 1, tasks_seen: 0, observations: [] });
  assert.equal(observationLedgerSchema.safeParse(ledger).success, true);
});

test("a fully populated observation parses", () => {
  const result = observationSchema.safeParse(observation({}));

  assert.equal(result.success, true);
});

test("an observation without a source is rejected", () => {
  const result = observationSchema.safeParse(observation({ sources: [] }));

  assert.equal(result.success, false);
});

test("an observation whose count disagrees with confirmed_by is rejected", () => {
  const result = observationSchema.safeParse(observation({ count: 2 }));

  assert.equal(result.success, false);
});

test("an observation confirmed twice by the same task is rejected", () => {
  const result = observationSchema.safeParse(
    observation({ confirmed_by: ["task-1", "task-1"], count: 2 }),
  );

  assert.equal(result.success, false);
});

test("a non-kebab-case id, an unknown kind and a short digest are rejected", () => {
  assert.equal(observationSchema.safeParse(observation({ id: "API_Tests" })).success, false);
  assert.equal(observationSchema.safeParse(observation({ kind: "anecdote" })).success, false);
  assert.equal(
    observationSchema.safeParse(
      observation({ sources: [{ path: "services/api/package.json", digest: "sha256:9f2c" }] }),
    ).success,
    false,
  );
});

test("an impossible calendar date is rejected", () => {
  assert.equal(observationSchema.safeParse(observation({ last_seen_at: "2026-02-30" })).success, false);
});

test("a last_seen_task_index beyond tasks_seen is rejected", () => {
  const result = observationLedgerSchema.safeParse(
    ledgerOf(5, [observation({ last_seen_task_index: 9 })]),
  );

  assert.equal(result.success, false);
});

test("duplicate observation ids are rejected", () => {
  const result = observationLedgerSchema.safeParse(
    ledgerOf(5, [observation({}), observation({ claim: "Another claim." })]),
  );

  assert.equal(result.success, false);
});

test("an unpromoted observation expires 90 days after its last confirmation", () => {
  const ledger = ledgerOf(1, [
    observation({ id: "quiet", last_seen_at: "2026-06-01", last_seen_task_index: 1 }),
    observation({ id: "recent", last_seen_at: "2026-08-01", last_seen_task_index: 1 }),
  ]);

  const pruned = pruneExpiredObservations(ledger, new Date("2026-08-30T00:00:00Z"));

  assert.deepEqual(pruned.expired, ["quiet"]);
  assert.deepEqual(
    pruned.ledger.observations.map((entry) => entry.id),
    ["recent"],
  );
  assert.equal(pruned.ledger.tasks_seen, 1);
});

test("the 90-day boundary expires on the day it is reached, not before", () => {
  const ledger = ledgerOf(1, [observation({ last_seen_at: "2026-06-01", last_seen_task_index: 1 })]);

  assert.deepEqual(
    pruneExpiredObservations(ledger, new Date("2026-08-29T23:00:00Z")).expired,
    [],
  );
  assert.deepEqual(
    pruneExpiredObservations(ledger, new Date("2026-08-30T00:00:00Z")).expired,
    ["api-test-execution"],
  );
});

test("an unpromoted observation expires 20 completed tasks after its last confirmation", () => {
  const ledger = ledgerOf(41, [
    observation({ id: "quiet", last_seen_task_index: 21 }),
    observation({ id: "recent", last_seen_task_index: 22 }),
  ]);

  const pruned = pruneExpiredObservations(ledger, new Date("2026-09-22T00:00:00Z"));

  assert.deepEqual(pruned.expired, ["quiet"]);
  assert.deepEqual(
    pruned.ledger.observations.map((entry) => entry.id),
    ["recent"],
  );
});

test("promoted and declined observations are never pruned, and expired ones always are", () => {
  const ledger = ledgerOf(99, [
    observation({ id: "declined-one", status: "declined", last_seen_task_index: 0 }),
    observation({ id: "promoted-one", status: "promoted", last_seen_task_index: 0 }),
    observation({ id: "proposed-one", status: "proposed", last_seen_task_index: 0 }),
    observation({ id: "expired-one", status: "expired", last_seen_task_index: 99 }),
  ]);

  const pruned = pruneExpiredObservations(ledger, new Date("2026-09-22T00:00:00Z"));

  assert.deepEqual(pruned.expired, ["expired-one"]);
  assert.deepEqual(
    pruned.ledger.observations.map((entry) => entry.id),
    ["declined-one", "promoted-one", "proposed-one"],
  );
});

test("pruning sorts the surviving observations deterministically", () => {
  const ledger = ledgerOf(1, [
    observation({ id: "zulu", last_seen_task_index: 1 }),
    observation({ id: "alpha", last_seen_task_index: 1 }),
  ]);

  const pruned = pruneExpiredObservations(ledger, new Date("2026-09-22T00:00:00Z"));

  assert.deepEqual(
    pruned.ledger.observations.map((entry) => entry.id),
    ["alpha", "zulu"],
  );
});

function observation(overrides: Record<string, unknown>): Observation {
  return {
    id: "api-test-execution",
    claim: "API tests must run with cwd services/api.",
    kind: "command-behavior",
    sources: [{ path: "services/api/package.json", digest: DIGEST }],
    confirmed_by: ["task-141", "task-156", "task-173"],
    count: 3,
    origin: "worker-discovery",
    first_seen_at: "2026-09-14",
    last_seen_at: "2026-09-22",
    last_seen_task_index: 0,
    status: "collecting",
    ...overrides,
  } as Observation;
}

function ledgerOf(tasksSeen: number, observations: readonly Observation[]): ObservationLedger {
  return { schema_version: 1, tasks_seen: tasksSeen, observations: [...observations] };
}
