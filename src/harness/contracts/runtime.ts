import type { ResolvedCredential, ResolveOptions } from "./auth.ts";
import type { AgentRole } from "./common.ts";
import type { Digest } from "./digest.ts";
import type { ExitCode } from "./errors.ts";
import type { EventStore, BlobStore } from "./store.ts";
import type { AttemptId, RequestId, RunId, SessionId, TaskId, TurnId } from "./ids.ts";
import type { RecalledMemory } from "./memory.ts";
import type { ContextBlockSource, ModelRequest, ModelRoute, ModelRouter, RouteDecision } from "./model.ts";
import type { CompletionPacket, ReviewPacket, TaskContextPacket } from "./packets.ts";
import type { EffectivePolicy, PolicyMode } from "./policy.ts";
import type { RenderEvent, TerminalRenderer } from "./renderer.ts";
import type { ToolGateway, ToolRegistry } from "./tools.ts";

/**
 * Seams between workstreams. Each interface has exactly one owning module (see
 * docs/harness/implementation-plan.md); every other module depends on it only through this file.
 */

export interface ContextBuildInput {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly taskId: TaskId | undefined;
  /** Separates two attempts of the same role that share a session; history keeps only this attempt's turns. */
  readonly attemptId: AttemptId | undefined;
  readonly role: AgentRole;
  readonly route: ModelRoute;
  readonly policy: EffectivePolicy;
  readonly packet: TaskContextPacket | undefined;
  readonly requestId: RequestId;
  /**
   * Reads the current digests of the packet's sources in the workspace the packet was computed
   * against (the attempt workspace for `context.digest_scheme: workspace-raw-v1`, ADR-19). When
   * absent the builder falls back to its own configured reader (pre-ADR-19 behaviour).
   */
  readonly sources?: WorkspaceDigestReader;
  /**
   * A report-only request (the forced last turn of an attempt that hit its step limit without a
   * report): only this report tool is offered, and the budget gate may grace the one request when
   * only the step budget is exhausted (`RequestBudgetGate.admit(..., { grace: true })`).
   */
  readonly reportOnly?: string;
}

export interface ContextBlockReport {
  readonly blockId: string;
  readonly source: ContextBlockSource;
  readonly trust: "harness" | "project" | "untrusted";
  readonly tokensEstimate: number;
  readonly truncated: boolean;
}

/**
 * A refused build. `budget-exceeded` means the run/task budget admits no further model request:
 * the driver ends the step without a request and the turn as `budget_exceeded` (not `failed`).
 */
export type ContextBuildRefusal = "stale-sources" | "context-overflow" | "compaction-thrash" | "budget-exceeded";

export type ContextBuildResult =
  | {
      readonly ok: true;
      readonly request: ModelRequest;
      readonly envelopeDigest: Digest;
      readonly blocks: readonly ContextBlockReport[];
      readonly memories: readonly RecalledMemory[];
    }
  | {
      readonly ok: false;
      readonly reason: ContextBuildRefusal;
      readonly stale: readonly { readonly path: string; readonly expected: Digest; readonly actual: Digest | undefined }[];
      /** Human-readable cause (budget metric and usage, overflow size); never model-facing. */
      readonly detail?: string;
    };

/** Rebuilds the model input for one step from the event log, blobs, packet and memory. Owned by context. */
export interface ContextBuilder {
  build(input: ContextBuildInput, signal: AbortSignal): Promise<ContextBuildResult>;
}

export interface TurnInput {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly role: AgentRole;
  readonly route: ModelRoute;
  readonly policy: EffectivePolicy;
  readonly packet: TaskContextPacket | undefined;
  readonly userMessage: string | undefined;
  readonly trigger: "user" | "orchestrator" | "steer" | "follow-up" | "dispatch";
  readonly maxSteps: number;
  /** Passed through to `ContextBuildInput.sources` (ADR-19); set by the worker manager per attempt. */
  readonly sources?: WorkspaceDigestReader;
  /**
   * Report-only turn: passed to `ContextBuildInput.reportOnly`; the driver refuses (without running)
   * any call to another tool. Set by the worker manager for the forced report turn only.
   */
  readonly reportOnly?: string;
}

