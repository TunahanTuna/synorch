import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createId,
  deriveProjectId,
  StoreFailure,
  type EventReadItem,
  type SessionEventDraft,
  type SessionId,
} from "../src/harness/contracts/index.ts";
import { projectSession } from "../src/harness/core/index.ts";
import { createSessionStore, MAX_EVENT_LINE_BYTES, type SegmentedEventStore } from "../src/harness/store/index.ts";

const homes: string[] = [];
const PROJECT = deriveProjectId("/home/dev/synorch", "linux");

after(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

async function seeded(count: number, segmentMaxBytes?: number): Promise<{ home: string; sessionId: SessionId; segment: (n: number) => string }> {
  const home = await mkdtemp(path.join(tmpdir(), "synorch-segments-"));
  homes.push(home);
  const store = createSessionStore(home, segmentMaxBytes === undefined ? {} : { segmentMaxBytes });
  const sessionId = createId("session");
  const writer = await store.create({ session_id: sessionId, project_id: PROJECT, workspace_root: "/home/dev/synorch", created_at: "2026-09-22T10:00:00.000Z" });
  for (let index = 1; index <= count; index += 1) await writer.append(steer(`event ${index}`));
  await writer.close();
  const segmentsDir = path.join(home, "sessions", PROJECT, sessionId, "segments");
  return { home, sessionId, segment: (n) => path.join(segmentsDir, `${String(n).padStart(6, "0")}.jsonl`) };
}

function steer(text: string): SessionEventDraft {
  return { type: "steer/queued", event_version: 1, actor: { kind: "user" }, data: { text } };
}

async function readAll(home: string, sessionId: SessionId): Promise<EventReadItem[]> {
  const out: EventReadItem[] = [];
  for await (const item of (await createSessionStore(home).openForRead(sessionId)).read()) out.push(item);
  return out;
}

async function rejectsWith(promise: Promise<unknown>, code: StoreFailure["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof StoreFailure && error.code === code);
}

function rawEvent(sessionId: SessionId, seq: number, extra: Record<string, unknown>): string {
  return `${JSON.stringify({
    schema_version: 1,
    event_id: createId("event"),
    session_id: sessionId,
    seq,
    event_version: 1,
    timestamp: "2026-09-22T10:00:00.000Z",
    actor: { kind: "system" },
    ...extra,
  })}\n`;
}

test("AC-2 a half-written last line is reported as torn-tail and quarantined when opened for writing", async () => {
  const { home, sessionId, segment } = await seeded(3);
  const torn = rawEvent(sessionId, 4, { type: "steer/queued", data: { text: "never finished" } }).slice(0, 40);
  await appendFile(segment(1), torn);

  const items = await readAll(home, sessionId);
  assert.deepEqual(items.slice(0, 3).map((item) => item.status), ["ok", "ok", "ok"]);
  assert.deepEqual(items[3], { status: "torn-tail", segment: 1, bytes: Buffer.byteLength(torn) });
  const projection = projectSession(items);
  assert.equal(projection.status, "ok");
  assert.deepEqual(projection.tornTail, { segment: 1, bytes: Buffer.byteLength(torn) });

  const writer = (await createSessionStore(home).openForWrite(sessionId)) as SegmentedEventStore;
  assert.equal(writer.lastSeq, 3);
  assert.equal(writer.quarantinedTail?.segment, 1);
  assert.equal(writer.quarantinedTail?.bytes, Buffer.byteLength(torn));
  assert.equal(await readFile(writer.quarantinedTail?.file ?? "", "utf8"), torn);
  assert.equal(path.basename(writer.quarantinedTail?.file ?? ""), "000001.jsonl.torn-1");
  assert.equal((await writer.append(steer("event 4"))).seq, 4);
  await writer.close();

  const healed = await readAll(home, sessionId);
  assert.deepEqual(healed.map((item) => (item.status === "ok" ? item.event.seq : item.status)), [1, 2, 3, 4]);
});

test("AC-2 a complete but unparseable final line is also a torn tail", async () => {
  const { home, sessionId, segment } = await seeded(2);
  await appendFile(segment(1), '{"schema_version":1,"seq":3,\n');
  const items = await readAll(home, sessionId);
  assert.equal(items.at(-1)?.status, "torn-tail");
  const writer = await createSessionStore(home).openForWrite(sessionId);
  assert.equal((await writer.append(steer("event 3"))).seq, 3);
  await writer.close();
});

test("AC-2 a second torn tail gets the next quarantine index", async () => {
  const { home, sessionId, segment } = await seeded(1);
  for (const expected of ["000001.jsonl.torn-1", "000001.jsonl.torn-2"]) {
    await appendFile(segment(1), '{"partial":');
    const writer = (await createSessionStore(home).openForWrite(sessionId)) as SegmentedEventStore;
    assert.equal(path.basename(writer.quarantinedTail?.file ?? ""), expected);
    await writer.close();
  }
});

test("AC-2 a corrupt line in the middle is session_corrupt and never repaired", async () => {
  const { home, sessionId, segment } = await seeded(3);
  const lines = (await readFile(segment(1), "utf8")).split("\n");
  lines[2] = '{"this is": not json';
  const damaged = lines.join("\n");
  await writeFile(segment(1), damaged);

  const items = await readAll(home, sessionId);
  assert.deepEqual(items.map((item) => item.status), ["ok", "invalid", "ok"]);
  assert.equal(projectSession(items).status, "corrupt");
  await rejectsWith(createSessionStore(home).openForWrite(sessionId), "session_corrupt");
  assert.equal(await readFile(segment(1), "utf8"), damaged, "the log is left untouched");
  await rejectsWith(createSessionStore(home).openForWrite(sessionId), "session_corrupt");
});

test("AC-2 a seq gap or a foreign session id in the middle is session_corrupt", async () => {
  const gap = await seeded(2);
  await appendFile(gap.segment(1), rawEvent(gap.sessionId, 4, { type: "steer/queued", data: { text: "skipped 3" } }));
  await appendFile(gap.segment(1), rawEvent(gap.sessionId, 5, { type: "steer/queued", data: { text: "after gap" } }));
  await rejectsWith(createSessionStore(gap.home).openForWrite(gap.sessionId), "session_corrupt");

  const foreign = await seeded(2);
  await appendFile(foreign.segment(1), rawEvent(createId("session"), 3, { type: "steer/queued", data: { text: "wrong session" } }));
  await appendFile(foreign.segment(1), rawEvent(foreign.sessionId, 4, { type: "steer/queued", data: { text: "tail" } }));
  await rejectsWith(createSessionStore(foreign.home).openForWrite(foreign.sessionId), "session_corrupt");
});

test("AC-2 a missing middle segment is session_corrupt", async () => {
  const { home, sessionId, segment } = await seeded(30, 800);
  await rm(segment(2));
  await rejectsWith(createSessionStore(home).openForWrite(sessionId), "session_corrupt");
});

test("AC-2 a torn header from a crash during rotation drops that segment and writing continues", async () => {
  const { home, sessionId, segment } = await seeded(3);
  await writeFile(segment(2), '{"kind":"segment","schema_version":1,');
  const items = await readAll(home, sessionId);
  assert.deepEqual(items.at(-1), { status: "torn-tail", segment: 2, bytes: 37 });

  const writer = (await createSessionStore(home).openForWrite(sessionId)) as SegmentedEventStore;
  assert.equal(writer.lastSeq, 3);
  assert.equal(writer.quarantinedTail?.segment, 2);
  assert.equal((await writer.append(steer("event 4"))).seq, 4);
  await writer.close();
  const names = await readdir(path.dirname(segment(1)));
  assert.ok(!names.includes("000002.jsonl"));
  assert.ok(names.includes("000002.jsonl.torn-1"));
});

test("AC-3 an unknown event type makes the session read-only: openForWrite refuses, reads report unsupported", async () => {
  const { home, sessionId, segment } = await seeded(2);
  await appendFile(segment(1), rawEvent(sessionId, 3, { type: "worker/heartbeat", data: {} }));
  await appendFile(segment(1), rawEvent(sessionId, 4, { type: "steer/queued", data: { text: "after the unknown type" } }));

  await rejectsWith(createSessionStore(home).openForWrite(sessionId), "unsupported_version");
  const items = await readAll(home, sessionId);
  assert.deepEqual(items[2], { status: "unsupported", type: "worker/heartbeat", event_version: 1 });
  const projection = projectSession(items);
  assert.equal(projection.status, "unsupported");
  assert.equal(projection.writable, false);
  assert.equal(projection.appliedSeq, 2);
  assert.equal(projection.lastSeq, 4);
  assert.match(projection.issues[0]?.message ?? "", /newer version/);
});

test("AC-3 a newer payload version of a known type is unsupported, not invalid", async () => {
  const { home, sessionId, segment } = await seeded(1);
  await appendFile(segment(1), rawEvent(sessionId, 2, { type: "session/closed", event_version: 2, data: { reason: "user", note: "newer" } }));
  await rejectsWith(createSessionStore(home).openForWrite(sessionId), "unsupported_version");
  const items = await readAll(home, sessionId);
  assert.deepEqual(items[1], { status: "unsupported", type: "session/closed", event_version: 2 });
});

test("an event line above the hard size cap is rejected before it is written", async () => {
  const { home, sessionId } = await seeded(1);
  const writer = await createSessionStore(home).openForWrite(sessionId);
  await rejectsWith(writer.append(steer("x".repeat(MAX_EVENT_LINE_BYTES))), "write_failed");
  assert.equal((await writer.append(steer("still healthy"))).seq, 2);
  await writer.close();
});

test("lines are split on LF only: U+2028 and U+2029 inside text survive a round trip", async () => {
  const { home, sessionId } = await seeded(0);
  const writer = await createSessionStore(home).openForWrite(sessionId);
  await writer.append(steer("line separator paragraph\r\ncrlf"));
  await writer.close();
  const [item] = await readAll(home, sessionId);
  assert.ok(item?.status === "ok" && item.event.type === "steer/queued");
  assert.equal(item.event.data.text, "line separator paragraph\r\ncrlf");
});
