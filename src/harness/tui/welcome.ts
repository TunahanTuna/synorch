import type { GlyphSet } from "./conversation-view.ts";
import { ART_COLUMNS } from "./logo.ts";
import { sanitizeInline } from "./sanitize.ts";
import type { Styler } from "./style.ts";
import { displayWidth, fitLine, truncate } from "./views/kit.ts";

/**
 * K8 welcome header: the first thing `syn agent` draws. Synorch's own mark — a conductor node that
 * fans out to three workers and synchronises them into one result (syn + orch) — next to the
 * facts a user checks first: version, the conversation model with effort / context / plan, the
 * worker team when it differs, the folder and branch, the permission mode, and one contextual
 * hint. It adapts to the terminal: `full` (mark + 5 rows) on roomy screens, `compact` (one info
 * line + the hint) otherwise, `minimal` (one line) when narrow; it scrolls away with the
 * transcript like any other line. Everything is plain text laid out first and painted last, so
 * NO_COLOR and the ascii glyph set read the same.
 */

export const WELCOME_STYLES = ["full", "compact", "minimal", "off"] as const;
export type WelcomeStyle = (typeof WELCOME_STYLES)[number];
/** `on` and `art`: the half-block art where colour allows (the glyph mark otherwise); `glyph`: always the glyph mark. */
export const WELCOME_LOGOS = ["on", "art", "glyph", "off", "custom"] as const;
export type WelcomeLogo = (typeof WELCOME_LOGOS)[number];
export const WELCOME_FIELDS = ["version", "model", "plan", "workers", "folder", "mode"] as const;
export type WelcomeField = (typeof WELCOME_FIELDS)[number];

export interface WelcomeSettings {
  readonly style: WelcomeStyle;
  readonly logo: WelcomeLogo;
  readonly fields: readonly WelcomeField[];
  readonly tips: boolean;
  /** `<synorch home>/logo.txt` lines when `logo` is `custom` (at most 6 rows of 32 columns). */
  readonly customLogo?: readonly string[] | undefined;
}

export const DEFAULT_WELCOME: WelcomeSettings = { style: "full", logo: "on", fields: WELCOME_FIELDS, tips: true };

/** What the renderer used before K8: one title line. The renderer's default when the CLI passes no settings. */
export const MINIMAL_WELCOME: WelcomeSettings = { style: "minimal", logo: "off", fields: WELCOME_FIELDS, tips: false };

export interface WelcomeInfo {
  readonly version: string;
  readonly commit?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly contextWindowTokens?: number | undefined;
  /** `ChatGPT Plus`, `Claude Code`, `OpenAI API`… */
  readonly plan?: string | undefined;
  /** Worker models that differ from the conversation model. */
  readonly workers?: readonly string[] | undefined;
  readonly folder: string;
  /** The workspace path, `~`-shortened (full variant). */
  readonly path?: string | undefined;
  readonly branch?: string | undefined;
  /** `auto`, `ask`, `full`, `plan`. */
  readonly mode?: string | undefined;
  readonly hint?: string | undefined;
  readonly warning?: string | undefined;
}

export interface WelcomeFrame {
  readonly width: number;
  readonly rows: number;
  readonly glyphs: GlyphSet;
  readonly style: Styler;
}

/** Full needs a roomy terminal; compact needs a line worth of room; anything smaller is one line. */
export const FULL_MIN_COLUMNS = 96;
export const FULL_MIN_ROWS = 30;
const COMPACT_MIN_COLUMNS = 40;

export function welcomeVariant(settings: WelcomeSettings, width: number, rows: number): WelcomeStyle {
  if (settings.style === "off" || settings.style === "minimal") return settings.style;
  if (settings.style === "full" && width >= FULL_MIN_COLUMNS && rows >= FULL_MIN_ROWS) return "full";
  return width >= COMPACT_MIN_COLUMNS ? "compact" : "minimal";
}

// ---------------------------------------------------------------------------------------------
// The mark.

interface LogoCell {
  readonly text: string;
  /** 0-2 gradient stop, `line` for the connectors. */
  readonly tone: number | "line";
}

