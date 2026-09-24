import type { PiTuiRenderer, PiTuiRendererOptions } from "./pi-tui-renderer.ts";

/**
 * I5 — TerminalRenderer implementations: pi-tui (only in pi-tui-renderer.ts), plain line, JSONL.
 * The pi-tui adapter is loaded lazily, so the plain and JSONL paths never load pi-tui.
 */
export type { TerminalRenderer } from "../contracts/index.ts";
export {
  actionChoices,
  actionTitle,
  brokerDecision,
  HeadlessApprovalBroker,
  suggestedCommandPrefix,
  userDecision,
  withApprovalDeadline,
  type ActionChoice,
  type ApprovalAnswer,
  type ApprovalChoice,
} from "./approvals.ts";
export { deviceCodeText, HeadlessAuthInteraction, LineAuthInteraction } from "./auth-interaction.ts";
export {
  allowPrefixFor,
  ConversationPresenter,
  GLYPH_SETS,
  patchPaths,
  selectGlyphs,
  type ConversationItem,
  type GlyphSet,
  type ViewOp,
} from "./conversation-view.ts";
export { describeEvent, formatHarnessError, type EventLine, type LineLevel } from "./describe.ts";
export { EXIT_CONFIRMATION_WINDOW_MS, INTERRUPT_NOTICES, InterruptController, type InterruptAction, type InterruptKey } from "./interrupt.ts";
export { JsonlRenderer, type FrameSink, type GuardableStdout, type JsonlRendererOptions, type ResultData } from "./jsonl-renderer.ts";
export { LineSource, type InputStream } from "./line-source.ts";
export { browserCommand, openBrowser, type BrowserEnvironment, type BrowserLauncher } from "./open-browser.ts";
export { chunkForConPty, CONPTY_MAX_WRITE_BYTES } from "./output-chunks.ts";
export { PlainLineRenderer, type PlainLifecycle, type PlainLineRendererOptions } from "./plain-line-renderer.ts";
export { DEFAULT_RENDER_QUEUE_CAPACITY, isDeltaEvent, RenderQueue } from "./render-queue.ts";
export { sanitizeInline, sanitizeTerminalText } from "./sanitize.ts";
export { createStyler, type Styler } from "./style.ts";
export {
  ConsoleCodepageGuard,
  EMERGENCY_RESTORE_SEQUENCE,
  installTerminalGuard,
  parseCodepage,
  type GuardProcess,
  type GuardSignal,
  type TerminalGuard,
} from "./terminal-lifecycle.ts";
export { ToolCardTracker, type ToolCard, type ToolCardStatus } from "./tool-cards.ts";
export { lineDiff } from "./views/diff.ts";
export {
  AttachmentTray,
  DEFAULT_COMMAND_PALETTE,
  filterCommands,
  InputCompletionProvider,
  LOCAL_COMMANDS,
  parseSgrMouse,
  readClipboardImage,
  WorkspaceFileIndex,
  type ClipboardImage,
} from "./input/index.ts";
export type { PiTuiLifecycle, PiTuiRenderer, PiTuiRendererOptions } from "./pi-tui-renderer.ts";

/** Loads the pi-tui adapter on demand; call only when `selectRendererKind` returned `tui`. */
export async function createPiTuiRenderer(options: PiTuiRendererOptions): Promise<PiTuiRenderer> {
  const adapter = await import("./pi-tui-renderer.ts");
  return new adapter.PiTuiRenderer(options);
}
