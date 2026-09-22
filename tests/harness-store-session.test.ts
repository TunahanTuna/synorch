import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createId,
  deriveProjectId,
  segmentHeaderSchema,
  StoreFailure,
  type EventReadItem,
  type SessionEventDraft,
  type SessionId,
} from "../src/harness/contracts/index.ts";
import { createSessionStore, type SegmentedEventStore } from "../src/harness/store/index.ts";

const homes: string[] = [];
const PROJECT = deriveProjectId("/home/dev/synorch", "linux");
const STORE_ENTRY = pathToFileURL(fileURLToPath(new URL("../src/harness/store/index.ts", import.meta.url))).href;

after(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

async function newHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "synorch-store-"));
  homes.push(home);
  return home;
}

function manifest(sessionId: SessionId = createId("session")) {
  return { session_id: sessionId, project_id: PROJECT, workspace_root: "/home/dev/synorch", created_at: "2026-09-22T10:00:00.000Z" };
}

function steer(text: string): SessionEventDraft {
  return { type: "steer/queued", event_version: 1, actor: { kind: "user" }, data: { text } };
}

async function collect(items: AsyncIterable<EventReadItem>): Promise<EventReadItem[]> {
  const out: EventReadItem[] = [];
  for await (const item of items) out.push(item);
  return out;
}

function seqs(items: readonly EventReadItem[]): number[] {
  return items.map((item) => (item.status === "ok" ? item.event.seq : -1));
}

async function rejectsWith(promise: Promise<unknown>, code: StoreFailure["code"], pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StoreFailure, `expected StoreFailure, got ${String(error)}`);
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  });
}

function clockAt(start: string): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse(start);
  return { now: () => new Date(current), advance: (ms) => (current += ms) };
}

test("AC-1 appended events read back in order with dense seq, across close and reopen", async () => {
  const store = createSessionStore(await newHome());
  const writer = await store.create(manifest());
  for (let index = 1; index <= 5; index += 1) {
    const event = await writer.append(steer(`message ${index}`));
    assert.equal(event.seq, index);
    assert.equal(event.session_id, writer.sessionId);
  }
  assert.equal(writer.lastSeq, 5);
  assert.deepEqual(seqs(await collect(writer.read())), [1, 2, 3, 4, 5]);
  await writer.close();

  const reader = await store.openForRead(writer.sessionId);
  const items = await collect(reader.read());
  assert.deepEqual(seqs(items), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    items.map((item) => (item.status === "ok" && item.event.type === "steer/queued" ? item.event.data.text : "")),
    ["message 1", "message 2", "message 3", "message 4", "message 5"],
  );

  const reopened = await store.openForWrite(writer.sessionId);
  assert.equal(reopened.lastSeq, 5);
  assert.equal((await reopened.append(steer("after reopen"))).seq, 6);
  await reopened.close();
});

test("AC-1 concurrent appends are serialized into a dense sequence", async () => {
  const writer = await createSessionStore(await newHome()).create(manifest());
  const events = await Promise.all(Array.from({ length: 25 }, (_, index) => writer.append(steer(`parallel ${index}`))));
  assert.deepEqual(
    events.map((event) => event.seq),
    Array.from({ length: 25 }, (_, index) => index + 1),
  );
  assert.deepEqual(seqs(await collect(writer.read())), events.map((event) => event.seq));
  await writer.close();
});

test("AC-1 a second writer in the same process gets session_locked naming the holder", async () => {
  const home = await newHome();
  const writer = await createSessionStore(home).create(manifest());
  await rejectsWith(createSessionStore(home).openForWrite(writer.sessionId), "session_locked", new RegExp(`pid ${process.pid} on `));
  await writer.close();
  const next = await createSessionStore(home).openForWrite(writer.sessionId);
  await next.close();
});

test("AC-1 a second writer in another process gets session_locked", async () => {
  const home = await newHome();
  const writer = await createSessionStore(home).create(manifest());
  const script = [
    `import { createSessionStore } from ${JSON.stringify(STORE_ENTRY)};`,
    `try { await createSessionStore(process.argv[2]).openForWrite(process.argv[3]); console.log("opened"); }`,
    `catch (error) { console.log(error.code + " " + error.message); }`,
  ].join("\n");
  const scriptFile = path.join(home, "second-writer.mjs");
  await writeFile(scriptFile, script);
  const output = await runNode(scriptFile, [home, writer.sessionId]);
  assert.match(output, new RegExp(`^session_locked session ${writer.sessionId} is locked by pid ${process.pid}`));
  await writer.close();
});

