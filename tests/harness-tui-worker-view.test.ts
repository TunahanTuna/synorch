import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";
import type { SessionHeaderView } from "../src/harness/contracts/index.ts";
import type { MemorySeam, WorkerAssignmentView, WorkerControl, WorkerSeam, WorkerStreamEvent } from "../src/harness/contracts/views.ts";
import { GLYPH_SETS } from "../src/harness/tui/conversation-view.ts";
import { PiTuiRenderer } from "../src/harness/tui/pi-tui-renderer.ts";
import { PlainLineRenderer } from "../src/harness/tui/plain-line-renderer.ts";
import { BOARD, T0 } from "./harness-tui-views-fixtures.ts";

/** K1.7: select workers on the board / graph, drill into one, talk to it, and the plain snapshot. */

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
  public flush(): Promise<void> {
    return new Promise((resolve) => this.xterm.write("", resolve));
  }
  public screen(): string {
    const buffer = this.xterm.buffer.active;
    const lines: string[] = [];
    for (let index = buffer.baseY; index < buffer.baseY + this.xterm.rows; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
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

const ASSIGNMENT: WorkerAssignmentView = {
  taskKey: "convert-mocks",
  objective: "Replace nock with msw in the HTTP tests",
  owned_paths: ["src/http/**", "tests/http.test.ts"],
  acceptance_criteria: ["all HTTP tests pass", "no nock import remains"],
  verification_commands: ["pnpm test tests/http.test.ts"],
  steering: [{ from: "orchestrator", text: "keep the retry helper" }],
};

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ESC = "\x1b";

/** In-memory fakes of the runtime seam (K1.7-RT implements the real one). */
function fakeSeam(): { seam: WorkerSeam; calls: string[]; emit: (key: string, event: WorkerStreamEvent) => void } {
  const calls: string[] = [];
  const history = new Map<string, WorkerStreamEvent[]>([
    [
      "convert-mocks",
      [
        { kind: "assignment", assignment: ASSIGNMENT },
        { kind: "stream", requestId: "w1", event: { type: "text_delta", index: 0, text: "Reading the HTTP client first." } },
      ],
    ],
  ]);
  const listeners = new Map<string, Set<(event: WorkerStreamEvent) => void>>();
  const control: WorkerControl = {
    message: async (key, text) => void calls.push(`message ${key}: ${text}`),
    pause: async (key) => void calls.push(`pause ${key}`),
    resume: async (key) => void calls.push(`resume ${key}`),
    cancel: async (key) => void calls.push(`cancel ${key}`),
  };
  return {
    calls,
    seam: {
      control,
      stream: {
        subscribe: (key, onEvent) => {
          for (const event of history.get(key) ?? []) onEvent(event);
          const set = listeners.get(key) ?? new Set();
          set.add(onEvent);
          listeners.set(key, set);
          return () => set.delete(onEvent);
        },
      },
    },
    emit: (key, event) => {
      for (const listener of listeners.get(key) ?? []) listener(event);
    },
  };
}

async function mounted(): Promise<{ tui: PiTuiRenderer; terminal: VirtualTerminal; settle: () => Promise<string> }> {
  const terminal = new VirtualTerminal(90, 40);
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
      return terminal.screen();
    },
  };
}

test("↓ selects a task on the board, j/k move, g keeps the selection in the graph and ←/→ cross levels", async () => {
  const { tui, terminal, settle } = await mounted();
  try {
    tui.setBoard(BOARD);
    terminal.type(DOWN);
    let screen = await settle();
    assert.equal(tui.selectedTask, "convert-mocks", "the first running task is selected first");
    assert.match(screen, /↑↓ select · enter open · tab next · g graph · esc back/);
    assert.match(screen, /^› \S convert-mocks/m);
    terminal.type("j");
    assert.equal(tui.selectedTask, "convert-simple");
    terminal.type("k");
    assert.equal(tui.selectedTask, "convert-mocks");

    terminal.type("g");
    screen = await settle();
    assert.equal(tui.boardMode, "graph");
    assert.match(screen, /║›\S convert-mocks/, "the selected node carries the marker");
    assert.match(screen, /Plan graph · 4 tasks · 3 levels · 2 running\s+enter open · g board · esc back/);
    terminal.type(RIGHT);
    assert.equal(tui.selectedTask, "review-migration");
    terminal.type(ESC);
    assert.equal(tui.selectedTask, undefined);
  } finally {
    await tui.stop("completed");
  }
});

