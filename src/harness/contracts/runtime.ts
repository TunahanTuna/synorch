import type { AgentRole } from "./common.ts";
import type { Digest } from "./digest.ts";
import type { ExitCode } from "./errors.ts";
import type { EventStore, BlobStore } from "./store.ts";
import type { AttemptId, RunId, SessionId, TaskId, TurnId } from "./ids.ts";
import type { RecalledMemory } from "./memory.ts";
import type { ModelRequest, ModelRoute, ModelRouter } from "./model.ts";
import type { CompletionPacket, TaskContextPacket } from "./packets.ts";
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
  readonly role: AgentRole;
  readonly route: ModelRoute;
  readonly policy: EffectivePolicy;
  readonly packet: TaskContextPacket | undefined;
  readonly requestId: string;
}

export interface ContextBlockReport {
  readonly blockId: string;
  readonly source: string;
  readonly trust: "harness" | "project" | "untrusted";
  readonly tokensEstimate: number;
  readonly truncated: boolean;
}

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
      readonly reason: "stale-sources" | "context-overflow" | "compaction-thrash";
      readonly stale: readonly { readonly path: string; readonly expected: Digest; readonly actual: Digest | undefined }[];
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

export interface AgentDriverDependencies {
  readonly events: EventStore;
  readonly blobs: BlobStore;
  readonly router: ModelRouter;
  readonly context: ContextBuilder;
  readonly tools: ToolRegistry;
  readonly gateway: ToolGateway;
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

/** Creates per-attempt isolation (ADR-07). Owned by orchestration. */
export interface IsolationProvider {
  create(packet: TaskContextPacket, attemptId: AttemptId, signal: AbortSignal): Promise<IsolatedWorkspace>;
  /** Applies a reviewed artifact onto the main workspace; an explicit, recorded coordination step. */
  integrate(workspace: IsolatedWorkspace, expectedArtifact: Digest, signal: AbortSignal): Promise<void>;
}

export interface AttemptHandle {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  readonly completion: Promise<CompletionPacket>;
  cancel(reason: string): void;
}

/** Runs worker attempts from packets with role policy, limits and isolation. Owned by orchestration. */
export interface WorkerManager {
  dispatch(packet: TaskContextPacket, signal: AbortSignal): Promise<AttemptHandle>;
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