test("AC-1 an expired lease is taken over and the previous writer can no longer append", async () => {
  const home = await newHome();
  const clock = clockAt("2026-09-22T10:00:00.000Z");
  const first = await createSessionStore(home, { clock: clock.now }).create(manifest());
  await first.append(steer("first writer"));

  const early = createSessionStore(home, { clock: clock.now });
  await rejectsWith(early.openForWrite(first.sessionId), "session_locked");

  clock.advance(31_000);
  const second = await createSessionStore(home, { clock: clock.now }).openForWrite(first.sessionId);
  assert.equal(second.lastSeq, 1);
  await rejectsWith(first.append(steer("stale writer")), "write_failed", /taken over by pid/);
  assert.equal((await second.append(steer("new writer"))).seq, 2);
  await second.close();
  await first.close();
});

test("a heartbeat renews the lease so a live writer is never taken over", async () => {
  const home = await newHome();
  const clock = clockAt("2026-09-22T10:00:00.000Z");
  const writer = (await createSessionStore(home, { clock: clock.now }).create(manifest())) as SegmentedEventStore;
  clock.advance(20_000);
  await writer.heartbeat();
  clock.advance(20_000);
  await rejectsWith(createSessionStore(home, { clock: clock.now }).openForWrite(writer.sessionId), "session_locked");
  const lease = JSON.parse(await readFile(path.join(home, "sessions", PROJECT, writer.sessionId, "lock.json"), "utf8")) as { expires_at: string };
  assert.equal(lease.expires_at, "2026-09-22T10:00:50.000Z");
  await writer.close();
});

test("a crashed writer's lease (process gone, lease unexpired) is taken over on the same host", async () => {
  const home = await newHome();
  const sessionId = createId("session");
  const script = [
    `import { createSessionStore } from ${JSON.stringify(STORE_ENTRY)};`,
    `const writer = await createSessionStore(process.argv[2]).create(JSON.parse(process.argv[3]));`,
    `for (let i = 1; i <= 3; i += 1) await writer.append({ type: "steer/queued", event_version: 1, actor: { kind: "user" }, data: { text: "before crash " + i } });`,
    `console.log("appended"); process.exit(0);`,
  ].join("\n");
  const scriptFile = path.join(home, "crash-writer.mjs");
  await writeFile(scriptFile, script);
  assert.equal((await runNode(scriptFile, [home, JSON.stringify(manifest(sessionId))])).trim(), "appended");

  const store = createSessionStore(home);
  const resumed = await store.openForWrite(sessionId);
  assert.equal(resumed.lastSeq, 3, "every append that resolved before the crash is durable");
  assert.equal((await resumed.append(steer("after crash"))).seq, 4);
  await resumed.close();
});

