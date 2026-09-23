import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  approvalIdSchema,
  createId,
  HarnessError,
  sha256,
  type ApprovalRequest,
  type ModelRoute,
  type RenderEvent,
  type SessionEvent,
  type SessionHeaderView,
} from "../src/harness/contracts/index.ts";
import { PlainLineRenderer, type GuardProcess, type PlainLineRendererOptions } from "../src/harness/tui/index.ts";

/**
 * I5 plain renderer: append-only lines for pipes, CI, TERM=dumb and --plain (AC-2), approvals and
 * auth prompts on a line terminal, and the shared Ctrl+C semantics through SIGINT.
 */

const HEADER: SessionHeaderView = {
  workspaceRoot: "/work/demo",
  gitBranch: "main",
  policyMode: "autonomous",
  routes: [{ tier: "orchestrator", model: "gpt-5.5", source: "profile" }],
  sandboxEnforcement: "partial",
  notices: ["sandbox cannot restrict network on this platform"],
};

const ROUTE: ModelRoute = {
  provider_id: "openai" as ModelRoute["provider_id"],
  model_id: "gpt-5.5" as ModelRoute["model_id"],
  adapter_id: "openai-responses",
  adapter_kind: "model",
  auth_method: "api-key",
  profile: "default",
};
const SESSION = createId("session");
const RUN = createId("run");

class FakeInput extends EventEmitter {
  public isTTY: boolean;
  public raw: boolean[] = [];

  public constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  public setRawMode(mode: boolean): void {
    this.raw.push(mode);
  }

  public setEncoding(): void {}
  public resume(): void {}
  public pause(): void {}

  public type(text: string): void {
    this.emit("data", text);
  }
}

function setup(overrides: Partial<PlainLineRendererOptions> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const renderer = new PlainLineRenderer({
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    color: false,
    policyMode: "ask",
    interactive: false,
    environment: { platform: "linux", env: {} },
    schedule: () => {},
    ...overrides,
  });
  return { renderer, out, err, stdout: () => out.join(""), stderr: () => err.join("") };
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

function approval(scope: ApprovalRequest["scope"], expiresAt?: string): ApprovalRequest {
  return {
    approval_id: approvalIdSchema.parse(createId("approval")),
    run_id: RUN,
    subject_kind: "action",
    subject_digest: sha256("x"),
    summary: "Run pnpm install",
    effect: "exec",
    scope,
    requested_at: "2026-09-22T10:00:00Z",
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  };
}

test("plain output is append-only: no cursor movement, no escape bytes without colour (AC-2)", async () => {
  const { renderer, stdout, stderr } = setup();
  await renderer.start(HEADER);
  const request = createId("request");
  renderer.render(event("run/created", { goal: "fix the failing test", policy_mode: "autonomous", headless: true, budget: {} }));
  renderer.render({ kind: "stream", requestId: request, event: { type: "start", request_id: request, route: ROUTE } });
  renderer.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: "Looking at \x1b[2J\x1b]0;pwned\x07the " } });
  renderer.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: "test\r\nfile" } });
  renderer.render({ kind: "stream", requestId: request, event: { type: "tool_call_start", index: 1, provider_call_id: "fc_1", name: "read_file" } });
  renderer.render({ kind: "stream", requestId: request, event: { type: "tool_call_end", index: 1, provider_call_id: "fc_1", name: "read_file", arguments: { path: "a.ts" } } });
  const toolCallId = createId("toolCall");
  renderer.render(event("tool/call_proposed", { tool_call_id: toolCallId, provider_call_id: "fc_1", tool_name: "read_file", args_digest: sha256("a") }));
  renderer.render(event("tool/execution_started", { tool_call_id: toolCallId, sandbox_enforcement: "partial" }));
  renderer.render(event("tool/result_recorded", { tool_call_id: toolCallId, state: "succeeded", result: { status: "ok", text: "12 lines", truncated: false, redactions: 0 }, duration_ms: 7 }));
  renderer.render({
    kind: "stream",
    requestId: request,
    event: { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Looking at the test\nfile and more." }] } },
  });
  renderer.render({ kind: "status", status: { runId: "run 1", task: undefined, model: "gpt-5.5", step: "2", budgetUsed: undefined, budgetLimit: undefined, workersRunning: 0, pendingApproval: undefined, lastVerification: undefined } });
  renderer.render({ kind: "status", status: { runId: "run 1", task: undefined, model: "gpt-5.5", step: "2", budgetUsed: undefined, budgetLimit: undefined, workersRunning: 0, pendingApproval: undefined, lastVerification: undefined } });
  renderer.render({ kind: "notice", level: "warning", message: "budget 80% used" });
  await renderer.stop("completed");

  const text = stdout();
  assert.doesNotMatch(text + stderr(), /\x1b/, "no escape sequence of any kind without colour");
  assert.doesNotMatch(text, /\r/);
  assert.equal(
    text,
    [
      "Synorch /work/demo (main)",
      "Policy: autonomous; sandbox: partial",
      "Route orchestrator: gpt-5.5 (profile)",
      "notice: sandbox cannot restrict network on this platform",
      `Run ${RUN}: fix the failing test`,
      "Looking at the test",
      "file",
      '[tool] read_file proposed {"path":"a.ts"}',
      "[tool] read_file running: sandbox partial",
      "[tool] read_file done in 7 ms: 12 lines",
      " and more.",
      "[status] run run 1 | model gpt-5.5 | step 2",
      "",
    ].join("\n"),
  );
  assert.equal(stderr(), "warning: budget 80% used\n");
});

