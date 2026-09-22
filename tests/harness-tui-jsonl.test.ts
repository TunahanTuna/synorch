import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalIdSchema,
  createId,
  EXIT_CODES,
  HarnessError,
  jsonlFrameSchema,
  sha256,
  splitJsonlLines,
  validateFrameSequence,
  type ApprovalRequest,
  type JsonlFrame,
  type RenderEvent,
  type SessionEvent,
  type SessionHeaderView,
} from "../src/harness/contracts/index.ts";
import { approvalFailure, failureInfo } from "../src/harness/cli/index.ts";
import { JsonlRenderer, type JsonlRendererOptions } from "../src/harness/tui/index.ts";

/**
 * I5 JSONL renderer: stdout carries only valid frames (AC-2) and headless outcomes end with the
 * contract's exit codes (AC-3).
 */

const HEADER: SessionHeaderView = { workspaceRoot: "/w", gitBranch: undefined, policyMode: "autonomous", routes: [], sandboxEnforcement: "full", notices: [] };
const RUN = createId("run");
const SESSION = createId("session");

class Sink {
  public readonly chunks: string[] = [];
  public accept = true;
  private drainListener: (() => void) | undefined;

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.accept;
  }

  public once(_event: "drain", listener: () => void): void {
    this.drainListener = listener;
  }

  public drain(): void {
    this.accept = true;
    const listener = this.drainListener;
    this.drainListener = undefined;
    listener?.();
  }

  public get text(): string {
    return this.chunks.join("");
  }
}

function setup(overrides: Partial<JsonlRendererOptions> = {}) {
  const stdout = new Sink();
  const stderr: string[] = [];
  const renderer = new JsonlRenderer({
    runId: RUN,
    sessionId: SESSION,
    policyMode: "autonomous",
    streamDeltas: false,
    harnessVersion: "0.4.0",
    stdout,
    stderr: (text) => stderr.push(text),
    clock: () => new Date("2026-09-22T10:00:00.000Z"),
    schedule: () => {},
    ...overrides,
  });
  return { renderer, stdout, stderr };
}

function frames(text: string): JsonlFrame[] {
  const { lines, rest } = splitJsonlLines(text);
  assert.equal(rest, "", "stdout ends with a LF");
  return lines.map((line) => jsonlFrameSchema.parse(JSON.parse(line)));
}

let seq = 0;
function event(type: SessionEvent["type"], data: unknown): RenderEvent {
  seq += 1;
  return {
    kind: "session-event",
    event: {
      schema_version: 1,
      event_id: createId("event"),
      session_id: SESSION,
      seq,
      event_version: 1,
      timestamp: "2026-09-22T10:00:00Z",
      actor: { kind: "orchestrator", role: "orchestrator" },
      run_id: RUN,
      type,
      data,
    } as SessionEvent,
  };
}

test("stdout holds only schema-valid frames: hello first, dense seq, one terminal frame last, LF only (AC-2)", async () => {
  const { renderer, stdout, stderr } = setup();
  await renderer.start(HEADER);
  renderer.render(event("run/state_changed", { from: "created", to: "running", reason: "plan approved" }));
  renderer.render({ kind: "notice", level: "warning", message: "sandbox is partial" });
  renderer.render({ kind: "status", status: { runId: undefined, task: undefined, model: undefined, step: "1", budgetUsed: undefined, budgetLimit: undefined, workersRunning: 0, pendingApproval: undefined, lastVerification: undefined } });
  renderer.render({ kind: "stream", requestId: "req", event: { type: "text_delta", index: 0, text: "hidden without --stream-deltas" } });
  await renderer.result({ status: "succeeded", exit_code: 0, summary: "done", tasks: [] });
  renderer.render(event("run/state_changed", { from: "running", to: "completed", reason: "late" }));
  await renderer.result({ status: "failed", exit_code: 5, summary: "second result", tasks: [] });
  await renderer.stop("completed");

  const parsed = frames(stdout.text);
  assert.deepEqual(validateFrameSequence(parsed), []);
  assert.deepEqual(parsed.map((frame) => frame.type), ["hello", "event", "result"]);
  assert.doesNotMatch(stdout.text, /\r/);
  assert.doesNotMatch(stdout.text, /\x1b/);
  assert.doesNotMatch(stdout.text, /sandbox is partial|hidden without/);
  assert.deepEqual(stderr, ["warning: sandbox is partial\n"]);
  assert.equal(renderer.exitCode, 0);
});

