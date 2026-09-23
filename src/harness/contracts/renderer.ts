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
  /** Conversation view (ADR-21): harness version, the conversation model's short name and its context window. */
  readonly version?: string;
  readonly model?: string;
  readonly contextWindowTokens?: number;
}

export type RenderEvent =
  | { readonly kind: "session-event"; readonly event: SessionEvent }
  | { readonly kind: "stream"; readonly requestId: string; readonly event: ModelStreamEvent }
  | { readonly kind: "status"; readonly status: StatusLine }
  | { readonly kind: "notice"; readonly level: "info" | "warning" | "error"; readonly message: string };

/**
 * One row of the `/` command palette (K1-U1). The session owns the command list and pushes it with
 * `InteractiveInputControls.setCommands`; the renderer only filters, shows and completes it.
 *
 * @example { name: "plan", description: "plan a large goal with parallel workers", argsHint: "<goal>" }
 */
export interface CommandPaletteEntry {
  /** Without the leading slash: `plan`, `model`. */
  readonly name: string;
  /** One line, shown dim next to the name. */
  readonly description: string;
  /**
   * Argument hint shown after the name. `<required>` hints make Enter complete the command (so the
   * argument can be typed) instead of submitting it; `[optional]` hints submit on Enter.
   */
  readonly argsHint?: string;
  readonly aliases?: readonly string[];
}

export const ATTACHMENT_KINDS = ["file", "directory", "image"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * Context the user attached to a message (K1-U1 → U2): `@path` mentions and pasted images. The text
 * keeps its visible placeholder (`@src/app.ts`, `[image 1]`); `label` is that placeholder so the
 * session can map it back. Paths are absolute. Images live in a temporary PNG (clipboard) or are the
 * user's own file (pasted/dragged path); the session decides how to send them to the model: only
 * routes with the `image_input` capability receive image bytes, others get a text note.
 *
 * @example { id: "image-1", kind: "image", label: "[image 1]", path: "/tmp/synorch-images/4242-1.png",
 *            displayPath: "clipboard image", mediaType: "image/png", bytes: 48213, source: "clipboard", temporary: true }
 * @example { id: "file-1", kind: "file", label: "@src/app.ts", path: "/repo/src/app.ts", displayPath: "src/app.ts", source: "mention" }
 */
export interface Attachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly label: string;
  readonly path: string;
  /** Workspace-relative for mentions; a short description for clipboard images. */
  readonly displayPath: string;
  readonly source: "mention" | "clipboard" | "paste-path";
  /** Images only: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. */
  readonly mediaType?: string;
  readonly bytes?: number;
  /** True when the harness created the file (clipboard image) and may delete it after the session. */
  readonly temporary?: boolean;
}

/**
 * One row of the `/model` picker (K1-U1 builds the picker, U2 supplies rows and applies the choice).
 *
 * @example { id: "session", tier: "session", provider: "openai", model: "gpt-6-sol", auth: "oauth", current: true }
 */
export interface ModelPickerEntry {
  /** Opaque to the renderer; returned unchanged with the choice. */
  readonly id: string;
  readonly tier: string;
  readonly provider: string;
  readonly model: string;
  /** How the route authenticates: `oauth`, `api-key`, `env`, `none`… */
  readonly auth: string;
  readonly current: boolean;
  readonly description?: string;
  /** When set, the row is shown but cannot be chosen; the text says why. */
  readonly disabled?: string;
}

/**
 * Interactive-only controls of the pi-tui renderer (`TerminalRenderer.controls`). Plain and JSONL
 * renderers leave `controls` undefined; every caller must treat it as optional.
 */
export interface InteractiveInputControls {
  /** Replaces the `/` palette rows (renderer-local `/mouse`, `/select` and `/exit` stay). */
  setCommands(entries: readonly CommandPaletteEntry[]): void;
  /** Called when the user attaches something (before submit); submit also carries the attachments. */
  onAttachment(listener: (attachment: Attachment) => void): () => void;
  /** Resolves with the chosen row, or undefined on Esc / abort. */
  openModelPicker(entries: readonly ModelPickerEntry[], signal?: AbortSignal): Promise<ModelPickerEntry | undefined>;
  /** Plan mode (Shift+Tab, Alt+M): the renderer shows it; the session applies the policy narrowing. */
  readonly planMode: boolean;
  setPlanMode(on: boolean): void;
  onPlanModeChange(listener: (on: boolean) => void): () => void;
  /** SGR mouse reporting (wheel scroll, click to expand). Off by default: it disables native selection. */
  readonly mouseMode: boolean;
  setMouseMode(on: boolean): void;
}

export type UserInputResult =
  | { readonly kind: "message" | "command"; readonly text: string; readonly attachments?: readonly Attachment[] }
  | { readonly kind: "interrupt" | "exit" };

export interface UserInputSource {
  /** Resolves with the next submitted message; Ctrl+C first cancels the active request (ADR-04). */
  next(signal: AbortSignal): Promise<UserInputResult>;
}

export interface TerminalRenderer {
  readonly kind: RendererKind;
  start(header: SessionHeaderView): Promise<void>;
  /** Must not block the agent: implementations queue and coalesce, bounded, and drop only deltas. */
  render(event: RenderEvent): void;
  readonly input: UserInputSource | undefined;
  /** Interactive renderer only (K1-U1): palette, attachments, model picker, plan and mouse modes. */
  readonly controls?: InteractiveInputControls;
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
