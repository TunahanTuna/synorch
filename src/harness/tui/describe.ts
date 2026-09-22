import type { HarnessErrorInfo, SessionEvent } from "../contracts/index.ts";
import { sanitizeInline } from "./sanitize.ts";

/**
 * Human wording for session events, shared by the plain and pi-tui renderers. Noise events (turn,
 * step, request preparation, usage) return undefined; tool events are rendered as tool cards by the
 * TUI and as single lines by the plain renderer. The level is repeated as a text prefix so colour is
 * never the only channel (checklist D8).
 */

export type LineLevel = "info" | "success" | "warning" | "error";

export interface EventLine {
  readonly level: LineLevel;
  readonly text: string;
}

const LEVEL_PREFIX: { readonly [L in LineLevel]: string } = {
  info: "",
  success: "",
  warning: "warning: ",
  error: "error: ",
};

export function levelPrefix(level: LineLevel): string {
  return LEVEL_PREFIX[level];
}

function line(level: LineLevel, text: string): EventLine {
  return { level, text: sanitizeInline(text, 1000) };
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

export function describeEvent(event: SessionEvent): EventLine | undefined {
  switch (event.type) {
    case "session/opened":
      return line("info", `Session ${event.session_id} opened in ${event.data.workspace_root} (policy ${event.data.policy_mode})`);
    case "session/resumed":
      return line("info", `Session resumed after seq ${event.data.previous_last_seq}; ${event.data.recovered.length} state(s) recovered`);
    case "session/closed":
      return line("info", `Session closed (${event.data.reason})`);
    case "run/created":
      return line("info", `Run ${event.run_id ?? ""}: ${event.data.goal}`);
    case "run/state_changed":
      return line(
        event.data.to === "failed" || event.data.to === "cancelled" ? "warning" : event.data.to === "completed" ? "success" : "info",
        `Run ${event.data.from} -> ${event.data.to}: ${event.data.reason}`,
      );
    case "route/decided":
      return line(
        event.data.decision.fallback.used ? "warning" : "info",
        `Route ${event.data.decision.tier}: ${event.data.decision.route.provider_id}/${event.data.decision.route.model_id} (${event.data.decision.source})`,
      );
    case "plan/proposed":
      return line("info", `Plan v${event.data.plan.version} proposed: ${event.data.plan.tasks.length} task(s), risk ${event.data.plan.risk}`);
    case "plan/state_changed":
      return line("info", `Plan ${event.data.from} -> ${event.data.to}: ${event.data.reason}`);
    case "approval/requested":
      return line("warning", `Approval needed (${event.data.request.subject_kind}): ${event.data.request.summary}`);
    case "approval/decided":
      return line(
        event.data.decision.outcome.startsWith("allowed") ? "success" : "warning",
        `Approval ${event.data.decision.outcome} by ${event.data.decision.decided_by}`,
      );
    case "approval/invalidated":
      return line("warning", `Approval ${short(event.data.approval_id)} invalidated: ${event.data.reason}`);
    case "task/created":
      return line("info", `Task ${event.data.key} (${event.data.role}, ${event.data.risk}) created`);
    case "task/state_changed":
      return line(
        event.data.to === "failed" || event.data.to === "blocked" ? "warning" : event.data.to === "completed" ? "success" : "info",
        `Task ${short(event.data.task_id)} ${event.data.from} -> ${event.data.to}: ${event.data.reason}`,
      );
    case "attempt/started":
      return line("info", `Attempt ${short(event.data.attempt_id)} started (${event.data.role}, ${event.data.route.model_id}, ${event.data.isolation.mode})`);
    case "attempt/state_changed":
      return line("info", `Attempt ${short(event.data.attempt_id)} ${event.data.from} -> ${event.data.to}`);
    case "attempt/completion_recorded":
      return line(event.data.status === "completed" ? "success" : "warning", `Attempt ${short(event.data.attempt_id)} reported ${event.data.status}`);
    case "review/recorded":
      return line(event.data.decision === "accept" ? "success" : "warning", `Review: ${event.data.decision}`);
    case "model/response_failed":
      return line("error", `Model request failed (${event.data.error.code}): ${event.data.error.message}`);
    case "tool/call_proposed":
      return line("info", `Tool ${event.data.tool_name} requested`);
    case "tool/policy_decided":
      return event.data.decision.decision === "deny"
        ? line("warning", `Tool ${event.data.action.tool_name} denied: ${event.data.decision.reasons[0]?.message ?? "policy"}`)
        : undefined;
    case "tool/execution_started":
      return line("info", `Tool running (sandbox ${event.data.sandbox_enforcement})`);
    case "tool/result_recorded":
      return line(
        event.data.state === "succeeded" ? "success" : "warning",
        `Tool ${event.data.state} in ${event.data.duration_ms} ms${event.data.result.error === undefined ? "" : `: ${event.data.result.error.message}`}`,
      );
    case "tool/interrupted":
      return line("warning", `Tool call ${short(event.data.tool_call_id)} was interrupted; outcome unknown`);
    case "context/compacted":
      return line("info", `Context compacted: ${event.data.tokens_before} -> ${event.data.tokens_after} tokens`);
    case "context/source_changed":
      return line("warning", `Source changed since the task packet was issued: ${event.data.path}`);
    case "memory/persisted":
      return line("info", `Memory saved: ${event.data.path}`);
    case "memory/proposed":
      return line("info", `Memory proposal queued (${event.data.kind})`);
    case "memory/proposal_decided":
      return line("info", `Memory proposal ${event.data.state} by ${event.data.decided_by}`);
    case "budget/exceeded":
      return line("error", `Budget exceeded: ${event.data.metric} ${event.data.used} / ${event.data.limit} (${event.data.action})`);
    case "steer/queued":
      return line("info", `Queued for the next safe boundary: ${event.data.text}`);
    default:
      return undefined;
  }
}

/** The error standard of the CLI contract (§6), rendered for humans on stderr. */
export function formatHarnessError(error: HarnessErrorInfo): string {
  const lines = [`Error [${error.code}]: ${sanitizeInline(error.message, 2000)}`];
  const ids = Object.entries(error.ids ?? {});
  if (ids.length > 0) lines.push(`  ids: ${ids.map(([key, value]) => `${key}=${value}`).join(" ")}`);
  lines.push(`  workspace effect: ${error.workspace_effect}; retry safe: ${error.retry_safe ? "yes" : "no"}`);
  if (error.next_command !== undefined) lines.push(`  next: ${error.next_command}`);
  return `${lines.join("\n")}\n`;
}