export interface TurnOutcome {
  readonly turnId: TurnId;
  readonly outcome: "completed" | "max_steps" | "cancelled" | "failed" | "awaiting_approval" | "budget_exceeded";
  readonly steps: number;
}

/**
 * Resolves the credential for a Synorch-owned (`adapter_kind: model`) route; the composition root
 * maps the route's `(provider_id, auth_method, profile)` to its `AuthProvider.resolve`. It throws
 * `ProviderFailure` (`auth_expired` / `unauthenticated`) and never falls back to another identity.
 */
export type CredentialResolver = (route: ModelRoute, signal: AbortSignal, options?: ResolveOptions) => Promise<ResolvedCredential>;

export interface AgentDriverDependencies {
  readonly events: EventStore;
  readonly blobs: BlobStore;
  readonly router: ModelRouter;
  readonly context: ContextBuilder;
  readonly tools: ToolRegistry;
  readonly gateway: ToolGateway;
  readonly credentials: CredentialResolver;
}

/** The fixed, small loop: context -> request -> stream -> tool calls via gateway -> next step. Owned by core. */
export interface AgentDriver {
  runTurn(input: TurnInput, signal: AbortSignal): Promise<TurnOutcome>;
  /** Queues a user message for the next safe boundary (after the current tool batch). */
  steer(text: string): void;
}

/**
 * Why a writing attempt that wanted a worktree runs in `scoped-dir` instead (ADR-19). A fallback
 * is recorded in `attempt/started.isolation.fallback` and never leaves an orphan worktree or owner
 * file behind. `high-risk` writing tasks never fall back; they fail with `sandbox_insufficient`.
 */
export const ISOLATION_FALLBACK_REASONS = ["worktree-create-failed", "path-too-long", "git-unavailable"] as const;
export type IsolationFallbackReason = (typeof ISOLATION_FALLBACK_REASONS)[number];

/**
 * Ignored dependency directories linked (junction/symlink) from the main tree into a worktree so
 * verification commands find installed dependencies (ADR-19). Linked only when git ignores them,
 * they exist in the main tree and no owned path overlaps them; they are read-only by policy.
 */
export const DEPENDENCY_LINK_DIRECTORIES = ["node_modules", ".venv", "venv", ".tox"] as const;

/**
 * Digest of one file in one workspace root with the single workspace scheme (`workspaceDigest`,
 * ADR-19); undefined when the file does not exist. Paths are workspace-relative.
 */
export type WorkspaceDigestReader = (relativePath: string, signal?: AbortSignal) => Promise<Digest | undefined>;

export interface IsolatedWorkspace {
  readonly mode: "worktree" | "scoped-dir" | "shared-read-only";
  readonly root: string;
  readonly baseCommit: string | undefined;
  /** Diff of the isolated workspace against its base, pinned as an artifact digest. */
  snapshot(signal: AbortSignal): Promise<{ readonly artifactDigest: Digest; readonly changedPaths: readonly string[] }>;
  dispose(): Promise<void>;
  /**
   * The workspace digest of a file in *this* root (ADR-19). Packet sources and known facts are
   * computed with it after isolation, so they match what the worker's tools see.
   */
  readonly digest?: WorkspaceDigestReader;
  /** True when this is an earlier attempt's workspace of the same task, reset and reused. */
  readonly reused?: boolean;
  /** Set when a worktree was wanted but the provider fell back to `scoped-dir`. */
  readonly fallback?: { readonly from: "worktree"; readonly reason: IsolationFallbackReason; readonly detail: string };
  /** Dirty or untracked read inputs copied from the main tree (recorded in the baseline, never integrated back). */
  readonly overlaid?: readonly string[];
  /** Dependency directories linked from the main tree (`DEPENDENCY_LINK_DIRECTORIES`). */
  readonly dependencyLinks?: readonly string[];
  /** Submodule (gitlink) paths of the base commit; an owned path inside one is refused at create. */
  readonly submodules?: readonly string[];
}

