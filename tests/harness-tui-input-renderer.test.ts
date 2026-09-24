import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";
import { approvalIdSchema, createId, sha256, type ApprovalRequest, type Attachment, type SessionHeaderView } from "../src/harness/contracts/index.ts";
import { PiTuiRenderer, type PiTuiRendererOptions } from "../src/harness/tui/pi-tui-renderer.ts";
import { WorkspaceFileIndex } from "../src/harness/tui/input/file-index.ts";

/** K1-U1: palette, plan mode, image paste, model picker and mouse mode inside a virtual terminal. */

class VirtualTerminal implements Terminal {
  public readonly xterm: InstanceType<typeof xterm.Terminal>;
  public readonly writes: string[] = [];
  private onInput: ((data: string) => void) | undefined;

  public constructor(columns: number, rows: number) {
    this.xterm = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 1000 });
  }

  public start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }

  public stop(): void {}
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

  public hideCursor(): void {}
  public showCursor(): void {}
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

  public text(): Promise<string> {
    return new Promise((resolve) =>
      this.xterm.write("", () => {
        const buffer = this.xterm.buffer.active;
        const lines: string[] = [];
        for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
        resolve(lines.join("\n"));
      }),
    );
  }
}

const HEADER: SessionHeaderView = {
  workspaceRoot: "/repo",
  gitBranch: "main",
  policyMode: "autonomous",
  routes: [],
  sandboxEnforcement: "full",
  notices: [],
  version: "0.9",
  model: "gpt-6-sol",
};

const tick = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function open(extra: Partial<PiTuiRendererOptions> = {}): Promise<{ tui: PiTuiRenderer; terminal: VirtualTerminal }> {
  const terminal = new VirtualTerminal(100, 30);
  const tui = new PiTuiRenderer({
    color: false,
    policyMode: "autonomous",
    environment: { platform: "linux", env: {} },
    terminal,
    schedule: () => {},
    drainInputMs: 0,
    view: "conversation",
    fileIndex: new WorkspaceFileIndex({ root: "/repo", lister: async () => ["src/app.ts", "README.md"] }),
    ...extra,
  });
  await tui.start(HEADER);
  return { tui, terminal };
}

async function screen(tui: PiTuiRenderer, terminal: VirtualTerminal): Promise<string> {
  tui.flush();
  return terminal.text();
}

test("typing / opens the palette; Enter on a command with a required argument completes it", async () => {
  const { tui, terminal } = await open();
  const next = tui.input.next(new AbortController().signal);
  terminal.type("/");
  terminal.type("p");
  terminal.type("l");
  await tick();
  const shown = await screen(tui, terminal);
  assert.match(shown, /\/plan <goal>\s+plan a large goal/);
  terminal.type("\r");
  await tick();
  for (const char of "ship it") terminal.type(char);
  terminal.type("\r");
  assert.deepEqual(await next, { kind: "command", text: "/plan ship it" });
  await tui.stop("completed");
});

test("Shift+Tab cycles ask -> auto -> full -> plan in the footer and notifies the session", async () => {
  const { tui, terminal } = await open();
  const seen: string[] = [];
  tui.controls.onPermissionModeChange((mode) => seen.push(mode));
  assert.equal(tui.controls.permissionMode, "auto");
  terminal.type("\x1b[Z");
  assert.equal(tui.controls.permissionMode, "full");
  assert.match(await screen(tui, terminal), /gpt-6-sol · full access/);
  terminal.type("\x1b[Z");
  assert.match(await screen(tui, terminal), /gpt-6-sol · plan mode/);
  terminal.type("\x1b[Z");
  terminal.type("\x1b[Z");
  assert.deepEqual(seen, ["full", "plan", "ask", "auto"]);
  await tui.stop("completed");
});

test("an image pasted from the clipboard becomes a chip and travels with the message", async () => {
  const image = { path: "/tmp/synorch-images/1.png", mediaType: "image/png", bytes: 1234 };
  const { tui, terminal } = await open({ readClipboardImage: async () => image });
  const attached: Attachment[] = [];
  tui.controls.onAttachment((attachment) => attached.push(attachment));
  const next = tui.input.next(new AbortController().signal);
  for (const char of "what is") terminal.type(char);
  terminal.type("\x1b[200~\x1b[201~"); // empty bracketed paste: the clipboard holds an image
  await tick();
  assert.match(await screen(tui, terminal), /what is \[image 1\]/);
  terminal.type("\r");
  const result = await next;
  assert.equal(result.kind, "message");
  assert.ok("text" in result && result.text === "what is [image 1]");
  assert.ok("attachments" in result);
  assert.deepEqual(result.attachments?.map((item) => [item.kind, item.label, item.path, item.temporary]), [["image", "[image 1]", image.path, true]]);
  assert.equal(attached.length, 1);
  await tui.stop("completed");
});

