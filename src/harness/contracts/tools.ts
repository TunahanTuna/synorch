import { z } from "zod";
import { agentRoleSchema, blobRefSchema, nonEmptyTextSchema, type AgentRole } from "./common.ts";
import { digestSchema, type Digest } from "./digest.ts";
import type { AttemptId, RunId, TaskId, ToolCallId } from "./ids.ts";
import { toolCallIdSchema } from "./ids.ts";
import type { ApprovalDecision, EffectivePolicy, NormalizedAction, PolicyDecision } from "./policy.ts";
import type { ToolDescriptor } from "./model.ts";
import type { BlobStore } from "./store.ts";

/**
 * Tools. Every action a model or backend can take, built-in or MCP, is a registered tool and goes
 * through one pipeline: parse -> validate -> normalize -> policy -> approval -> sandbox check ->
 * execute -> redact/bound -> record -> model.
 */

/**
 * `network-read` (K4.1): reads from the internet without writing anywhere (`web_search`,
 * `web_fetch`). Allowed in every mode's effect matrix; the real decision is the network policy
 * (domain allowlist, "always allow this domain" grants, permission-mode prompts) and the rails.
 */
export const TOOL_EFFECTS = ["read", "workspace-write", "exec", "external-write", "control", "network-read"] as const;
export const toolEffectSchema = z.enum(TOOL_EFFECTS);
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

export const TOOL_SOURCES = ["builtin", "mcp", "extension"] as const;

export const toolMetadataSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "tool name must be snake_case"),
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "version must be semver"),
    description: nonEmptyTextSchema,
    source: z.enum(TOOL_SOURCES),
    effect: toolEffectSchema,
    /** For non-builtin tools the effect comes from user configuration, never from the server's own claim. */
    effect_source: z.enum(["builtin", "user-config", "default-high-risk"]),
    idempotent: z.boolean(),
    network: z.enum(["none", "optional", "required"]),
    output_limit_bytes: z.int().min(1024).max(4 * 1024 * 1024),
    /** Up to 24 h: long control tools (`orchestrate`) are bounded by the run budget, not this timer. */
    timeout_ms: z.int().min(100).max(86_400_000),
    cancellable: z.boolean(),
    concurrency: z.enum(["parallel", "sequential"]),
    visible_to: z.array(agentRoleSchema).min(1),
    /**
     * A terminal control tool (ADR-20): when a call succeeds with `status: ok` the driver ends the
     * turn after it instead of sending another model request (`task_report`, `review_report`, an
     * accepted `plan_propose`, `task_triage`). A rejected call (`invalid_arguments`) never ends it.
     */
    ends_turn: z.boolean().optional(),
  })
  .superRefine((tool, context) => {
    if ((tool.source === "builtin") !== (tool.effect_source === "builtin")) {
      context.addIssue({ code: "custom", path: ["effect_source"], message: "only builtin tools may self-declare their effect" });
    }
    if (tool.effect_source === "default-high-risk" && tool.effect !== "external-write") {
      context.addIssue({ code: "custom", path: ["effect"], message: "an unclassified tool defaults to external-write" });
    }
    if (tool.effect === "read" && tool.network === "required") {
      context.addIssue({ code: "custom", path: ["network"], message: "a network-requiring tool cannot be classified read" });
    }
    if (tool.effect === "network-read" && tool.network === "none") {
      context.addIssue({ code: "custom", path: ["network"], message: "a network-read tool uses the network" });
    }
    if (tool.ends_turn === true && tool.effect !== "control") {
      context.addIssue({ code: "custom", path: ["ends_turn"], message: "only control tools can end a turn" });
    }
  });
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;

