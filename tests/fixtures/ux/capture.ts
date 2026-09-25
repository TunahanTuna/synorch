import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import xterm from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";
import type { ModelAdapter, ModelStreamEvent } from "../../../src/harness/contracts/index.ts";
import { runHarnessCommand } from "../../../src/harness/cli/index.ts";
import { createScriptedAdapter, type ScriptStep } from "../../../src/harness/providers/index.ts";
import { PiTuiRenderer } from "../../../src/harness/tui/pi-tui-renderer.ts";
import { BOARD, BOARD_DONE, T0 } from "../../harness-tui-views-fixtures.ts";
import { call, calls, createSandbox, overridesFor, trustWorkspace, type Sandbox } from "../cli/runtime/support.ts";

/**
 * UX evidence capture (terminal polish brief, P0 baseline): drives the real `syn agent` (scripted
 * model, real runtime) inside a headless xterm at several sizes, and records text frames, Enter
 * latency, full-redraw counts and scroll stability per scenario.
 *
 *   node tests/fixtures/ux/capture.ts <out-dir> [--color]
 */

export class VirtualTerminal implements Terminal {
  public readonly xterm: InstanceType<typeof xterm.Terminal>;
  public bytes = 0;
  public clears = 0;
  private onInput: ((data: string) => void) | undefined;

  public constructor(columns: number, rows: number) {
    this.xterm = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 5000 });
  }

  public start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }

  public stop(): void {}
  public async drainInput(): Promise<void> {}

  public write(data: string): void {
    this.bytes += data.length;
    if (data.includes("\x1b[3J") || data.includes("\x1b[2J")) this.clears += 1;
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

  private settle(): Promise<void> {
    return new Promise((resolve) => this.xterm.write("", () => resolve()));
  }

  /** The visible rows (what the user sees right now, honouring a scrolled-up viewport). */
  public async viewport(): Promise<string> {
    await this.settle();
    const buffer = this.xterm.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.xterm.rows; row += 1) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    return lines.join("\n");
  }

  public async all(): Promise<string> {
    await this.settle();
    const buffer = this.xterm.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    return lines.join("\n");
  }

  public get viewportY(): number {
    return this.xterm.buffer.active.viewportY;
  }

  public get baseY(): number {
    return this.xterm.buffer.active.baseY;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Delays every stream event so streaming looks like a real provider. */
function paced(inner: ModelAdapter, ms: number): ModelAdapter {
  return {
    ...inner,
    stream(request, credential, signal) {
      const source = inner.stream(request, credential, signal);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        for await (const event of source) {
          if (event.type === "text_delta") await sleep(ms);
          yield event;
        }
      })();
    },
    discoverCapabilities: (signal) => inner.discoverCapabilities(signal),
    prepare: (request, capabilities) => inner.prepare(request, capabilities),
    health: (signal) => inner.health(signal),
  };
}

/** A text answer streamed in word-sized deltas. */
function streamed(value: string, chunk = 3): ScriptStep {
  const words = value.split(/(?<=\s)/);
  const deltas: ModelStreamEvent[] = [];
  for (let index = 0; index < words.length; index += chunk) deltas.push({ type: "text_delta", index: 0, text: words.slice(index, index + chunk).join("") });
  return [
    ...deltas,
    { type: "done", stop_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: value }] }, usage: { input_tokens: 900, output_tokens: 120, source: "provider-reported" } },
  ];
}

interface Frame {
  readonly label: string;
  readonly text: string;
}

interface Metrics {
  enterToUserLineMs?: number;
  enterToActivityMs?: number;
  fullRedraws: number;
  bytes: number;
  notes: string[];
}

interface Scenario {
  readonly name: string;
  readonly title: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly script: readonly ScriptStep[];
  readonly args?: readonly string[];
  readonly trusted?: boolean;
  readonly paceMs?: number;
  readonly drive: (ctx: DriveContext) => Promise<void>;
}

interface DriveContext {
  readonly terminal: VirtualTerminal;
  readonly frames: Frame[];
  readonly metrics: Metrics;
  snap(label: string): Promise<void>;
  send(text: string): Promise<void>;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<boolean>;
  idle(timeoutMs?: number): Promise<void>;
}

const APP = "export function add(a, b) {\n  return a - b;\n}\n";
const TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./src/add.mjs";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n';
const FILES = {
  "src/add.mjs": APP,
  "add.test.mjs": TEST,
  "README.md": "# demo\n\nA tiny demo project.\n",
  "package.json": '{ "name": "demo", "type": "module" }\n',
  "src/a.mjs": "export const a = 1;\n",
  "src/b.mjs": "export const b = 2;\n",
  "src/c.mjs": "export const c = 3;\n",
  "src/d.mjs": "export const d = 4;\n",
  "src/e.mjs": "export const e = 5;\n",
};
const PATCH = "*** Begin Patch\n*** Update File: src/add.mjs\n@@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch";

