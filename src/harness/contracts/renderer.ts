import type { AuthInteraction } from "./auth.ts";
import type { SessionEvent } from "./events.ts";
import type { ModelStreamEvent } from "./model.ts";
import type { ApprovalBroker } from "./policy.ts";

/**
 * The terminal port (ADR-04). Renderers only consume events; they never own task state. The
 * interactive renderer is the only module allowed to import `@earendil-works/pi-tui`; the plain
 * and JSONL renderers have no dependencies and are selected whenever there is no TTY.
 */

export const RENDERER_KINDS = ["tui", "plain", "jsonl"] as const;
export type RendererKind = (typeof RENDERER_KINDS)[number];

export interface StatusLine {
  readonly runId: string | undefined;
  readonly task: string | undefined;
  readonly model: string | undefined;
  readonly step: string | undefined;
  readonly budgetUsed: string | undefined;
  readonly budgetLimit: string | undefined;
  readonly workersRunning: number;
  readonly pendingApproval: string | undefined;
  readonly lastVerification: string | undefined;
}

export interface SessionHeaderView {
  readonly workspaceRoot: string;
  readonly gitBranch: string | undefined;
  readonly policyMode: "autonomous" | "ask";
  readonly routes: readonly { readonly tier: string; readonly model: string; readonly source: string }[];
  readonly sandboxEnforcement: "full" | "partial" | "unavailable";
  readonly notices: readonly string[];
}

export type RenderEvent =
  | { readonly kind: "session-event"; readonly event: SessionEvent }
  | { readonly kind: "stream"; readonly requestId: string; readonly event: ModelStreamEvent }
  | { readonly kind: "status"; readonly status: StatusLine }
  | { readonly kind: "notice"; readonly level: "info" | "warning" | "error"; readonly message: string };

export interface UserInputSource {
  /** Resolves with the next submitted message; Ctrl+C first cancels the active request (ADR-04). */
  next(signal: AbortSignal): Promise<{ readonly kind: "message" | "command"; readonly text: string } | { readonly kind: "interrupt" | "exit" }>;
}

export interface TerminalRenderer {
  readonly kind: RendererKind;
  start(header: SessionHeaderView): Promise<void>;
  /** Must not block the agent: implementations queue and coalesce, bounded, and drop only deltas. */
  render(event: RenderEvent): void;
  readonly input: UserInputSource | undefined;
  readonly approvals: ApprovalBroker;
  readonly auth: AuthInteraction;
  stop(reason: "completed" | "error" | "signal"): Promise<void>;
}

export interface RendererSelectionInput {
  readonly jsonl: boolean;
  readonly plain: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

/** Mode rule from the cross-platform checklist: jsonl > plain triggers > interactive TUI. */
export function selectRendererKind(input: RendererSelectionInput): RendererKind {
  if (input.jsonl) return "jsonl";
  const plainEnv = input.env.SYN_PLAIN;
  if (
    input.plain ||
    (plainEnv !== undefined && plainEnv !== "" && plainEnv !== "0") ||
    input.env.TERM === "dumb" ||
    !input.stdinIsTTY ||
    !input.stdoutIsTTY
  ) {
    return "plain";
  }
  return "tui";
}

export interface ColorSelectionInput {
  readonly flag: "always" | "never" | "auto";
  readonly config: boolean | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly streamHasColors: boolean;
}

/** `--color` > config > NO_COLOR (non-empty) > FORCE_COLOR > the stream's own capability. */
export function selectColor(input: ColorSelectionInput): boolean {
  if (input.flag !== "auto") return input.flag === "always";
  if (input.config !== undefined) return input.config;
  const noColor = input.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  const force = input.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  return input.streamHasColors;
}
