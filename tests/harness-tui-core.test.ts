import assert from "node:assert/strict";
import { test } from "node:test";
import { createId, type RenderEvent } from "../src/harness/contracts/index.ts";
import {
  browserCommand,
  chunkForConPty,
  ConsoleCodepageGuard,
  CONPTY_MAX_WRITE_BYTES,
  formatHarnessError,
  InterruptController,
  installTerminalGuard,
  openBrowser,
  parseCodepage,
  RenderQueue,
  sanitizeInline,
  sanitizeTerminalText,
  type GuardProcess,
} from "../src/harness/tui/index.ts";

/** I5 building blocks shared by the three renderers. */

test("model output cannot smuggle terminal control sequences", () => {
  const hostile = [
    "a\x1b]52;c;ZXZpbA==\x07b",
    "c\x1b]0;title\x1b\\d",
    "e\x1b[2J\x1b[31mf\x1b[0m",
    "g\x1bPq#0;2;0;0;0\x1b\\h",
    "i\x9b2Jj",
    "k\x07\x08\x00l",
  ].join("|");
  assert.equal(sanitizeTerminalText(hostile), "ab|cd|ef|gh|ij|kl");
  assert.equal(sanitizeTerminalText("progress 10%\rprogress 90%\rdone\nnext\r\n"), "done\nnext\n");
  assert.equal(sanitizeTerminalText("tab\tkept, ğüşıöç 漢字 👩‍💻"), "tab\tkept, ğüşıöç 漢字 👩‍💻");
  assert.equal(sanitizeInline("  many\n\nlines  here "), "many lines here");
  assert.equal([...sanitizeInline("👍".repeat(10), 5)].length, 5);
});

test("Ctrl+C: cancel, then offer exit, then exit inside the window; Esc only cancels", () => {
  const controller = new InterruptController(2000);
  assert.equal(controller.press("ctrl+c", 0), "offer-exit", "idle: offer a safe exit");
  assert.equal(controller.press("ctrl+c", 3000), "offer-exit", "outside the window the offer restarts");
  assert.equal(controller.press("ctrl+c", 3500), "exit");

  controller.setActive(true, true);
  assert.equal(controller.press("escape", 0), "cancel-request");
  assert.equal(controller.press("escape", 10), "none", "Esc never offers an exit");
  assert.equal(controller.press("ctrl+c", 20), "offer-exit", "cancellation already requested");
  assert.equal(controller.press("ctrl+c", 30), "exit");

  controller.setActive(true, true);
  assert.equal(controller.press("ctrl+c", 100), "cancel-request");
  controller.setActive(false);
  controller.setActive(true, true);
  assert.equal(controller.press("ctrl+c", 200), "cancel-request", "a new request re-arms cancellation");
});

test("the render queue coalesces deltas and drops only deltas when full", () => {
  const consumed: RenderEvent[] = [];
  const queue = new RenderQueue((event) => consumed.push(event), { capacity: 3, schedule: () => {} });
  const request = createId("request");
  queue.push({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: "a" } });
  queue.push({ kind: "stream", requestId: request, event: { type: "text_delta", index: 0, text: "b" } });
  assert.equal(queue.size, 1, "consecutive deltas coalesce");
  queue.push({ kind: "notice", level: "info", message: "1" });
  queue.push({ kind: "stream", requestId: request, event: { type: "thinking_delta", index: 1, text: "t" } });
  queue.push({ kind: "notice", level: "info", message: "2" });
  queue.push({ kind: "notice", level: "info", message: "3" });
  queue.push({ kind: "stream", requestId: request, event: { type: "tool_call_delta", index: 2, provider_call_id: "c", arguments_fragment: "{" } });
  queue.flush();
  assert.deepEqual(
    consumed.map((event) => (event.kind === "notice" ? event.message : event.kind === "stream" ? event.event.type : event.kind)),
    ["1", "2", "3"],
  );
  assert.equal(queue.dropped, 3);
});

test("ConPTY chunks stay under 16 KiB of UTF-8, prefer LF boundaries and keep surrogates whole", () => {
  assert.deepEqual(chunkForConPty(""), []);
  assert.deepEqual(chunkForConPty("short"), ["short"]);
  const lines = `${"x".repeat(100)}\n`.repeat(400);
  const chunks = chunkForConPty(lines);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk) <= CONPTY_MAX_WRITE_BYTES);
    assert.ok(chunk.endsWith("\n"), "split after a line feed");
  }
  assert.equal(chunks.join(""), lines);
  const emoji = "👩‍💻".repeat(3000);
  const pieces = chunkForConPty(emoji, 1000);
  for (const piece of pieces) {
    assert.ok(Buffer.byteLength(piece) <= 1000);
    assert.doesNotMatch(piece, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
  assert.equal(pieces.join(""), emoji);
});

