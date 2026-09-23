import type { POLICY_LAYERS } from "./policy.ts";
import type { TaskState } from "./state.ts";

export type PolicyLayerView = (typeof POLICY_LAYERS)[number];

/**
 * View models of the rich terminal views (TUI experience §8.6, §8.11; UX-03, UX-04, UX-10; X1, X2,
 * X6, X7). They are the only coupling between whoever produces the data (the session, from the
 * event log and projections) and the renderers in `tui/views/**`: plain, already-resolved display
 * data, no ids the user must not see, no JSON. Every string is untrusted and is sanitized on render.
 * Times are epoch milliseconds; a live view computes elapsed time against the renderer's clock.
 */

// ---------------------------------------------------------------------------------------------
// Orchestration: the live board (X1) and the plan graph (`/graph`).

export type ReviewVerdictView = "accepted" | "changes_requested" | "rejected";

export interface OrchestrationTaskView {
  /** Short, stable, human key shown in the first column and used by `dependsOn` (e.g. `convert-mocks`). */
  readonly key: string;
  /** Worker role (`explorer`, `implementer`, `debugger`, `reviewer`) or another display role. */
  readonly role: string;
  /** Short model name (`luna`, `opus-5.5`); omitted while unrouted. */
  readonly model?: string | undefined;
  readonly state: TaskState;
  /** The worker's latest action, e.g. `editing src/auth/refresh.ts`, or the verification command while verifying. */
  readonly activity?: string | undefined;
  /** One-line outcome once completed (`38 files mapped, 4 use mocks`). */
  readonly summary?: string | undefined;
  /** Why the task is blocked, failed or being revised. */
  readonly reason?: string | undefined;
  readonly startedAtMs?: number | undefined;
  readonly endedAtMs?: number | undefined;
  /** Used when start/end are unknown (e.g. replayed from a summary). */
  readonly elapsedMs?: number | undefined;
  /** Keys of the tasks this task waits for. Unknown keys are ignored. */
  readonly dependsOn?: readonly string[] | undefined;
  /** The independent review of this task's work, when one was recorded. */
  readonly review?: { readonly verdict: ReviewVerdictView; readonly reviewer?: string | undefined; readonly revisions?: number | undefined } | undefined;
  readonly diffstat?: { readonly files: number; readonly added: number; readonly removed: number } | undefined;
  /** Harness-run verification checks (never worker claims). */
  readonly checks?: { readonly passed: number; readonly total: number } | undefined;
}

export interface OrchestrationView {
  readonly kind: "orchestration";
  /** Board title; default `Workers`. */
  readonly title?: string | undefined;
  readonly tasks: readonly OrchestrationTaskView[];
  readonly startedAtMs?: number | undefined;
  readonly endedAtMs?: number | undefined;
  readonly elapsedMs?: number | undefined;
  /** True once the run ended: the live board collapses to its summary and is pinned to the transcript once. */
  readonly done: boolean;
  readonly outcome?: "completed" | "failed" | "cancelled" | undefined;
  /** e.g. `approved by you for this session`. */
  readonly note?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Usage (`/usage`, X7, UX-10).

export type BillingView = "subscription" | "api_key" | "unknown";

export interface UsageRowView {
  readonly provider: string;
  readonly model: string;
  /** Model tier the requests were routed under (`fast`, `balanced`, `deep`, `session`, …). */
  readonly tier?: string | undefined;
  readonly billing: BillingView;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  /** API-key cost in USD; subscriptions show quota instead. */
  readonly costUsd?: number | undefined;
  /** True when the cost is an estimate (shown with `~`); never fake billing precision. */
  readonly costEstimated?: boolean | undefined;
}

export interface QuotaWindowView {
  /** Account/provider label (`claude-code`, `codex`). */
  readonly provider: string;
  /** Window label (`5h`, `weekly`). */
  readonly window: string;
  readonly usedPercent: number;
  /** Display text, e.g. `14:20` or `in 3h`. */
  readonly resetsAt?: string | undefined;
}

export interface UsageView {
  readonly kind: "usage";
  /** Rows of the current session. */
  readonly session: readonly UsageRowView[];
  /** Rows of today across sessions; omitted when unknown. */
  readonly today?: readonly UsageRowView[] | undefined;
  readonly quotas?: readonly QuotaWindowView[] | undefined;
  readonly sessionElapsedMs?: number | undefined;
  /** Optional budget line, e.g. `$2.00 session budget`. */
  readonly budget?: { readonly usedUsd: number; readonly limitUsd: number } | undefined;
}

// ---------------------------------------------------------------------------------------------
// Evidence (`/evidence`, X2, UX-04).

export type CriterionStatusView = "passed" | "failed" | "not_run" | "unverifiable";

export type ProofView =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly exitCode?: number | undefined;
      /** `harness`: Synorch ran it (ADR-18). `worker`: a claim, shown as such. */
      readonly runBy: "harness" | "worker";
      readonly durationMs?: number | undefined;
      /** `42 passed`, `3 failed`. */
      readonly detail?: string | undefined;
    }
  | { readonly kind: "review"; readonly verdict: ReviewVerdictView; readonly reviewer: string; readonly independent: boolean }
  | { readonly kind: "file"; readonly path: string; readonly note?: string | undefined }
  | { readonly kind: "note"; readonly text: string; readonly inferred?: boolean | undefined };

