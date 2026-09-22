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

export interface IsolatedWorkspace {
  readonly mode: "worktree" | "scoped-dir" | "shared-read-only";
  readonly root: string;
  readonly baseCommit: string | undefined;
  /** Diff of the isolated workspace against its base, pinned as an artifact digest. */
  snapshot(signal: AbortSignal): Promise<{ readonly artifactDigest: Digest; readonly changedPaths: readonly string[] }>;
  dispose(): Promise<void>;
}

export interface IsolationCreateOptions {
  /**
   * Root a `shared-read-only` workspace reads from instead of the main workspace: a reviewer reads
   * the isolated workspace holding the pinned artifact under review.
   */
  readonly readRoot?: string;
}

/** Creates per-attempt isolation (ADR-07). Owned by orchestration. */
export interface IsolationProvider {
  create(packet: TaskContextPacket, attemptId: AttemptId, signal: AbortSignal, options?: IsolationCreateOptions): Promise<IsolatedWorkspace>;
  /** Applies a reviewed artifact onto the main workspace; the caller records it as `task/integrated`. */
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
