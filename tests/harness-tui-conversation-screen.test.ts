import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalIdSchema, createId, sha256, type ApprovalRequest, type RenderEvent, type SessionEvent, type SessionHeaderView } from "../src/harness/contracts/index.ts";
import { GLYPH_SETS } from "../src/harness/tui/conversation-view.ts";
import { PiTuiRenderer, type PiTuiRendererOptions } from "../src/harness/tui/pi-tui-renderer.ts";
import { lineDiff, renderDiff, viewContext } from "../src/harness/tui/views/index.ts";
import { VirtualTerminal } from "./fixtures/ux/capture.ts";

/**
 * Terminal polish (owner brief): screen snapshots of the main conversation view in a virtual
 * terminal — the first screen, compact tool rows with status glyphs and stats, the turn-end result
 * line, the inline approval prompt, and the same screen at 40 columns and with ASCII glyphs.
 */

const HEADER: SessionHeaderView = {
  workspaceRoot: "/work/demo",
  gitBranch: "main",
  policyMode: "autonomous",
  routes: [],
  sandboxEnforcement: "full",
  notices: [],
  version: "0.4.0-beta.1",
  model: "sol-large",
  permissionMode: "auto",
};

let seq = 0;
function event(type: SessionEvent["type"], data: unknown): RenderEvent {
  seq += 1;
  return {
    kind: "session-event",
    event: { schema_version: 1, event_id: createId("event"), session_id: createId("session"), seq, event_version: 1, timestamp: "2026-09-24T10:00:00Z", actor: { kind: "agent", role: "session" }, type, data } as SessionEvent,
  };
}

async function open(columns = 80, rows = 24, extra: Partial<PiTuiRendererOptions> = {}): Promise<{ tui: PiTuiRenderer; terminal: VirtualTerminal }> {
  const terminal = new VirtualTerminal(columns, rows);
  const tui = new PiTuiRenderer({ color: false, policyMode: "autonomous", environment: { platform: "linux", env: {} }, terminal, schedule: () => {}, drainInputMs: 0, view: "conversation", now: () => 1_000, ...extra });
  await tui.start(HEADER);
  return { tui, terminal };
}

