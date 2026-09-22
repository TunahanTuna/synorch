import {
  completionPacketSchema,
  type CompletionPacket,
  type SessionEvent,
  type SessionId,
} from "../contracts/index.ts";
import type { Runtime } from "./runtime.ts";

/**
 * In-session commands of `syn agent` (cli-experience.md). They only read what the session already
 * recorded (and the runtime's configuration); none of them changes state except `/cancel`.
 */

export interface SlashContext {
  readonly runtime: Runtime;
  readonly events: readonly SessionEvent[];
  readonly sessionId: SessionId | undefined;
  cancel(): void;
}

export interface SlashResult {
  readonly lines: readonly string[];
  readonly exit: boolean;
}

export const SLASH_HELP = [
  "/plan         latest plan, digest and approval",
  "/tasks        task DAG with states and owned paths",
  "/context      context blocks and token estimates of the last model request",
  "/permissions  effective policy of the orchestrator and the latest worker",
  "/model        configured routes and the routes actually decided",
  "/diff         files integrated by this session's runs",
  "/evidence     acceptance criterion -> evidence per completed attempt, and reviews",
  "/cancel       cancel the active run (the session stays resumable)",
  "/memory       memory vault and pending proposals",
  "/help         this list; headless: syn run \"<goal>\" --mode jsonl",
  "/exit         leave the session",
];

function latest<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event as Extract<SessionEvent, { type: T }>;
  }
  return undefined;
}

function plan(events: readonly SessionEvent[]): string[] {
  const proposed = latest(events, "plan/proposed");
  if (proposed === undefined) return ["no plan yet"];
  const state = events.filter((event) => event.type === "plan/state_changed" && event.data.plan_id === proposed.data.plan.plan_id).at(-1);
  const approval = latest(events, "approval/decided");
  return [
    `plan ${proposed.data.plan.plan_id} v${proposed.data.plan.version} ${proposed.data.digest}: ${proposed.data.plan.goal}`,
    `state ${state?.type === "plan/state_changed" ? state.data.to : "proposed"}; risk ${proposed.data.plan.risk}`,
    ...(approval === undefined ? [] : [`approval ${approval.data.decision.outcome} by ${approval.data.decision.decided_by} (${approval.data.decision.mode})`]),
    ...proposed.data.plan.tasks.map((task) => `- ${task.key} (${task.role}, ${task.risk}): ${task.objective}`),
  ];
}

function tasks(events: readonly SessionEvent[]): string[] {
  const created = events.filter((event): event is Extract<SessionEvent, { type: "task/created" }> => event.type === "task/created");
  if (created.length === 0) return ["no tasks yet"];
  return created.map((task) => {
    const last = events.filter((event) => event.type === "task/state_changed" && event.data.task_id === task.data.task_id).at(-1);
    const state = last?.type === "task/state_changed" ? last.data.to : "draft";
    const owned = task.data.owned_paths.length === 0 ? "read-only" : task.data.owned_paths.join(", ");
    const after = task.data.depends_on.length === 0 ? "" : ` after ${task.data.depends_on.join(", ")}`;
    return `${task.data.key} ${task.data.task_id} ${state} (${task.data.role}; ${owned})${after}`;
  });
}

function contextReport(events: readonly SessionEvent[]): string[] {
  const request = latest(events, "model/request_prepared");
  if (request === undefined) return ["no model request yet"];
  const total = request.data.context.reduce((sum, block) => sum + block.tokens_estimate, 0);
  const compaction = latest(events, "context/compacted");
  return [
    `request ${request.data.request_id} to ${request.data.route.provider_id}/${request.data.route.model_id}: ~${total} tokens`,
    ...request.data.context.map((block) => `- ${block.source} (${block.trust}) ~${block.tokens_estimate}${block.truncated ? " truncated" : ""}`),
    compaction === undefined ? "no compaction" : `last compaction ${compaction.data.trigger}: ${compaction.data.tokens_before} -> ${compaction.data.tokens_after} tokens`,
  ];
}