export interface IsolationCreateOptions {
  /**
   * Root a `shared-read-only` workspace reads from instead of the main workspace: a reviewer reads
   * the isolated workspace holding the pinned artifact under review.
   */
  readonly readRoot?: string;
  /**
   * An earlier attempt's workspace of the same task (retry, repair, revision). The provider resets
   * it to its base (then applies the caller's seed artifact, if any) instead of creating a new
   * worktree; the caller keeps ownership and disposes it when the task settles (ADR-19).
   */
  readonly reuse?: IsolatedWorkspace;
  /**
   * Main-tree read inputs (packet read paths and cited sources) to overlay into a worktree when
   * they are dirty or untracked in the main tree. Owned paths are never overlaid.
   */
  readonly overlay?: readonly string[];
}

/** Creates per-attempt isolation (ADR-07, ADR-19). Owned by orchestration. */
export interface IsolationProvider {
  create(packet: TaskContextPacket, attemptId: AttemptId, signal: AbortSignal, options?: IsolationCreateOptions): Promise<IsolatedWorkspace>;
  /**
   * Applies a reviewed artifact onto the main workspace; the caller records it as `task/integrated`.
   * Conflicts are detected by `ContentIdentity` (git blob id through the tree's own filters, ADR-19)
   * and written content is converted to the main tree's representation (EOL, filters).
   */
  integrate(workspace: IsolatedWorkspace, expectedArtifact: Digest, signal: AbortSignal): Promise<void>;
}

export interface AttemptHandle {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  readonly completion: Promise<CompletionPacket>;
  cancel(reason: string): void;
}

export interface DispatchOptions {
  /** A route already decided (and recorded) by the caller, e.g. an independent reviewer model. */
  readonly route?: RouteDecision;
  /** Artifact bytes of an earlier attempt that a revise attempt continues from. */
  readonly seedArtifact?: Uint8Array;
}

export interface ReviewOutcome {
  readonly attemptId: AttemptId;
  /** The recorded review packet; absent when the reviewer produced no valid report. */
  readonly review: ReviewPacket | undefined;
  /** Orchestrator-side check of the review; `invalid` means the review itself cannot be trusted. */
  readonly verification: { readonly decision: "accept" | "revise" | "block" | "invalid"; readonly problems: readonly string[] };
}

export interface ReviewHandle {
  readonly attemptId: AttemptId;
  readonly result: Promise<ReviewOutcome>;
  cancel(reason: string): void;
}

/** Runs worker attempts from packets with role policy, limits and isolation. Owned by orchestration. */
export interface WorkerManager {
  dispatch(packet: TaskContextPacket, signal: AbortSignal, options?: DispatchOptions): Promise<AttemptHandle>;
  /**
   * Starts an independent review of `target` (ADR-09): a fresh session, a read-only workspace on the
   * target's pinned artifact, the completion packet and changed files but never the target's transcript.
   */
  dispatchReview(packet: TaskContextPacket, target: AttemptId, signal: AbortSignal, options?: DispatchOptions): Promise<ReviewHandle>;
  running(): readonly AttemptHandle[];
}

export interface RunRequest {
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly policyMode: PolicyMode;
  readonly headless: boolean;
  readonly resumeSessionId: SessionId | undefined;
  readonly budget: { readonly maxWallTimeSeconds: number | undefined; readonly maxCostUsd: number | undefined };
}

export interface RunOutcome {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly status: "succeeded" | "failed" | "cancelled" | "rejected";
  readonly exitCode: ExitCode;
  readonly summary: string;
}

/**
 * Drives one run end to end: plan -> approval -> DAG -> workers -> verification -> review -> report.
 * Owned by orchestration; the CLI composition root is its only caller.
 */
export interface Coordinator {
  run(request: RunRequest, signal: AbortSignal): Promise<RunOutcome>;
  steer(text: string): void;
  /** Non-blocking fan-out to renderers; returns an unsubscribe function. */
  onEvent(listener: (event: RenderEvent) => void): () => void;
}

export interface CommandIO {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly renderer: TerminalRenderer;
  readonly signal: AbortSignal;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** A runtime sub-command (`syn login`, `syn memory ...`) exported by its owning module and wired by the CLI. */
export type CommandHandler = (args: readonly string[], io: CommandIO) => Promise<ExitCode>;
