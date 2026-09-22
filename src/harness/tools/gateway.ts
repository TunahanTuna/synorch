import { performance } from "node:perf_hooks";
import { formatZodIssues } from "../../domain/zod-issues.ts";
import {
  ALLOWING_OUTCOMES,
  approvalDecisionSchema,
  approvalRequestSchema,
  canonicalJson,
  createId,
  digestOf,
  INLINE_PAYLOAD_MAX_BYTES,
  policyDecisionSchema,
  sha256,
  toolResultSchema,
  type ApprovalBroker,
  type ApprovalDecision,
  type BlobRef,
  type BlobStore,
  type EffectivePolicy,
  type EventStore,
  type HardRail,
  type NormalizedAction,
  type PolicyDecision,
  type PolicyEngine,
  type SandboxReport,
  type SandboxRunner,
  type SessionEvent,
  type SessionEventDraft,
  type ToolCallId,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolErrorCode,
  type ToolExecutionContext,
  type ToolGateway,
  type ToolInvocationScope,
  type ToolRegistry,
  type ToolResult,
} from "../contracts/index.ts";
import { errorResult } from "./builtin/shared.ts";
import { boundText, containsCredentialValue, createRedactor, INLINE_OUTPUT_LIMIT_BYTES, type Redactor } from "./redaction.ts";
import { ToolScopeViolation } from "./workspace-path.ts";

export interface ToolGatewayDependencies {
  readonly events: EventStore;
  readonly blobs: BlobStore;
  readonly registry: ToolRegistry;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalBroker;
  readonly sandbox: SandboxRunner;
  /** Exact credential values to redact and to refuse in arguments (`ResolvedCredential.redactionValues`). */
  readonly redactionValues?: () => readonly string[];
  /** Streaming progress from a running tool, already redacted. */
  readonly onUpdate?: (toolCallId: ToolCallId, text: string) => void;
  readonly now?: () => Date;
}

type PolicyLayer = PolicyDecision["reasons"][number]["layer"];
type Reason = PolicyDecision["reasons"][number];
type EventBody = DistributiveOmit<SessionEventDraft, "event_version" | "actor" | "run_id" | "task_id" | "attempt_id" | "causation_seq">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const WRITE_EFFECTS = new Set(["workspace-write", "exec"]);
const ENFORCEMENT_ORDER = ["unavailable", "partial", "full"] as const;

/**
 * The single tool pipeline: propose → lookup → validate → normalize → policy → approval →
 * sandbox check → execute → redact/bound → record. It writes every `tool/*` event itself, never
 * throws for a denied or failed call and never starts a side effect when the log refuses a write.
 * Recorded states follow the `toolCall` machine: anything refused before `tool/execution_started`
 * (unknown tool, invalid arguments, policy, approval, sandbox) ends `denied` (or `cancelled`);
 * only an executed call can end `succeeded` or `failed`.
 */
