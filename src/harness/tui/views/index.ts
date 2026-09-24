/**
 * Rich terminal views (K1-U3): live orchestration board, orchestration graph, usage statistics,
 * evidence, action and why cards. Pure `render*` functions over the view models of
 * `contracts/views.ts`, pi-tui-shaped components, and plain-mode equivalents.
 */
export { isActive, isFinished, isWaiting, PlainBoardTracker, presentTask, renderBoard, renderBoardSummary, renderLiveBoard, type TaskPresentation, type Tone } from "./board.ts";
export { renderAction, renderEvidence, renderWhy } from "./cards.ts";
export { lineDiff, renderDiff } from "./diff.ts";
export { DelegationComponent, LiveBoardComponent, PlainViews, renderView, StaticViewComponent, UserToWorkerComponent, type ViewComponent, type ViewStyleOptions } from "./components.ts";
export { graphLevels, layoutGraph, renderGraph, type GraphOptions } from "./graph.ts";
export {
  cycleWorker,
  initialSelection,
  moveSelection,
  renderAssignment,
  renderDelegation,
  renderItem,
  renderUserToWorker,
  renderWorkerHeader,
  renderWorkerSnapshot,
  workerItems,
  workerStatus,
  type SelectionMove,
} from "./worker.ts";
export {
  createViewTheme,
  displayWidth,
  fitLine,
  shareBar,
  meterBar,
  truncate,
  viewContext,
  viewGlyphs,
  type ViewContext,
  type ViewGlyphs,
  type ViewTheme,
} from "./kit.ts";
export { renderUsage } from "./usage.ts";
export { renderContext, renderMemoryGraph, renderMemoryLedger, renderMemoryProposal } from "./trust-cards.ts";
