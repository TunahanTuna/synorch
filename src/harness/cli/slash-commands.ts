import {
  completionPacketSchema,
  type CompletionPacket,
  type SessionEvent,
  type SessionId,
  type CommandPaletteEntry,
} from "../contracts/index.ts";
import { closestMatch } from "../../domain/suggest.ts";
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

export function planReport(events: readonly SessionEvent[]): string[] {
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

export function tasksReport(events: readonly SessionEvent[]): string[] {
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

export function contextReport(events: readonly SessionEvent[]): string[] {
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

export function permissionsReport(runtime: Runtime, events: readonly SessionEvent[]): string[] {
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

export function modelReport(runtime: Runtime, events: readonly SessionEvent[]): string[] {
  const lines = runtime.routeRules().map(
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

export async function evidenceReport(runtime: Runtime, events: readonly SessionEvent[]): Promise<string[]> {
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

export async function memoryReport(runtime: Runtime): Promise<string[]> {
  const pending = await runtime.memory.pending();
  return [`vault ${runtime.memoryRoot}`, `${pending.length} proposal(s) waiting (syn memory review)`];
}

export async function handleSlashCommand(text: string, context: SlashContext): Promise<SlashResult> {
  const command = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  const lines = async (): Promise<readonly string[]> => {
    switch (command) {
      case "/plan":
        return planReport(context.events);
      case "/tasks":
        return tasksReport(context.events);
      case "/context":
        return contextReport(context.events);
      case "/permissions":
        return permissionsReport(context.runtime, context.events);
      case "/model":
        return modelReport(context.runtime, context.events);
      case "/diff":
        return diff(context.events);
      case "/evidence":
        return evidenceReport(context.runtime, context.events);
      case "/memory":
        return memoryReport(context.runtime);
      case "/cancel":
        context.cancel();
        return ["cancel requested; the session stays resumable"];
      case "/help":
        return SLASH_HELP;
      default:
        return [unknownConversationCommand(command, "·")];
    }
  };
  if (command === "/exit" || command === "/quit") return { lines: [], exit: true };
  return { lines: await lines(), exit: false };
}

// ---- the conversation's command registry (ADR-21, TUI §8.11) ----------------------------------

/**
 * What a conversation command may do. `cli/conversation.ts` implements it; the registry below is
 * the single source for the handlers, `/help` and the renderer's command palette (`setCommands`).
 */
export interface ConversationCommandHost {
  print(lines: readonly string[]): void;
  cancel(): void;
  planMode(goal: string): Promise<void>;
  go(mode: string): Promise<void>;
  workers(goal: string): Promise<void>;
  /** K1.7 `/worker [key] [message | --pause | --resume | --cancel]`. */
  worker(argument: string): Promise<void>;
  undo(): Promise<void>;
  allow(argument: string): Promise<void>;
  trust(): Promise<void>;
  model(argument: string): Promise<void>;
  review(argument: string): Promise<void>;
  commit(argument: string): Promise<void>;
  usage(): Promise<void>;
  cost(): Promise<void>;
  evidence(): Promise<void>;
  why(argument: string): Promise<void>;
  compact(focus: string): Promise<void>;
  report(name: "context" | "permissions" | "tasks" | "memory" | "diff" | "log", argument: string): Promise<void>;
  clear(): Promise<void>;
  resume(argument: string): Promise<void>;
  mouse(argument: string): Promise<void>;
  graph(): Promise<void>;
  /** `/config [key [value]]`: the settings screen, or read / set one key (user configuration). */
  config(argument: string): Promise<void>;
}

export interface SlashCommand {
  /** With the leading slash, lower case: `/model`. */
  readonly name: string;
  readonly description: string;
  /** `<required>` makes the palette complete instead of submit; `[optional]` submits. */
  readonly argsHint?: string;
  readonly aliases?: readonly string[];
  /** Runs at once while the agent works; other commands wait for the turn to end. */
  readonly whileBusy?: boolean;
  /** Executed by the interactive renderer itself (`/mouse`, `/exit`): kept out of the palette rows the session pushes. */
  readonly rendererLocal?: boolean;
  /** Resolves true when the user asked to leave the session. */
  run(host: ConversationCommandHost, argument: string): Promise<boolean | void>;
}

export const CONVERSATION_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", description: "commands and keys", whileBusy: true, run: async (host) => host.print(conversationHelp()) },
  { name: "/plan", argsHint: "[goal]", description: "plan mode: read-only, discuss and plan before changing anything (Shift+Tab cycles modes)", whileBusy: true, run: (host, argument) => host.planMode(argument) },
  { name: "/go", argsHint: "[workers]", description: "leave plan mode and carry out the plan here, or with workers", run: (host, argument) => host.go(argument) },
  { name: "/workers", argsHint: "<goal>", description: "run a large goal with parallel workers and an independent reviewer; alone: list the workers", whileBusy: true, run: (host, argument) => host.workers(argument) },
  { name: "/worker", argsHint: "[key] [message | --pause | --resume | --cancel]", description: "one worker: its assignment and recent activity, or message / pause / resume / cancel it", whileBusy: true, run: (host, argument) => host.worker(argument) },
  { name: "/model", argsHint: "[tier] [provider/model] [--save]", description: "every logged-in provider's models; set a tier's model for this session (--save keeps it)", run: (host, argument) => host.model(argument) },
  { name: "/review", argsHint: "[focus]", description: "independent review of the uncommitted changes (fresh context)", run: (host, argument) => host.review(argument) },
  { name: "/commit", argsHint: "[message]", description: "diff summary and a proposed message; commits only after you confirm", run: (host, argument) => host.commit(argument) },
  { name: "/undo", description: "revert the last edit Synorch made (files only)", run: (host) => host.undo() },
  { name: "/allow", argsHint: "[prefix | -r prefix]", description: "let Synorch run commands starting with <prefix> here", whileBusy: true, run: (host, argument) => host.allow(argument) },
  { name: "/trust", description: "trust this folder so build/test commands may run", run: (host) => host.trust() },
  { name: "/usage", description: "requests, tokens, quota and estimated cost (session and today)", whileBusy: true, run: (host) => host.usage() },
  { name: "/cost", description: "this session's estimated cost and tokens", whileBusy: true, run: (host) => host.cost() },
  { name: "/evidence", description: "checks, criteria and reviews of this conversation's worker runs", whileBusy: true, run: (host) => host.evidence() },
  { name: "/why", argsHint: "[tool]", description: "why the last action was allowed or refused, and what would change it", whileBusy: true, run: (host, argument) => host.why(argument) },
  { name: "/compact", argsHint: "[focus]", description: "summarize older messages to free context", run: (host, argument) => host.compact(argument) },
  { name: "/context", description: "what the model saw in its last request", whileBusy: true, run: (host, argument) => host.report("context", argument) },
  { name: "/clear", description: "start a fresh conversation (this one stays resumable)", run: (host) => host.clear() },
  { name: "/resume", argsHint: "[n | session id]", description: "list recent conversations or switch to one", run: (host, argument) => host.resume(argument) },
  { name: "/memory", description: "memory vault and pending proposals", whileBusy: true, run: (host, argument) => host.report("memory", argument) },
  { name: "/mouse", argsHint: "[on|off]", description: "toggle mouse capture (scroll / select)", whileBusy: true, rendererLocal: true, run: (host, argument) => host.mouse(argument) },
  { name: "/diff", description: "files changed by Synorch in this conversation", whileBusy: true, run: (host, argument) => host.report("diff", argument) },
  { name: "/graph", description: "the plan graph of the current or last worker run", whileBusy: true, run: (host) => host.graph() },
  { name: "/tasks", description: "tasks of this conversation's worker runs", whileBusy: true, run: (host, argument) => host.report("tasks", argument) },
  { name: "/permissions", argsHint: "[ask|auto|full|plan | allow <prefix> | remove <prefix>]", description: "permission mode, allow rules and trust; switch mode or edit rules", whileBusy: true, run: (host, argument) => host.report("permissions", argument) },
  { name: "/config", argsHint: "[key [value]]", description: "settings: routes, permission mode, budget, mouse, glyphs (saved to your user config)", whileBusy: true, run: (host, argument) => host.config(argument) },
  { name: "/log", argsHint: "[n]", description: "raw event log of this conversation (debug)", whileBusy: true, run: (host, argument) => host.report("log", argument) },
  { name: "/cancel", description: "stop the current work (the conversation stays resumable)", whileBusy: true, run: async (host) => host.cancel() },
  { name: "/exit", aliases: ["/quit"], description: "leave (resume with syn agent --continue)", whileBusy: true, rendererLocal: true, run: async () => true },
];

export function findConversationCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  return CONVERSATION_COMMANDS.find((command) => command.name === lower || command.aliases?.includes(lower) === true);
}

/** The reply to an unknown slash command: the closest registered command when one is plausibly meant. */
export function unknownConversationCommand(name: string, sep: string): string {
  const names = CONVERSATION_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
  const match = name.startsWith("/") ? closestMatch(name.slice(1), names.map((candidate) => candidate.slice(1))) : undefined;
  return match === undefined ? `Unknown command ${name} ${sep} /help lists the commands` : `Unknown command ${name} ${sep} did you mean /${match}?`;
}

/** Palette rows for the interactive renderer (`controls.setCommands`, K1-U1): names without the slash; renderer-local commands stay the renderer's. */
export function conversationPaletteEntries(): CommandPaletteEntry[] {
  return CONVERSATION_COMMANDS.filter((command) => command.rendererLocal !== true).map(({ name, description, argsHint, aliases }) => ({
    name: name.slice(1),
    description,
    ...(argsHint === undefined ? {} : { argsHint }),
    ...(aliases === undefined ? {} : { aliases: aliases.map((alias) => alias.slice(1)) }),
  }));
}

export function conversationHelp(): string[] {
  const label = (command: SlashCommand): string => `${command.name}${command.argsHint === undefined ? "" : ` ${command.argsHint}`}`;
  const width = Math.max(...CONVERSATION_COMMANDS.map((command) => label(command).length));
  return [
    ...CONVERSATION_COMMANDS.map((command) => `${label(command).padEnd(width + 2)}${command.description}`),
    "Keys: Esc interrupts (twice stops workers) · Shift+Tab cycles ask/auto/full/plan · Enter while working steers · @path attaches a file · Ctrl+C twice exits",
  ];
}
