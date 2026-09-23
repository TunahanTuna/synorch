import { z } from "zod";
import { authMethodSchema, type AuthMethodKind, type ResolvedCredential } from "./auth.ts";
import { blobRefSchema, modelTierSchema, nonEmptyTextSchema, timestampSchema, agentRoleSchema, type AgentRole, type ModelTier } from "./common.ts";
import { digestSchema, type Digest } from "./digest.ts";
import {
  approvalIdSchema,
  modelIdSchema,
  providerIdSchema,
  requestIdSchema,
  toolCallIdSchema,
  type ProviderId,
  type RequestId,
  type RunId,
  type TaskId,
} from "./ids.ts";
import type { ApprovalDecision, ApprovalRequest } from "./policy.ts";

/**
 * The model boundary. Two adapter families implement it:
 *
 * - `ModelAdapter`: Synorch owns the agent loop; the adapter turns one `ModelRequest` into one
 *   stream (direct HTTP: OpenAI Responses for API key and ChatGPT subscription, Anthropic
 *   Messages for API key).
 * - `AgentBackendAdapter`: the user's installed official client owns the loop (Claude Code via
 *   the Agent SDK or `claude -p`, later the Codex app-server). Built-in tools are disabled and
 *   Synorch's tools are exposed through a bridge (MCP / dynamic tools) that routes every call into
 *   the same ToolGateway, so policy, audit and packets are unchanged.
 *
 * Both emit the same `ModelStreamEvent` union and never throw once streaming has begun.
 */

export const ADAPTER_KINDS = ["model", "agent-backend"] as const;
export const adapterKindSchema = z.enum(ADAPTER_KINDS);
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export const adapterIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "adapter id must be kebab-case");

export const modelRouteSchema = z.strictObject({
  provider_id: providerIdSchema,
  model_id: modelIdSchema,
  adapter_id: adapterIdSchema,
  adapter_kind: adapterKindSchema,
  auth_method: authMethodSchema,
  profile: z.string().min(1).max(64),
  tier: modelTierSchema.optional(),
});
export type ModelRoute = z.infer<typeof modelRouteSchema>;

export const TRUST_LEVELS = ["harness", "project", "untrusted"] as const;
export const SYSTEM_BLOCK_SOURCES = [
  "harness",
  "constitution",
  "protocol",
  "role",
  "skill-catalog",
  "skill",
  "packet",
  "memory",
  "compaction",
] as const;

/** Sources a context report can name: every system block source plus the two message channels. */
export const CONTEXT_BLOCK_SOURCES = [...SYSTEM_BLOCK_SOURCES, "history", "tool-result"] as const;
export type ContextBlockSource = (typeof CONTEXT_BLOCK_SOURCES)[number];

/**
 * One system-side block. `trust` is the priority channel: repository and tool text is
 * `untrusted` data and is never promoted to instruction priority, whatever it says.
 */
export const systemBlockSchema = z.strictObject({
  id: z.string().min(1).max(128),
  source: z.enum(SYSTEM_BLOCK_SOURCES),
  trust: z.enum(TRUST_LEVELS),
  text: z.string(),
  digest: digestSchema,
});
export type SystemBlock = z.infer<typeof systemBlockSchema>;

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const contentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("thinking"),
    text: z.string(),
    /** Opaque provider continuation (e.g. encrypted reasoning when `store:false`). Never shown. */
    opaque: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("tool_call"),
    provider_call_id: z.string().min(1).max(200),
    tool_call_id: toolCallIdSchema.optional(),
    name: z.string().min(1).max(128),
    arguments: jsonObjectSchema,
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    tool_call_id: toolCallIdSchema,
    provider_call_id: z.string().min(1).max(200),
    is_error: z.boolean(),
    text: z.string(),
    blob: blobRefSchema.optional(),
  }),
  z.strictObject({ type: z.literal("blob"), blob: blobRefSchema }),
]);
export type ContentPart = z.infer<typeof contentPartSchema>;