const LONG = Array.from({ length: 60 }, (_, index) =>
  index % 12 === 0 ? `\n## Section ${index / 12 + 1}\n` : `- Point ${index}: the renderer keeps ${index % 3 === 0 ? "`streaming`" : "text"} readable while the answer grows line by line.`,
).join("\n");

const SCENARIOS: readonly Scenario[] = [
  {
    name: "01-startup",
    title: "Startup / empty state",
    script: [],
    drive: async (ctx) => {
      await sleep(200);
      await ctx.snap("first screen");
      ctx.terminal.type("?");
      await sleep(100);
      await ctx.snap("? shortcuts");
    },
  },
  {
    name: "02-short-question",
    title: "Short question",
    script: [streamed("This is a tiny demo project: `src/add.mjs` exports an `add` function and `add.test.mjs` checks it with node's test runner.")],
    paceMs: 12,
    drive: async (ctx) => {
      await sleep(150);
      await ctx.send("what does this repo do?");
      await ctx.waitFor(/tiny demo/);
      await ctx.snap("mid-stream");
      await ctx.idle();
      await ctx.snap("answer done");
    },
  },
  {
    name: "03-direct-edit",
    title: "Direct edit with diff",
    trusted: true,
    script: [
      call("read_file", () => ({ path: "src/add.mjs" })),
      call("apply_patch", () => ({ patch: PATCH })),
      call("exec", () => ({ argv: ["node", "--test"] })),
      streamed("Fixed: `add` subtracted instead of adding. The test passes now."),
    ],
    paceMs: 8,
    drive: async (ctx) => {
      await sleep(150);
      await ctx.send("fix the add function");
      await ctx.idle(20000);
      await ctx.snap("turn done");
      await ctx.send("/diff");
      await sleep(300);
      await ctx.snap("/diff");
    },
  },
  {
    name: "04-tool-heavy",
    title: "Tool-heavy turn (~20 tools)",
    trusted: true,
    script: [
      calls(() => ["README.md", "package.json", "src/add.mjs", "src/a.mjs", "src/b.mjs", "src/c.mjs", "src/d.mjs", "src/e.mjs"].map((file) => ({ name: "read_file", arguments: { path: file } }))),
      calls(() => [
        { name: "search", arguments: { pattern: "export", path: "src" } },
        { name: "search", arguments: { pattern: "add\\(" } },
        { name: "list_dir", arguments: { path: "src" } },
      ]),
      call("apply_patch", () => ({ patch: PATCH })),
      call("write_file", () => ({ path: "src/f.mjs", content: "export const f = 6;\n" })),
      calls(() => ["src/a.mjs", "src/b.mjs", "src/c.mjs"].map((file) => ({ name: "read_file", arguments: { path: file } }))),
      call("exec", () => ({ argv: ["node", "--test"] })),
      call("search", () => ({ pattern: "zzz-nothing" })),
      call("read_file", () => ({ path: "missing.mjs" })),
      streamed("Done. `add` is fixed, `src/f.mjs` is new, and the test suite passes."),
    ],
    paceMs: 5,
    drive: async (ctx) => {
      await sleep(150);
      await ctx.send("audit the project and fix add");
      await ctx.idle(12000);
      await ctx.snap("turn done (viewport)");
      ctx.frames.push({ label: "turn done (full scrollback)", text: await ctx.terminal.all() });
      ctx.terminal.type("\x0f");
      await sleep(80);
      await ctx.snap("ctrl+o expanded (viewport)");
      ctx.terminal.type("\x0f");
      await sleep(80);
    },
  },
  {
    name: "05-approval",
    title: "Approval prompt (ask mode)",
    args: ["--permission-mode", "ask"],
    trusted: true,
    script: [call("read_file", () => ({ path: "src/add.mjs" })), call("apply_patch", () => ({ patch: PATCH })), streamed("Fixed the subtraction.")],
    paceMs: 8,
    drive: async (ctx) => {
      await sleep(150);
      await ctx.send("fix add");
      await ctx.waitFor(/Esc|allow|Allow|Yes/, 5000);
      await sleep(100);
      await ctx.snap("approval prompt");
      ctx.terminal.type("1");
      await ctx.idle(6000);
      await ctx.snap("after approving");
    },
  },
  {
    name: "06-esc-interrupt",
    title: "Esc interrupt mid-stream",
    script: [streamed(LONG, 2)],
    paceMs: 25,
    drive: async (ctx) => {
      await sleep(150);
      await ctx.send("explain the renderer in detail");
      await ctx.waitFor(/Point 5/, 6000);
      ctx.terminal.type("\x1b");
      await sleep(400);
      await ctx.snap("after esc");
    },
  },
  {
    name: "07-scrolled-up-stream",
    title: "Long streaming answer while the user scrolled up",
    script: [streamed(LONG, 2)],
    paceMs: 6,
    drive: async (ctx) => {
      await sleep(150);
      await ctx.send("explain the renderer in detail");
      await ctx.waitFor(/Point 30/, 8000);
      ctx.terminal.xterm.scrollLines(-8);
      const before = ctx.terminal.viewportY;
      const clearsBefore = ctx.terminal.clears;
      await ctx.snap("user scrolled up 8 lines");
      await ctx.waitFor(/Point 50/, 8000);
      await ctx.snap("more output arrived (viewport)");
      const after = ctx.terminal.viewportY;
      ctx.metrics.notes.push(`viewportY before=${before} after=${after} (base ${ctx.terminal.baseY}); full redraws while scrolled up: ${ctx.terminal.clears - clearsBefore}`);
      await ctx.idle(8000);
      ctx.terminal.xterm.scrollToBottom();
      await ctx.snap("answer done (bottom)");
    },
  },
];

