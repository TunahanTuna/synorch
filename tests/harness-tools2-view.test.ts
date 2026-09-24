import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createId, deriveProjectId, type EventStore, type ModelRequest, type SessionEvent } from "../src/harness/contracts/index.ts";
import { createAgentDriver } from "../src/harness/core/index.ts";
import {
  createLogContextBuilder,
  lazy,
  newRunId,
  RecordingToolGateway,
  ScriptedModelAdapter,
  testCredential,
  testPolicy,
  testRegistry,
  testRoute,
  testRouter,
  textTurn,
  toolTurn,
} from "../src/harness/core/testing.ts";
import { createBlobStore, createSessionStore } from "../src/harness/store/index.ts";
import { ConversationPresenter, GLYPH_SETS, type ConversationItem } from "../src/harness/tui/index.ts";
import { bindBackgroundStatus, renderToolRow } from "../src/harness/tui/tool-row.ts";

const homes: string[] = [];
const stores: EventStore[] = [];
after(async () => {
  await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function imageTurn(adapterId: string): Promise<{ readonly second: ModelRequest | undefined; readonly toolText: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "synorch-k42-img-"));
  homes.push(home);
  const store = await createSessionStore(home).create({ session_id: createId("session"), project_id: deriveProjectId("/workspace", "linux"), workspace_root: "/workspace", created_at: "2026-09-24T10:00:00.000Z" });
  stores.push(store);
  const blobs = createBlobStore(home);
  const blob = await blobs.put(new Uint8Array(PNG_1PX), "image/png");
  let second: ModelRequest | undefined;
  const adapter = new ScriptedModelAdapter([
    lazy((request) => toolTurn(request, [{ id: "call-1", name: "read_file", arguments: { path: "shot.png" } }])),
    lazy((request) => {
      second = request;
      return textTurn(request, "I see a pixel.");
    }),
  ]);
  const registry = testRegistry();
  const gateway = new RecordingToolGateway(store, async () => ({ status: "ok", text: "shot.png · image image/png", truncated: false, redactions: 0, blob }));
  const driver = createAgentDriver({ events: store, blobs, router: testRouter(adapter), context: createLogContextBuilder(store, blobs, registry), tools: registry, gateway, credentials: async () => testCredential() });
  const runId = newRunId();
  const route = { ...testRoute("model"), adapter_id: adapterId };
  await driver.runTurn(
    { sessionId: store.sessionId, runId, taskId: undefined, attemptId: undefined, role: "implementer", route, policy: testPolicy(runId), packet: undefined, userMessage: "look", trigger: "user", maxSteps: 4 },
    new AbortController().signal,
  );
  const events: SessionEvent[] = [];
  for await (const item of store.read()) if (item.status === "ok") events.push(item.event);
  const toolText = events.flatMap((event) => (event.type === "message/recorded" && event.data.role === "tool" ? (event.data.message?.content ?? []) : [])).flatMap((part) => (part.type === "tool_result" ? [part.text] : [])).join("\n");
  return { second, toolText };
}

test("an image read by a tool reaches an image-capable model as an image part after the results", async () => {
  const { second } = await imageTurn("scripted");
  const last = second?.messages.at(-1);
  assert.equal(last?.role, "user");
  const image = last?.content.find((part) => part.type === "image");
  assert.equal(image?.type === "image" ? image.blob.media_type : undefined, "image/png");
  assert.equal(image?.type === "image" ? image.data : undefined, PNG_1PX.toString("base64"));
});

test("a route without image input gets a note in the tool result instead of the image", async () => {
  const { second, toolText } = await imageTurn("codex-app-server");
  assert.match(toolText, /does not take image input/);
  assert.equal(second?.messages.some((message) => message.content.some((part) => part.type === "image")), false);
});

function toolCallEvent(id: string, name: string, args: Record<string, unknown>, seq: number): SessionEvent {
  return {
    type: "message/recorded",
    seq,
    timestamp: new Date().toISOString(),
    data: { role: "assistant", request_id: `req-${seq}`, message: { role: "assistant", content: [{ type: "tool_call", provider_call_id: `p-${id}`, tool_call_id: id, name, arguments: args }] } },
  } as unknown as SessionEvent;
}

function resultEvent(id: string, text: string, seq: number): SessionEvent {
  return {
    type: "tool/result_recorded",
    seq,
    timestamp: new Date().toISOString(),
    data: { tool_call_id: id, state: "succeeded", duration_ms: 1500, result: { status: "ok", text, truncated: false, redactions: 0 } },
  } as unknown as SessionEvent;
}

test("the todo checklist updates in place within a turn and background exec rows show live status", () => {
  const presenter = new ConversationPresenter({ glyphs: GLYPH_SETS.rich, echoesUser: true });
  const apply = (event: SessionEvent) => presenter.apply({ kind: "session-event", event });
  apply({ type: "turn/started", seq: 1, timestamp: new Date().toISOString(), data: { turn_id: "t", trigger: "user" } } as unknown as SessionEvent);
  const first = apply(toolCallEvent("toolCall_a", "todo", { items: [{ text: "read", status: "in_progress" }, { text: "fix", status: "pending" }] }, 2));
  assert.equal(first[0]?.op, "append");
  const itemId = first[0]?.item.id;
  const second = apply(toolCallEvent("toolCall_b", "todo", { items: [{ text: "read", status: "done" }, { text: "fix", status: "in_progress" }] }, 3));
  assert.equal(second[0]?.op, "update");
  assert.equal(second[0]?.item.id, itemId);
  const done = apply(resultEvent("toolCall_b", "checklist 1/2 done", 4));
  const todo = done[0]?.item as Extract<ConversationItem, { kind: "tool" }>;
  assert.equal(todo.title, "Tasks");
  assert.equal(todo.stat, "1/2 done");
  assert.deepEqual(todo.preview.map((line) => line.text), ["✓ read", "◐ fix"]);
  assert.match(todo.summary ?? "", /\[x\] read; \[>\] fix/);

  apply(toolCallEvent("toolCall_c", "exec", { argv: ["pnpm", "dev"], background: true, name: "dev server" }, 5));
  const started = apply(resultEvent("toolCall_c", "p1 · dev server (pnpm dev) · running · 1s · pid 42\nstarted in the background as p1\noutput 0-5 · next read: since=5\nready", 6));
  const row = started[0]?.item as Extract<ConversationItem, { kind: "tool" }>;
  assert.equal(row.title, "dev server (pnpm dev)");
  assert.equal(row.background?.handle, "p1");
  const paint = { ok: (s: string) => s, fail: (s: string) => s, warn: (s: string) => s, running: (s: string) => s, dim: (s: string) => s, bold: (s: string) => s };
  const render = () => renderToolRow(row, { width: 100, glyphs: GLYPH_SETS.rich, paint, expanded: false, gap: false, measure: (s) => s.length, fit: (s) => s })[0] ?? "";
  const unbind = bindBackgroundStatus(() => ({ running: true, startedAt: Date.now() - 12_000, endedAt: undefined, ended: undefined }));
  assert.equal(render(), "◌ dev server (pnpm dev)  running · 12s · p1");
  unbind();
  const unbindEnded = bindBackgroundStatus(() => ({ running: false, startedAt: Date.now() - 34_000, endedAt: Date.now(), ended: "exited 1" }));
  assert.equal(render(), "✗ dev server (pnpm dev)  exited 1 · 34s · p1");
  unbindEnded();
});