test("colour, when selected, is SGR only", async () => {
  const { renderer, stdout } = setup({ color: true });
  await renderer.start(HEADER);
  renderer.render(event("run/state_changed", { from: "running", to: "failed", reason: "tests failed" }));
  await renderer.stop("completed");
  const escapes = stdout().match(/\x1b\[[0-9;]*[A-Za-z]/g) ?? [];
  assert.ok(escapes.length > 0);
  for (const escape of escapes) assert.match(escape, /m$/, `non-SGR escape ${JSON.stringify(escape)}`);
  assert.match(stdout(), /warning: Run running -> failed: tests failed/);
});

test("a dropped delta is reconciled from the final message instead of losing text", async () => {
  const { renderer, stdout } = setup({ queueCapacity: 1 });
  await renderer.start({ ...HEADER, notices: [], routes: [] });
  const request = createId("request");
  renderer.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: "alpha " } });
  renderer.render({ kind: "stream", requestId: `${request}-other`, event: { type: "text_delta", index: 0, text: "dropped" } });
  renderer.render({ kind: "stream", requestId: request, event: { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "alpha beta" }] } } });
  await renderer.stop("completed");
  assert.match(stdout(), /alpha beta\n$/);
  assert.doesNotMatch(stdout(), /dropped/);
});

test("without a terminal, approvals are unavailable and secrets are never prompted", async () => {
  const { renderer, stderr } = setup({ input: new FakeInput(false) });
  assert.equal(renderer.approvals.availability, "headless");
  const decision = await renderer.approvals.request(approval("once"), new AbortController().signal);
  assert.equal(decision.outcome, "unavailable");
  assert.equal(renderer.auth.interactive, false);
  await assert.rejects(renderer.auth.promptSecret("API key", new AbortController().signal), (error) => error instanceof HarnessError && error.info.code === "auth_required");
  assert.equal(await renderer.auth.acknowledge({ id: "api-key-billing", text: "Metered billing", requiresAcknowledgement: true }, new AbortController().signal), false);
  assert.equal(await renderer.auth.openBrowser("https://auth.example.com/?a=1&b=2"), false);
  assert.match(stderr(), /Open this URL in a browser: https:\/\/auth\.example\.com\/\?a=1&b=2/);
});

test("an interactive plain terminal asks [y/N]; the default and a timeout refuse", async () => {
  const input = new FakeInput(true);
  const { renderer, stdout } = setup({ input, interactive: true });
  assert.equal(renderer.approvals.availability, "interactive");

  const yes = renderer.approvals.request(approval("once"), new AbortController().signal);
  input.type("y\n");
  assert.equal((await yes).outcome, "allowed-once");
  assert.match(stdout(), /1\. Allow once\n {2}2\. Deny\n {2}3\. Deny and tell Synorch why\nChoose \[1-3\]/);

  const always = renderer.approvals.request(approval("session"), new AbortController().signal);
  input.type("a\r\n");
  assert.equal((await always).outcome, "allowed-for-scope");

  const empty = renderer.approvals.request(approval("once"), new AbortController().signal);
  input.type("\n");
  assert.equal((await empty).outcome, "rejected");

  const expired = await renderer.approvals.request(approval("once", new Date(Date.now() + 20).toISOString()), new AbortController().signal);
  assert.equal(expired.outcome, "expired");
  assert.equal(expired.decided_by, "broker");

  const controller = new AbortController();
  const cancelled = renderer.approvals.request(approval("once"), controller.signal);
  controller.abort();
  assert.equal((await cancelled).outcome, "cancelled");
  await renderer.stop("completed");
});