async function screen(tui: PiTuiRenderer, terminal: VirtualTerminal): Promise<string> {
  tui.flush();
  return (await terminal.viewport()).replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

const PATCH = "*** Begin Patch\n*** Update File: src/add.mjs\n@@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch";

function toolCall(name: string, args: Record<string, unknown>): { id: string; event: RenderEvent } {
  const id = createId("toolCall");
  return { id, event: event("message/recorded", { role: "assistant", message: { role: "assistant", content: [{ type: "tool_call", provider_call_id: `fc_${id.slice(-4)}`, tool_call_id: id, name, arguments: args }] } }) };
}

function finished(id: string, result: Record<string, unknown>): RenderEvent {
  return event("tool/result_recorded", { tool_call_id: id, state: "succeeded", result: { status: "ok", truncated: false, redactions: 0, ...result }, duration_ms: 1200 });
}

/** A direct edit turn: read, edit, test, answer. */
function editTurn(tui: PiTuiRenderer): void {
  tui.render(event("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  const read = toolCall("read_file", { path: "src/add.mjs" });
  tui.render(read.event);
  tui.render(finished(read.id, { text: "src/add.mjs · digest abc · lines 1-3 of 3\n1 export function add(a, b) {\n2   return a - b;\n3 }" }));
  const edit = toolCall("apply_patch", { patch: PATCH });
  tui.render(edit.event);
  tui.render(finished(edit.id, { text: "updated src/add.mjs" }));
  const run = toolCall("exec", { argv: ["node", "--test"] });
  tui.render(run.event);
  tui.render(finished(run.id, { text: "$ node --test\nexit 0\n--- stdout ---\nℹ tests 12\nℹ pass 12\nℹ fail 0\n", exit_code: 0 }));
  tui.render(event("message/recorded", { role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed: `add` subtracted instead of adding." }] } }));
  tui.render(event("turn/ended", { turn_id: createId("turn"), outcome: "completed" }));
}

test("first screen: product and folder above, a prompt with a hint, model and mode in the footer", async () => {
  const { tui, terminal } = await open();
  assert.equal(
    await screen(tui, terminal),
    [
      "Synorch 0.4.0-beta.1 · demo (main)",
      "────────────────────────────────────────────────────────────────────────────────",
      ">  Ask anything or describe a change · / commands · @ files",
      "────────────────────────────────────────────────────────────────────────────────",
      "  demo · main · sol-large · auto mode                                ? shortcuts",
    ].join("\n"),
  );
  await tui.stop("completed");
});

test("a direct edit: status glyphs and stats on one line, the diff preview, and a result line that cites the test run", async () => {
  const { tui, terminal } = await open();
  editTurn(tui);
  const shown = await screen(tui, terminal);
  assert.equal(
    shown.split("\n").slice(1, 11).join("\n"),
    [
      "",
      "✓ Read src/add.mjs  3 lines",
      "✓ Edit src/add.mjs  +1 −1",
      "    −   return a - b;",
      "    +   return a + b;",
      "✓ Run node --test  12 passed · 1.2s",
      "",
      "● Fixed: add subtracted instead of adding.",
      "",
      "✓ Changed src/add.mjs (+1 −1) · Tests: 12 passed · /diff /evidence",
    ].join("\n"),
  );
  assert.doesNotMatch(shown, /tool_|toolCall|\{"|->/, "no ids, JSON or state transitions");
  await tui.stop("completed");
});

test("an edit without a test run says so instead of implying a pass; a failed read keeps its reason", async () => {
  const { tui, terminal } = await open();
  tui.render(event("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  const missing = toolCall("read_file", { path: "missing.mjs" });
  tui.render(missing.event);
  tui.render(event("tool/result_recorded", { tool_call_id: missing.id, state: "failed", result: { status: "error", text: "", truncated: false, redactions: 0, error: { code: "io", message: "ENOENT: no such file or directory, stat 'C:\\tmp\\ws\\missing.mjs'" } }, duration_ms: 3 }));
  const edit = toolCall("apply_patch", { patch: PATCH });
  tui.render(edit.event);
  tui.render(finished(edit.id, { text: "updated src/add.mjs" }));
  tui.render(event("turn/ended", { turn_id: createId("turn"), outcome: "completed" }));
  const shown = await screen(tui, terminal);
  assert.match(shown, /^✗ Read missing\.mjs\n {2}⎿ file not found$/m);
  assert.match(shown, /^! Changed src\/add\.mjs \(\+1 −1\) · Tests: not run · \/diff \/evidence$/m);
  assert.doesNotMatch(shown, /C:\\tmp/);
  await tui.stop("completed");
});

test("the approval prompt replaces the editor inline: the action, its diff, what allowing means, numbered choices", async () => {
  const { tui, terminal } = await open(80, 30, { policyMode: "ask" });
  tui.render(event("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  const edit = toolCall("apply_patch", { patch: PATCH });
  tui.render(edit.event);
  const request: ApprovalRequest = {
    approval_id: approvalIdSchema.parse(createId("approval")),
    subject_kind: "action",
    subject_digest: sha256("edit"),
    summary: "apply_patch [workspace-write] write src/add.mjs",
    effect: "workspace-write",
    scope: "once",
    details: { why: "workspace-write needs your approval", consequence: "changes files in the workspace (/undo reverts Synorch's edits)" },
    requested_at: "2026-09-24T10:00:00Z",
  };
  const answer = tui.approvals.request(request, new AbortController().signal);
  const shown = await screen(tui, terminal);
  const prompt = shown.slice(shown.indexOf("Allow Synorch"));
  assert.equal(
    prompt,
    [
      "Allow Synorch to edit files?",
      "   Edit src/add.mjs  +1 −1",
      "     −   return a - b;",
      "     +   return a + b;",
      "   changes files in the workspace (/undo reverts Synorch's edits)",
      " ❯ 1. Allow once",
      "   2. Allow all edits (switch to auto mode)",
      "   3. Deny",
      "   4. Deny and tell Synorch why",
      "   ↑↓ + Enter · 1-4 · Esc denies",
      "────────────────────────────────────────────────────────────────────────────────",
      "  demo · main · sol-large · auto mode · approval waiting             ? shortcuts",
    ].join("\n"),
  );
  assert.doesNotMatch(shown, /apply_patch|workspace-write needs/, "internal names stay out of the prompt");
  terminal.type("1");
  assert.equal((await answer).outcome, "allowed-once");
  assert.match(await screen(tui, terminal), /> {2}Type to steer Synorch/, "the editor comes back after the answer, saying a message steers the running turn");
  await tui.stop("completed");
});

test("40 columns: rows fit, the footer drops fields instead of cutting the mode; ASCII glyphs stay 7-bit", async () => {
  const narrow = await open(40, 24);
  editTurn(narrow.tui);
  const shown = await screen(narrow.tui, narrow.terminal);
  for (const line of shown.split("\n")) assert.ok([...line].length <= 40, `wider than 40: ${line}`);
  assert.match(shown, /auto mode/);
  assert.doesNotMatch(shown, /auto mo\.\.\.|auto mo…/);
  await narrow.tui.stop("completed");

  const ascii = await open(80, 24, { glyphs: GLYPH_SETS.ascii });
  editTurn(ascii.tui);
  const plain = await screen(ascii.tui, ascii.terminal);
  assert.match(plain, /^\+ Edit src\/add\.mjs {2}\+1 -1$/m);
  assert.match(plain, /^\+ Changed src\/add\.mjs \(\+1 -1\) - Tests: 12 passed - \/diff \/evidence$/m);
  assert.doesNotMatch(plain, /[^\x00-\x7f]/, "ASCII glyph set: no non-ASCII character on screen");
  await ascii.tui.stop("completed");
});

test("/diff view: removals before additions with line numbers and context", () => {
  const diff = lineDiff("a\nb\nc\nd\ne\nf\n", "a\nb\nC\nd\ne\nf\ng\n");
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  const lines = renderDiff({ kind: "diff", files: [{ path: "x.txt", change: "modified", added: diff.added, removed: diff.removed, lines: diff.lines }] }, viewContext({ glyphs: "rich", color: false, width: 60 }));
  assert.deepEqual(lines.slice(1), [
    "1 file changed by Synorch  +2 −1",
    "not independently reviewed · /undo reverts the last edit",
    "",
    "● x.txt  +2 −1",
    "   1   a",
    "   2   b",
    "   3 − c",
    "   3 + C",
    "   4   d",
    "   5   e",
    "   6   f",
    "   7 + g",
  ]);
});

const LONG_PROMPT = "Bana finansla alakalı etkileyici bir landing page yapacaksın. Şirketin amacı da teknik analiz eğitimleri satacak tamam mı? Hayali bir şirket olsun, adını da sen koy; renkler koyu ve premium dursun 📈.";
const GOAL = "Create a visually striking Turkish-language HTML landing page for a fictional fintech company that sells technical analysis courses, with a premium dark editorial design.";
const OBJECTIVE = "Tek başına açılabilen index.html içinde özgün premium koyu editoryal fintech tasarımını, duyarlı düzeni ve erişilebilir içerik yapısını eksiksiz uygula.";

/** The owner's orchestrated turn (screenshot, 2026-09-25): what the session emits for a background run. */
function orchestratedTurn(tui: PiTuiRenderer, terminal: VirtualTerminal): void {
  terminal.type(LONG_PROMPT);
  terminal.type("\r");
  tui.render(event("turn/started", { turn_id: createId("turn"), trigger: "user" }));
  const run = toolCall("orchestrate", { goal: GOAL, reason: "A complete landing page benefits from coordinated implementation and proportionate independent verification." });
  tui.render(run.event);
  tui.render(finished(run.id, { text: "Started worker run run-1 in the background. The user sees the plan and a live board; the conversation is not blocked.\nGoal: …\nEnd your turn now with one short line to the user." }));
  tui.render(event("message/recorded", { role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hayali bir marka için Türkçe landing page'i worker'lara verdim; bitince sonucu paylaşacağım." }] } }));
  tui.render(event("turn/ended", { turn_id: createId("turn"), outcome: "completed" }));
  tui.render({ kind: "notice", level: "info", message: "● Plan · 1 task · risk standard · starting now" });
  tui.render({ kind: "notice", level: "info", message: `  1. landing-page (implementer): ${OBJECTIVE}` });
  tui.showView({ kind: "delegation", taskKey: "landing-page", role: "implementer", model: "gpt-6-sol", objective: OBJECTIVE });
}

test("owner screen: the user's message, tool headline, plan goal and delegation wrap in full; no ceremony lines", async () => {
  const { tui, terminal } = await open(120, 40);
  orchestratedTurn(tui, terminal);
  const shown = await screen(tui, terminal);
  if (process.env.SYN_PRINT_SCREEN === "1") console.log(shown);
  const rows = shown.split("\n");
  const body = rows.slice(1, rows.findIndex((line) => line.startsWith("──"))).join("\n");
  assert.equal(
    body,
    [
      "",
      "> Bana finansla alakalı etkileyici bir landing page yapacaksın. Şirketin amacı da teknik analiz eğitimleri satacak tamam",
      "  mı? Hayali bir şirket olsun, adını da sen koy; renkler koyu ve premium dursun 📈.",
      "",
      "✓ Workers Create a visually striking Turkish-language HTML landing page for a fictional fintech company that sells",
      "  technical analysis courses, with a premium dark editorial design.",
      "  ⎿ Workers running in background (run-1) · keep chatting · /runs",
      "",
      "● Hayali bir marka için Türkçe landing page'i worker'lara verdim; bitince sonucu paylaşacağım.",
      "● Plan · 1 task · risk standard · starting now",
      "  1. landing-page (implementer): Tek başına açılabilen index.html içinde özgün premium koyu editoryal fintech",
      "     tasarımını, duyarlı düzeni ve erişilebilir içerik yapısını eksiksiz uygula.",
      "→ landing-page (implementer, gpt-6-sol): Tek başına açılabilen index.html içinde özgün premium koyu editoryal fintech",
      "  tasarımını, duyarlı düzeni ve erişilebilir içerik yapısını eksiksiz uygula.",
    ].join("\n"),
  );
  assert.doesNotMatch(shown, /Starting workers|Workers run in the background|Started worker run/);
  assert.doesNotMatch(shown, /\.\.\.|…/, "nothing is cut");
  await tui.stop("completed");
});

test("wrapping follows the width: 40 columns keep every word, the tool headline caps at 3 lines until Ctrl+O", async () => {
  const { tui, terminal } = await open(40, 40);
  orchestratedTurn(tui, terminal);
  const shown = await screen(tui, terminal);
  for (const line of shown.split("\n")) assert.ok([...line].length <= 40, `wider than 40: ${line}`);
  assert.match(shown.replace(/\n +/g, " "), /dursun 📈\./, "the whole prompt is there");
  const head = shown.split("\n").findIndex((line) => line.startsWith("✓ Workers"));
  assert.ok(shown.split("\n")[head + 2]?.endsWith("…"), "headline capped at 3 lines");
  terminal.type("\x0f");
  const expanded = await screen(tui, terminal);
  assert.match(expanded.replace(/\n +/g, " "), /premium dark editorial design\./, "Ctrl+O shows the full headline");
  await tui.stop("completed");
});
