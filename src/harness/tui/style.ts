import { styleText } from "node:util";
import { ANSI_TOKENS, painter, parseStyleSpec, themePaints, type ColorDepth, type Paint, type ThemeDefinition, type ThemePaints, type ThemeToken } from "./theme.ts";

/**
 * Colour is decided once by `selectColor` and then applied unconditionally: `validateStream` is
 * off because the decision already covered `--color`, config, NO_COLOR and FORCE_COLOR. With colour
 * off every style is the identity, so plain output never contains an SGR byte.
 *
 * K8: the styler paints through the active theme's semantic tokens (`accent`, `muted`, `success`…).
 * The older names stay as aliases (`cyan` = accent, `dim` = muted, `green` = success, `yellow` =
 * warning, `red` = danger, `magenta` = secondary). Without a theme the tokens are the 16-colour ANSI
 * mapping, byte-identical to the former `styleText` output. The theme can be swapped at runtime
 * (`/theme`); components paint at render time, so a re-render restyles the whole screen.
 */

export interface Styler {
  readonly enabled: boolean;
  /** Name of the active theme (`ansi` when none was given). */
  readonly themeName: string;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
  accent(text: string): string;
  secondary(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  danger(text: string): string;
  user(text: string): string;
  tool(text: string): string;
  code(text: string): string;
  heading(text: string): string;
  link(text: string): string;
  diffAdd(text: string): string;
  diffRemove(text: string): string;
  border(text: string): string;
  /** Logo gradient stop 0-2. */
  logo(stop: number, text: string): string;
  token(name: ThemeToken, text: string): string;
}

export interface ThemedStyler extends Styler {
  /** Swaps the palette; every later paint uses it. */
  setTheme(theme: ThemeDefinition | undefined, depth?: ColorDepth): void;
  readonly depth: ColorDepth;
}

type Format = Parameters<typeof styleText>[0];

export interface StylerOptions {
  readonly theme?: ThemeDefinition | undefined;
  readonly depth?: ColorDepth | undefined;
}

function ansiPaints(): ThemePaints {
  const out = {} as Record<ThemeToken, Paint>;
  for (const [token, spec] of Object.entries(ANSI_TOKENS)) out[token as ThemeToken] = painter(parseStyleSpec(spec).spec, 16);
  return out;
}

export function createStyler(enabled: boolean, options: StylerOptions = {}): ThemedStyler {
  const legacy = (format: Format) => (text: string) => (enabled && text.length > 0 ? styleText(format, text, { validateStream: false }) : text);
  let paints: ThemePaints = ansiPaints();
  let themeName = "ansi";
  let depth: ColorDepth = options.depth ?? 16;
  const apply = (theme: ThemeDefinition | undefined, nextDepth?: ColorDepth): void => {
    if (nextDepth !== undefined) depth = nextDepth;
    paints = theme === undefined ? ansiPaints() : themePaints(theme, depth);
    themeName = theme?.name ?? "ansi";
  };
  apply(options.theme, options.depth);
  const token =
    (name: ThemeToken) =>
    (text: string): string =>
      enabled && text.length > 0 ? paints[name](text) : text;
  const bold = legacy("bold");
  return {
    enabled,
    get themeName() {
      return themeName;
    },
    get depth() {
      return depth;
    },
    setTheme: apply,
    bold,
    dim: token("muted"),
    red: token("danger"),
    green: token("success"),
    yellow: token("warning"),
    cyan: token("accent"),
    magenta: token("secondary"),
    accent: token("accent"),
    secondary: token("secondary"),
    muted: token("muted"),
    success: token("success"),
    warning: token("warning"),
    danger: token("danger"),
    user: token("user"),
    tool: token("tool"),
    code: token("code"),
    heading: token("heading"),
    link: token("link"),
    diffAdd: token("diffAdd"),
    diffRemove: token("diffRemove"),
    border: token("border"),
    logo: (stop, text) => token(stop <= 0 ? "logo1" : stop === 1 ? "logo2" : "logo3")(text),
    token: (name, text) => token(name)(text),
  };
}
