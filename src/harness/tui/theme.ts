/**
 * K8 themes: a theme is a set of semantic colour tokens every TUI view paints through (transcript,
 * tool rows, board, graph, modal, footer, welcome). A token is a small style spec — `#88c0d0`,
 * `#88c0d0 bold`, `cyan`, `dim`, `bold underline` — resolved per colour depth: truecolor uses the
 * hex value, 256 colours its nearest xterm index, 16 colours the terminal's own palette (the
 * `ansi` column, TUI §11.2), so light and dark terminal schemes keep working. With colour off
 * (NO_COLOR, `--color never`) every token is the identity.
 */

export const THEME_TOKENS = [
  "text",
  "accent",
  "secondary",
  "muted",
  "success",
  "warning",
  "danger",
  "user",
  "tool",
  "code",
  "heading",
  "link",
  "diffAdd",
  "diffRemove",
  "border",
  "logo1",
  "logo2",
  "logo3",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export type ColorDepth = 16 | 256 | 24;

export interface ThemeDefinition {
  readonly name: string;
  readonly description: string;
  /** Built for a dark (true) or light (false) terminal background. */
  readonly dark: boolean;
  /** Truecolor / 256-colour specs. */
  readonly tokens: Readonly<Record<ThemeToken, string>>;
  /** 16-colour specs (the terminal's palette); unset tokens use the shared ANSI mapping. */
  readonly ansi?: Partial<Readonly<Record<ThemeToken, string>>>;
  /** Loaded from `<synorch home>/themes/<name>.yaml`. */
  readonly custom?: boolean;
}

/** The 16-colour mapping of TUI §11.2; also the whole of a theme at depth 16 unless it overrides a token. */
export const ANSI_TOKENS: Readonly<Record<ThemeToken, string>> = {
  text: "",
  accent: "cyan",
  secondary: "magenta",
  muted: "dim",
  success: "green",
  warning: "yellow",
  danger: "red",
  user: "bold",
  tool: "bold",
  code: "yellow",
  heading: "cyan bold",
  link: "cyan",
  diffAdd: "green",
  diffRemove: "red",
  border: "dim",
  logo1: "cyan",
  logo2: "blue",
  logo3: "magenta",
};

function palette(tokens: Omit<Record<ThemeToken, string>, "text" | "heading" | "link" | "diffAdd" | "diffRemove"> & Partial<Record<ThemeToken, string>>): Record<ThemeToken, string> {
  return {
    text: "",
    heading: `${tokens.accent} bold`,
    link: tokens.accent,
    diffAdd: tokens.success,
    diffRemove: tokens.danger,
    ...tokens,
  };
}

export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  {
    name: "synorch",
    description: "default dark: teal conductor, violet workers",
    dark: true,
    tokens: palette({
      accent: "#4fd1c5",
      secondary: "#b794f4",
      muted: "#7c8594",
      success: "#7bd88f",
      warning: "#f2c265",
      danger: "#f47c7c",
      user: "bold",
      tool: "bold",
      code: "#f0b878",
      border: "#4b5563",
      logo1: "#4fd1c5",
      logo2: "#63b3ed",
      logo3: "#b794f4",
    }),
  },
  {
    name: "light",
    description: "for light terminal backgrounds",
    dark: false,
    tokens: palette({
      accent: "#0b7285",
      secondary: "#7048e8",
      muted: "#6b7280",
      success: "#2b8a3e",
      warning: "#b35c00",
      danger: "#c92a2a",
      user: "bold",
      tool: "bold",
      code: "#a61e4d",
      border: "#adb5bd",
      logo1: "#0b7285",
      logo2: "#1c7ed6",
      logo3: "#7048e8",
    }),
    ansi: { code: "magenta", logo2: "blue" },
  },
  {
    name: "high-contrast",
    description: "bright, bold and never dim",
    dark: true,
    tokens: palette({
      accent: "#00ffff bold",
      secondary: "#ff87ff",
      muted: "#d0d0d0",
      success: "#00ff5f bold",
      warning: "#ffff00 bold",
      danger: "#ff5f5f bold",
      user: "bold",
      tool: "bold",
      code: "#ffd75f",
      border: "#ffffff",
      logo1: "#00ffff",
      logo2: "#ffffff",
      logo3: "#ff87ff",
      diffAdd: "#00ff5f",
      diffRemove: "#ff5f5f",
    }),
    ansi: {
      accent: "cyanBright bold",
      secondary: "magentaBright",
      muted: "white",
      success: "greenBright bold",
      warning: "yellowBright bold",
      danger: "redBright bold",
      heading: "cyanBright bold underline",
      code: "yellowBright",
      diffAdd: "greenBright",
      diffRemove: "redBright",
      border: "white",
      logo1: "cyanBright",
      logo2: "whiteBright",
      logo3: "magentaBright",
    },
  },
  {
    name: "mono",
    description: "no colour, only bold / dim / italic",
    dark: true,
    tokens: {
      text: "",
      accent: "bold",
      secondary: "italic",
      muted: "dim",
      success: "",
      warning: "bold",
      danger: "bold",
      user: "bold",
      tool: "bold",
      code: "italic",
      heading: "bold underline",
      link: "underline",
      diffAdd: "",
      diffRemove: "dim",
      border: "dim",
      logo1: "bold",
      logo2: "",
      logo3: "dim",
    },
    ansi: {
      text: "",
      accent: "bold",
      secondary: "italic",
      muted: "dim",
      success: "",
      warning: "bold",
      danger: "bold",
      user: "bold",
      tool: "bold",
      code: "italic",
      heading: "bold underline",
      link: "underline",
      diffAdd: "",
      diffRemove: "dim",
      border: "dim",
      logo1: "bold",
      logo2: "",
      logo3: "dim",
    },
  },
  {
    name: "nord",
    description: "arctic blues (Nord)",
    dark: true,
    tokens: palette({
      accent: "#88c0d0",
      secondary: "#b48ead",
      muted: "#7b88a1",
      success: "#a3be8c",
      warning: "#ebcb8b",
      danger: "#bf616a",
      user: "bold",
      tool: "bold",
      code: "#d08770",
      border: "#4c566a",
      logo1: "#8fbcbb",
      logo2: "#88c0d0",
      logo3: "#81a1c1",
    }),
    ansi: { logo2: "cyan", logo3: "blue" },
  },
  {
    name: "dracula",
    description: "neon on purple-grey (Dracula)",
    dark: true,
    tokens: palette({
      accent: "#8be9fd",
      secondary: "#bd93f9",
      muted: "#7c86b8",
      success: "#50fa7b",
      warning: "#f1fa8c",
      danger: "#ff5555",
      user: "bold",
      tool: "bold",
      code: "#ffb86c",
      heading: "#ff79c6 bold",
      border: "#6272a4",
      logo1: "#ff79c6",
      logo2: "#bd93f9",
      logo3: "#8be9fd",
    }),
    ansi: { logo1: "magenta", logo2: "blue", logo3: "cyan" },
  },
  {
    name: "gruvbox",
    description: "warm retro (Gruvbox dark)",
    dark: true,
    tokens: palette({
      accent: "#83a598",
      secondary: "#d3869b",
      muted: "#928374",
      success: "#b8bb26",
      warning: "#fabd2f",
      danger: "#fb4934",
      user: "bold",
      tool: "bold",
      code: "#fe8019",
      heading: "#fabd2f bold",
      border: "#665c54",
      logo1: "#fabd2f",
      logo2: "#fe8019",
      logo3: "#fb4934",
    }),
    ansi: { logo1: "yellow", logo2: "red", logo3: "magenta" },
  },
  {
    name: "catppuccin",
    description: "soft pastels (Catppuccin Mocha)",
    dark: true,
    tokens: palette({
      accent: "#89b4fa",
      secondary: "#cba6f7",
      muted: "#7f849c",
      success: "#a6e3a1",
      warning: "#f9e2af",
      danger: "#f38ba8",
      user: "bold",
      tool: "bold",
      code: "#fab387",
      border: "#585b70",
      logo1: "#f5c2e7",
      logo2: "#cba6f7",
      logo3: "#89b4fa",
    }),
    ansi: { accent: "blue", heading: "blue bold", link: "blue", logo1: "magenta", logo2: "magenta", logo3: "blue" },
  },
];