test("segments rotate at the size limit, carry first_seq headers and range reads cross them", async () => {
  const home = await newHome();
  const writer = await createSessionStore(home, { segmentMaxBytes: 1200 }).create(manifest());
  for (let index = 1; index <= 40; index += 1) await writer.append(steer(`rotating event number ${index}`));
  await writer.close();

  const segmentsDir = path.join(home, "sessions", PROJECT, writer.sessionId, "segments");
  const files = (await readdir(segmentsDir)).sort();
  assert.ok(files.length >= 4, `expected several segments, got ${files.join(", ")}`);
  let expectedFirst = 1;
  for (const [index, file] of files.entries()) {
    const text = await readFile(path.join(segmentsDir, file), "utf8");
    assert.ok(text.endsWith("\n"));
    assert.ok(!text.includes("\r"));
    const lines = text.trimEnd().split("\n");
    const header = segmentHeaderSchema.parse(JSON.parse(lines[0] ?? ""));
    assert.equal(header.segment, index + 1);
    assert.equal(header.first_seq, expectedFirst);
    assert.ok(Buffer.byteLength(text) <= 1200 || lines.length === 2, "a segment only exceeds the limit with a single event");
    expectedFirst += lines.length - 1;
  }
  assert.equal(expectedFirst, 41);

  const reader = await createSessionStore(home).openForRead(writer.sessionId);
  assert.deepEqual(seqs(await collect(reader.read())), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.deepEqual(seqs(await collect(reader.read(17, 29))), Array.from({ length: 13 }, (_, index) => index + 17));
  const reopened = await createSessionStore(home, { segmentMaxBytes: 1200 }).openForWrite(writer.sessionId);
  assert.equal((await reopened.append(steer("continues in the last segment"))).seq, 41);
  await reopened.close();
});

test("fork reads the parent up to the fork point, then continues with its own seq", async () => {
  const home = await newHome();
  const store = createSessionStore(home);
  const parent = await store.create(manifest());
  for (let index = 1; index <= 5; index += 1) await parent.append(steer(`parent ${index}`));

  const child = await store.fork(parent.sessionId, 3);
  assert.notEqual(child.sessionId, parent.sessionId);
  assert.equal(child.lastSeq, 3);
  const own = await child.append(steer("child 4"));
  assert.equal(own.seq, 4);
  assert.equal(own.session_id, child.sessionId);
  await parent.append(steer("parent 6 is not inherited"));

  const items = await collect((await store.openForRead(child.sessionId)).read());
  assert.deepEqual(seqs(items), [1, 2, 3, 4]);
  assert.deepEqual(
    items.map((item) => (item.status === "ok" ? item.event.session_id : "")),
    [parent.sessionId, parent.sessionId, parent.sessionId, child.sessionId],
  );
  await child.close();

  const reopened = await createSessionStore(home).openForWrite(child.sessionId);
  assert.equal(reopened.lastSeq, 4);
  await reopened.close();
  await rejectsWith(store.fork(parent.sessionId, 99), "write_failed", /last seq is 6/);
  await parent.close();
});

test("list reports each session's last seq, last event time and lock state", async () => {
  const home = await newHome();
  const clock = clockAt("2026-09-22T10:00:00.000Z");
  const store = createSessionStore(home, { clock: clock.now });
  const open = await store.create({ ...manifest(), created_at: "2026-09-22T10:00:00.000Z" });
  await open.append(steer("one"));
  const closed = await store.create({ ...manifest(), created_at: "2026-09-22T11:00:00.000Z" });
  clock.advance(5_000);
  await closed.append(steer("one"));
  await closed.append(steer("two"));
  await closed.close();

  const summaries = await store.list(PROJECT);
  assert.deepEqual(
    summaries.map((summary) => [summary.manifest.session_id, summary.lastSeq, summary.locked]),
    [
      [open.sessionId, 1, true],
      [closed.sessionId, 2, false],
    ],
  );
  assert.equal(summaries[1]?.lastEventAt, "2026-09-22T10:00:05.000Z");
  assert.deepEqual(await store.list(deriveProjectId("/elsewhere", "linux")), []);
  await open.close();
});

test("an existing session cannot be created twice and an unknown session is session_not_found", async () => {
  const store = createSessionStore(await newHome());
  const first = manifest();
  const writer = await store.create(first);
  await rejectsWith(store.create(first), "write_failed", /already exists/);
  await rejectsWith(store.openForRead(createId("session")), "session_not_found");
  await rejectsWith(store.openForWrite(createId("session")), "session_not_found");
  await rejectsWith(store.create({ ...manifest(), project_id: "Not A Project" as typeof PROJECT }), "write_failed", /invalid session manifest/);
  await writer.close();
});

test("an invalid or smuggled draft is rejected without consuming a seq", async () => {
  const writer = await createSessionStore(await newHome()).create(manifest());
  await rejectsWith(writer.append({ ...steer("x"), data: { text: "x", grant_write: true } } as unknown as SessionEventDraft), "write_failed", /rejected/);
  await rejectsWith(writer.append({ ...steer("x"), event_version: 2 } as SessionEventDraft), "write_failed", /unsupported/);
  const forged = await writer.append({ ...steer("forged"), seq: 99, session_id: createId("session") } as unknown as SessionEventDraft);
  assert.equal(forged.seq, 1, "the store assigns identity and order");
  assert.equal(forged.session_id, writer.sessionId);
  await writer.close();
  await rejectsWith(writer.append(steer("closed")), "write_failed", /closed/);
});

function runNode(script: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`))));
  });
}