test("T1 the plain workspace-trust prompt has its own choices and defaults to Not now", async () => {
  const input = new FakeInput(true);
  const { renderer, stdout } = setup({ input, interactive: true });
  const trust = (): ApprovalRequest => ({ ...approval("once"), subject_kind: "workspace-trust", effect: undefined, summary: "Trust /repo?" });

  const empty = renderer.approvals.request(trust(), new AbortController().signal);
  input.type("\n");
  assert.equal((await empty).outcome, "rejected", "Enter alone is Not now");
  assert.match(stdout(), /Trust this workspace\? Trust \/repo\?/);
  assert.match(stdout(), /\[n\] Not now \(default\)\n {2}\[s\] Trust for this session only\n {2}\[t\] Trust this workspace\n/);
  assert.match(stdout(), /Choose \[N\/s\/t\]: /);
  assert.doesNotMatch(stdout(), /Allow\?/);

  const yes = renderer.approvals.request(trust(), new AbortController().signal);
  input.type("y\n");
  assert.equal((await yes).outcome, "rejected", "the generic yes is not an answer to the trust prompt");

  const session = renderer.approvals.request(trust(), new AbortController().signal);
  input.type("s\n");
  assert.equal((await session).outcome, "allowed-once");

  const persist = renderer.approvals.request(trust(), new AbortController().signal);
  input.type("t\r\n");
  const persisted = await persist;
  assert.equal(persisted.outcome, "allowed-for-scope");
  assert.equal(persisted.decided_by, "user");
  await renderer.stop("completed");
});

test("secrets are read in raw mode without echo and notices are acknowledged explicitly", async () => {
  const input = new FakeInput(true);
  const { renderer, stdout, stderr } = setup({ input, interactive: true });
  const secret = renderer.auth.promptSecret("API key", new AbortController().signal);
  input.type("sk-1");
  input.type("23\x7f4\r");
  assert.equal(await secret, "sk-124");
  assert.deepEqual(input.raw, [true, false]);
  assert.doesNotMatch(stdout() + stderr(), /sk-1/);

  const cancelled = renderer.auth.promptSecret("API key", new AbortController().signal);
  input.type("\x03");
  await assert.rejects(cancelled, { name: "AbortError" });

  const ack = renderer.auth.acknowledge({ id: "chatgpt-subscription", text: "Uses your ChatGPT plan", requiresAcknowledgement: true }, new AbortController().signal);
  input.type("yes\n");
  assert.equal(await ack, true);
  await renderer.stop("completed");
});

test("plain input yields messages, commands, interrupts and exit on EOF", async () => {
  const input = new FakeInput(false);
  const { renderer } = setup({ input });
  assert.ok(renderer.input !== undefined);
  const signal = new AbortController().signal;
  const first = renderer.input.next(signal);
  input.type("first goal\n\n/plan\nsecond ");
  assert.deepEqual(await first, { kind: "message", text: "first goal" });
  assert.deepEqual(await renderer.input.next(signal), { kind: "command", text: "/plan" });
  const pending = renderer.input.next(signal);
  renderer.render(event("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  renderer.render({ kind: "notice", level: "info", message: "flush" });
  await new Promise((resolve) => setImmediate(resolve));
  (renderer as unknown as { queue: { flush(): void } }).queue.flush();
  assert.equal(renderer.interrupt("ctrl+c", 0), "cancel-request");
  assert.deepEqual(await pending, { kind: "interrupt" });
  input.type("line with separator\n");
  assert.deepEqual(await renderer.input.next(signal), { kind: "message", text: "second line with separator" });
  input.emit("end");
  assert.deepEqual(await renderer.input.next(signal), { kind: "exit" });
  await renderer.stop("completed");
});

test("SIGINT follows the Ctrl+C semantics and SIGTERM is handed to the caller", async () => {
  const listeners = new Map<string, (() => void)[]>();
  const fakeProcess: GuardProcess = {
    platform: "linux",
    on: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener as () => void]),
    removeListener: (name, listener) => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener)),
  };
  let interrupts = 0;
  let exits = 0;
  const signals: string[] = [];
  const { renderer, stderr, stdout } = setup({
    onInterrupt: () => (interrupts += 1),
    onExit: () => (exits += 1),
    lifecycle: { process: fakeProcess, onSignal: (signal) => signals.push(signal), onCrash: () => {} },
  });
  await renderer.start(HEADER);
  renderer.render(event("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  (renderer as unknown as { queue: { flush(): void } }).queue.flush();
  const sigint = (): void => {
    for (const listener of listeners.get("SIGINT") ?? []) listener();
  };
  sigint();
  assert.equal(interrupts, 1);
  assert.match(stderr(), /warning: Cancelling the active request/);
  sigint();
  assert.match(stdout(), /Press Ctrl\+C again to exit safely/);
  sigint();
  assert.equal(exits, 1);
  for (const listener of listeners.get("SIGTERM") ?? []) listener();
  assert.deepEqual(signals, ["SIGTERM"]);
  await renderer.stop("signal");
  assert.equal(listeners.get("SIGINT")?.length, 0);
});