export const TOOL_ERROR_CODES = [
  "unknown_tool",
  "invalid_arguments",
  "policy_denied",
  "approval_rejected",
  "approval_unavailable",
  "sandbox_insufficient",
  "path_outside_scope",
  "stale_precondition",
  "timeout",
  "cancelled",
  "execution_failed",
  "outcome_unknown",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Bounded output. Anything above the inline cap is stored as a blob and referenced. */
export const toolResultSchema = z
  .strictObject({
    status: z.enum(["ok", "error"]),
    text: z.string().max(16 * 1024),
    blob: blobRefSchema.optional(),
    truncated: z.boolean(),
    exit_code: z.int().optional(),
    changed_paths: z.array(z.string().min(1)).optional(),
    /**
     * Single-file tools (`read_file`, `write_file`, `apply_patch` on one file): the workspace digest
     * (`workspaceDigest`, ADR-19) of the file in the attempt workspace after the call. `read_file`
     * also prints it in its header line so the model can cite it as `expected_digest`.
     */
    digest: digestSchema.optional(),
    redactions: z.int().min(0),
    error: z.strictObject({ code: z.enum(TOOL_ERROR_CODES), message: z.string().min(1).max(2000) }).optional(),
  })
  .superRefine((result, context) => {
    if ((result.status === "error") !== (result.error !== undefined)) {
      context.addIssue({ code: "custom", path: ["error"], message: "error details are present exactly when status is error" });
    }
  });
export type ToolResult = z.infer<typeof toolResultSchema>;

export const toolCallRequestSchema = z.strictObject({
  tool_call_id: toolCallIdSchema,
  provider_call_id: z.string().min(1).max(200),
  tool_name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const SANDBOX_ENFORCEMENT = ["full", "partial", "unavailable"] as const;
export type SandboxEnforcement = (typeof SANDBOX_ENFORCEMENT)[number];

export const sandboxReportSchema = z.strictObject({
  backend: z.string().min(1).max(64),
  platform: z.enum(["win32", "darwin", "linux", "other"]),
  enforcement: z.enum(SANDBOX_ENFORCEMENT),
  filesystem: z.enum(SANDBOX_ENFORCEMENT),
  network: z.enum(SANDBOX_ENFORCEMENT),
  process: z.enum(SANDBOX_ENFORCEMENT),
  notes: z.array(z.string().max(500)),
});
export type SandboxReport = z.infer<typeof sandboxReportSchema>;

export interface ProcessSpec {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string | undefined;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly writeRoots: readonly string[];
  readonly network: "deny" | "allow";
  /** Roots (the task's workspace) whose PATH entries are never used to look up `argv[0]`; the runner adds its own (Synorch home, session workspace). */
  readonly untrustedRoots?: readonly string[];
}

/**
 * How a child ended. `exited`: it ran and exited (with a code or a signal of its own); `timeout`
 * and `cancelled`: the runner terminated the whole tree; `spawn-failed`: nothing ran.
 */
export const PROCESS_TERMINATIONS = ["exited", "timeout", "cancelled", "spawn-failed"] as const;
export type ProcessTermination = (typeof PROCESS_TERMINATIONS)[number];

export interface ProcessResult {
  readonly termination: ProcessTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  /** Why the child could not be started (e.g. `ENOENT`); always set for `spawn-failed`. */
  readonly spawnError: string | undefined;
  readonly durationMs: number;
}

/** Applies and reports OS-level limits. It never decides permission; the PolicyEngine does. */
export interface SandboxRunner {
  probe(): Promise<SandboxReport>;
  run(spec: ProcessSpec, signal: AbortSignal): Promise<ProcessResult>;
  /**
   * K4.2: starts `spec` without waiting for it (dev servers, watchers, long test runs). The same
   * sandbox wrapping, environment and PATH rules as `run`; `timeoutMs` still bounds its lifetime.
   * Optional: a runner without it cannot run background processes.
   */
  start?(spec: ProcessSpec): BackgroundChild;
}

/** How a background child ended (`exited` also covers a signal of its own). */
export interface BackgroundExit {
  readonly termination: ProcessTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError: string | undefined;
}

/** A child started by `SandboxRunner.start`: streamed output, its exit, and a whole-tree kill. */
export interface BackgroundChild {
  readonly pid: number | undefined;
  onOutput(listener: (chunk: string, stream: "stdout" | "stderr") => void): void;
  readonly exited: Promise<BackgroundExit>;
  /** Terminates the child and every descendant (taskkill /T /F on Windows, the process group elsewhere). */
  kill(): Promise<void>;
  /** Synchronous best-effort tree kill for process exit handlers. */
  killSync(): void;
}

/**
 * What one attempt has read and written, per workspace path (NFC and, on case-insensitive
 * platforms, `foldPathCase`d). `write_file`/`apply_patch` default a missing `expected_digest` to
 * `lastSeen(path)` (ADR-18 D3); a write records the new digest, so consecutive edits of the same
 * file need no re-read. Scoped to one attempt (one session when there is no attempt). It is a
 * convenience, never a permission: a path it does not know simply needs an explicit digest.
 */
export interface AttemptFileLedger {
  lastSeen(path: string): Digest | undefined;
  noteRead(path: string, digest: Digest): void;
  noteWrite(path: string, digest: Digest | undefined): void;
}

export interface ToolExecutionContext {
  readonly toolCallId: ToolCallId;
  /** The call's short ref ordinal (`[#n]`, ADR-18), when the gateway assigned one. */
  readonly ref?: number;
  /** Read/write ledger of the attempt (ADR-18 D3); absent in runtimes that do not track it. */
  readonly files?: AttemptFileLedger;
  /** Undefined for a conversation turn (`session` role). */
  readonly runId: RunId | undefined;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly role: AgentRole;
  readonly workspaceRoot: string;
  readonly policy: EffectivePolicy;
  readonly sandbox: SandboxRunner;
  readonly blobs: BlobStore;
  readonly signal: AbortSignal;
  onUpdate(text: string): void;
}

export interface Tool<Input = unknown> {
  readonly metadata: ToolMetadata;
  readonly input: z.ZodType<Input>;
  descriptor(): ToolDescriptor;
  /** Canonicalizes arguments into the action the policy evaluates (resolved paths, argv, hosts). */
  normalize(input: Input, context: ToolExecutionContext): Promise<NormalizedAction>;
  execute(input: Input, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  /** K3: removes a registered tool (an MCP server was disabled or reconnected); false when absent. */
  unregister?(name: string): boolean;
  get(name: string): Tool | undefined;
  visibleTo(role: AgentRole, policy: EffectivePolicy): readonly ToolDescriptor[];
}

export interface ToolCallOutcome {
  readonly toolCallId: ToolCallId;
  readonly state: "succeeded" | "failed" | "denied" | "cancelled" | "interrupted";
  readonly result: ToolResult;
  readonly decision: PolicyDecision | undefined;
  readonly approval: ApprovalDecision | undefined;
  /**
   * Short ref ordinal the gateway assigned and recorded in `tool/call_proposed.ref` (ADR-18). The
   * driver renders the model-visible result with `renderToolResultText(ref, result)`.
   */
  readonly ref?: number;
  /** True when a terminal control tool (`ends_turn`) succeeded with `status: ok` (ADR-20). */
  readonly endsTurn?: boolean;
}

export interface ToolInvocationScope {
  /** Undefined for a conversation turn (`session` role). */
  readonly runId: RunId | undefined;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly role: AgentRole;
  readonly policy: EffectivePolicy;
  /**
   * `system`: a call the harness makes itself under `role`'s policy (the harness-run verification
   * commands, ADR-18). Its `tool/*` events carry `actor.kind: system`, it gets no short ref, it
   * never asks for approval (an `ask` decision is refused) and it is never a model's evidence.
   * Absent: the call comes from the model of `role`.
   */
  readonly actor?: "system";
  /**
   * K7: the call reached the gateway through a Claude Code native backend's tool bridge. Claude
   * Code runs its own plugins' hooks there, so Claude-sourced hooks are not run a second time.
   */
  readonly backend?: "claude-native";
}

/**
 * The single entry point for tool execution. It records `tool/*` events itself, so no caller can
 * execute a tool without a durable call record; it never throws for a denied or failed call.
 */
export interface ToolGateway {
  invoke(request: ToolCallRequest, scope: ToolInvocationScope, signal: AbortSignal): Promise<ToolCallOutcome>;
}
