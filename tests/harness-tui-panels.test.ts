import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import xterm from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";
import type { SessionHeaderView, TerminalRenderer } from "../src/harness/contracts/index.ts";
import { describeSkills, runSkillsSlash, type ExtensionSlashHost } from "../src/harness/cli/extensions-command.ts";
import type { ExtensionItem, Extensions, ExtensionSettings, ItemStatus } from "../src/harness/cli/extensions/index.ts";
import { skillsPanel } from "../src/harness/cli/panels/skills.ts";
import { GLYPH_SETS } from "../src/harness/tui/conversation-view.ts";
import { PiTuiRenderer } from "../src/harness/tui/pi-tui-renderer.ts";
import { PlainLineRenderer } from "../src/harness/tui/plain-line-renderer.ts";

/** Layered panels: `/skills` opens, navigates, drills in, filters, switches tabs, acts and restores the transcript. */

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

const HEADER: SessionHeaderView = { workspaceRoot: "/work/demo", gitBranch: "main", policyMode: "autonomous", routes: [], sandboxEnforcement: "full", notices: [], version: "0.9", model: "astra" };

const DOWN = "\x1b[B";
const ESC = "\x1b";
const TAB = "\t";
const ENTER = "\r";

function meta(description: string, extra: Partial<ExtensionItem["meta"]> = {}): ExtensionItem["meta"] {
  return { name: undefined, description, whenToUse: undefined, argumentHint: undefined, argumentNames: [], allowedTools: [], modelInvocable: true, userInvocable: true, ...extra };
}

function entry(partial: Pick<ExtensionItem, "kind" | "name" | "source" | "location" | "meta"> & Partial<ExtensionItem>): ExtensionItem {
  return { plugin: undefined, needsTrust: false, claudeNative: false, file: undefined, content: undefined, dir: undefined, pluginRoot: undefined, canonical: false, ...partial };
}

