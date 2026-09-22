import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createId, type SessionId } from "../src/harness/contracts/index.ts";
import { SessionLeaseHandle, type LeaseSettings } from "../src/harness/store/lease.ts";

/**
 * SEC-L2 regression: a writer suspended in the middle of a lease renewal (after it verified its
 * token, before it wrote) must not overwrite a takeover that happened meanwhile; otherwise two
 * processes would both believe they hold the session.
 */

test("SEC-L2 a renewal suspended between token check and write cannot overwrite a takeover", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-lease-"));
  const file = path.join(directory, "lock.json");
  const sessionId = createId("session") as SessionId;
  let now = Date.parse("2026-09-22T10:00:00.000Z");
  const base: LeaseSettings = { clock: () => new Date(now), pid: process.pid, host: "suspend-test", ttlMs: 30_000, heartbeatMs: 10_000 };
  let suspendOnce = false;
  let taker: SessionLeaseHandle | undefined;
  const writer = await SessionLeaseHandle.acquire(file, sessionId, {
    ...base,
    checkpoint: async () => {
      if (!suspendOnce) return;
      suspendOnce = false;
      // The process sleeps well past its lease; another writer takes the expired session over.
      now += 120_000;
      taker = await SessionLeaseHandle.acquire(file, sessionId, base);
    },
  });
  try {
    suspendOnce = true;
    await writer.renew();
    assert.ok(taker !== undefined, "the takeover happened while the renewal was suspended");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { holder: { token: string } };
    assert.equal(onDisk.holder.token, taker.lease.holder.token, "lock.json still carries the new holder's token");
    assert.ok(writer.lostReason !== undefined, "the suspended writer knows it lost the lease");
    await assert.rejects(writer.verify(), /no longer held by this writer/);
    await taker.verify();
  } finally {
    await writer.release().catch(() => undefined);
    await taker?.release().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease CAS: renew, verify and release still work for an undisturbed holder", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-lease-"));
  const file = path.join(directory, "lock.json");
  let now = Date.parse("2026-09-22T10:00:00.000Z");
  const settings: LeaseSettings = { clock: () => new Date(now), pid: process.pid, host: "suspend-test", ttlMs: 30_000, heartbeatMs: 10_000 };
  const holder = await SessionLeaseHandle.acquire(file, createId("session") as SessionId, settings);
  try {
    now += 25_000;
    await holder.verify();
    assert.equal(holder.lease.expires_at, "2026-09-22T10:00:55.000Z");
    await holder.release();
    await assert.rejects(readFile(file, "utf8"));
    await assert.rejects(readFile(`${file}.cas`, "utf8"), "the mutex is gone after release");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