export const DEFAULT_THEME = "synorch";

export function builtinTheme(name: string): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((theme) => theme.name === name);
}

/**
 * `COLORFGBG` (xterm, rxvt, Konsole, some others) names the background's palette index; 7 and 15
 * are light. Used only to pick `light` when no theme is configured.
 */
export function prefersLightTheme(env: Readonly<Record<string, string | undefined>>): boolean {
  const background = env.COLORFGBG?.split(";").at(-1);
  return background === "7" || background === "15";
}

/** The theme to start with: the configured one, else `light` on a light terminal, else the default. */
export function defaultThemeName(env: Readonly<Record<string, string | undefined>>): string {
  return prefersLightTheme(env) ? "light" : DEFAULT_THEME;
}

/**
 * Colour depth of the terminal: `SYN_COLOR_DEPTH` (16, 256, 24/truecolor) > `FORCE_COLOR` 1-3 >
 * `COLORTERM=truecolor|24bit` > terminals known to render truecolor (Windows Terminal, VS Code,
 * iTerm2, WezTerm, Ghostty, Kitty…) > `TERM=*256color*` > 16.
 */
export function detectColorDepth(env: Readonly<Record<string, string | undefined>>, platform: string = process.platform): ColorDepth {
  const wanted = env.SYN_COLOR_DEPTH?.trim().toLowerCase();
  if (wanted === "16") return 16;
  if (wanted === "256") return 256;
  if (wanted === "24" || wanted === "truecolor" || wanted === "24bit") return 24;
  const force = env.FORCE_COLOR;
  if (force === "3") return 24;
  if (force === "2") return 256;
  if (force === "1") return 16;
  const colorterm = env.COLORTERM?.toLowerCase() ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== "") return 24;
  const program = env.TERM_PROGRAM ?? "";
  if (["vscode", "iTerm.app", "WezTerm", "ghostty", "Hyper", "Tabby", "rio"].includes(program)) return 24;
  const term = env.TERM ?? "";
  if (term === "xterm-kitty" || term === "xterm-ghostty" || term === "alacritty" || term.includes("truecolor") || term.includes("direct")) return 24;
  if (term === "linux" || term === "dumb") return 16;
  if (term.includes("256")) return 256;
  // Windows 10+ conhost renders 256 colours and truecolor through VT; keep 256 for its limited fonts.
  if (platform === "win32") return 256;
  return 16;
}