/** A small catalog on disk (the skill folder is real so its files can be browsed) and an Extensions fake over it. */
async function fixture(): Promise<{ host: ExtensionSlashHost; home: string; printed: string[]; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-panels-"));
  const home = path.join(root, "home");
  const skillDir = path.join(root, "claude", "skills", "code-review");
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  await writeFile(skillFile, "---\nname: code-review\ndescription: Review a pull request\nallowed-tools: Read Grep\n---\n# Code review\n\nCheck **correctness** first, then style.\n", "utf8");
  await writeFile(path.join(skillDir, "scripts", "lint.sh"), "#!/bin/sh\necho lint\n", "utf8");
  const items: ExtensionItem[] = [
    entry({ kind: "skill", name: "code-review", source: "claude", location: skillFile, file: skillFile, dir: skillDir, claudeNative: true, meta: meta("Review a pull request", { whenToUse: "the user asks for a review", allowedTools: ["Read", "Grep"] }) }),
    entry({ kind: "skill", name: "deploy", source: "project", location: path.join(root, ".claude/skills/deploy/SKILL.md"), needsTrust: true, meta: meta("Ship to staging") }),
    entry({ kind: "command", name: "standup", source: "user", location: path.join(home, "commands/standup.md"), content: "Summarize yesterday.", meta: meta("Write my standup") }),
  ];
  let disabled = new Set<string>();
  const statuses = (): ItemStatus[] => items.map((item) => ({ item, state: item.needsTrust ? "needs-trust" : disabled.has(item.name) ? "disabled" : "active", shadowedBy: undefined }));
  const extensions = {
    env: {},
    claudeHome: undefined,
    skills: { list: () => [], load: async () => undefined },
    state: () => ({ items, plugins: [], problems: [] }),
    statuses,
    invocable: () => items,
    find: () => undefined,
    invocationText: async () => undefined,
    mcpServers: () => [],
    problems: () => [],
    settings: (): ExtensionSettings => ({ includeClaudeSkills: true, includeClaudePlugins: true, disabledSkills: [...disabled], disabledPlugins: [] }),
    reload: async (settings?: ExtensionSettings) => {
      if (settings !== undefined) disabled = new Set(settings.disabledSkills);
    },
  } as unknown as Extensions;
  const printed: string[] = [];
  const host: ExtensionSlashHost = {
    extensions,
    home,
    workspaceRoot: root,
    env: {},
    sep: "·",
    print: (lines) => printed.push(...lines),
    choose: async () => undefined,
    changed: async () => undefined,
  };
  return { host, home, printed, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Settles until the screen matches (panel pages open asynchronously). */
async function waitFor(settle: () => Promise<string>, pattern: RegExp): Promise<string> {
  let screen = await settle();
  for (let attempt = 0; attempt < 100 && !pattern.test(screen); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    screen = await settle();
  }
  return screen;
}

async function mounted(): Promise<{ tui: PiTuiRenderer; terminal: VirtualTerminal; settle: () => Promise<string> }> {
  const terminal = new VirtualTerminal(100, 30);
  const tui = new PiTuiRenderer({ color: false, policyMode: "autonomous", environment: { platform: "linux", env: {} }, terminal, schedule: () => {}, drainInputMs: 0, view: "conversation", glyphs: GLYPH_SETS.rich });
  await tui.start(HEADER);
  return {
    tui,
    terminal,
    settle: async () => {
      tui.flush();
      await new Promise((resolve) => setImmediate(resolve));
      tui.flush();
      await terminal.flush();
      return terminal.screen();
    },
  };
}

test("/skills panel: open, navigate, detail with the rendered SKILL.md, files, back, close restores the transcript", async () => {
  const { tui, terminal, settle } = await mounted();
  const { host, cleanup } = await fixture();
  try {
    tui.render({ kind: "notice", level: "info", message: "earlier transcript line" });
    let screen = await settle();
    assert.match(screen, /earlier transcript line/);
    const controls = tui.controls;
    assert.ok(controls.openPanel !== undefined);
    let closed = false;
    const done = controls.openPanel(skillsPanel(host)).then(() => {
      closed = true;
    });
    screen = await settle();
    assert.doesNotMatch(screen, /earlier transcript line/, "the panel takes the screen");
    assert.match(screen, /^ Skills\s+1\/3 $/m);
    assert.match(screen, /2 skills · 1 command · 2 on · \/<name> runs one/);
    assert.match(screen, / All 3 {2} Project 1 {2} User 1 {2} Claude 1 /);
    assert.match(screen, /❯ code-review\s+on\s+claude\s+Review a pull request/);
    assert.match(screen, /deploy\s+needs trust\s+project\s+Ship to staging/);
    assert.match(screen, /\/standup\s+on\s+user cmd\s+Write my standup/);
    assert.match(screen, /↑↓ move · Enter open · d disable · i invoke · o open file · \/ filter · Tab switch · Esc close/);

    terminal.type(ENTER);
    screen = await waitFor(settle, /^ Skills › code-review/m);
    assert.match(screen, /^ Skills › code-review/m);
    assert.match(screen, / Overview {3}Files 2 /);
    assert.match(screen, /state\s+on/);
    assert.match(screen, /source\s+claude/);
    assert.match(screen, /when to use\s+the user asks for a review/);
    assert.match(screen, /allowed tools\s+Read Grep \(informational/);
    assert.match(screen, /SKILL\.md/);
    assert.match(screen, /Code review/);
    assert.match(screen, /Check correctness first, then style\./, "the markdown body is rendered (no ** markers)");
    assert.match(screen, /Esc back/);

    terminal.type(TAB);
    screen = await settle();
    assert.match(screen, /❯ scripts\/lint\.sh\n {3}SKILL\.md/, "the skill folder's files, openable");
    terminal.type(ENTER);
    screen = await waitFor(settle, /› lint\.sh/);
    assert.match(screen, /^ Skills › code-review › lint\.sh/m);
    assert.match(screen, /│ echo lint/);

    terminal.type(ESC);
    terminal.type("\x7f");
    screen = await settle();
    assert.equal(tui.panelState?.depth, 1, "Esc and Backspace each go back one level");
    assert.match(screen, /^ Skills\s+1\/3 $/m);

    terminal.type(ESC);
    await done;
    screen = await settle();
    assert.equal(closed, true);
    assert.equal(tui.panelState, undefined);
    assert.match(screen, /earlier transcript line/, "closing restores the transcript");
  } finally {
    await tui.stop("completed");
    await cleanup();
  }
});

test("/skills panel: / filters, Tab switches source tabs, q closes", async () => {
  const { tui, terminal, settle } = await mounted();
  const { host, cleanup } = await fixture();
  try {
    const done = tui.controls.openPanel?.(skillsPanel(host));
    await settle();
    terminal.type("/");
    for (const char of "stand") terminal.type(char);
    let screen = await settle();
    assert.match(screen, /\/ filter stand▏/);
    assert.match(screen, /❯ \/standup/);
    assert.doesNotMatch(screen, /code-review/);
    assert.match(screen, /^ Skills\s+1\/1 $/m);
    terminal.type(ENTER);
    terminal.type(ESC);
    screen = await settle();
    assert.match(screen, /code-review/, "Esc clears the filter");

    terminal.type(TAB);
    screen = await settle();
    assert.equal(tui.panelState?.view, 1);
    assert.match(screen, /❯ deploy\s+needs trust/);
    assert.doesNotMatch(screen, /code-review\s+on/);
    terminal.type("\x1b[Z");
    screen = await settle();
    assert.equal(tui.panelState?.view, 0, "Shift+Tab goes back a tab");

    terminal.type("q");
    await done;
    assert.equal(tui.panelState, undefined);
  } finally {
    await tui.stop("completed");
    await cleanup();
  }
});

test("/skills panel: d disables in place (saved, reloaded, one transcript line); i puts /name into the editor", async () => {
  const { tui, terminal, settle } = await mounted();
  const { host, home, printed, cleanup } = await fixture();
  try {
    const done = tui.controls.openPanel?.(skillsPanel(host));
    await settle();
    terminal.type("d");
    let screen = await waitFor(settle, /code-review\s+off/);
    assert.match(screen, /❯ code-review\s+off/);
    assert.match(screen, /✓ code-review is off \(saved in your user config\)\./);
    assert.match(await readFile(path.join(home, "config.yaml"), "utf8"), /code-review/);
    assert.deepEqual(printed, ["code-review is off (saved in your user config)."]);
    assert.match(screen, /e enable/);

    terminal.type(DOWN);
    terminal.type(DOWN);
    terminal.type("i");
    await done;
    screen = await settle();
    assert.equal(tui.panelState, undefined);
    assert.match(screen, /\/standup/);
  } finally {
    await tui.stop("completed");
    await cleanup();
  }
});

test("plain mode keeps the text report: no panel control, /skills prints the listing", async () => {
  const out: string[] = [];
  const plain = new PlainLineRenderer({ stdout: (text) => out.push(text), stderr: () => undefined, color: false, policyMode: "ask", interactive: false, environment: { platform: "linux", env: {} } });
  assert.equal((plain as TerminalRenderer).controls?.openPanel, undefined);
  const { host, printed, cleanup } = await fixture();
  try {
    await runSkillsSlash(host, "");
    assert.deepEqual(printed.slice(0, -1), describeSkills(host.extensions.statuses(), "·"));
  } finally {
    await cleanup();
  }
});
