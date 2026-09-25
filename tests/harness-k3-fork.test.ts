import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createId,
  deriveProjectId,
  workspaceDigest,
  type BlobRef,
  type SessionEvent,
  type SessionEventDraft,
} from "../src/harness/contracts/index.ts";
import { createSessionStore } from "../src/harness/store/index.ts";
import { applyRestore, planRestore, rewindPoints, type RestoreIO } from "../src/harness/cli/rewind.ts";
import { commitSelected, uncommittedChanges } from "../src/harness/cli/session-git.ts";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const draft = (type: SessionEventDraft["type"], data: unknown, user = false): SessionEventDraft =>
  ({ type, event_version: 1, actor: user ? { kind: "user" } : { kind: "agent", role: "session" }, data }) as SessionEventDraft;

const userTurn = (text: string): SessionEventDraft[] => [
  draft("turn/started", { turn_id: createId("turn"), trigger: "user" }),
  draft("message/recorded", { role: "user", message: { role: "user", content: [{ type: "text", text: `[Synorch note: resumed]\n${text}` }] } }, true),
  draft("message/recorded", { role: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer to ${text}` }] } }),
];

test("rewind forks from just before a message: the fork replays the parent prefix only", async () => {
  const home = await tempDir("synorch-k3-");
  const store = createSessionStore(home);
  const parent = await store.create({
    session_id: createId("session"),
    project_id: deriveProjectId("/work/app", "linux"),
    workspace_root: "/work/app",
    created_at: new Date().toISOString(),
    title: "chat: first",
  });
  for (const entry of [...userTurn("first"), ...userTurn("second"), ...userTurn("third")]) await parent.append(entry);
  const events: SessionEvent[] = [];
  for await (const item of parent.read()) if (item.status === "ok") events.push(item.event);

  const points = rewindPoints(events);
  assert.deepEqual(points.map((point) => point.text), ["first", "second", "third"]);
  const second = points[1];
  assert.ok(second !== undefined);
  assert.equal(second.forkSeq, 3);

  const child = await store.fork(parent.sessionId, second.forkSeq, { title: "chat: branch" });
  await child.append(draft("steer/queued", { text: "own" }, true));
  await child.close();
  await parent.append(draft("steer/queued", { text: "parent later" }, true));

  const replayed: SessionEvent[] = [];
  for await (const item of (await store.openForRead(child.sessionId)).read()) if (item.status === "ok") replayed.push(item.event);
  assert.deepEqual(replayed.map((event) => event.seq), [1, 2, 3, 4]);
  assert.deepEqual(rewindPoints(replayed).map((point) => point.text), ["first"]);
  assert.equal(replayed.at(-1)?.session_id, child.sessionId);

  const listed = (await store.list(deriveProjectId("/work/app", "linux"))).find((summary) => summary.manifest.session_id === child.sessionId);
  assert.equal(listed?.manifest.title, "chat: branch");
  assert.deepEqual(listed?.manifest.parent, { session_id: parent.sessionId, up_to_seq: 3 });
  await parent.close();
});

test("rewind restore only reverts files Synorch changed and keeps files the user changed since", async () => {
  const root = await tempDir("synorch-k3-ws-");
  const blobs = new Map<string, Uint8Array>();
  const put = (text: string): BlobRef => {
    const bytes = new TextEncoder().encode(text);
    const digest = workspaceDigest(bytes);
    blobs.set(digest, bytes);
    return { digest, size_bytes: bytes.byteLength, media_type: "application/octet-stream" };
  };
  const digest = (text: string) => workspaceDigest(new TextEncoder().encode(text));
  await writeFile(path.join(root, "a.txt"), "a2");
  await writeFile(path.join(root, "b.txt"), "b1-user-edit");
  await writeFile(path.join(root, "new.txt"), "created");
  const checkpoint = (seq: number, files: unknown[]): SessionEvent =>
    ({ seq, type: "checkpoint/recorded", data: { tool_call_id: "call-1", files } }) as unknown as SessionEvent;
  const events: SessionEvent[] = [
    checkpoint(2, [{ path: "old.txt", before: put("x"), after: digest("y") }]),
    checkpoint(5, [{ path: "a.txt", before: put("a0"), after: digest("a1") }, { path: "b.txt", before: put("b0"), after: digest("b1") }]),
    checkpoint(7, [{ path: "a.txt", before: put("a1"), after: digest("a2") }, { path: "new.txt", before: null, after: digest("created") }]),
  ];
  const plan = planRestore(events, 4);
  assert.deepEqual(plan.files.map((file) => file.path).sort(), ["a.txt", "b.txt", "new.txt"]);
  const io: RestoreIO = {
    resolve: (relative) => path.join(root, relative),
    read: (absolute) => readFile(absolute).then((bytes) => new Uint8Array(bytes), () => undefined),
    write: (absolute, bytes) => writeFile(absolute, bytes),
    remove: (absolute) => rm(absolute),
    blob: async (ref) => blobs.get(ref.digest) ?? new Uint8Array(),
  };
  const result = await applyRestore(plan, io);
  assert.deepEqual([...result.restored].sort(), ["a.txt", "new.txt"]);
  assert.deepEqual(result.skipped.map((entry) => entry.path), ["b.txt"]);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "a0");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "b1-user-edit");
  await assert.rejects(readFile(path.join(root, "new.txt")));
});

test("/commit selection commits only the chosen files", async (t) => {
  const repo = await tempDir("synorch-k3-git-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-q");
  } catch {
    t.skip("git is not available");
    return;
  }
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "keep.txt"), "base");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  await writeFile(path.join(repo, "keep.txt"), "changed");
  await writeFile(path.join(repo, "one.txt"), "one");
  await writeFile(path.join(repo, "two.txt"), "two");
  git("add", "two.txt");
  const changes = await uncommittedChanges(repo);
  assert.equal(changes?.files.length, 3);
  const chosen = changes?.files.filter((file) => file.path === "one.txt" || file.path === "keep.txt") ?? [];
  const result = await commitSelected(repo, "feat: selected", chosen);
  assert.ok(result.ok, result.stderr);
  assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").trim().split(/\r?\n/).sort(), ["keep.txt", "one.txt"]);
  const left = await uncommittedChanges(repo);
  assert.deepEqual(left?.files.map((file) => file.path), ["two.txt"]);
});
