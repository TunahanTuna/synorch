import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";
import type { SessionHeaderView } from "../src/harness/contracts/index.ts";
import { GLYPH_SETS } from "../src/harness/tui/conversation-view.ts";
import { PiTuiRenderer } from "../src/harness/tui/pi-tui-renderer.ts";
import { PlainLineRenderer } from "../src/harness/tui/plain-line-renderer.ts";
import { ACTION, BOARD, BOARD_DONE, EVIDENCE, T0, USAGE, WHY } from "./harness-tui-views-fixtures.ts";

/**
 * K1-U3 screen snapshots: the views mounted in the real pi-tui renderer, drawn into an
 * `@xterm/headless` virtual terminal (the technique of harness-tui-pi-tui.test.ts), and the same
 * views through the plain renderer.
 */

class VirtualTerminal implements Terminal {
  public readonly xterm: InstanceType<typeof xterm.Terminal>;
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
  public flush(): Promise<void> {
    return new Promise((resolve) => this.xterm.write("", resolve));
  }
  public text(): string {
    const buffer = this.xterm.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    return lines.join("\n");
  }
}

const HEADER: SessionHeaderView = {
  workspaceRoot: "/work/demo",
  gitBranch: "main",
  policyMode: "autonomous",
  routes: [],
  sandboxEnforcement: "full",
  notices: [],
  version: "0.9",
  model: "astra",
};

async function mounted(columns: number): Promise<{ tui: PiTuiRenderer; terminal: VirtualTerminal; settle: () => Promise<string> }> {
  const terminal = new VirtualTerminal(columns, 40);
  const tui = new PiTuiRenderer({
    color: false,
    policyMode: "autonomous",
    environment: { platform: "linux", env: {} },
    terminal,
    schedule: () => {},
    drainInputMs: 0,
    view: "conversation",
    glyphs: GLYPH_SETS.rich,
    now: () => T0 + 64_000,
  });
  await tui.start(HEADER);
  return {
    tui,
    terminal,
    settle: async () => {
      tui.flush();
      await terminal.flush();
      return terminal.text();
    },
  };
}

test("the live board updates in place, toggles to the graph with g and pins its summary once", async () => {
  const { tui, terminal, settle } = await mounted(80);
  try {
    tui.setBoard(BOARD);
    let screen = await settle();
    assert.match(screen, /● Workers · 4 tasks · 2 running\s+g graph · esc to stop/);
    assert.match(screen, /✓ map-usage\s+explorer\s+luna\s+38 files mapped, 4 use mocks\s+14s/);
    assert.match(screen, /convert-mocks\s+implementer astra editing tests\/http\.test\.ts\s+41s/);

    tui.setBoard({ ...BOARD, tasks: BOARD.tasks.map((task) => (task.key === "convert-mocks" ? { ...task, activity: "editing src/auth/refresh.ts" } : task)) });
    screen = await settle();
    assert.match(screen, /editing src\/auth\/refresh\.ts/);
    assert.doesNotMatch(screen, /editing tests\/http\.test\.ts/, "the row was updated in place, not appended");

    terminal.type("g");
    screen = await settle();
    assert.equal(tui.boardMode, "graph");
    assert.match(screen, /Plan graph · 4 tasks · 3 levels · 2 running\s+g board/);
    assert.match(screen, /╔═+╗/);
    terminal.type("g");
    await settle();
    assert.equal(tui.boardMode, "board");

    tui.setBoard(BOARD_DONE);
    screen = await settle();
    assert.equal(tui.boardMode, undefined);
    assert.equal(screen.match(/Workers · 4 tasks · done in 4m 12s/g)?.length, 1, "the summary is pinned exactly once");
    assert.match(screen, /✓ review-migration reviewer\s+Accepted after 1 revision/);
  } finally {
    await tui.stop("completed");
  }
});

test("cards and the graph are pinned to the transcript and fit a 60-column terminal", async () => {
  const { tui, settle } = await mounted(60);
  try {
    tui.showView(USAGE);
    tui.showView(EVIDENCE);
    tui.showView(ACTION);
    tui.showView(WHY);
    tui.showGraph(BOARD);
    const screen = await settle();
    assert.match(screen, /● Usage · this session · 1h 12m vs today/);
    assert.match(screen, /claude-code 5h\s+█+░+\s+58% resets 14:20/);
    assert.match(screen, /\[✓ independently reviewed\]/);
    assert.match(screen, /╭─ Delete 14 files\? ─+╮/);
    assert.match(screen, /Why was this denied\?/);
    assert.match(screen, /┌ level 1\n\s+│ ✓ map-usage/, "the graph wraps its levels at 60 columns");
    for (const line of screen.split("\n")) assert.ok(line.length <= 60);
  } finally {
    await tui.stop("completed");
  }
});

test("the plain renderer prints the same views as text and board changes as task lines", async () => {
  const out: string[] = [];
  const plain = new PlainLineRenderer({
    stdout: (text) => out.push(text),
    stderr: () => {},
    color: false,
    policyMode: "autonomous",
    interactive: false,
    environment: { platform: "linux", env: {} },
    schedule: () => {},
    view: "conversation",
  });
  plain.setBoard(BOARD);
  plain.setBoard(BOARD_DONE);
  plain.showView(USAGE);
  plain.showGraph(BOARD);
  const text = out.join("");
  assert.match(text, /^workers: 4 tasks - map-usage \(explorer, luna\)/m);
  assert.match(text, /^task 2\/4 convert-mocks: editing tests\/http\.test\.ts$/m);
  assert.match(text, /^workers: done in 4m 12s$/m);
  assert.match(text, /^\* Usage - this session/m);
  assert.match(text, /^\* Plan graph - 4 tasks - 3 levels/m);
  assert.match(text, /^[\x00-\x7f]*$/, "plain ascii output");
  await plain.stop("completed");
});
