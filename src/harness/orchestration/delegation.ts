import type { AgentRole, AttemptId, RunId, ToolExecutionContext, ToolResult } from "../contracts/index.ts";

/**
 * Orchestrator control tools (`plan_propose`, `task_spawn`, `task_status`, `task_triage`) bound to
 * the active run. The tool registry is built once per runtime, so the coordinator publishes a port
 * for its run into a slot while that run is active and clears it when the run ends. Every call is
 * checked again here: only the orchestrator of the active run may delegate, whatever the tool's
 * visibility says.
 */

export type DelegationResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "invalid_arguments" | "policy_denied" | "execution_failed"; readonly message: string };

export interface DelegationCaller {
  readonly runId: RunId;
  readonly role: AgentRole;
  readonly toolCallId: string;
}

export interface TriageDecision {
  readonly task: string;
  readonly decision: "accept" | "retry" | "fail";
  readonly waive_criteria?: readonly string[] | undefined;
  readonly guidance?: string | undefined;
}

export interface DelegationPort {
  readonly runId: RunId;
  /** Adds a follow-up task to the next plan revision (DAG, ownership and budget checked). */
  spawn(task: Readonly<Record<string, unknown>>, caller: DelegationCaller): DelegationResult;
  status(task: string | undefined): DelegationResult;
  /**
   * Validates a `plan_propose` call while the run is planning, so a structurally valid but
   * unworkable plan (e.g. a verification command on an explorer) is rejected in the same turn with
   * the reason; the orchestrator re-proposes within the revision limit. Absent: the call is only
   * recorded, and the coordinator validates the candidate after the turn.
   */
  proposePlan?(proposal: Readonly<Record<string, unknown>>, caller: DelegationCaller): DelegationResult;
  /** Records the orchestrator's decision on a triaged worker report (only during that consultation). */
  triage?(decision: TriageDecision, caller: DelegationCaller): DelegationResult;
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

const PLAN_RECORDED = "report recorded; end your turn now";

/** The `ControlCallbacks` entries for `plan_propose`, `task_spawn`, `task_status` and `task_triage`. */
export function delegationCallbacks(slot: DelegationSlot): {
  readonly planPropose: (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => Promise<ToolResult>;
  readonly taskSpawn: (input: { readonly packet: Readonly<Record<string, unknown>> }, context: ToolExecutionContext) => Promise<ToolResult>;
  readonly taskStatus: (input: { readonly task_id?: string | undefined }, context: ToolExecutionContext) => Promise<ToolResult>;
  readonly taskTriage: (input: TriageDecision, context: ToolExecutionContext) => Promise<ToolResult>;
} {
  return {
    async planPropose(input, context) {
      const port = slot.current();
      if (context.role !== "orchestrator" || port?.proposePlan === undefined || port.runId !== context.runId) {
        return toolResult({ ok: true, text: PLAN_RECORDED });
      }
      return toolResult(port.proposePlan(input, { runId: port.runId, role: context.role, toolCallId: context.toolCallId }));
    },
    async taskSpawn(input, context) {
      const port = portFor(slot, context);
      if ("ok" in port) return toolResult(port);
      return toolResult(port.spawn(input.packet, { runId: port.runId, role: context.role, toolCallId: context.toolCallId }));
    },
    async taskStatus(input, context) {
      const port = portFor(slot, context);
      if ("ok" in port) return toolResult(port);
      return toolResult(port.status(input.task_id));
    },
    async taskTriage(input, context) {
      const port = portFor(slot, context);
      if ("ok" in port) return toolResult(port);
      if (port.triage === undefined) return toolResult({ ok: false, code: "execution_failed", message: "no worker report is being triaged in this run" });
      return toolResult(port.triage(input, { runId: port.runId, role: context.role, toolCallId: context.toolCallId }));
    },
  };
}

/**
 * Report tools (`task_report`, `review_report`) bound to the attempt that calls them (ADR-18 D1).
 * The worker manager registers a check per running attempt; the tool callback resolves the report's
 * evidence pointers inside the call and returns an actionable `invalid_arguments` (with the valid
 * `[#n]` refs) while a correction round is left. A call from no registered attempt is recorded and
 * acknowledged as before.
 */
export type ReportCheck = (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => Promise<ToolResult>;

export interface ReportSlot {
  register(attemptId: AttemptId, check: ReportCheck): () => void;
  current(attemptId: AttemptId | undefined): ReportCheck | undefined;
}

export function createReportSlot(): ReportSlot {
  const checks = new Map<AttemptId, ReportCheck>();
  return {
    register(attemptId, check) {
      checks.set(attemptId, check);
      return () => {
        if (checks.get(attemptId) === check) checks.delete(attemptId);
      };
    },
    current: (attemptId) => (attemptId === undefined ? undefined : checks.get(attemptId)),
  };
}

export const REPORT_RECORDED = "report recorded; end your turn now";

/** The `ControlCallbacks` entries for `task_report` and `review_report`. */
export function reportCallbacks(slot: ReportSlot): {
  readonly taskReport: (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => Promise<ToolResult>;
  readonly reviewReport: (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => Promise<ToolResult>;
} {
  const handle = async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ToolResult> => {
    const check = slot.current(context.attemptId);
    if (check === undefined) return toolResult({ ok: true, text: REPORT_RECORDED });
    return check(input, context);
  };
  return { taskReport: handle, reviewReport: handle };
}
