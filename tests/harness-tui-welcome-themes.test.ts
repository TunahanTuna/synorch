import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionHeaderView } from "../src/harness/contracts/index.ts";
import { GLYPH_SETS } from "../src/harness/tui/conversation-view.ts";
import { PiTuiRenderer, type PiTuiRendererOptions } from "../src/harness/tui/pi-tui-renderer.ts";
import { createStyler } from "../src/harness/tui/style.ts";
import { BUILTIN_THEMES, builtinTheme, customTheme, detectColorDepth, painter, parseStyleSpec, toXterm256 } from "../src/harness/tui/theme.ts";
import { DEFAULT_WELCOME, pickHint, renderWelcome, themePreview } from "../src/harness/tui/welcome.ts";
import { VirtualTerminal } from "./fixtures/ux/capture.ts";

/**
 * K8: the welcome header (full at 120×40, compact at 60×20, ascii fallback), theme tokens reaching
 * the painted output at each colour depth, NO_COLOR leaving no SGR byte, and custom themes.
 */

const HEADER: SessionHeaderView = {
  workspaceRoot: "/home/me/dev/demo",
  gitBranch: "main",
  policyMode: "autonomous",
  routes: [],
  sandboxEnforcement: "full",
  notices: [],
  version: "0.4.0-beta.1",
  model: "gpt-6-sol",
  contextWindowTokens: 400_000,
  permissionMode: "auto",
  welcome: { commit: "ef46ef1", effort: "high", plan: "ChatGPT Plus", workers: ["opus-5.5", "gpt-6-luna"], path: "~/dev/demo", hint: "Type / for commands · @ attaches files · Shift+Tab switches modes" },
};

async function open(columns: number, rows: number, extra: Partial<PiTuiRendererOptions> = {}): Promise<{ tui: PiTuiRenderer; terminal: VirtualTerminal }> {
  const terminal = new VirtualTerminal(columns, rows);
  const tui = new PiTuiRenderer({
    color: false,
    policyMode: "autonomous",
    environment: { platform: "linux", env: {} },
    terminal,
    schedule: () => {},
    drainInputMs: 0,
    view: "conversation",
    now: () => 1_000,
    welcome: DEFAULT_WELCOME,
    ...extra,
  });
  await tui.start(HEADER);
  return { tui, terminal };
}

