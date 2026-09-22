import type { AgentRole, RunId, ToolExecutionContext, ToolResult } from "../contracts/index.ts";

/**
 * Orchestrator delegation tools (`task_spawn`, `task_status`) bound to the active run. The tool
 * registry is built once per runtime, so the coordinator publishes a port for its run into a slot
 * while that run is active and clears it when the run ends. Every call is checked again here:
 * only the orchestrator of the active run may delegate, whatever the tool's visibility says.
 */

export type DelegationResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "invalid_arguments" | "policy_denied" | "execution_failed"; readonly message: string };

export interface DelegationCaller {
  readonly runId: RunId;
  readonly role: AgentRole;
  readonly toolCallId: string;
}

export interface DelegationPort {
  readonly runId: RunId;
  /** Adds a follow-up task to the next plan revision (DAG, ownership and budget checked). */
  spawn(task: Readonly<Record<string, unknown>>, caller: DelegationCaller): DelegationResult;
  status(task: string | undefined): DelegationResult;
}

export interface DelegationSlot {
  set(port: DelegationPort | undefined): void;
  current(): DelegationPort | undefined;
}

export function createDelegationSlot(): DelegationSlot {
  let port: DelegationPort | undefined;
  return {
    set(next) {
      port = next;
    },
    current: () => port,
  };
}

function toolResult(result: DelegationResult): ToolResult {
  return result.ok
    ? { status: "ok", text: result.text.slice(0, 16 * 1024), truncated: false, redactions: 0 }
    : { status: "error", text: "", truncated: false, redactions: 0, error: { code: result.code, message: result.message.slice(0, 2000) } };
}

function portFor(slot: DelegationSlot, context: ToolExecutionContext): DelegationPort | DelegationResult {
  if (context.role !== "orchestrator") return { ok: false, code: "policy_denied", message: "only the orchestrator delegates tasks" };
  const port = slot.current();
  if (port === undefined || port.runId !== context.runId) {
    return { ok: false, code: "execution_failed", message: "no approved plan is active for this run yet; propose the plan with plan_propose" };
  }
  return port;
}

/** The `ControlCallbacks` entries for `task_spawn` and `task_status`. */
export function delegationCallbacks(slot: DelegationSlot): {
  readonly taskSpawn: (input: { readonly packet: Readonly<Record<string, unknown>> }, context: ToolExecutionContext) => Promise<ToolResult>;
  readonly taskStatus: (input: { readonly task_id?: string | undefined }, context: ToolExecutionContext) => Promise<ToolResult>;
} {
  return {
    async taskSpawn(input, context) {
      const port = portFor(slot, context);
      if ("ok" in port) return toolResult(port);
      return toolResult(port.spawn(input.packet, { runId: context.runId, role: context.role, toolCallId: context.toolCallId }));
    },
    async taskStatus(input, context) {
      const port = portFor(slot, context);
      if ("ok" in port) return toolResult(port);
      return toolResult(port.status(input.task_id));
    },
  };
}