export interface CriterionView {
  readonly text: string;
  readonly status: CriterionStatusView;
  readonly proofs: readonly ProofView[];
}

export interface EvidenceView {
  readonly kind: "evidence";
  /** e.g. the task or turn the evidence belongs to. */
  readonly title?: string | undefined;
  readonly criteria: readonly CriterionView[];
  readonly review?: { readonly independent: boolean; readonly reviewer?: string | undefined; readonly verdict?: ReviewVerdictView | undefined } | undefined;
  readonly changedPaths?: readonly string[] | undefined;
  readonly risk?: string | undefined;
  readonly next?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Action card (UX-03): a consequential action before it executes or asks for authority.

export interface ActionView {
  readonly kind: "action";
  /** A question: `Delete 14 files?`, `Run a command with side effects?`. */
  readonly title: string;
  /** The concrete command or target. */
  readonly what: string;
  readonly why: string;
  /** What changes if it runs. */
  readonly consequence: string;
  readonly effect: "local" | "remote" | "local+remote" | "none";
  readonly reversible: boolean | "unknown";
  readonly paths?: readonly string[] | undefined;
  /** Exact permission scope and duration, e.g. `this command once`. */
  readonly scope?: string | undefined;
  /** e.g. `sandbox partial: not fully contained`. */
  readonly warning?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Why card (`/why`, X6): a policy decision explained.

export interface WhyView {
  readonly kind: "why";
  /** What was decided about, e.g. `Run rm -rf build`. */
  readonly subject: string;
  readonly decision: "allow" | "ask" | "deny";
  readonly reasons: readonly { readonly layer: PolicyLayerView; readonly code: string; readonly message: string; readonly source?: string | undefined }[];
  /** Commands that would change the outcome (`/allow rm -rf`, `/trust`) and what each does. */
  readonly howToChange: readonly { readonly command: string; readonly effect: string }[];
}

export type HarnessView = OrchestrationView | UsageView | EvidenceView | ActionView | WhyView;
export type HarnessViewKind = HarnessView["kind"];

/**
 * What a renderer offers the session to show views (implemented by the pi-tui and plain
 * renderers). `showView` pins a card once to the transcript; `setBoard` keeps one live board in
 * place (pinned as a summary when `done`); `showGraph` pins the plan graph (`/graph`).
 */
export interface ViewHost {
  showView(view: HarnessView): void;
  setBoard(view: OrchestrationView | undefined): void;
  showGraph(view: OrchestrationView): void;
}