export const modelMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.array(contentPartSchema),
});
export type ModelMessage = z.infer<typeof modelMessageSchema>;

export const assistantMessageSchema = modelMessageSchema.extend({ role: z.literal("assistant") });
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

/** The model-facing view of a tool: name, description and JSON Schema for its arguments. */
export const toolDescriptorSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "tool name must be 1-64 [A-Za-z0-9_-]"),
  description: nonEmptyTextSchema,
  input_schema: jsonObjectSchema,
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

/**
 * Prompt caching hint (ADR-20). `key` is stable for one session and role (e.g.
 * `<session_id>:<role>`); the OpenAI Responses adapters send it as `prompt_cache_key`. The first
 * `stable_system_blocks` system blocks are byte-identical on every step of that session; the
 * Anthropic Messages adapter puts its `cache_control` breakpoints after the last of them and after
 * the tool list. Adapters that cannot cache ignore it; it never changes what the model sees.
 */
export const promptCacheSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, "cache key must be 1-64 [A-Za-z0-9._:-]"),
  stable_system_blocks: z.int().min(0).max(64),
});
export type PromptCache = z.infer<typeof promptCacheSchema>;

/**
 * Everything the model sees for one step. It is built by the ContextBuilder from the event log
 * and blobs, recorded (as a blob) before it is sent, and bound by `envelopeDigest`.
 */
export const modelRequestSchema = z.strictObject({
  request_id: requestIdSchema,
  route: modelRouteSchema,
  system: z.array(systemBlockSchema),
  messages: z.array(modelMessageSchema),
  tools: z.array(toolDescriptorSchema),
  max_output_tokens: z.int().positive().optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  cache: promptCacheSchema.optional(),
});
export type ModelRequest = z.infer<typeof modelRequestSchema>;

export const USAGE_SOURCES = ["provider-reported", "adapter-estimated", "unknown"] as const;

export const usageSchema = z.strictObject({
  input_tokens: z.int().min(0).optional(),
  output_tokens: z.int().min(0).optional(),
  cache_read_tokens: z.int().min(0).optional(),
  cache_write_tokens: z.int().min(0).optional(),
  reasoning_tokens: z.int().min(0).optional(),
  cost_usd_estimate: z.number().min(0).optional(),
  source: z.enum(USAGE_SOURCES),
});
export type Usage = z.infer<typeof usageSchema>;

/** Subscription quota as the provider exposes it. Never mixed with tokens or USD. */
export const quotaSnapshotSchema = z.strictObject({
  source: z.enum(["headers", "api", "none"]),
  plan_label: z.string().max(100).optional(),
  windows: z.array(
    z.strictObject({
      name: z.string().min(1).max(64),
      used_percent: z.number().min(0).max(100),
      resets_at: timestampSchema.optional(),
    }),
  ),
});
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;

