import assert from "node:assert/strict";
import { test } from "node:test";
import { GLYPH_SETS } from "../src/harness/tui/conversation-view.ts";
import { ART_COLUMNS, ART_ROWS, gradientAt, themeLogoPalette } from "../src/harness/tui/logo.ts";
import { createStyler } from "../src/harness/tui/style.ts";
import { builtinTheme, toXterm256 } from "../src/harness/tui/theme.ts";
import { DEFAULT_WELCOME, logoLines, renderWelcome } from "../src/harness/tui/welcome.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const hex = (value: string): [number, number, number] => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as [number, number, number];

test("logo art: 7 rows × 14 cells of half-blocks tinted with the theme's logo colours", () => {
  assert.equal(ART_ROWS, 7);
  assert.equal(ART_COLUMNS, 14);
  const theme = builtinTheme("nord")!;
  const logo = logoLines({ glyphs: GLYPH_SETS.rich, style: createStyler(true, { theme, depth: 24 }) }, undefined, "art");
  assert.equal(logo.width, 14);
  assert.equal(logo.lines.length, 7);
  for (const line of logo.lines) assert.equal([...strip(line)].length, 14);
  const joined = logo.lines.join("");
  assert.match(joined, /[▀▄█]/);
  const stops = (["logo1", "logo2", "logo3"] as const).map((token) => hex(theme.tokens[token].match(/#[0-9a-f]{6}/i)![0]));
  const palette = themeLogoPalette(theme, 24)!;
  assert.deepEqual(palette.stops, stops, "the palette is the theme's logo1-3");
  const first = gradientAt(palette.stops, (6 / 13) * 0.15);
  const last = gradientAt(palette.stops, 0.85 + (7 / 13) * 0.15);
  assert.ok(logo.lines[0]!.includes(`38;2;${first.join(";")}m`), "the top is tinted near logo1");
  assert.ok(logo.lines[6]!.includes(`48;2;${last.join(";")}m`), "the bottom is tinted near logo3");
  const at256 = logoLines({ glyphs: GLYPH_SETS.rich, style: createStyler(true, { theme, depth: 256 }) }, undefined, "art").lines.join("");
  assert.ok(at256.includes(`38;5;${toXterm256(first)}m`), "256 colours use the nearest palette index");
  assert.doesNotMatch(at256, /38;2;/);
});

test("logo art falls back to the glyph mark: NO_COLOR, 16 colours, ascii glyphs, logo glyph", () => {
  const theme = builtinTheme("nord")!;
  const info = { version: "0.4.0-beta.1", folder: "demo" };
  const frame = { width: 120, rows: 40, glyphs: GLYPH_SETS.rich };
  const noColor = renderWelcome(info, DEFAULT_WELCOME, { ...frame, style: createStyler(false, { theme, depth: 24 }) });
  assert.equal(noColor[0], "   ◆");
  assert.ok(!noColor.join("").includes("\x1b"));
  assert.equal(strip(renderWelcome(info, DEFAULT_WELCOME, { ...frame, style: createStyler(true, { theme, depth: 16 }) })[0] ?? ""), "   ◆");
  assert.equal(strip(renderWelcome(info, DEFAULT_WELCOME, { ...frame, glyphs: GLYPH_SETS.ascii, style: createStyler(true, { theme, depth: 24 }) })[0] ?? ""), "   @");
  assert.equal(strip(renderWelcome(info, { ...DEFAULT_WELCOME, logo: "glyph" }, { ...frame, style: createStyler(true, { theme, depth: 24 }) })[0] ?? ""), "   ◆");
  assert.equal(renderWelcome(info, DEFAULT_WELCOME, { ...frame, style: createStyler(true, { theme, depth: 24 }) }).length, 7);
});