function permissions(runtime: Runtime, events: readonly SessionEvent[]): string[] {
  const snapshots = events.filter((event): event is Extract<SessionEvent, { type: "policy/snapshot" }> => event.type === "policy/snapshot");
  const lines = [`policy mode ${runtime.policyMode}; sandbox ${runtime.sandbox.backend} (${runtime.sandbox.enforcement})`];
  if (snapshots.length === 0) return [...lines, "no effective policy recorded yet"];
  const seen = new Set<string>();
  for (const snapshot of [...snapshots].reverse()) {
    const policy = snapshot.data.policy;
    if (seen.has(policy.role)) continue;
    seen.add(policy.role);
    const effects = Object.entries(policy.effects).map(([effect, decision]) => `${effect}=${decision}`).join(" ");
    lines.push(`${policy.role}: ${effects}; write ${policy.write_scope.join(", ") || "none"}`);
  }
  const approvals = events.filter((event) => event.type === "approval/decided");
  lines.push(`${approvals.length} approval decision(s) recorded`);
  return lines;
}

function model(runtime: Runtime, events: readonly SessionEvent[]): string[] {
  const lines = runtime.config.router.rules.map(
    (rule) => `configured ${rule.tier}${rule.role === undefined ? "" : `/${rule.role}`} -> ${rule.route.provider_id}/${rule.route.model_id} via ${rule.route.adapter_id} (${rule.source})`,
  );
  for (const event of events) {
    if (event.type !== "route/decided") continue;
    const decision = event.data.decision;
    lines.push(`decided ${decision.tier}${decision.role === undefined ? "" : `/${decision.role}`} -> ${decision.route.provider_id}/${decision.route.model_id}${decision.fallback.used ? " (approved fallback)" : ""}`);
  }
  return lines.length === 0 ? ["no routes configured"] : lines;
}

function diff(events: readonly SessionEvent[]): string[] {
  const integrated = events.filter((event): event is Extract<SessionEvent, { type: "task/integrated" }> => event.type === "task/integrated");
  if (integrated.length === 0) return ["no changes integrated in this session"];
  return integrated.map((event) => `${event.data.task_id} ${event.data.artifact_digest}: ${event.data.paths.join(", ") || "(no files)"}`);
}

async function evidence(runtime: Runtime, events: readonly SessionEvent[]): Promise<string[]> {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "attempt/completion_recorded") {
      let completion: CompletionPacket | undefined;
      try {
        completion = completionPacketSchema.parse(JSON.parse(new TextDecoder().decode(await runtime.blobs.get(event.data.blob.digest))));
      } catch {
        completion = undefined;
      }
      lines.push(`attempt ${event.data.attempt_id} ${event.data.status}`);
      for (const entry of completion?.acceptance_evidence ?? []) {
        lines.push(`  ${entry.criterion_id}: ${entry.evidence.map((ref) => `${ref.kind}:${ref.ref}`).join(", ")}`);
      }
    }
    if (event.type === "review/recorded") lines.push(`review ${event.data.reviewer_attempt_id}: ${event.data.decision}`);
  }
  return lines.length === 0 ? ["no evidence recorded yet"] : lines;
}

async function memory(runtime: Runtime): Promise<string[]> {
  const pending = await runtime.memory.pending();
  return [`vault ${runtime.memoryRoot}`, `${pending.length} proposal(s) waiting (syn memory review)`];
}

export async function handleSlashCommand(text: string, context: SlashContext): Promise<SlashResult> {
  const command = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  const lines = async (): Promise<readonly string[]> => {
    switch (command) {
      case "/plan":
        return plan(context.events);
      case "/tasks":
        return tasks(context.events);
      case "/context":
        return contextReport(context.events);
      case "/permissions":
        return permissions(context.runtime, context.events);
      case "/model":
        return model(context.runtime, context.events);
      case "/diff":
        return diff(context.events);
      case "/evidence":
        return evidence(context.runtime, context.events);
      case "/memory":
        return memory(context.runtime);
      case "/cancel":
        context.cancel();
        return ["cancel requested; the session stays resumable"];
      case "/help":
        return SLASH_HELP;
      default:
        return [`unknown command ${command}; /help lists the commands`];
    }
  };
  if (command === "/exit" || command === "/quit") return { lines: [], exit: true };
  return { lines: await lines(), exit: false };
}
