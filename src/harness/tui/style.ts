import { styleText } from "node:util";

/**
 * Colour is decided once by `selectColor` and then applied unconditionally: `validateStream` is
 * off because the decision already covered `--color`, config, NO_COLOR and FORCE_COLOR. With colour
 * off every style is the identity, so plain output never contains an SGR byte.
 */

export interface Styler {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
}

type Format = Parameters<typeof styleText>[0];

export function createStyler(enabled: boolean): Styler {
  const paint = (format: Format) => (text: string) => (enabled && text.length > 0 ? styleText(format, text, { validateStream: false }) : text);
  return {
    enabled,
    bold: paint("bold"),
    dim: paint("dim"),
    red: paint("red"),
    green: paint("green"),
    yellow: paint("yellow"),
    cyan: paint("cyan"),
    magenta: paint("magenta"),
  };
}