const SIZES: readonly (readonly [number, number])[] = [
  [80, 24],
  [120, 40],
  [40, 20],
];

async function runScenario(scenario: Scenario, columns: number, rows: number, color: boolean): Promise<{ frames: Frame[]; metrics: Metrics }> {
  const sandbox: Sandbox = await createSandbox(scenario.files ?? FILES, { git: true });
  const terminal = new VirtualTerminal(columns, rows);
  const frames: Frame[] = [];
  const metrics: Metrics = { fullRedraws: 0, bytes: 0, notes: [] };
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), "routes:\n  - { tier: orchestrator, provider: scripted, model: sol-large, adapter: ux }\n");
    if (scenario.trusted === true) await trustWorkspace(sandbox);
    const model = paced(createScriptedAdapter(scenario.script, { adapterId: "ux", yieldBetweenEvents: true }), scenario.paceMs ?? 0);
    const controller = new AbortController();
    const out: string[] = [];
    const env: Record<string, string | undefined> = { WT_SESSION: "1", TERM: "xterm-256color", ...(color ? {} : { NO_COLOR: "1" }), ...(process.argv.includes("--ascii") ? { SYN_GLYPHS: "ascii" } : {}) };
    const running = runHarnessCommand(
      ["agent", ...(scenario.args ?? [])],
      {
        env,
        cwd: sandbox.workspace,
        stdinIsTTY: true,
        stdout: { isTTY: true, write: (chunk: string) => (out.push(chunk), true), hasColors: () => color },
        stderr: { isTTY: true, write: (chunk: string) => (out.push(chunk), true), hasColors: () => color },
        signal: controller.signal,
        platform: process.platform,
        terminal,
      },
      overridesFor(sandbox, { adapters: [model as never] }),
    );
    const ctx: DriveContext = {
      terminal,
      frames,
      metrics,
      snap: async (label) => {
        frames.push({ label, text: await terminal.viewport() });
      },
      waitFor: async (pattern, timeoutMs = 4000) => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          if (pattern.test(await terminal.all())) return true;
          await sleep(10);
        }
        metrics.notes.push(`timeout waiting for ${pattern}`);
        return false;
      },
      idle: async (timeoutMs = 5000) => {
        const until = Date.now() + timeoutMs;
        await sleep(60);
        let quiet = 0;
        while (Date.now() < until) {
          const screen = await terminal.all();
          const tail = screen.split("\n").slice(-8).join("\n");
          quiet = /(Thinking|Responding|Waiting for you|Running|Reading|Editing)(…|\.\.\.)/.test(tail) ? 0 : quiet + 1;
          if (quiet >= 5) return;
          await sleep(40);
        }
        metrics.notes.push("timeout waiting for idle");
      },
      send: async (text) => {
        for (const char of text) terminal.type(char);
        await sleep(20);
        const start = performance.now();
        terminal.type("\r");
        const escaped = text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const user = new RegExp(`> ${escaped}`);
        while (performance.now() - start < 2000) {
          const screen = await terminal.viewport();
          if (metrics.enterToUserLineMs === undefined && user.test(screen)) metrics.enterToUserLineMs = Math.round(performance.now() - start);
          if (metrics.enterToActivityMs === undefined && /esc to interrupt|Thinking|Waiting/.test(screen)) metrics.enterToActivityMs = Math.round(performance.now() - start);
          if (metrics.enterToUserLineMs !== undefined && metrics.enterToActivityMs !== undefined) break;
          await sleep(1);
        }
      },
    };
    await scenario.drive(ctx);
    terminal.type("\x04");
    const exited = await Promise.race([running.then(() => true), sleep(4000).then(() => false)]);
    if (!exited) {
      controller.abort();
      await Promise.race([running, sleep(2000)]);
    }
    metrics.fullRedraws = terminal.clears;
    metrics.bytes = terminal.bytes;
    return { frames, metrics };
  } finally {
    await sandbox.cleanup().catch(() => undefined);
  }
}

