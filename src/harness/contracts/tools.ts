import { z } from "zod";
import { agentRoleSchema, blobRefSchema, nonEmptyTextSchema, type AgentRole } from "./common.ts";
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

export const TOOL_EFFECTS = ["read", "workspace-write", "exec", "external-write", "control"] as const;
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
    timeout_ms: z.int().min(100).max(3_600_000),
    cancellable: z.boolean(),
    concurrency: z.enum(["parallel", "sequential"]),
    visible_to: z.array(agentRoleSchema).min(1),
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
}

export interface ToolExecutionContext {
  readonly toolCallId: ToolCallId;
  readonly runId: RunId;
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
  get(name: string): Tool | undefined;
  visibleTo(role: AgentRole, policy: EffectivePolicy): readonly ToolDescriptor[];
}

export interface ToolCallOutcome {
  readonly toolCallId: ToolCallId;
  readonly state: "succeeded" | "failed" | "denied" | "cancelled" | "interrupted";
  readonly result: ToolResult;
  readonly decision: PolicyDecision | undefined;
  readonly approval: ApprovalDecision | undefined;
}

export interface ToolInvocationScope {
  readonly runId: RunId;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly role: AgentRole;
  readonly policy: EffectivePolicy;
}

/**
 * The single entry point for tool execution. It records `tool/*` events itself, so no caller can
 * execute a tool without a durable call record; it never throws for a denied or failed call.
 */
export interface ToolGateway {
  invoke(request: ToolCallRequest, scope: ToolInvocationScope, signal: AbortSignal): Promise<ToolCallOutcome>;
}
