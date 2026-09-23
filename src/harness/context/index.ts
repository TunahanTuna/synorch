/** I4 — ContextBuilder, compaction (summary-v1), freshness checks. */
export type { ContextBuilder } from "../contracts/index.ts";
export {
  createContextBuilder,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ContextBuilderDependencies,
  type MemoryRecall,
  type RequestBudgetAdmission,
  type RequestBudgetGate,
  type UsageObservation,
} from "./context-builder.ts";
export {
  createCompactor,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  detectThrash,
  extractiveSummarizer,
  readSummary,
  renderSummary,
  SUMMARY_MEDIA_TYPE,
  SUMMARY_NOT_EVIDENCE,
  THRASH_STEP_WINDOW,
  type CompactInput,
  type CompactionOutcome,
  type Compactor,
  type CompactorDependencies,
  type Summarizer,
  type SummaryContent,
  type SummaryV1,
} from "./compaction.ts";
export { belongsTo, reconstructHistory, type History, type HistoryFilter, type HistoryMessage } from "./history.ts";
export { harnessInstructions, type ProjectInstructions, type RuntimeFacts } from "./instructions.ts";
export { createSourceReader, isOwnedPath, type SourceDigestReader } from "./scope.ts";
export { renderCatalog, triggeredSkills, type SkillCatalog, type SkillEntry } from "./skills.ts";
export { estimateTokens, messageTokens } from "./tokens.ts";