test("the Windows codepage guard restores a codepage a child changed, and no-ops elsewhere", () => {
  const calls: string[][] = [];
  let current = 65001;
  const run = (args: readonly string[]): string => {
    calls.push([...args]);
    if (args[0] !== undefined) current = Number(args[0]);
    return `Active code page: ${current}\r\n`;
  };
  const guard = new ConsoleCodepageGuard("win32", run);
  guard.start();
  assert.equal(guard.startCodepage, 65001);
  current = 437;
  assert.equal(guard.restore(), true);
  assert.equal(current, 65001);
  assert.equal(guard.restore(), false, "nothing to do when unchanged");
  assert.deepEqual(calls, [[], [], ["65001"], []]);

  const posix = new ConsoleCodepageGuard("linux", () => assert.fail("chcp must not run outside Windows"));
  posix.start();
  assert.equal(posix.restore(), false);
  assert.equal(parseCodepage("Aktif kod sayfası: 857"), 857);
  assert.equal(parseCodepage(undefined), undefined);
});

test("browser launch never uses a shell, never runs over SSH and only opens http(s)", async () => {
  const url = "https://auth.openai.com/authorize?a=1&b=^2|x";
  assert.deepEqual(browserCommand(url, { platform: "win32", env: {} }), { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", new URL(url).href] });
  assert.deepEqual(browserCommand(url, { platform: "darwin", env: {} }), { command: "open", args: [new URL(url).href] });
  assert.equal(browserCommand(url, { platform: "linux", env: {} }), undefined, "no display");
  assert.deepEqual(browserCommand(url, { platform: "linux", env: { DISPLAY: ":0" } })?.command, "xdg-open");
  assert.equal(browserCommand(url, { platform: "darwin", env: { SSH_CONNECTION: "1 2 3 4" } }), undefined);
  assert.equal(browserCommand("file:///etc/passwd", { platform: "darwin", env: {} }), undefined);
  assert.equal(browserCommand("javascript:alert(1)", { platform: "win32", env: {} }), undefined);
  const launched: string[] = [];
  assert.equal(await openBrowser(url, { platform: "darwin", env: {} }, async (command) => (launched.push(command), true)), true);
  assert.deepEqual(launched, ["open"]);
});

test("the terminal guard restores once on exit, crash and signals, then unhooks", () => {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const fakeProcess: GuardProcess = {
    platform: "linux",
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    removeListener: (event, listener) => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener)),
  };
  let restores = 0;
  const signals: string[] = [];
  const guard = installTerminalGuard({
    process: fakeProcess,
    restore: () => (restores += 1),
    onSignal: (signal) => signals.push(signal),
    onCrash: () => {},
    handleSigint: true,
  });
  assert.equal(listeners.get("SIGBREAK"), undefined, "SIGBREAK is Windows-only");
  for (const listener of listeners.get("SIGINT") ?? []) (listener as () => void)();
  assert.equal(restores, 0, "SIGINT is an interrupt, not a shutdown");
  assert.deepEqual(signals, ["SIGINT"]);
  for (const listener of listeners.get("exit") ?? []) (listener as () => void)();
  for (const listener of listeners.get("SIGHUP") ?? []) (listener as () => void)();
  assert.equal(restores, 1);
  guard.release();
  assert.equal(restores, 1);
  for (const [event, registered] of listeners) assert.equal(registered.length, 0, `${event} still hooked`);
});

test("human errors carry what happened, ids, workspace effect, retry safety and the next command", () => {
  assert.equal(
    formatHarnessError({
      code: "session_locked",
      message: "session is held by pid 48122\x1b[2J",
      ids: { session_id: "ses_1" },
      workspace_effect: "none",
      retry_safe: true,
      next_command: "syn agent --fork ses_1",
    }),
    "Error [session_locked]: session is held by pid 48122\n  ids: session_id=ses_1\n  workspace effect: none; retry safe: yes\n  next: syn agent --fork ses_1\n",
  );
});