test("Enter opens the worker view: assignment, transcript, messages, pause, cancel, tab and esc", async () => {
  const { tui, terminal, settle } = await mounted();
  const { seam, calls, emit } = fakeSeam();
  try {
    tui.connectWorkers(seam);
    tui.showView({ kind: "delegation", taskKey: "convert-mocks", role: "implementer", model: "astra", objective: ASSIGNMENT.objective, assignment: ASSIGNMENT });
    tui.setBoard(BOARD);
    terminal.type(DOWN);
    terminal.type("\r");
    let screen = await settle();
    assert.equal(tui.openWorker, "convert-mocks");
    assert.match(screen, /convert-mocks · implementer · astra · running · 41s/);
    assert.match(screen, /Assignment/);
    assert.match(screen, /objective\s+Replace nock with msw in the HTTP tests/);
    assert.match(screen, /verify\s+\$ pnpm test tests\/http\.test\.ts/);
    assert.match(screen, /steering\s+orchestrator: keep the retry helper/);
    assert.match(screen, /Reading the HTTP client first\./);
    assert.match(screen, /message convert-mocks…/, "the editor placeholder names the worker");
    assert.match(screen, /enter sends to convert-mocks · p pause · x cancel · tab next · esc back/);

    emit("convert-mocks", { kind: "notice", level: "info", message: "worker is running the tests" });
    for (const char of "use msw v2") terminal.type(char);
    terminal.type("\r");
    screen = await settle();
    assert.match(screen, /worker is running the tests/, "live events reach the open view");
    assert.match(screen, /> use msw v2/);
    terminal.type("p");
    terminal.type("x");
    screen = await settle();
    assert.match(screen, /press x again to cancel convert-mocks/);
    terminal.type("x");
    screen = await settle();
    assert.match(screen, /cancelling…/);
    assert.deepEqual(calls, ["message convert-mocks: use msw v2", "pause convert-mocks", "cancel convert-mocks"]);

    terminal.type("\t");
    assert.equal(tui.openWorker, "convert-simple");
    screen = await settle();
    assert.match(screen, /convert-simple · implementer · astra · verifying/);
    terminal.type(ESC);
    screen = await settle();
    assert.equal(tui.openWorker, undefined);
    assert.match(screen, /→ convert-mocks \(implementer, astra\): Replace nock with msw/);
    assert.match(screen, /↳ you → convert-mocks: use msw v2/);
    assert.doesNotMatch(screen, /message convert-mocks…/);
  } finally {
    await tui.stop("completed");
  }
});

test("plain mode prints a worker snapshot and delegation lines", async () => {
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
  const task = BOARD.tasks[1];
  assert.ok(task !== undefined);
  plain.showView({ kind: "delegation", taskKey: "convert-mocks", role: "implementer", model: "astra", objective: ASSIGNMENT.objective });
  plain.showView({
    kind: "worker",
    task,
    events: [
      { kind: "assignment", assignment: ASSIGNMENT },
      { kind: "stream", requestId: "w1", event: { type: "text_delta", index: 0, text: "Reading the HTTP client first." } },
    ],
  });
  const text = out.join("");
  assert.match(text, /^-> convert-mocks \(implementer, astra\): Replace nock with msw/m);
  assert.match(text, /convert-mocks - implementer - astra - running/);
  assert.match(text, /objective\s+Replace nock with msw/);
  assert.match(text, /accept\s+- all HTTP tests pass/);
  assert.match(text, /Reading the HTTP client first\./);
  assert.match(text, /^[\x00-\x7f]*$/, "plain ascii output");
  await plain.stop("completed");
});

test("/memory graph is navigable: arrows move, Enter opens the note card, o opens Obsidian, Esc goes back", async () => {
  const { tui, terminal, settle } = await mounted();
  const calls: string[] = [];
  const seam: MemorySeam = {
    note: async (id) => {
      calls.push(`note ${id}`);
      return { kind: "memory-note", id, noteKind: "decision", status: "accepted", title: "Use pnpm", frontmatter: [["scope", "project"]], body: "We use pnpm everywhere.", relations: [{ direction: "in", type: "supports", id: "evd-lockfile" }], path: "/vault/decisions/dec-pnpm.md" };
    },
    open: async (id) => {
      calls.push(`open ${id}`);
      return `Opened in Obsidian: ${id}`;
    },
  };
  try {
    tui.connectMemory(seam);
    tui.showView({
      kind: "memory-graph",
      nodes: [
        { id: "dec-pnpm", kind: "decision", status: "accepted", title: "Use pnpm" },
        { id: "evd-lockfile", kind: "evidence", status: "verified", title: "Lockfile present" },
      ],
      edges: [{ from: "evd-lockfile", to: "dec-pnpm", type: "supports" }],
      scope: "project demo",
    });
    let screen = await settle();
    assert.match(screen, /arrows\/hjkl move · enter open · o obsidian · esc done/);
    assert.match(screen, /›\S? ?dec-pnpm/);
    terminal.type(RIGHT);
    screen = await settle();
    assert.match(screen, /›\S? ?evd-lockfile/);
    terminal.type("h");
    terminal.type("\r");
    await new Promise((resolve) => setImmediate(resolve));
    screen = await settle();
    assert.deepEqual(calls, ["note dec-pnpm"]);
    assert.match(screen, /We use pnpm everywhere\./);
    assert.match(screen, /evd-lockfile supports this/);
    terminal.type("o");
    await new Promise((resolve) => setImmediate(resolve));
    screen = await settle();
    assert.deepEqual(calls, ["note dec-pnpm", "open dec-pnpm"]);
    assert.match(screen, /Opened in Obsidian: dec-pnpm/);
    terminal.type(ESC);
    screen = await settle();
    assert.doesNotMatch(screen, /We use pnpm everywhere\./);
    assert.match(screen, /Memory graph · 2 notes · 1 link/);
    terminal.type(ESC);
    screen = await settle();
    assert.doesNotMatch(screen, /esc done/);
  } finally {
    await tui.stop("completed");
  }
});