export const PROVIDER_ERROR_CODES = [
  "unauthenticated",
  "auth_expired",
  "forbidden",
  "entitlement_missing",
  "model_unavailable",
  "rate_limited",
  "quota_exhausted",
  "context_overflow",
  "invalid_request",
  "timeout",
  "cancelled",
  "stream_interrupted",
  "provider_internal",
  "protocol_mismatch",
  "bridge_unavailable",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * Whether re-sending the *same model request* is safe. It says nothing about tools: a side-effecting
 * tool call is never repeated because a model request was retried.
 */
export const PROVIDER_ERROR_RETRYABLE: { readonly [C in ProviderErrorCode]: boolean } = {
  unauthenticated: false,
  auth_expired: false,
  forbidden: false,
  entitlement_missing: false,
  model_unavailable: false,
  rate_limited: true,
  quota_exhausted: false,
  context_overflow: false,
  invalid_request: false,
  timeout: true,
  cancelled: false,
  stream_interrupted: true,
  provider_internal: true,
  protocol_mismatch: false,
  bridge_unavailable: false,
};

export const providerErrorSchema = z
  .strictObject({
    code: z.enum(PROVIDER_ERROR_CODES),
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
    retry_after_ms: z.int().min(0).optional(),
    http_status: z.int().min(100).max(599).optional(),
    provider_code: z.string().max(200).optional(),
  })
  .superRefine((error, context) => {
    if (error.retryable && !PROVIDER_ERROR_RETRYABLE[error.code]) {
      context.addIssue({ code: "custom", path: ["retryable"], message: `${error.code} is never retryable` });
    }
  });
export type ProviderError = z.infer<typeof providerErrorSchema>;

export class ProviderFailure extends Error {
  public readonly error: ProviderError;

  public constructor(error: ProviderError) {
    super(error.message);
    this.name = "ProviderFailure";
    this.error = error;
  }
}

export const STOP_REASONS = ["stop", "length", "tool_use"] as const;

export const modelStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    request_id: requestIdSchema,
    route: modelRouteSchema,
    provider_request_id: z.string().max(200).optional(),
  }),
  z.strictObject({
    type: z.literal("backend_init"),
    backend_session_id: z.string().min(1).max(200),
    model_id: modelIdSchema,
    auth_source: z.enum(["subscription", "api-key", "unknown"]),
    tools: z.array(z.string().min(1)),
  }),
  z.strictObject({ type: z.literal("text_delta"), index: z.int().min(0), text: z.string() }),
  z.strictObject({ type: z.literal("thinking_delta"), index: z.int().min(0), text: z.string() }),
  z.strictObject({
    type: z.literal("tool_call_start"),
    index: z.int().min(0),
    provider_call_id: z.string().min(1),
    name: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("tool_call_delta"),
    index: z.int().min(0),
    provider_call_id: z.string().min(1),
    arguments_fragment: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool_call_end"),
    index: z.int().min(0),
    provider_call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: jsonObjectSchema,
  }),
  z.strictObject({ type: z.literal("usage"), usage: usageSchema }),
  z.strictObject({ type: z.literal("quota"), quota: quotaSnapshotSchema }),
  z.strictObject({
    type: z.literal("done"),
    stop_reason: z.enum(STOP_REASONS),
    message: assistantMessageSchema,
    usage: usageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("error"),
    error: providerErrorSchema,
    partial: assistantMessageSchema.optional(),
  }),
]);
export type ModelStreamEvent = z.infer<typeof modelStreamEventSchema>;

export const capabilityLevelSchema = z.enum(["supported", "degraded", "unsupported", "unknown"]);
export type CapabilityLevel = z.infer<typeof capabilityLevelSchema>;

export const modelCapabilitySchema = z.strictObject({
  id: modelIdSchema,
  context_window: z.int().positive().nullable(),
  max_output_tokens: z.int().positive().nullable(),
  tool_calls: capabilityLevelSchema,
  streaming: capabilityLevelSchema,
  cancellation: capabilityLevelSchema,
  image_input: capabilityLevelSchema,
  structured_output: capabilityLevelSchema,
  reasoning: capabilityLevelSchema,
  prompt_cache: capabilityLevelSchema,
  system_message_updates: capabilityLevelSchema,
  usage_reporting: z.enum(["exact", "estimated", "none", "unknown"]),
});
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const providerCapabilitiesSchema = z
  .strictObject({
    schema_version: z.literal(1),
    provider_id: providerIdSchema,
    adapter_id: adapterIdSchema,
    adapter_kind: adapterKindSchema,
    auth_method: authMethodSchema,
    auth_status: z.enum(["connected", "expired", "login_required", "disconnected", "unknown", "error"]),
    billing: z.enum(["subscription", "metered", "unknown"]),
    quota_visibility: z.enum(["headers", "api", "none"]),
    loop_owner: z.enum(["synorch", "backend"]),
    tool_channel: z.enum(["native", "mcp", "dynamic-tools", "none"]),
    policy_status: z.enum(["permitted", "unclear"]),
    models: z.array(modelCapabilitySchema),
    probed_at: timestampSchema,
    source: z.enum(["static-config", "provider-api", "probe", "backend-init"]),
  })
  .superRefine((capabilities, context) => {
    const backend = capabilities.adapter_kind === "agent-backend";
    if (backend !== (capabilities.loop_owner === "backend")) {
      context.addIssue({ code: "custom", path: ["loop_owner"], message: "agent-backend adapters and only they own the loop" });
    }
    if (backend !== (capabilities.auth_method === "cli-bridge")) {
      context.addIssue({ code: "custom", path: ["auth_method"], message: "cli-bridge auth is exclusive to agent-backend adapters" });
    }
    if (backend && capabilities.tool_channel === "native") {
      context.addIssue({
        code: "custom",
        path: ["tool_channel"],
        message: "a backend-owned loop must receive Synorch tools through mcp or dynamic-tools, never its built-ins",
      });
    }
    if (!backend && capabilities.tool_channel !== "native" && capabilities.tool_channel !== "none") {
      context.addIssue({ code: "custom", path: ["tool_channel"], message: "a Synorch-owned loop uses native tool calls" });
    }
  });
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerHealthSchema = z.strictObject({
  state: z.enum(["ok", "degraded", "down", "unknown"]),
  checked_at: timestampSchema,
  detail: z.string().max(500).optional(),
});
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const ROUTE_SOURCES = ["session", "project", "workspace", "user", "provider-default"] as const;

