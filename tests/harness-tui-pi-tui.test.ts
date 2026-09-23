import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import {
  approvalIdSchema,
  createId,
  sha256,
  type ApprovalRequest,
  type ModelRoute,
  type RenderEvent,
  type SessionEvent,
  type SessionHeaderView,
} from "../src/harness/contracts/index.ts";
import { ChunkedTerminal, PiTuiRenderer, type PiTuiRendererOptions } from "../src/harness/tui/pi-tui-renderer.ts";
import { createPiTuiRenderer, EMERGENCY_RESTORE_SEQUENCE, type GuardProcess } from "../src/harness/tui/index.ts";
import { CONPTY_MAX_WRITE_BYTES } from "../src/harness/tui/output-chunks.ts";

/**
 * AC-4 (I5): the pi-tui renderer renders a stream, survives a resize and draws a tool card inside an
 * `@xterm/headless` virtual terminal, the same technique pi-tui uses for its own tests.
 */

class VirtualTerminal implements Terminal {
  public readonly xterm: InstanceType<typeof xterm.Terminal>;
  public readonly writes: string[] = [];
  public stopped = false;
  private onInput: ((data: string) => void) | undefined;
  private onResize: (() => void) | undefined;

  public constructor(columns: number, rows: number) {
    this.xterm = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 1000 });
  }

  public start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  public stop(): void {
    this.stopped = true;
  }

  public async drainInput(): Promise<void> {}

  public write(data: string): void {
    this.writes.push(data);
    this.xterm.write(data);
  }

  public get columns(): number {
    return this.xterm.cols;
  }

  public get rows(): number {
    return this.xterm.rows;
  }

  public get kittyProtocolActive(): boolean {
    return false;
  }

  public moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    else if (lines < 0) this.write(`\x1b[${-lines}A`);
  }

  public hideCursor(): void {
    this.write("\x1b[?25l");
  }

  public showCursor(): void {
    this.write("\x1b[?25h");
  }

  public clearLine(): void {
    this.write("\x1b[K");
  }

  public clearFromCursor(): void {
    this.write("\x1b[J");
  }

  public clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }

  public setTitle(): void {}

  public setProgress(): void {}

  public type(data: string): void {
    this.onInput?.(data);
  }

  public resize(columns: number, rows: number): void {
    this.xterm.resize(columns, rows);
    this.onResize?.();
  }

  public flush(): Promise<void> {
    return new Promise((resolve) => this.xterm.write("", resolve));
  }

  /** Every line of scrollback plus viewport, right-trimmed. */
  public lines(): string[] {
    const buffer = this.xterm.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    return lines;
  }

  public text(): string {
    return this.lines().join("\n");
  }
}