async function screen(tui: PiTuiRenderer, terminal: VirtualTerminal): Promise<string> {
  tui.flush();
  return (await terminal.viewport()).replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

test("welcome at 120x40: the mark beside version, model line, team, folder and mode, the hint on the last row", async () => {
  const { tui, terminal } = await open(120, 40);
  const shown = await screen(tui, terminal);
  const head = shown.split("\n").slice(0, 5).join("\n");
  assert.equal(
    head,
    [
      "   ◆      Synorch v0.4.0-beta.1 (ef46ef1)",
      " ╭   ╮    gpt-6-sol · high · 400k context · ChatGPT Plus",
      "│  ●  │   workers opus-5.5 · gpt-6-luna",
      " ╰   ╯    ~/dev/demo (main) · auto mode",
      "   ◇      › Type / for commands · @ attaches files · Shift+Tab switches modes",
    ].join("\n"),
  );
  assert.match(shown, /demo · main · gpt-6-sol · auto mode/, "the footer stays one line");
  await tui.stop("completed");
});

test("welcome at 60x20: compact, one info line and the hint", async () => {
  const { tui, terminal } = await open(60, 20);
  const lines = (await screen(tui, terminal)).split("\n");
  assert.equal(lines[0], "◆ Synorch · gpt-6-sol · high · demo (main) · auto mode");
  assert.equal(lines[1], "  › Type / for commands · @ attaches files · Shift+Tab swit…");
  assert.match(lines[2] ?? "", /^─+$/, "the editor follows at once");
  await tui.stop("completed");
});

test("ascii glyphs draw a 7-bit mark; minimal is the one-line title of before", async () => {
  const frame = { width: 120, rows: 40, glyphs: GLYPH_SETS.ascii, style: createStyler(false) };
  const info = { version: "0.4.0-beta.1", folder: "demo", branch: "main", model: "gpt-6-sol", mode: "auto", hint: "Ctrl+O expands tool output" };
  const full = renderWelcome(info, DEFAULT_WELCOME, frame);
  assert.deepEqual(full.slice(0, 5), ["   @      Synorch v0.4.0-beta.1", " /   \\    gpt-6-sol", "|  o  |   demo (main) - auto mode", " \\   /    > Ctrl+O expands tool output", "   *"]);
  assert.ok(full.every((line) => /^[\x20-\x7e]*$/.test(line)), "ascii stays 7-bit");
  assert.deepEqual(renderWelcome(info, { ...DEFAULT_WELCOME, style: "minimal" }, frame), ["Synorch 0.4.0-beta.1 - demo (main)"]);
  assert.deepEqual(renderWelcome(info, { ...DEFAULT_WELCOME, style: "off" }, frame), []);
});

test("theme tokens reach the output: truecolor hex, 256 nearest index, 16-colour ANSI palette", () => {
  const nord = builtinTheme("nord")!;
  assert.equal(createStyler(true, { theme: nord, depth: 24 }).accent("x"), "\x1b[38;2;136;192;208mx\x1b[39m");
  assert.equal(createStyler(true, { theme: nord, depth: 256 }).accent("x"), `\x1b[38;5;${toXterm256([136, 192, 208])}mx\x1b[39m`);
  assert.equal(createStyler(true, { theme: nord, depth: 16 }).accent("x"), "\x1b[36mx\x1b[39m");
  // Without a theme the styler is the pre-K8 16-colour output, byte for byte.
  const legacy = createStyler(true);
  assert.equal(legacy.cyan("x"), "\x1b[36mx\x1b[39m");
  assert.equal(legacy.dim("x"), "\x1b[2mx\x1b[22m");
  assert.equal(legacy.bold("x"), "\x1b[1mx\x1b[22m");
  // Mono paints no colour, only attributes.
  const mono = createStyler(true, { theme: builtinTheme("mono"), depth: 24 });
  assert.doesNotMatch(mono.accent("x") + mono.danger("x") + mono.success("x") + mono.diffAdd("x"), /\x1b\[3[0-9]|38;/);
  // Swapping the theme restyles later paints.
  const live = createStyler(true, { theme: builtinTheme("synorch"), depth: 24 });
  const before = live.success("ok");
  live.setTheme(builtinTheme("gruvbox"));
  assert.notEqual(live.success("ok"), before);
  assert.equal(live.themeName, "gruvbox");
});

test("every built-in theme paints every surface of the preview; NO_COLOR paints none", () => {
  for (const theme of BUILTIN_THEMES) {
    for (const depth of [16, 256, 24] as const) {
      const lines = themePreview(createStyler(true, { theme, depth }), GLYPH_SETS.rich, 80);
      assert.equal(lines.length, 8, theme.name);
      if (theme.name !== "mono") assert.match(lines.join("\n"), /\x1b\[/, `${theme.name} paints at ${depth}`);
    }
    const plain = themePreview(createStyler(false, { theme, depth: 24 }), GLYPH_SETS.rich, 80).join("\n");
    assert.doesNotMatch(plain, /\x1b/, `${theme.name} with colour off`);
  }
});

test("NO_COLOR: the welcome and the whole first screen carry no SGR byte", async () => {
  const terminal = new VirtualTerminal(120, 40);
  const writes: string[] = [];
  const write = terminal.write.bind(terminal);
  terminal.write = (data: string) => {
    writes.push(data);
    write(data);
  };
  const tui = new PiTuiRenderer({ color: false, policyMode: "autonomous", environment: { platform: "linux", env: { NO_COLOR: "1" } }, terminal, schedule: () => {}, drainInputMs: 0, view: "conversation", now: () => 1_000, welcome: DEFAULT_WELCOME, theme: builtinTheme("dracula")!, colorDepth: 24 });
  await tui.start(HEADER);
  tui.flush();
  assert.doesNotMatch(writes.join("").replaceAll("\x1b[7m", ""), /\x1b\[[0-9;]*[1-9][0-9;]*m/, "no colour or attribute SGR (the editor cursor aside)");
  await tui.stop("completed");
});

test("colour depth detection and custom themes", () => {
  assert.equal(detectColorDepth({ COLORTERM: "truecolor" }, "linux"), 24);
  assert.equal(detectColorDepth({ WT_SESSION: "x" }, "win32"), 24);
  assert.equal(detectColorDepth({ TERM: "xterm-256color" }, "linux"), 256);
  assert.equal(detectColorDepth({ TERM: "xterm" }, "linux"), 16);
  assert.equal(detectColorDepth({ SYN_COLOR_DEPTH: "16", COLORTERM: "truecolor" }, "linux"), 16);
  const loaded = customTheme("ocean", { extends: "nord", tokens: { accent: "#00aaff bold", logo: ["#111111", "#222222"], nope: "red" } }, BUILTIN_THEMES);
  assert.equal(loaded.theme?.tokens.accent, "#00aaff bold");
  assert.equal(loaded.theme?.tokens.logo2, "#222222");
  assert.equal(loaded.theme?.tokens.danger, builtinTheme("nord")?.tokens.danger);
  assert.match(loaded.problems.join("\n"), /unknown token "nope"/);
  assert.deepEqual(parseStyleSpec("#fff bold wobbly").unknown, ["wobbly"]);
  assert.equal(painter(parseStyleSpec("").spec, 24)("x"), "x");
});

test("hints: first run explains the basics, a recent conversation offers /resume, otherwise a rotating tip", () => {
  assert.match(pickHint({ firstRun: true, seed: 0, sep: "·" }), /Type \/ for commands/);
  assert.equal(pickHint({ firstRun: false, resumable: "2h ago", seed: 0, sep: "·" }), "Conversation from 2h ago · /resume picks it up");
  const tips = new Set(Array.from({ length: 12 }, (_, seed) => pickHint({ firstRun: false, skills: 100, seed, sep: "·" })));
  assert.ok(tips.size >= 6, "tips rotate");
});

test("/theme picker previews the highlighted theme and applies it on Enter", async () => {
  const { tui, terminal } = await open(100, 40, { color: true, theme: builtinTheme("synorch")!, colorDepth: 24 });
  const appearance = tui.controls.appearance!;
  const picked = appearance.pickTheme();
  tui.flush();
  let shown = await screen(tui, terminal);
  assert.match(shown, /Pick a theme/);
  assert.match(shown, /│ > Fix the flaky login test/, "the preview block is drawn");
  terminal.type("\x1b[B");
  terminal.type("\r");
  assert.equal(await picked, "light");
  assert.equal(appearance.theme, "light");
  shown = await screen(tui, terminal);
  assert.doesNotMatch(shown, /Pick a theme/);
  await tui.stop("completed");
});