export function createToolGateway(dependencies: ToolGatewayDependencies): ToolGateway {
  const redactionValues = dependencies.redactionValues ?? (() => []);
  const redact = createRedactor(redactionValues);
  const now = dependencies.now ?? (() => new Date());
  const recordedPolicies = new Set<string>();
  const scopedGrants = new Set<string>();
  let sandboxReport: Promise<SandboxReport> | undefined;
  const liveSandbox = (): Promise<SandboxReport> => {
    sandboxReport ??= dependencies.sandbox.probe().catch((error: unknown) => ({
      backend: "none",
      platform: "other" as const,
      enforcement: "unavailable" as const,
      filesystem: "unavailable" as const,
      network: "unavailable" as const,
      process: "unavailable" as const,
      notes: [`sandbox probe failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500)],
    }));
    return sandboxReport;
  };

  async function invoke(request: ToolCallRequest, scope: ToolInvocationScope, signal: AbortSignal): Promise<ToolCallOutcome> {
    const started = performance.now();
    const toolCallId = request.tool_call_id;
    let causation: number | undefined;
    const append = (body: EventBody): Promise<SessionEvent> =>
      dependencies.events.append({
        ...body,
        event_version: 1,
        actor: { kind: scope.role === "orchestrator" ? "orchestrator" : "worker", role: scope.role, ...(scope.attemptId === undefined ? {} : { attempt_id: scope.attemptId }) },
        run_id: scope.runId,
        ...(scope.taskId === undefined ? {} : { task_id: scope.taskId }),
        ...(scope.attemptId === undefined ? {} : { attempt_id: scope.attemptId }),
        ...(causation === undefined ? {} : { causation_seq: causation }),
      } as SessionEventDraft);

    let decision: PolicyDecision | undefined;
    let approval: ApprovalDecision | undefined;
    let executionStarted = false;
    const finish = async (state: ToolCallOutcome["state"], raw: ToolResult): Promise<ToolCallOutcome> => {
      const result = await finalize(raw);
      const recorded = state === "interrupted" ? "failed" : state;
      try {
        await append({
          type: "tool/result_recorded",
          data: { tool_call_id: toolCallId, state: recorded, result, duration_ms: Math.max(0, Math.round(performance.now() - started)) },
        });
        return { toolCallId, state, result, decision, approval };
      } catch {
        return { toolCallId, state: executionStarted ? "interrupted" : state, result, decision, approval };
      }
    };
    const refuseUnlogged = (message: string): ToolCallOutcome => ({
      toolCallId,
      state: "failed",
      result: errorResult("execution_failed", message),
      decision,
      approval,
    });

    let argsJson: string;
    try {
      argsJson = canonicalJson(request.arguments);
    } catch (error: unknown) {
      return refuseUnlogged(`arguments are not canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const policyDigest = digestOf(scope.policy);
      if (!recordedPolicies.has(policyDigest)) {
        await append({ type: "policy/snapshot", data: { policy: scope.policy, digest: policyDigest } });
        recordedPolicies.add(policyDigest);
      }
      let argsBlob: BlobRef | undefined;
      if (Buffer.byteLength(argsJson) > INLINE_PAYLOAD_MAX_BYTES) {
        argsBlob = await dependencies.blobs.put(new Uint8Array(Buffer.from(redact(argsJson).text, "utf8")), "application/json");
      }
      const proposed = await append({
        type: "tool/call_proposed",
        data: {
          tool_call_id: toolCallId,
          provider_call_id: request.provider_call_id,
          tool_name: request.tool_name,
          args_digest: sha256(argsJson),
          ...(argsBlob === undefined ? {} : { args_blob: argsBlob }),
        },
      });
      causation = proposed.seq;
    } catch (error: unknown) {
      return refuseUnlogged(`the event log refused the call record; nothing was started (${error instanceof Error ? error.message : String(error)})`);
    }

    const tool = dependencies.registry.get(request.tool_name);
    if (tool === undefined) return finish("denied", errorResult("unknown_tool", `no tool named ${request.tool_name}`));
    const parsed = tool.input.safeParse(request.arguments);
    if (!parsed.success) return finish("denied", errorResult("invalid_arguments", formatZodIssues(parsed.error)));

    const execution = new AbortController();
    const callSignal = AbortSignal.any([signal, execution.signal]);
    const context: ToolExecutionContext = {
      toolCallId,
      runId: scope.runId,
      taskId: scope.taskId,
      attemptId: scope.attemptId,
      role: scope.role,
      workspaceRoot: scope.policy.workspace_root,
      policy: scope.policy,
      sandbox: dependencies.sandbox,
      blobs: dependencies.blobs,
      signal: callSignal,
      onUpdate: (text) => dependencies.onUpdate?.(toolCallId, redact(text).text),
    };

    let action: NormalizedAction;
    try {
      action = await tool.normalize(parsed.data, context);
    } catch (error: unknown) {
      if (error instanceof ToolScopeViolation) {
        decision = gatewayDecision({ tool: request.tool_name, args: sha256(argsJson), role: scope.role }, scope.policy, [
          { code: error.rail === undefined ? "read-outside-workspace" : "path-escape", layer: "platform", message: error.message.slice(0, 500) },
        ], error.rail);
        return finish("denied", errorResult("path_outside_scope", error.message));
      }
      return finish("denied", errorResult("invalid_arguments", error instanceof Error ? error.message : String(error)));
    }

    decision = decide(tool.metadata.visible_to.includes(scope.role), action, scope, argsJson);
    try {
      await append({ type: "tool/policy_decided", data: { tool_call_id: toolCallId, action, decision } });
    } catch {
      return refuseUnlogged("the event log refused the policy decision; nothing was started");
    }
    if (decision.decision === "deny") return finish("denied", errorResult(denialCode(decision), denialMessage(decision)));

    if (decision.decision === "ask") {
      const grantKey = `${decision.action_digest}|${decision.policy_digest}`;
      if (!scopedGrants.has(grantKey)) {
        try {
          approval = await requestApproval(action, decision, scope, callSignal, append);
        } catch {
          return refuseUnlogged("the event log refused the approval record; nothing was started");
        }
        if (!(ALLOWING_OUTCOMES as readonly string[]).includes(approval.outcome)) {
          const code: ToolErrorCode = approval.outcome === "rejected" ? "approval_rejected" : approval.outcome === "cancelled" ? "cancelled" : "approval_unavailable";
          return finish(approval.outcome === "cancelled" ? "cancelled" : "denied", errorResult(code, `approval ${approval.outcome}${approval.reason === undefined ? "" : `: ${approval.reason}`}`));
        }
        if (approval.outcome === "allowed-for-scope") scopedGrants.add(grantKey);
      }
    }

    const live = await liveSandbox();
    const enforcement = weakest(live.enforcement, scope.policy.sandbox.enforcement);
    if (scope.policy.require_full_sandbox && enforcement !== "full" && (WRITE_EFFECTS.has(action.effect) || WRITE_EFFECTS.has(tool.metadata.effect))) {
      return finish(
        "denied",
        errorResult("sandbox_insufficient", `full sandbox required; ${live.backend} enforcement is ${enforcement}${live.notes.length > 0 ? ` (${live.notes.join("; ")})` : ""}`),
      );
    }

    try {
      await append({ type: "tool/execution_started", data: { tool_call_id: toolCallId, sandbox_enforcement: enforcement } });
    } catch {
      return refuseUnlogged("the event log refused the execution record; nothing was started");
    }
    executionStarted = true;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      execution.abort();
    }, tool.metadata.timeout_ms);
    let raw: ToolResult;
    try {
      raw = await tool.execute(parsed.data, context);
    } catch (error: unknown) {
      raw = errorResult("execution_failed", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
    if (timedOut && !signal.aborted && raw.error?.code !== "timeout") {
      raw = errorResult("timeout", `${tool.metadata.name} exceeded ${tool.metadata.timeout_ms} ms`, { text: raw.text, truncated: raw.truncated });
    }
    const state: ToolCallOutcome["state"] = raw.status === "ok" ? "succeeded" : raw.error?.code === "cancelled" ? "cancelled" : "failed";
    return finish(state, raw);
  }

  function decide(visible: boolean, action: NormalizedAction, scope: ToolInvocationScope, argsJson: string): PolicyDecision {
    if (action.role !== scope.role) {
      return gatewayDecision(action, scope.policy, [{ code: "action-role-mismatch", layer: "role", message: "the normalized action names a different role" }]);
    }
    if (!visible) {
      return gatewayDecision(action, scope.policy, [{ code: "tool-not-visible", layer: "role", message: `${action.tool_name} is not available to ${scope.role}` }]);
    }
    if (containsCredentialValue(argsJson, redactionValues())) {
      return gatewayDecision(action, scope.policy, [{ code: "credential-in-arguments", layer: "platform", message: "the arguments contain a credential value" }], "secret-egress");
    }
    try {
      return dependencies.policy.evaluate(action, scope.policy);
    } catch (error: unknown) {
      return gatewayDecision(action, scope.policy, [
        { code: "policy-error", layer: "platform", message: `policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) },
      ]);
    }
  }

  async function requestApproval(
    action: NormalizedAction,
    decision: PolicyDecision,
    scope: ToolInvocationScope,
    signal: AbortSignal,
    append: (body: EventBody) => Promise<SessionEvent>,
  ): Promise<ApprovalDecision> {
    const request = approvalRequestSchema.parse({
      approval_id: createId("approval"),
      run_id: scope.runId,
      task_id: scope.taskId,
      subject_kind: "action",
      subject_digest: decision.action_digest,
      summary: redact(summarize(action)).text.slice(0, 2000),
      effect: action.effect,
      scope: "once",
      requested_at: now().toISOString(),
    });
    await append({ type: "approval/requested", data: { request } });
    const refusal = (reason: string, outcome: "cancelled" | "unavailable"): ApprovalDecision =>
      approvalDecisionSchema.parse({
        approval_id: request.approval_id,
        subject_kind: "action",
        subject_digest: request.subject_digest,
        outcome,
        decided_by: "broker",
        mode: scope.policy.mode,
        decided_at: now().toISOString(),
        reason,
      });
    let answer: ApprovalDecision;
    try {
      const parsed = approvalDecisionSchema.safeParse(await dependencies.approvals.request(request, signal));
      if (!parsed.success) answer = refusal("the approval decision was malformed", "cancelled");
      else if (parsed.data.approval_id !== request.approval_id || parsed.data.subject_kind !== "action" || parsed.data.subject_digest !== request.subject_digest) {
        answer = refusal("the approval does not bind to this action digest", "cancelled");
      } else answer = parsed.data;
    } catch (error: unknown) {
      answer = refusal(`approval broker failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000), signal.aborted ? "cancelled" : "unavailable");
    }
    await append({ type: "approval/decided", data: { decision: answer } });
    return answer;
  }

  async function finalize(raw: ToolResult): Promise<ToolResult> {
    const text = redact(raw.text);
    const message = raw.error === undefined ? undefined : redact(raw.error.message);
    let bounded: { text: string; blob: BlobRef | undefined };
    try {
      bounded = await boundText(text.text, dependencies.blobs);
    } catch {
      bounded = { text: Buffer.from(text.text, "utf8").subarray(0, INLINE_OUTPUT_LIMIT_BYTES - 64).toString("utf8").replace(/�$/, ""), blob: undefined };
    }
    const blob = bounded.blob ?? raw.blob;
    const candidate: ToolResult = {
      status: raw.status,
      text: bounded.text,
      truncated: raw.truncated || (bounded.blob === undefined && bounded.text.length < text.text.length),
      redactions: raw.redactions + text.count + (message?.count ?? 0),
      ...(blob === undefined ? {} : { blob }),
      ...(raw.exit_code === undefined ? {} : { exit_code: raw.exit_code }),
      ...(raw.changed_paths === undefined ? {} : { changed_paths: raw.changed_paths }),
      ...(raw.error === undefined || message === undefined ? {} : { error: { code: raw.error.code, message: message.text.slice(0, 2000) } }),
    };
    const checked = toolResultSchema.safeParse(candidate);
    return checked.success ? checked.data : errorResult("execution_failed", `the tool returned an invalid result: ${formatZodIssues(checked.error)}`.slice(0, 2000));
  }

  return { invoke };
}

function gatewayDecision(subject: unknown, policy: EffectivePolicy, reasons: readonly Reason[], rail?: HardRail): PolicyDecision {
  return policyDecisionSchema.parse({
    decision: "deny",
    action_digest: digestOf(subject),
    policy_digest: digestOf(policy),
    reasons,
    rail,
  });
}

function denialCode(decision: PolicyDecision): ToolErrorCode {
  if (decision.rail === "write-outside-scope" || decision.rail === "reserved-path-write") return "path_outside_scope";
  if (decision.reasons.some((reason) => reason.layer === ("sandbox" satisfies PolicyLayer))) return "sandbox_insufficient";
  return "policy_denied";
}

function denialMessage(decision: PolicyDecision): string {
  const prefix = decision.rail === undefined ? "denied" : `hard rail ${decision.rail}`;
  return `${prefix}: ${decision.reasons.map((reason) => `${reason.code} (${reason.layer}): ${reason.message}`).join("; ")}`.slice(0, 2000);
}

function summarize(action: NormalizedAction): string {
  const target = action.command === undefined ? action.paths.map((entry) => `${entry.access} ${entry.path}`).join(", ") : `${action.command.argv.join(" ")} (cwd ${action.command.cwd})`;
  return `${action.tool_name} [${action.effect}] ${target}`.trim();
}

function weakest(left: SandboxReport["enforcement"], right: SandboxReport["enforcement"]): SandboxReport["enforcement"] {
  return ENFORCEMENT_ORDER[Math.min(ENFORCEMENT_ORDER.indexOf(left), ENFORCEMENT_ORDER.indexOf(right))] ?? "unavailable";
}