// ---------------------------------------------------------------------------------------------
// Style specs → SGR.

const ANSI_FG: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackBright: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97,
};

const MODIFIERS: Readonly<Record<string, readonly [number, number]>> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
};

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

export interface StyleSpec {
  readonly color?: { readonly kind: "hex"; readonly rgb: readonly [number, number, number] } | { readonly kind: "ansi"; readonly code: number };
  readonly modifiers: readonly (keyof typeof MODIFIERS)[];
}

function parseHex(text: string): readonly [number, number, number] | undefined {
  const match = HEX.exec(text);
  if (match === null) return undefined;
  let digits = match[1] ?? "";
  if (digits.length === 3) digits = [...digits].map((char) => char + char).join("");
  return [Number.parseInt(digits.slice(0, 2), 16), Number.parseInt(digits.slice(2, 4), 16), Number.parseInt(digits.slice(4, 6), 16)];
}

/** Parses `#88c0d0 bold`, `cyan`, `dim italic`; unknown words are reported. */
export function parseStyleSpec(spec: string): { readonly spec: StyleSpec; readonly unknown: readonly string[] } {
  let color: StyleSpec["color"];
  const modifiers: (keyof typeof MODIFIERS)[] = [];
  const unknown: string[] = [];
  for (const word of spec.trim().split(/\s+/).filter((part) => part !== "")) {
    const rgb = parseHex(word);
    if (rgb !== undefined) {
      color = { kind: "hex", rgb };
      continue;
    }
    const code = ANSI_FG[word] ?? ANSI_FG[word.toLowerCase()];
    if (code !== undefined) {
      color = { kind: "ansi", code };
      continue;
    }
    const modifier = word.toLowerCase();
    if (modifier in MODIFIERS) {
      modifiers.push(modifier as keyof typeof MODIFIERS);
      continue;
    }
    if (word === "default" || word === "none") continue;
    unknown.push(word);
  }
  return { spec: { ...(color === undefined ? {} : { color }), modifiers }, unknown };
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** The nearest xterm-256 index of an RGB colour (6×6×6 cube or the grey ramp). */
export function toXterm256(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb;
  const nearest = (value: number): number => {
    let best = 0;
    for (let index = 1; index < CUBE.length; index += 1) if (Math.abs((CUBE[index] ?? 0) - value) < Math.abs((CUBE[best] ?? 0) - value)) best = index;
    return best;
  };
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cube = [CUBE[ri] ?? 0, CUBE[gi] ?? 0, CUBE[bi] ?? 0];
  const grey = Math.round((r + g + b) / 3);
  const greyIndex = grey < 8 ? 0 : grey > 238 ? 23 : Math.round((grey - 8) / 10);
  const greyValue = 8 + greyIndex * 10;
  const distance = (a: readonly number[]): number => (a[0]! - r) ** 2 + (a[1]! - g) ** 2 + (a[2]! - b) ** 2;
  return distance([greyValue, greyValue, greyValue]) < distance(cube) ? 232 + greyIndex : 16 + 36 * ri + 6 * gi + bi;
}

export type Paint = (text: string) => string;

const identity: Paint = (text) => text;

/** A painter for one spec at one depth; the empty spec is the identity. */
export function painter(spec: StyleSpec, depth: ColorDepth): Paint {
  const open: number[][] = [];
  const close: number[] = [];
  const color = spec.color;
  if (color !== undefined) {
    if (color.kind === "ansi") open.push([color.code]);
    else if (depth === 24) open.push([38, 2, ...color.rgb]);
    else open.push([38, 5, toXterm256(color.rgb)]);
    close.push(39);
  }
  for (const modifier of spec.modifiers) {
    const [on, off] = MODIFIERS[modifier] ?? [0, 0];
    open.push([on]);
    close.push(off);
  }
  if (open.length === 0) return identity;
  // One SGR per attribute, closed in reverse: the same byte shape `util.styleText` writes.
  const head = open.map((codes) => `\x1b[${codes.join(";")}m`).join("");
  const tail = [...close].reverse().map((code) => `\x1b[${code}m`).join("");
  return (text) => (text.length === 0 ? text : `${head}${text}${tail}`);
}

export type ThemePaints = Readonly<Record<ThemeToken, Paint>>;

/** Every token of `theme` as a painter at `depth` (16: the theme's `ansi` specs over the shared mapping). */
export function themePaints(theme: ThemeDefinition, depth: ColorDepth): ThemePaints {
  const out = {} as Record<ThemeToken, Paint>;
  for (const token of THEME_TOKENS) {
    const source = depth === 16 ? (theme.ansi?.[token] ?? ANSI_TOKENS[token]) : theme.tokens[token];
    out[token] = painter(parseStyleSpec(source).spec, depth);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Custom themes (`<synorch home>/themes/<name>.yaml`).

export const THEME_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * A user theme from its parsed YAML: `extends: <theme>` (default `synorch`), optional
 * `description`, and `tokens:` overriding any token (`logo:` may list up to three logo colours).
 * Problems come back as messages; the theme still loads with the valid tokens.
 */
export function customTheme(name: string, raw: unknown, known: readonly ThemeDefinition[]): { readonly theme: ThemeDefinition | undefined; readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (!THEME_NAME.test(name)) return { theme: undefined, problems: [`theme file name "${name}" must be lower-case letters, digits and dashes`] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { theme: undefined, problems: [`themes/${name}.yaml must be a mapping (extends, description, tokens)`] };
  const record = raw as Record<string, unknown>;
  const baseName = typeof record.extends === "string" ? record.extends : DEFAULT_THEME;
  const base = known.find((theme) => theme.name === baseName);
  if (base === undefined) problems.push(`themes/${name}.yaml extends unknown theme "${baseName}"; using ${DEFAULT_THEME}`);
  const parent = base ?? builtinTheme(DEFAULT_THEME)!;
  const tokens: Record<ThemeToken, string> = { ...parent.tokens };
  const ansi: Partial<Record<ThemeToken, string>> = { ...(parent.ansi ?? {}) };
  const overrides = record.tokens ?? {};
  if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (key === "logo" && Array.isArray(value)) {
        value.slice(0, 3).forEach((entry, index) => {
          if (typeof entry === "string") tokens[`logo${index + 1}` as ThemeToken] = entry;
        });
        continue;
      }
      if (!(THEME_TOKENS as readonly string[]).includes(key)) {
        problems.push(`themes/${name}.yaml: unknown token "${key}" (known: ${THEME_TOKENS.join(", ")})`);
        continue;
      }
      if (typeof value !== "string") {
        problems.push(`themes/${name}.yaml: token ${key} must be a string like "#88c0d0 bold"`);
        continue;
      }
      const parsed = parseStyleSpec(value);
      if (parsed.unknown.length > 0) problems.push(`themes/${name}.yaml: token ${key} has unknown word(s) ${parsed.unknown.join(", ")}`);
      tokens[key as ThemeToken] = value;
      // A named ANSI colour or a pure modifier also applies at 16 colours; a hex colour keeps the base's ANSI entry.
      if (parsed.spec.color?.kind !== "hex") ansi[key as ThemeToken] = value;
    }
  }
  const description = typeof record.description === "string" ? record.description.slice(0, 80) : `custom, based on ${parent.name}`;
  const dark = typeof record.dark === "boolean" ? record.dark : parent.dark;
  return { theme: { name, description, dark, tokens, ansi, custom: true }, problems };
}