test("the model picker marks the current route and resolves with the chosen row", async () => {
  const { tui, terminal } = await open();
  const picked = tui.controls.openModelPicker([
    { id: "a", tier: "session", provider: "openai", model: "gpt-6-sol", auth: "oauth", current: true },
    { id: "b", tier: "session", provider: "anthropic", model: "opus-5.5", auth: "api-key", current: false },
  ]);
  const shown = await screen(tui, terminal);
  assert.match(shown, /Select model/);
  assert.match(shown, /session\s+openai\/gpt-6-sol\s+oauth · current/);
  terminal.type("\x1b[B");
  terminal.type("\r");
  assert.equal((await picked)?.id, "b");
  await tui.stop("completed");
});

test("/mouse enables SGR reporting; wheel reports never reach the editor", async () => {
  const { tui, terminal } = await open();
  for (const char of "/mouse") terminal.type(char);
  terminal.type("\x1b"); // close the palette
  terminal.type("\r");
  assert.equal(tui.controls.mouseMode, true);
  assert.ok(terminal.writes.some((write) => write.includes("\x1b[?1006h")));
  terminal.type("\x1b[<64;5;5M");
  terminal.type("\x1b[<65;5;5M");
  const shown = await screen(tui, terminal);
  assert.doesNotMatch(shown, /\[<6/);
  assert.match(shown, /mouse/);
  tui.controls.setMouseMode(false);
  assert.ok(terminal.writes.some((write) => write.includes("\x1b[?1006l")));
  await tui.stop("completed");
});

test("K5: a choice question owns the input; number keys answer it and nothing reaches the conversation", async () => {
  const { tui, terminal } = await open();
  let delivered = false;
  void tui.input.next(new AbortController().signal).then(() => (delivered = true));
  const answer = tui.controls.ask("Write the Synorch structure into this repository?", ["Create the files", "Cancel"]);
  const shown = await screen(tui, terminal);
  assert.match(shown, /\? Write the Synorch structure into this repository\?/);
  assert.match(shown, /1\. Create the files/);
  terminal.type("1");
  assert.equal(await answer, "Create the files");
  terminal.type("\r");
  await tick();
  assert.equal(delivered, false, "the answer never becomes a message");
  assert.doesNotMatch(await screen(tui, terminal), /^\s*> 1\s*$/m);
  await tui.stop("completed");
});

test("K5: a text question takes typed text and Enter; Esc on a choice cancels", async () => {
  const { tui, terminal } = await open();
  let delivered = false;
  void tui.input.next(new AbortController().signal).then(() => (delivered = true));
  const typed = tui.controls.ask("Type the commit message", undefined);
  for (const char of "fix it") terminal.type(char);
  terminal.type("\r");
  assert.equal(await typed, "fix it");
  const choice = tui.controls.ask("Remember this?", ["Accept", "Reject"]);
  terminal.type("\x1b[B");
  terminal.type("\r");
  assert.equal(await choice, "Reject");
  const cancelled = tui.controls.ask("Remember this?", ["Accept", "Reject"]);
  terminal.type("\x1b");
  await tick(80);
  assert.equal(await cancelled, undefined);
  await tick();
  assert.equal(delivered, false);
  await tui.stop("completed");
});

test("K5: an approval opened over a question stacks on it; the question comes back unanswered", async () => {
  const { tui, terminal } = await open({ policyMode: "ask" });
  const question = tui.controls.ask("Which folder?", ["docs", "src"]);
  const request: ApprovalRequest = {
    approval_id: approvalIdSchema.parse(createId("approval")),
    subject_kind: "action",
    subject_digest: sha256("edit"),
    summary: "apply_patch [workspace-write] write src/add.mjs",
    effect: "workspace-write",
    scope: "once",
    requested_at: "2026-09-24T10:00:00Z",
  };
  const approval = tui.approvals.request(request, new AbortController().signal);
  assert.match(await screen(tui, terminal), /3\. Deny/);
  terminal.type("3");
  assert.equal((await approval).outcome, "rejected");
  assert.match(await screen(tui, terminal), /\? Which folder\?/);
  terminal.type("2");
  assert.equal(await question, "src");
  await tui.stop("completed");
});