const HEADER: SessionHeaderView = {
  workspaceRoot: "/work/demo",
  gitBranch: "main",
  policyMode: "autonomous",
  routes: [{ tier: "orchestrator", model: "gpt-5.5", source: "profile" }],
  sandboxEnforcement: "full",
  notices: [],
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
let seq = 0;

function sessionEvent(type: SessionEvent["type"], data: unknown): RenderEvent {
  seq += 1;
  const event = {
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
  } as SessionEvent;
  return { kind: "session-event", event };
}

function renderer(terminal: VirtualTerminal, extra: Partial<PiTuiRendererOptions> = {}): PiTuiRenderer {
  return new PiTuiRenderer({
    color: false,
    policyMode: "ask",
    environment: { platform: "linux", env: {} },
    terminal,
    schedule: () => {},
    drainInputMs: 0,
    ...extra,
  });
}

async function settle(tui: PiTuiRenderer, terminal: VirtualTerminal): Promise<void> {
  tui.flush();
  await terminal.flush();
}

function assertWithinWidth(terminal: VirtualTerminal, tui: PiTuiRenderer): void {
  tui.flush();
  for (const write of terminal.writes) assert.ok(Buffer.byteLength(write, "utf8") <= CONPTY_MAX_WRITE_BYTES, "a write exceeded the ConPTY chunk size");
}

test("pi-tui renderer streams markdown, resizes and draws a tool card in a virtual terminal (AC-4)", async () => {
  const terminal = new VirtualTerminal(80, 24);
  const tui = renderer(terminal);
  await tui.start(HEADER);
  const request = createId("request");

  tui.render(sessionEvent("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  tui.render({ kind: "stream", requestId: request, event: { type: "start", request_id: request, route: ROUTE } });
  for (const piece of ["# Plan\n\n", "Reading the **config** ", "and running ", "the tests.\x1b]52;c;ZXZpbA==\x07\x1b[2J"]) {
    tui.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: piece } });
  }
  await settle(tui, terminal);
  let screen = terminal.text();
  assert.match(screen, /Synorch \/work\/demo main/);
  assert.match(screen, /Plan/);
  assert.match(screen, /Reading the config and running the tests\./);
  assert.doesNotMatch(terminal.writes.join(""), /\x1b\]52/, "OSC 52 from model output must never reach the terminal");

  tui.render({ kind: "stream", requestId: request, event: { type: "tool_call_start", index: 1, provider_call_id: "fc_1", name: "run_tests" } });
  tui.render({ kind: "stream", requestId: request, event: { type: "tool_call_end", index: 1, provider_call_id: "fc_1", name: "run_tests", arguments: { command: "pnpm test" } } });
  const toolCallId = createId("toolCall");
  tui.render(sessionEvent("tool/call_proposed", { tool_call_id: toolCallId, provider_call_id: "fc_1", tool_name: "run_tests", args_digest: sha256("x") }));
  tui.render(sessionEvent("tool/execution_started", { tool_call_id: toolCallId, sandbox_enforcement: "full" }));
  await settle(tui, terminal);
  screen = terminal.text();
  assert.match(screen, /┌ run_tests · running/);
  assert.match(screen, /│ \{"command":"pnpm test"\}/);
  assert.match(screen, /└ sandbox full/);

  tui.render(
    sessionEvent("tool/result_recorded", {
      tool_call_id: toolCallId,
      state: "succeeded",
      result: { status: "ok", text: "42 tests passed\n", truncated: false, redactions: 0 },
      duration_ms: 1234,
    }),
  );
  tui.render({ kind: "status", status: { runId: "run 1", task: "fix", model: "gpt-5.5", step: "3/40", budgetUsed: "$0.12", budgetLimit: "$5", workersRunning: 1, pendingApproval: undefined, lastVerification: "pass" } });
  await settle(tui, terminal);
  screen = terminal.text();
  assert.match(screen, /┌ run_tests · done 1234 ms/);
  assert.match(screen, /└ 42 tests passed/);
  assert.equal(screen.match(/run_tests/g)?.length, 1, "one card follows the call from stream to result");
  assert.match(tui.statusText, /run 1 · fix · gpt-5\.5 · 3\/40 · \$0\.12\/\$5 · 1 worker\(s\) · verify: pass/);

  terminal.resize(40, 20);
  await settle(tui, terminal);
  const narrow = terminal.lines().slice(-20);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 40, `line wider than 40 columns after resize: ${line}`);
  assert.match(terminal.text(), /run_tests · done/);

  terminal.resize(200, 30);
  tui.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: " 漢字 👍 👩‍💻 🇹🇷 é" } });
  await settle(tui, terminal);
  assert.match(terminal.text(), /漢字/);
  assertWithinWidth(terminal, tui);

  tui.render({
    kind: "stream",
    requestId: request,
    event: {
      type: "done",
      stop_reason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "# Plan\n\nAll green." }] },
    },
  });
  tui.render(sessionEvent("turn/ended", { turn_id: createId("turn"), outcome: "completed" }));
  await settle(tui, terminal);
  assert.match(terminal.text(), /All green\./);

  await tui.stop("completed");
  assert.equal(terminal.stopped, true);
});

test("every line stays within the terminal width at 40, 80 and 200 columns with wide characters", async () => {
  for (const columns of [40, 80, 200]) {
    const terminal = new VirtualTerminal(columns, 30);
    const tui = renderer(terminal);
    await tui.start({ ...HEADER, workspaceRoot: `/very/long/${"segment/".repeat(40)}root`, notices: ["ğüşıöç İ 漢字 👍 ".repeat(20)] });
    const request = createId("request");
    tui.render({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: `${"漢字👍 wide text ".repeat(50)}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`ts\nconst x = 1;\n\`\`\`` } });
    tui.render({ kind: "stream", requestId: request, event: { type: "tool_call_start", index: 1, provider_call_id: "fc", name: "write_file" } });
    tui.render({ kind: "stream", requestId: request, event: { type: "tool_call_delta", index: 1, provider_call_id: "fc", arguments_fragment: `{"path":"${"src/".repeat(80)}a.ts"` } });
    await settle(tui, terminal);
    for (const line of terminal.lines()) assert.ok(visibleWidth(line) <= columns, `${columns}: ${line}`);
    await tui.stop("completed");
  }
});