test("delta frames appear only with --stream-deltas and a U+2028 in model text stays one record", async () => {
  const { renderer, stdout } = setup({ streamDeltas: true });
  await renderer.start(HEADER);
  const request = createId("request");
  renderer.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: "line separator" } });
  renderer.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: " + more" } });
  await renderer.result({ status: "succeeded", exit_code: 0, summary: "ok", tasks: [] });
  const parsed = frames(stdout.text);
  assert.deepEqual(parsed.map((frame) => frame.type), ["hello", "delta", "result"]);
  const delta = parsed[1];
  assert.ok(delta?.type === "delta" && delta.data.type === "text_delta");
  assert.equal(delta.data.text, "line separator + more", "consecutive deltas coalesce, never as cumulative snapshots");
  assert.equal(parsed[0]?.type === "hello" && parsed[0].data.stream_deltas, true);
});

test("an invalid event never reaches stdout; it is reported on stderr and seq stays dense", async () => {
  const { renderer, stdout, stderr } = setup();
  await renderer.start(HEADER);
  renderer.render({ kind: "session-event", event: { type: "log", data: { text: "human text on stdout" } } as unknown as SessionEvent });
  renderer.render(event("steer/queued", { text: "also run lint" }));
  await renderer.result({ status: "succeeded", exit_code: 0, summary: "ok", tasks: [] });
  const parsed = frames(stdout.text);
  assert.deepEqual(validateFrameSequence(parsed), []);
  assert.deepEqual(parsed.map((frame) => frame.seq), [1, 2, 3]);
  assert.match(stderr.join(""), /dropped an invalid event frame/);
});

test("stray writes to the guarded stdout are redirected to stderr until stop", async () => {
  const stderr: string[] = [];
  const written: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      written.push(String(chunk));
      return true;
    },
  };
  const renderer = new JsonlRenderer({
    runId: RUN,
    sessionId: SESSION,
    policyMode: "autonomous",
    streamDeltas: false,
    harnessVersion: "0.4.0",
    stdout: stream,
    guardStdout: stream,
    stderr: (text) => stderr.push(text),
    schedule: () => {},
  });
  await renderer.start(HEADER);
  stream.write("console.log from a dependency\n");
  await renderer.result({ status: "succeeded", exit_code: 0, summary: "ok", tasks: [] });
  await renderer.stop("completed");
  stream.write("after stop\n");
  assert.deepEqual(stderr, ["console.log from a dependency\n"]);
  assert.deepEqual(frames(written.slice(0, 2).join("")).map((frame) => frame.type), ["hello", "result"]);
  assert.equal(written[2], "after stop\n");
});

test("under backpressure only deltas are dropped and the stream stays valid", async () => {
  const { renderer, stdout } = setup({ streamDeltas: true, queueCapacity: 4 });
  await renderer.start(HEADER);
  stdout.accept = false;
  renderer.render(event("run/state_changed", { from: "created", to: "running", reason: "go" }));
  for (let index = 0; index < 20; index += 1) {
    renderer.render({ kind: "stream", requestId: `req-${index}`, event: { type: "text_delta", index: 0, text: `d${index}` } });
    renderer.render(event("steer/queued", { text: `persistent ${index}` }));
  }
  const finished = renderer.result({ status: "succeeded", exit_code: 0, summary: "ok", tasks: [] });
  await new Promise((resolve) => setImmediate(resolve));
  stdout.drain();
  await finished;
  const parsed = frames(stdout.text);
  assert.deepEqual(validateFrameSequence(parsed), []);
  const persistent = parsed.filter((frame) => frame.type === "event" && frame.data.type === "steer/queued");
  assert.equal(persistent.length, 20, "persistent events are never dropped");
  assert.ok(renderer.droppedDeltas > 0, "deltas were dropped");
  assert.ok(parsed.filter((frame) => frame.type === "delta").length < 20);
});