/** Live board: the renderer with the view fixtures (orchestration needs a full plan otherwise). */
async function runBoard(columns: number, rows: number): Promise<{ frames: Frame[]; metrics: Metrics }> {
  const terminal = new VirtualTerminal(columns, rows);
  let now = T0 + 40_000;
  const tui = new PiTuiRenderer({
    color: false,
    policyMode: "autonomous",
    environment: { platform: "linux", env: {} },
    terminal,
    drainInputMs: 0,
    view: "conversation",
    now: () => now,
  });
  await tui.start({ workspaceRoot: "/work/demo", gitBranch: "main", policyMode: "autonomous", routes: [], sandboxEnforcement: "full", notices: [], version: "0.4.0-beta.0", model: "sol-large", permissionMode: "auto" });
  const frames: Frame[] = [];
  tui.flush();
  tui.setBoard(BOARD);
  tui.flush();
  frames.push({ label: "live board", text: await terminal.viewport() });
  now += 5_000;
  tui.setBoard(BOARD_DONE);
  tui.flush();
  frames.push({ label: "board done (pinned summary)", text: await terminal.viewport() });
  await tui.stop("completed");
  return { frames, metrics: { fullRedraws: terminal.clears, bytes: terminal.bytes, notes: [] } };
}

function renderReport(name: string, title: string, results: readonly { size: string; frames: Frame[]; metrics: Metrics }[]): string {
  const out: string[] = [`# ${name}: ${title}`, ""];
  for (const result of results) {
    out.push(`## ${result.size}`, "");
    const m = result.metrics;
    out.push(
      `- enter -> user line: ${m.enterToUserLineMs ?? "n/a"} ms · enter -> activity: ${m.enterToActivityMs ?? "n/a"} ms · full redraws (screen+scrollback clears): ${m.fullRedraws} · bytes written: ${m.bytes}`,
    );
    for (const note of m.notes) out.push(`- ${note}`);
    out.push("");
    for (const frame of result.frames) {
      out.push(`### ${frame.label}`, "", "```text", frame.text.replace(/[ \t]+$/gm, ""), "```", "");
    }
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (outDir === undefined) throw new Error("usage: node tests/fixtures/ux/capture.ts <out-dir> [--color] [--only name]");
  const color = process.argv.includes("--color");
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];
  await mkdir(outDir, { recursive: true });
  const summary: string[] = [];
  for (const scenario of SCENARIOS) {
    if (only !== undefined && !scenario.name.includes(only)) continue;
    const results: { size: string; frames: Frame[]; metrics: Metrics }[] = [];
    for (const [columns, rows] of SIZES) {
      const result = await runScenario(scenario, columns, rows, color);
      results.push({ size: `${columns}x${rows}`, ...result });
      summary.push(`${scenario.name} ${columns}x${rows}: enter->user ${result.metrics.enterToUserLineMs ?? "-"}ms, enter->activity ${result.metrics.enterToActivityMs ?? "-"}ms, redraws ${result.metrics.fullRedraws}${result.metrics.notes.length === 0 ? "" : ` | ${result.metrics.notes.join("; ")}`}`);
    }
    await writeFile(path.join(outDir, `${scenario.name}.md`), renderReport(scenario.name, scenario.title, results));
  }
  if (only === undefined || "08-board".includes(only)) {
    const results: { size: string; frames: Frame[]; metrics: Metrics }[] = [];
    for (const [columns, rows] of SIZES) results.push({ size: `${columns}x${rows}`, ...(await runBoard(columns, rows)) });
    await writeFile(path.join(outDir, "08-board.md"), renderReport("08-board", "Orchestration live board (renderer with fixtures)", results));
  }
  await writeFile(path.join(outDir, "metrics.txt"), `${summary.join("\n")}\n`);
  process.stdout.write(`${summary.join("\n")}\n`);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/").replace(/^\/?/, "/")}` || process.argv[1]?.endsWith("capture.ts") === true) {
  await main();
  process.exit(0);
}