test("large renders are split into ConPTY-safe writes without breaking surrogate pairs", async () => {
  const inner = new VirtualTerminal(120, 40);
  const chunked = new ChunkedTerminal(inner);
  const payload = `${"👍".repeat(5000)}\n${"x".repeat(40000)}`;
  chunked.write(payload);
  assert.ok(inner.writes.length >= 3);
  for (const write of inner.writes) {
    assert.ok(Buffer.byteLength(write, "utf8") <= CONPTY_MAX_WRITE_BYTES);
    assert.doesNotMatch(write, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/, "a surrogate pair was split");
  }
  assert.equal(inner.writes.join(""), payload);
});

test("the approval dialog answers from the keyboard and Esc rejects", async () => {
  const terminal = new VirtualTerminal(80, 24);
  const tui = renderer(terminal);
  await tui.start(HEADER);
  const base: ApprovalRequest = {
    approval_id: approvalIdSchema.parse(createId("approval")),
    run_id: RUN,
    subject_kind: "action",
    subject_digest: sha256("rm build"),
    summary: "Delete the build directory",
    effect: "workspace-write",
    scope: "plan",
    requested_at: "2026-09-22T10:00:00Z",
  };

  const allowed = tui.approvals.request(base, new AbortController().signal);
  await settle(tui, terminal);
  assert.match(terminal.text(), /Approval needed \(action\)/);
  assert.match(terminal.text(), /Allow for this plan/);
  terminal.type("\x1b[B");
  terminal.type("\r");
  const first = await allowed;
  assert.equal(first.outcome, "allowed-for-scope");
  assert.equal(first.decided_by, "user");

  const rejected = tui.approvals.request({ ...base, approval_id: approvalIdSchema.parse(createId("approval")) }, new AbortController().signal);
  await settle(tui, terminal);
  terminal.type("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const second = await rejected;
  assert.equal(second.outcome, "rejected");

  const cancelled = tui.approvals.request({ ...base, approval_id: approvalIdSchema.parse(createId("approval")) }, new AbortController().signal);
  await settle(tui, terminal);
  terminal.type("\x03");
  const third = await cancelled;
  assert.equal(third.outcome, "cancelled");
  assert.equal(third.decided_by, "broker");
  await tui.stop("completed");
});

test("T1 the workspace-trust dialog offers Not now (pre-selected), session-only and persistent trust", async () => {
  const terminal = new VirtualTerminal(100, 30);
  const tui = renderer(terminal);
  await tui.start(HEADER);
  const request = (): ApprovalRequest => ({
    approval_id: approvalIdSchema.parse(createId("approval")),
    run_id: RUN,
    subject_kind: "workspace-trust",
    subject_digest: sha256("trust"),
    summary: "Trust /repo?",
    scope: "once",
    requested_at: "2026-09-22T10:00:00Z",
  });

  const enter = tui.approvals.request(request(), new AbortController().signal);
  await settle(tui, terminal);
  const text = terminal.text();
  assert.match(text, /Trust this workspace\?/);
  assert.match(text, /Not now/);
  assert.match(text, /Trust for this session only/);
  assert.match(text, /Trust this workspace\b/);
  assert.doesNotMatch(text, /Allow once/);
  assert.ok(text.indexOf("Not now") < text.indexOf("Trust for this session only"), "Not now is listed first");
  terminal.type("\r");
  assert.equal((await enter).outcome, "rejected", "Enter on the pre-selected item is Not now");

  const session = tui.approvals.request(request(), new AbortController().signal);
  await settle(tui, terminal);
  terminal.type("\x1b[B");
  terminal.type("\r");
  assert.equal((await session).outcome, "allowed-once");

  const persist = tui.approvals.request(request(), new AbortController().signal);
  await settle(tui, terminal);
  terminal.type("\x1b[B");
  terminal.type("\x1b[B");
  terminal.type("\r");
  const persisted = await persist;
  assert.equal(persisted.outcome, "allowed-for-scope");
  assert.equal(persisted.decided_by, "user");
  await tui.stop("completed");
});

test("Ctrl+C cancels the active request, then offers a safe exit, then exits; Esc only cancels", async () => {
  const terminal = new VirtualTerminal(80, 24);
  let clock = 0;
  let interrupts = 0;
  let exits = 0;
  const tui = renderer(terminal, { now: () => clock, onInterrupt: () => (interrupts += 1), onExit: () => (exits += 1) });
  await tui.start(HEADER);

  tui.render(sessionEvent("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  await settle(tui, terminal);
  const next = tui.input.next(new AbortController().signal);
  terminal.type("\x03");
  assert.deepEqual(await next, { kind: "interrupt" });
  assert.equal(interrupts, 1);

  terminal.type("\x03");
  clock += 500;
  await settle(tui, terminal);
  assert.match(terminal.text(), /Press Ctrl\+C again to exit safely/);
  assert.equal(exits, 0);
  terminal.type("\x03");
  assert.equal(exits, 1);
  assert.deepEqual(await tui.input.next(new AbortController().signal), { kind: "exit" });

  tui.render(sessionEvent("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  tui.flush();
  terminal.type("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(interrupts, 2, "Esc cancels an active request");
  terminal.type("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(exits, 1, "Esc never exits");
  await tui.stop("completed");
});

test("submitted text and slash commands reach the input source; Ctrl+C clears a draft first", async () => {
  const terminal = new VirtualTerminal(80, 24);
  const tui = renderer(terminal);
  await tui.start(HEADER);
  const first = tui.input.next(new AbortController().signal);
  for (const character of "hello") terminal.type(character);
  terminal.type("\r");
  assert.deepEqual(await first, { kind: "message", text: "hello" });

  for (const character of "/plan") terminal.type(character);
  terminal.type("\r");
  assert.deepEqual(await tui.input.next(new AbortController().signal), { kind: "command", text: "/plan" });

  for (const character of "draft") terminal.type(character);
  terminal.type("\x03");
  await settle(tui, terminal);
  assert.doesNotMatch(terminal.lines().slice(-4).join("\n"), /draft/);
  await tui.stop("completed");
});

test("secret prompts are masked and notices can require acknowledgement", async () => {
  const terminal = new VirtualTerminal(80, 24);
  const tui = renderer(terminal);
  await tui.start(HEADER);
  const secret = tui.auth.promptSecret("OpenAI API key", new AbortController().signal);
  for (const character of "sk-live-123") terminal.type(character);
  await settle(tui, terminal);
  assert.doesNotMatch(terminal.text(), /sk-live-123/);
  assert.match(terminal.text(), /OpenAI API key: •{11}/);
  terminal.type("\r");
  assert.equal(await secret, "sk-live-123");

  const acknowledged = tui.auth.acknowledge({ id: "api-key-billing", text: "API keys are billed per token.", requiresAcknowledgement: true }, new AbortController().signal);
  await settle(tui, terminal);
  terminal.type("\r");
  assert.equal(await acknowledged, true);
  await tui.stop("completed");
});

test("the terminal is restored on stop, on crash and on termination signals", async () => {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const fakeProcess: GuardProcess = {
    platform: "win32",
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    removeListener: (event, listener) => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener)),
  };
  const emergency: string[] = [];
  const signals: string[] = [];
  const crashes: unknown[] = [];
  const terminal = new VirtualTerminal(80, 24);
  const tui = renderer(terminal, {
    lifecycle: {
      process: fakeProcess,
      onSignal: (signal) => signals.push(signal),
      onCrash: (error) => crashes.push(error),
      emergencyWrite: (data) => emergency.push(data),
      setRawMode: () => {},
    },
  });
  await tui.start(HEADER);
  for (const event of ["exit", "uncaughtException", "unhandledRejection", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    assert.equal(listeners.get(event)?.length, 1, `${event} is guarded`);
  }
  assert.equal(listeners.get("SIGINT")?.length ?? 0, 0, "raw mode receives Ctrl+C as input, not SIGINT");
  const crash = new Error("boom");
  for (const listener of listeners.get("uncaughtException") ?? []) (listener as (error: unknown) => void)(crash);
  assert.deepEqual(emergency, [EMERGENCY_RESTORE_SEQUENCE]);
  assert.deepEqual(crashes, [crash]);
  assert.equal(terminal.stopped, true);
  for (const listener of listeners.get("SIGTERM") ?? []) (listener as () => void)();
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(emergency.length, 1, "restoration runs once");
  await tui.stop("signal");
  for (const event of ["exit", "uncaughtException", "SIGTERM"]) assert.equal(listeners.get(event)?.length, 0, `${event} hook removed`);
  for (const sequence of ["\x1b[?2004l", "\x1b[<u", "\x1b[>4;0m", "\x1b[?25h", "\x1b[?2026l"]) assert.ok(EMERGENCY_RESTORE_SEQUENCE.includes(sequence));
});

test("the adapter is loaded lazily through the tui entry point", async () => {
  const terminal = new VirtualTerminal(60, 10);
  const tui = await createPiTuiRenderer({ color: false, policyMode: "autonomous", environment: { platform: "linux", env: {} }, terminal, schedule: () => {}, drainInputMs: 0 });
  assert.equal(tui.kind, "tui");
  assert.equal(tui.approvals.availability, "interactive");
  assert.equal(tui.auth.interactive, true);
});