test("stop without a terminal frame writes one: cancelled on a signal, internal otherwise", async () => {
  for (const [reason, code, exit] of [
    ["signal", "cancelled", 130],
    ["error", "internal", 1],
  ] as const) {
    const { renderer, stdout } = setup();
    await renderer.start(HEADER);
    await renderer.stop(reason);
    const parsed = frames(stdout.text);
    assert.deepEqual(validateFrameSequence(parsed), []);
    const last = parsed.at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.data.code, code);
    assert.equal(last.data.exit_code, exit);
    assert.equal(renderer.exitCode, exit);
  }
});

test("a result without a prior start still begins with hello", async () => {
  const { renderer, stdout } = setup();
  await renderer.result({ status: "succeeded", exit_code: 0, summary: "ok", tasks: [] });
  assert.deepEqual(validateFrameSequence(frames(stdout.text)), []);
});

test("headless approval ends with an error frame and exit 3 (AC-3)", async () => {
  const { renderer, stdout } = setup();
  await renderer.start(HEADER);
  const request: ApprovalRequest = {
    approval_id: approvalIdSchema.parse(createId("approval")),
    run_id: RUN,
    subject_kind: "provider-change",
    subject_digest: sha256("switch to paid route"),
    summary: "Switch the complex worker to a metered API route",
    scope: "once",
    requested_at: "2026-09-22T10:00:00Z",
  };
  assert.equal(renderer.approvals.availability, "headless");
  const decision = await renderer.approvals.request(request, new AbortController().signal);
  assert.equal(decision.outcome, "unavailable");
  assert.equal(decision.decided_by, "broker");
  const failure = approvalFailure(decision);
  assert.ok(failure !== undefined);
  await renderer.fail(failure);
  const parsed = frames(stdout.text);
  assert.deepEqual(validateFrameSequence(parsed), []);
  const last = parsed.at(-1);
  assert.ok(last?.type === "error");
  assert.equal(last.data.code, "approval_unavailable");
  assert.equal(last.data.exit_code, EXIT_CODES.approval);
  assert.equal(renderer.exitCode, 3);
});

test("user cancellation exits 130 and a locked session exits 8 (AC-3)", async () => {
  const cases: [unknown, string, number][] = [
    [new DOMException("aborted", "AbortError"), "cancelled", 130],
    [
      new HarnessError({
        code: "session_locked",
        message: "session is held by pid 48122 on dev-laptop",
        ids: { session_id: SESSION },
        workspace_effect: "none",
        retry_safe: true,
        next_command: `syn agent --fork ${SESSION}`,
      }),
      "session_locked",
      8,
    ],
    [new Error("disk full"), "internal", 1],
  ];
  for (const [error, code, exit] of cases) {
    const { renderer, stdout } = setup();
    await renderer.start(HEADER);
    await renderer.fail(failureInfo(error));
    const last = frames(stdout.text).at(-1);
    assert.ok(last?.type === "error");
    assert.equal(last.data.code, code);
    assert.equal(last.data.exit_code, exit);
    assert.equal(renderer.exitCode, exit);
  }
});

test("an EPIPE on stdout stops further writes without throwing", async () => {
  let errorListener: ((error: NodeJS.ErrnoException) => void) | undefined;
  const chunks: string[] = [];
  const renderer = new JsonlRenderer({
    runId: RUN,
    sessionId: SESSION,
    policyMode: "autonomous",
    streamDeltas: false,
    harnessVersion: "0.4.0",
    stdout: {
      write: (chunk) => {
        chunks.push(chunk);
        return true;
      },
      on: (_event, listener) => {
        errorListener = listener;
      },
    },
    stderr: () => {},
    schedule: () => {},
  });
  await renderer.start(HEADER);
  errorListener?.(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  await renderer.result({ status: "succeeded", exit_code: 0, summary: "ok", tasks: [] });
  assert.equal(chunks.length, 1);
  assert.equal(renderer.exitCode, 0);
});
