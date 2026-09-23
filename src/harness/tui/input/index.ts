/** K1-U1 input and interaction pieces of the interactive renderer; none of them imports pi-tui. */
export { AttachmentTray, imageLabel } from "./attachments.ts";
export { formatMention, InputCompletionProvider, mentionPrefix, type CompletionItem, type CompletionSuggestions } from "./autocomplete.ts";
export {
  IMAGE_MEDIA_TYPES,
  imagePathFromPaste,
  imageTempDir,
  MAX_IMAGE_BYTES,
  readClipboardImage,
  sniffImage,
  type ClipboardEnvironment,
  type ClipboardImage,
  type CommandRunner,
  type NativeImageSource,
} from "./clipboard.ts";
export { commandLabel, DEFAULT_COMMAND_PALETTE, filterCommands, LOCAL_COMMANDS, mergeCommands, requiresArgument } from "./commands.ts";
export { buildIndex, defaultLister, gitLister, scorePath, searchIndex, walkLister, WorkspaceFileIndex, type IndexedPath, type PathLister } from "./file-index.ts";
export {
  isMouseSequence,
  MOUSE_DISABLE_SEQUENCE,
  MOUSE_ENABLE_SEQUENCE,
  parseSgrMouse,
  TranscriptViewport,
  type MouseInput,
  type ViewComponent,
  type ViewContainer,
} from "./mouse.ts";
