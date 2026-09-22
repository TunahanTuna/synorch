import {
  EXIT_CODES,
  ROUTE_SOURCES,
  type HarnessErrorCode,
  type HarnessErrorInfo,
  type RunId,
  type RunOutcome,
  type SessionEvent,
  type SessionHeaderView,
  type TaskId,
  type TaskState,
  type Usage,
} from "../contracts/index.ts";
import type { ResultData } from "../tui/index.ts";
import type { Runtime } from "./runtime.ts";

/** Turns a run's recorded events into the header, the JSONL result/error frame and the human summary. */

export function headerFor(runtime: Runtime, notices: readonly string[] = []): SessionHeaderView {
  const routes: { tier: string; model: string; source: string }[] = [];
  for (const tier of ["orchestrator", "complex_worker", "fast_worker"] as const) {
    const rule = runtime.config.router.rules
      .filter((candidate) => candidate.tier === tier && candidate.role === undefined)
      .sort((left, right) => ROUTE_SOURCES.indexOf(left.source) - ROUTE_SOURCES.indexOf(right.source))[0];
    if (rule !== undefined) routes.push({ tier, model: `${rule.route.provider_id}/${rule.route.model_id}`, source: rule.source });
  }
  const sandboxNotes = runtime.sandbox.enforcement === "full" ? [] : runtime.sandbox.notes.map((note) => `sandbox ${runtime.sandbox.enforcement}: ${note}`);
  return {
    workspaceRoot: runtime.workspaceRoot,
    gitBranch: runtime.gitBranch,
    policyMode: runtime.policyMode,
    routes,
    sandboxEnforcement: runtime.sandbox.enforcement,
    notices: [...sandboxNotes, ...notices],
  };
}

export function runEvents(events: readonly SessionEvent[], runId: RunId): SessionEvent[] {
  return events.filter((event) => event.run_id === runId);
}

export function taskStates(events: readonly SessionEvent[]): { task_id: TaskId; state: TaskState }[] {
  const states = new Map<TaskId, TaskState>();
  for (const event of events) {
    if (event.type === "task/created") states.set(event.data.task_id, "draft");
    if (event.type === "task/state_changed") states.set(event.data.task_id, event.data.to);
  }
  return [...states].map(([task_id, state]) => ({ task_id, state }));
}

export function totalUsage(events: readonly SessionEvent[]): Usage | undefined {
  const usages = events.flatMap((event) => (event.type === "provider/usage" ? [event.data.usage] : []));
  if (usages.length === 0) return undefined;
  const sum = (field: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "reasoning_tokens"): number | undefined => {
    const values = usages.map((usage) => usage[field]).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  const costs = usages.map((usage) => usage.cost_usd_estimate).filter((value): value is number => value !== undefined);
  const sources = new Set(usages.map((usage) => usage.source));
  const source: Usage["source"] = sources.size === 1 ? (usages[0]?.source ?? "unknown") : sources.has("unknown") ? "unknown" : "adapter-estimated";
  const usage: { -readonly [K in keyof Usage]: Usage[K] } = { source };
  for (const field of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const) {
    const value = sum(field);
    if (value !== undefined) usage[field] = value;
  }
  if (costs.length > 0) usage.cost_usd_estimate = costs.reduce((total, value) => total + value, 0);
  return usage;
}

/** Outcomes that are a finished run with a task table go out as `result`; refusals and aborts as `error`. */
export function isResultOutcome(outcome: RunOutcome): boolean {
  return outcome.exitCode === EXIT_CODES.success || outcome.exitCode === EXIT_CODES.verification || outcome.exitCode === EXIT_CODES.budget;
}

export function resultData(outcome: RunOutcome, events: readonly SessionEvent[]): ResultData {
  const usage = totalUsage(events);
  return {
    status: outcome.status,
    exit_code: outcome.exitCode,
    summary: outcome.summary.slice(0, 4000) || outcome.status,
    tasks: taskStates(events),
    ...(usage === undefined ? {} : { usage }),
  };
}

const CODE_FOR_EXIT: Readonly<Record<number, HarnessErrorCode>> = {
  1: "internal",
  2: "config_invalid",
  3: "approval_rejected",
  4: "provider_failed",
  5: "verification_failed",
  6: "policy_denied",
  7: "auth_required",
  8: "session_locked",
  9: "budget_exceeded",
  130: "cancelled",
};

export function outcomeError(outcome: RunOutcome): HarnessErrorInfo {
  let code = CODE_FOR_EXIT[outcome.exitCode] ?? "internal";
  if (code === "approval_rejected" && /unavailable/.test(outcome.summary)) code = "approval_unavailable";
  return {
    code,
    message: (outcome.summary || outcome.status).slice(0, 2000),
    ids: { run_id: outcome.runId, session_id: outcome.sessionId },
    workspace_effect: code === "approval_rejected" || code === "approval_unavailable" || code === "config_invalid" ? "none" : "unknown",
    retry_safe: code !== "internal",
    ...(code === "approval_unavailable" ? { next_command: "syn agent --policy ask (an interactive terminal can answer approvals)" } : {}),
  };
}