/**
 * The glyph mark, 5 rows × 7 columns, echoing the art: the conductor (◆) on top, the core (●)
 * between the two worker arcs, and the result (◇) below.
 */
function logoCells(glyphs: GlyphSet): LogoCell[][] {
  const set =
    glyphs.name === "ascii"
      ? { top: "@", core: "o", end: "*", tl: "/", tr: "\\", bl: "\\", br: "/", v: "|" }
      : glyphs.name === "safe"
        ? { top: "■", core: "●", end: "○", tl: "┌", tr: "┐", bl: "└", br: "┘", v: "│" }
        : { top: "◆", core: "●", end: "◇", tl: "╭", tr: "╮", bl: "╰", br: "╯", v: "│" };
  return [
    [{ text: "   ", tone: 0 }, { text: set.top, tone: 0 }],
    [{ text: " ", tone: 0 }, { text: set.tl, tone: 0 }, { text: "   ", tone: 0 }, { text: set.tr, tone: 0 }],
    [
      { text: set.v, tone: 1 },
      { text: "  ", tone: 1 },
      { text: set.core, tone: 1 },
      { text: "  ", tone: 1 },
      { text: set.v, tone: 1 },
    ],
    [{ text: " ", tone: 2 }, { text: set.bl, tone: 2 }, { text: "   ", tone: 2 }, { text: set.br, tone: 2 }],
    [{ text: "   ", tone: 2 }, { text: set.end, tone: 2 }],
  ];
}

export const LOGO_WIDTH = 7;

/**
 * The painted mark (or a custom text-art logo painted with the gradient row by row). `art` uses the
 * half-block art when the styler has colour for it (truecolor or 256 colours with the rich glyph
 * set); otherwise, and for `glyph`, the glyph mark.
 */
