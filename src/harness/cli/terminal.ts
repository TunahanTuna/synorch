import { selectColor, selectRendererKind, type RendererKind } from "../contracts/index.ts";
import type { ColorMode } from "./args.ts";

/**
 * Renderer and colour selection for one invocation (CLI contract §3). `agent` never runs in JSONL:
 * it is interactive by definition and falls back to plain lines without a terminal. Colour is
 * decided against the stream the renderer writes human text to (stdout, or stderr in JSONL mode).
 */

export interface TerminalFacts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stdoutHasColors: boolean;
  readonly stderrHasColors: boolean;
}

export interface TerminalRequest {
  readonly jsonl: boolean;
  readonly plain: boolean;
  readonly color: ColorMode;
  /** From user/workspace config once I5 stage B wires configuration; undefined until then. */
  readonly configColor?: boolean | undefined;
}

export interface TerminalSettings {
  readonly kind: RendererKind;
  readonly color: boolean;
}

export function resolveTerminalSettings(request: TerminalRequest, facts: TerminalFacts): TerminalSettings {
  const kind = selectRendererKind({
    jsonl: request.jsonl,
    plain: request.plain,
    env: facts.env,
    stdinIsTTY: facts.stdinIsTTY,
    stdoutIsTTY: facts.stdoutIsTTY,
  });
  const color = selectColor({
    flag: request.color,
    config: request.configColor,
    env: facts.env,
    streamHasColors: kind === "jsonl" ? facts.stderrHasColors : facts.stdoutHasColors,
  });
  return { kind, color };
}

export interface ColorCapableStream {
  readonly isTTY?: boolean;
  hasColors?(): boolean;
}

export function streamHasColors(stream: ColorCapableStream): boolean {
  return stream.isTTY === true && typeof stream.hasColors === "function" && stream.hasColors();
}