/** Why a tier resolved to a route. A fallback is never silent: it names the approval that allowed it. */
export const routeDecisionSchema = z
  .strictObject({
    tier: modelTierSchema,
    role: agentRoleSchema.optional(),
    route: modelRouteSchema,
    source: z.enum(ROUTE_SOURCES),
    reason: nonEmptyTextSchema,
    capabilities_probed_at: timestampSchema.optional(),
    fallback: z.strictObject({
      used: z.boolean(),
      from: modelRouteSchema.optional(),
      approval_id: approvalIdSchema.optional(),
    }),
  })
  .superRefine((decision, context) => {
    if (decision.fallback.used && (decision.fallback.approval_id === undefined || decision.fallback.from === undefined)) {
      context.addIssue({ code: "custom", path: ["fallback"], message: "a fallback route requires the original route and an approval id" });
    }
  });
export type RouteDecision = z.infer<typeof routeDecisionSchema>;

export type PrepareResult =
  | { readonly ok: true; readonly wireDigest: Digest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: ProviderError };

export interface ModelAdapter {
  readonly kind: "model";
  readonly adapterId: string;
  readonly providerId: ProviderId;
  readonly authMethod: Exclude<AuthMethodKind, "cli-bridge">;
  discoverCapabilities(signal: AbortSignal): Promise<ProviderCapabilities>;
  /** Pure: maps the request to the provider wire body and reports unsupported features up front. */
  prepare(request: ModelRequest, capabilities: ProviderCapabilities): PrepareResult;
  /** Never throws after it is called: every failure, including abort, ends in an `error` event. */
  stream(request: ModelRequest, credential: ResolvedCredential, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  health(signal: AbortSignal): Promise<ProviderHealth>;
}

export interface BackendProbe {
  readonly installed: boolean;
  readonly executable: string | undefined;
  readonly version: string | undefined;
  readonly minimumVersion: string;
  readonly authSource: "subscription" | "api-key" | "unknown";
  readonly loginHint: string | undefined;
}

export interface BackendSessionOptions {
  readonly cwd: string;
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly maxTurns: number;
  readonly resumeBackendSessionId: string | undefined;
  /** Environment passed to the child; `BRIDGE_STRIPPED_ENV` names are always removed. */
  readonly env: Readonly<Record<string, string>>;
}

export interface ToolBridgeCall {
  readonly providerCallId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolBridgeResult {
  readonly isError: boolean;
  readonly text: string;
}

/** Synorch's tools as the backend sees them. Every `call` goes through the ToolGateway. */
export interface ToolBridge {
  readonly serverName: "synorch";
  list(): readonly ToolDescriptor[];
  call(call: ToolBridgeCall, signal: AbortSignal): Promise<ToolBridgeResult>;
}

/** Backend permission callbacks. Anything that is not a Synorch bridge tool is denied. */
export interface ApprovalBridge {
  decide(toolName: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ readonly allow: boolean; readonly reason: string }>;
}

export interface BackendTurnInput {
  readonly requestId: RequestId;
  readonly route: ModelRoute;
  readonly messages: readonly ModelMessage[];
}

export interface BackendSession {
  readonly backendSessionId: string;
  runTurn(
    input: BackendTurnInput,
    bridges: { readonly tools: ToolBridge; readonly approvals: ApprovalBridge },
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentBackendAdapter {
  readonly kind: "agent-backend";
  readonly adapterId: string;
  readonly providerId: ProviderId;
  readonly authMethod: "cli-bridge";
  probe(signal: AbortSignal): Promise<BackendProbe>;
  discoverCapabilities(signal: AbortSignal): Promise<ProviderCapabilities>;
  startSession(options: BackendSessionOptions, signal: AbortSignal): Promise<BackendSession>;
  health(signal: AbortSignal): Promise<ProviderHealth>;
}

export type AnyModelAdapter = ModelAdapter | AgentBackendAdapter;

export interface RouteRequest {
  readonly tier: z.infer<typeof modelTierSchema>;
  readonly role: z.infer<typeof agentRoleSchema> | undefined;
}

export type RouteSource = (typeof ROUTE_SOURCES)[number];

/** Where a tier is served. Validated against the registered adapters by the router at construction. */
export interface RouteBinding {
  readonly provider_id: string;
  readonly model_id: string;
  readonly adapter_id: string;
  readonly profile?: string;
}

/** One configured mapping. `role` narrows it to one role (e.g. an independent reviewer model). */
export interface RouteRule {
  readonly source: RouteSource;
  readonly tier: ModelTier;
  readonly role?: AgentRole;
  readonly route: RouteBinding;
}

/** What the composition root builds from session/project/workspace/user configuration for the router. */
export interface ModelRouterConfig {
  readonly rules: readonly RouteRule[];
}

/** A tier whose route is blocked (subscription quota exhausted). The router never reroutes on its own. */
export class RouteBlockedFailure extends ProviderFailure {
  public readonly blocked: ModelRoute;
  public readonly tier: ModelTier;
  public readonly role: AgentRole | undefined;
  public readonly alternatives: readonly ModelRoute[];

  public constructor(error: ProviderError, blocked: ModelRoute, request: RouteRequest, alternatives: readonly ModelRoute[]) {
    super(error);
    this.name = "RouteBlockedFailure";
    this.blocked = blocked;
    this.tier = request.tier;
    this.role = request.role;
    this.alternatives = alternatives;
  }
}

/** The human-only `provider-change` approval a blocked route needs before any fallback. */
export interface ProviderChangeProposal {
  readonly request: ApprovalRequest;
  readonly from: ModelRoute;
  readonly to: ModelRoute;
}

export interface ModelRouter {
  /** Resolves a tier; a blocked route rejects with `RouteBlockedFailure` (`quota_exhausted`). */
  resolve(request: RouteRequest, signal: AbortSignal): Promise<RouteDecision>;
  adapterFor(route: ModelRoute): AnyModelAdapter;
  /** Records a provider failure for a route; `quota_exhausted` blocks the route until it resets. */
  reportFailure(route: ModelRoute, error: ProviderError): void;
  /** Builds the `provider-change` approval request for a blocked route; it never switches by itself. */
  proposeProviderChange(
    failure: RouteBlockedFailure,
    context: { readonly runId: RunId; readonly taskId?: TaskId; readonly to?: ModelRoute },
  ): ProviderChangeProposal;
  /** Applies a decision; only an allowing *user* decision for the exact proposal enables the fallback. */
  applyProviderChange(decision: ApprovalDecision): void;
}