export function logoLines(frame: Pick<WelcomeFrame, "glyphs" | "style">, custom?: readonly string[], kind: "art" | "glyph" = "glyph"): { readonly lines: string[]; readonly width: number } {
  const { style } = frame;
  const art = kind === "art" && frame.glyphs.name === "rich" ? style.logoArt?.() : undefined;
  if (art !== undefined && custom === undefined) return { lines: [...art], width: ART_COLUMNS };
  if (custom !== undefined && custom.length > 0) {
    const rows = custom.slice(0, 6).map((line) => truncate(sanitizeInline(line, 200).replace(/\s+$/, ""), 32, ""));
    const width = Math.max(...rows.map((row) => displayWidth(row)));
    const stop = (index: number): number => (rows.length <= 1 ? 0 : Math.round((index / (rows.length - 1)) * 2));
    return { lines: rows.map((row, index) => style.logo(stop(index), row)), width };
  }
  const lines = logoCells(frame.glyphs).map((cells) =>
    cells.map((cell) => (cell.tone === "line" ? style.border(cell.text) : cell.text.trim() === "" ? cell.text : style.bold(style.logo(cell.tone, cell.text)))).join(""),
  );
  return { lines, width: LOGO_WIDTH };
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers.

export function formatContextWindow(tokens: number | undefined): string | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`;
  return `${Math.round(tokens / 1000)}k context`;
}

function modeText(mode: string | undefined): string | undefined {
  if (mode === undefined || mode === "") return undefined;
  return mode === "full" ? "full access" : `${mode} mode`;
}

function paintMode(style: Styler, mode: string | undefined, text: string): string {
  return mode === "full" ? style.bold(style.danger(text)) : mode === "plan" ? style.accent(text) : mode === "ask" ? style.warning(text) : style.muted(text);
}

/** Paints `/commands` and key names in a hint with the accent, the rest muted. */
export function paintHint(style: Styler, text: string): string {
  return text
    .split(/(\s+)/)
    .map((word) => (/^(\/[a-z][\w-]*|@|Shift\+Tab|Ctrl\+[A-Z]|Esc)$/.test(word) ? style.accent(word) : style.muted(word)))
    .join("");
}

interface Part {
  readonly plain: string;
  readonly painted: string;
  /** 0 never drops; lower drops first. */
  readonly drop: number;
  /** Joined to the previous part with a space instead of the separator (`Synorch v0.4.0-beta.0`). */
  readonly glue?: boolean;
}

function joinParts(parts: readonly Part[], width: number, sep: string, style: Styler): string {
  let shown = parts.filter((part) => part.plain !== "");
  const join = (list: readonly Part[], key: "plain" | "painted"): string =>
    list.map((part, index) => `${index === 0 ? "" : part.glue === true ? " " : key === "plain" ? ` ${sep} ` : style.muted(` ${sep} `)}${part[key]}`).join("");
  const measure = (): number => displayWidth(join(shown, "plain"));
  while (measure() > width) {
    const candidates = shown.filter((part) => part.drop > 0);
    if (candidates.length === 0) break;
    const first = candidates.reduce((low, part) => (part.drop < low.drop ? part : low));
    shown = shown.filter((part) => part !== first);
  }
  return join(shown, "painted");
}

const has = (settings: WelcomeSettings, field: WelcomeField): boolean => settings.fields.includes(field);

// ---------------------------------------------------------------------------------------------
// Variants.

function minimalLines(info: WelcomeInfo, frame: WelcomeFrame): string[] {
  const { style, glyphs: g } = frame;
  // Byte-compatible with the pre-K8 title line.
  const title = `${style.bold(style.cyan("Synorch"))}${info.version === "" ? "" : style.dim(` ${info.version}`)} ${style.dim(g.sep)} ${style.bold(info.folder)}${info.branch === undefined ? "" : style.dim(` (${info.branch})`)}`;
  return [title];
}

function compactLines(info: WelcomeInfo, settings: WelcomeSettings, frame: WelcomeFrame): string[] {
  const { style, glyphs: g, width } = frame;
  const mark = settings.logo === "off" ? "" : `${style.bold(style.logo(0, g.name === "ascii" ? "@" : g.name === "safe" ? "■" : "◆"))} `;
  const markWidth = settings.logo === "off" ? 0 : 2;
  const parts: Part[] = [{ plain: "Synorch", painted: style.bold(style.accent("Synorch")), drop: 0 }];
  if (has(settings, "version") && info.version !== "") parts.push({ plain: `v${info.version}`, painted: style.muted(`v${info.version}`), drop: 3, glue: true });
  if (has(settings, "model") && info.model !== undefined) {
    parts.push({ plain: info.model, painted: style.bold(style.accent(info.model)), drop: 7 });
    if (info.effort !== undefined) parts.push({ plain: info.effort, painted: style.secondary(info.effort), drop: 5 });
  }
  if (has(settings, "plan") && info.plan !== undefined) parts.push({ plain: info.plan, painted: style.muted(info.plan), drop: 2 });
  if (has(settings, "workers") && info.workers !== undefined && info.workers.length > 0) {
    const text = `workers ${info.workers.join(", ")}`;
    parts.push({ plain: text, painted: `${style.muted("workers")} ${style.secondary(info.workers.join(", "))}`, drop: 1 });
  }
  if (has(settings, "folder")) {
    const folder = `${info.folder}${info.branch === undefined ? "" : ` (${info.branch})`}`;
    parts.push({ plain: folder, painted: `${style.bold(info.folder)}${info.branch === undefined ? "" : style.secondary(` (${info.branch})`)}`, drop: 6 });
  }
  const mode = modeText(info.mode);
  if (has(settings, "mode") && mode !== undefined) parts.push({ plain: mode, painted: paintMode(style, info.mode, mode), drop: 0 });
  const lines = [`${mark}${joinParts(parts, width - markWidth, g.sep, style)}`];
  if (settings.tips && info.hint !== undefined && info.hint !== "") lines.push(`${" ".repeat(markWidth)}${paintHint(style, `${g.name === "ascii" ? ">" : "›"} ${info.hint}`)}`);
  return lines;
}

function fullLines(info: WelcomeInfo, settings: WelcomeSettings, frame: WelcomeFrame): string[] {
  const { style, glyphs: g, width } = frame;
  const sep = style.muted(` ${g.sep} `);
  const infoLines: string[] = [];
  const title = `${style.bold(style.accent("Synorch"))}${has(settings, "version") && info.version !== "" ? ` ${style.bold(`v${info.version}`)}${info.commit === undefined ? "" : style.muted(` (${info.commit})`)}` : ""}`;
  infoLines.push(title);
  const modelParts: string[] = [];
  if (has(settings, "model") && info.model !== undefined) {
    modelParts.push(style.bold(style.accent(info.model)));
    if (info.effort !== undefined) modelParts.push(style.secondary(info.effort));
    const context = formatContextWindow(info.contextWindowTokens);
    if (context !== undefined) modelParts.push(style.muted(context));
  }
  if (has(settings, "plan") && info.plan !== undefined) modelParts.push(style.muted(info.plan));
  if (modelParts.length > 0) infoLines.push(modelParts.join(sep));
  if (has(settings, "workers") && info.workers !== undefined && info.workers.length > 0) infoLines.push(`${style.muted("workers")} ${info.workers.map((worker) => style.secondary(worker)).join(sep)}`);
  const placeParts: string[] = [];
  if (has(settings, "folder")) placeParts.push(`${style.bold(info.path ?? info.folder)}${info.branch === undefined ? "" : style.secondary(` (${info.branch})`)}`);
  const mode = modeText(info.mode);
  if (has(settings, "mode") && mode !== undefined) placeParts.push(paintMode(style, info.mode, mode));
  if (placeParts.length > 0) infoLines.push(placeParts.join(sep));
  const hint = settings.tips && info.hint !== undefined && info.hint !== "" ? paintHint(style, `${g.name === "ascii" ? ">" : "›"} ${info.hint}`) : undefined;

  const logo = settings.logo === "off" ? undefined : logoLines(frame, settings.logo === "custom" ? settings.customLogo : undefined, settings.logo === "glyph" ? "glyph" : "art");
  if (logo === undefined) return [...infoLines, ...(hint === undefined ? [] : [hint])];
  const gap = 3;
  const column = logo.width + gap;
  const room = Math.max(10, width - column);
  // The info rows and the hint, vertically centred beside the mark.
  const block = [...infoLines, ...(hint === undefined ? [] : [hint])];
  const rowCount = Math.max(logo.lines.length, block.length);
  const offset = Math.floor((rowCount - block.length) / 2);
  const right: string[] = Array.from({ length: rowCount }, (_, index) => block[index - offset] ?? "");
  return right.map((text, index) => {
    const left = logo.lines[index] ?? "";
    const pad = " ".repeat(Math.max(0, logo.width - displayWidth(left)) + gap);
    return `${left}${text === "" ? "" : `${pad}${fitLine(text, room)}`}`;
  });
}

/** The welcome block for the current terminal size; warnings (when any) follow on one line. */
export function renderWelcome(info: WelcomeInfo, settings: WelcomeSettings, frame: WelcomeFrame): string[] {
  const variant = welcomeVariant(settings, frame.width, frame.rows);
  const lines = variant === "off" ? [] : variant === "minimal" ? minimalLines(info, frame) : variant === "compact" ? compactLines(info, settings, frame) : fullLines(info, settings, frame);
  if (info.warning !== undefined) lines.push(frame.style.yellow(info.warning));
  const fitted = lines.map((line) => fitLine(line.trimEnd(), frame.width));
  return frame.glyphs.name === "ascii" ? fitted.map((line) => line.replace(/…/g, ".").replace(/·/g, "-")) : fitted;
}

// ---------------------------------------------------------------------------------------------
// Hints.

export interface HintContext {
  /** No conversation recorded in this workspace yet. */
  readonly firstRun: boolean;
  /** The most recent other conversation, e.g. `2h ago`. */
  readonly resumable?: string | undefined;
  readonly skills?: number | undefined;
  readonly mcpServers?: number | undefined;
  /** Rotation seed (launch time); tests pass a fixed one. */
  readonly seed: number;
  readonly sep: string;
}

/**
 * The one hint under the welcome: the actionable next thing first (first run: how to talk to
 * Synorch; a recent conversation: resume it), otherwise a rotating tip.
 */
export function pickHint(context: HintContext): string {
  const s = context.sep;
  if (context.firstRun) return `Type / for commands ${s} @ attaches files ${s} Shift+Tab switches modes`;
  if (context.resumable !== undefined) return `Conversation from ${context.resumable} ${s} /resume picks it up`;
  const tips = [
    `/theme changes colours ${s} /welcome shapes this screen`,
    `Ctrl+O expands tool output ${s} Esc Esc rewinds`,
    `/model switches models ${s} /effort tunes reasoning`,
    `/workers <goal> runs a big goal with parallel workers`,
    `/usage shows quota and cost ${s} /context what the model saw`,
    `/memory review ${s} what Synorch remembers here`,
    ...(context.skills !== undefined && context.skills > 0 ? [`${context.skills} skill${context.skills === 1 ? "" : "s"} ready ${s} /skills`] : []),
    ...(context.mcpServers !== undefined && context.mcpServers > 0 ? [`${context.mcpServers} MCP server${context.mcpServers === 1 ? "" : "s"} ${s} /mcp`] : []),
  ];
  return tips[Math.abs(Math.floor(context.seed)) % tips.length] ?? tips[0] ?? "";
}

// ---------------------------------------------------------------------------------------------
// Previews (the /theme, /welcome and /setup pickers).

/** A sample of every surface in `style`'s theme: swatches, a user line, a tool row, a diff, an answer, states and the footer. */
export function themePreview(style: Styler, glyphs: GlyphSet, width: number): string[] {
  const g = glyphs;
  const ascii = g.name === "ascii";
  const sep = style.muted(` ${g.sep} `);
  const swatch = ascii ? "#" : "■";
  const mark = logoCells(glyphs)[2]?.map((cell) => (cell.tone === "line" ? cell.text : cell.text.trim() === "" ? cell.text : style.logo(cell.tone, cell.text))).join("") ?? "";
  const lines = [
    `${mark}   ${[style.accent(`${swatch} accent`), style.secondary(`${swatch} secondary`), style.success(`${swatch} success`), style.warning(`${swatch} warning`), style.danger(`${swatch} danger`), style.muted(`${swatch} muted`)].join(" ")}`,
    style.user(`${g.user} Fix the flaky login test`),
    `${style.success(g.ok)} ${style.tool("Edit src/login.ts")}  ${style.muted(`+8 ${g.minus}3`)}`,
    `    ${style.diffRemove(`${g.minus} expect(total).toBe(3)`)}`,
    `    ${style.diffAdd("+ expect(total).toEqual(3)")}`,
    `${style.accent(g.bullet)} Fixed: ${style.code("total")} was compared by reference ${style.heading("# Tests")} ${style.link("docs")}`,
    `${style.accent(`${g.spinner[3] ?? "-"} Thinking${g.ellipsis} 4s`)}  ${style.warning(`${g.warn} ctx 72%`)}  ${style.danger(`${g.fail} 1 failed`)}`,
    `${style.muted("demo")}${sep}${style.secondary("main")}${sep}${style.bold(style.accent("gpt-6-sol"))}${sep}${style.secondary("high")}${sep}auto mode${sep}${style.success("ctx 12%")}`,
  ];
  const fitted = lines.map((line) => fitLine(line, width));
  return ascii ? fitted.map((line) => line.replace(/…/g, ".").replace(/·/g, "-")) : fitted;
}

/** `/home/me/dev/demo` → `~/dev/demo`. */
export function shortenPath(target: string, home: string | undefined): string {
  if (home === undefined || home === "") return target;
  const normalized = target.replace(/\\/g, "/");
  const base = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.toLowerCase() === base.toLowerCase()) return "~";
  if (normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return `~${normalized.slice(base.length)}`;
  return target;
}

/** Parses `ui.welcome.fields` (list or comma text) to known fields; unknown names drop. */
export function welcomeFields(raw: readonly string[] | string | undefined): readonly WelcomeField[] {
  if (raw === undefined) return WELCOME_FIELDS;
  const list = typeof raw === "string" ? raw.split(",") : raw;
  return WELCOME_FIELDS.filter((field) => list.map((entry) => entry.trim()).includes(field));
}
