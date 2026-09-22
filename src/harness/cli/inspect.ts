import path from "node:path";
import {
  completionPacketSchema,
  deriveProjectId,
  EXIT_CODES,
  HarnessError,
  type BlobStore,
  type RunId,
  type SessionEvent,
  type SessionId,
  type SessionStore,
  type SessionSummary,
} from "../contracts/index.ts";
import { createBlobStore, createSessionStore } from "../store/index.ts";
import { resolveHome } from "./config.ts";
import { taskStates, totalUsage } from "./run-summary.ts";

/**
 * `syn runs` and `syn show`: read-only views over the session store of this project. They never
 * take a lease, so they work while a run is live (a live session's last line may still be settling).
 */

export interface InspectIO {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string | undefined;
  readonly platform: NodeJS.Platform;
  stdout(text: string): void;
}

interface Stores {
  readonly sessions: SessionStore;
  readonly blobs: BlobStore;
}

function stores(io: InspectIO): Stores {
  const home = io.home ?? resolveHome(io.env);
  return { sessions: createSessionStore(home), blobs: createBlobStore(home) };
}

async function readEvents(sessions: SessionStore, sessionId: SessionId): Promise<SessionEvent[]> {
  const reader = await sessions.openForRead(sessionId);
  const events: SessionEvent[] = [];
  for await (const item of reader.read()) if (item.status === "ok") events.push(item.event);
  return events;
}

export interface RunListing {
  readonly session_id: SessionId;
  readonly run_id: RunId;
  readonly goal: string;
  readonly state: string;
  readonly policy_mode: string;
  readonly created_at: string;
  readonly tasks: number;
  readonly locked: boolean;
}

function listRuns(summary: SessionSummary, events: readonly SessionEvent[]): RunListing[] {
  const runs: RunListing[] = [];
  for (const event of events) {
    if (event.type !== "run/created" || event.run_id === undefined) continue;
    const runId = event.run_id;
    const mine = events.filter((candidate) => candidate.run_id === runId);
    const last = mine.filter((candidate) => candidate.type === "run/state_changed").at(-1);
    runs.push({
      session_id: summary.manifest.session_id,
      run_id: runId,
      goal: event.data.goal,
      state: last?.type === "run/state_changed" ? last.data.to : "created",
      policy_mode: event.data.policy_mode,
      created_at: event.timestamp,
      tasks: mine.filter((candidate) => candidate.type === "task/created").length,
      locked: summary.locked,
    });
  }
  return runs;
}

async function projectRuns(io: InspectIO, target: string): Promise<{ readonly stores: Stores; readonly runs: RunListing[]; readonly sessions: readonly SessionSummary[] }> {
  const opened = stores(io);
  const projectId = deriveProjectId(target, io.platform);
  const summaries = await opened.sessions.list(projectId);
  const runs: RunListing[] = [];
  for (const summary of summaries) {
    if (summary.manifest.title?.includes(" attempt att_") === true) continue;
    runs.push(...listRuns(summary, await readEvents(opened.sessions, summary.manifest.session_id).catch(() => [])));
  }
  return { stores: opened, runs, sessions: summaries };
}

export async function runsCommand(io: InspectIO, target: string | undefined, json: boolean): Promise<number> {
  const root = path.resolve(io.cwd, target ?? ".");
  const { runs } = await projectRuns(io, root);
  if (json) {
    io.stdout(`${JSON.stringify(runs, null, 2)}\n`);
    return EXIT_CODES.success;
  }
  if (runs.length === 0) {
    io.stdout(`No runs recorded for ${root}.\n`);
    return EXIT_CODES.success;
  }
  for (const run of runs) {
    io.stdout(`${run.created_at}  ${run.run_id}  ${run.state.padEnd(20)} ${run.tasks} task(s)  ${run.session_id}${run.locked ? " [live]" : ""}\n    ${run.goal.split("\n")[0]?.slice(0, 120) ?? ""}\n`);
  }
  return EXIT_CODES.success;
}

export interface RunReport {
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly goal: string;
  readonly state: string;
  readonly policy_mode: string;
  readonly plan: unknown;
  readonly tasks: readonly unknown[];
  readonly attempts: readonly unknown[];
  readonly approvals: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly reviews: readonly unknown[];
  readonly routes: readonly unknown[];
  readonly usage: unknown;
}

async function reportFor(stores: Stores, sessionId: SessionId, runId: RunId, events: readonly SessionEvent[]): Promise<RunReport> {
  const mine = events.filter((event) => event.run_id === runId);
  const created = mine.find((event) => event.type === "run/created");
  const last = mine.filter((event) => event.type === "run/state_changed").at(-1);
  const proposed = mine.filter((event) => event.type === "plan/proposed").at(-1);
  const planState = mine.filter((event) => event.type === "plan/state_changed").at(-1);
  const states = new Map(taskStates(mine).map((entry) => [entry.task_id, entry.state]));
  const attemptEvents: SessionEvent[] = [];
  const attempts: unknown[] = [];
  for (const event of mine) {
    if (event.type !== "attempt/started") continue;
    const final = mine.filter((candidate) => candidate.type === "attempt/state_changed" && candidate.data.attempt_id === event.data.attempt_id).at(-1);
    const completion = mine.find((candidate) => candidate.type === "attempt/completion_recorded" && candidate.data.attempt_id === event.data.attempt_id);
    if (event.data.session_id !== undefined) attemptEvents.push(...(await readEvents(stores.sessions, event.data.session_id).catch(() => [])));
    attempts.push({
      attempt_id: event.data.attempt_id,
      task_id: event.data.task_id,
      role: event.data.role,
      route: `${event.data.route.provider_id}/${event.data.route.model_id}`,
      isolation: event.data.isolation.mode,
      session_id: event.data.session_id,
      state: final?.type === "attempt/state_changed" ? final.data.to : "running",
      completion: completion?.type === "attempt/completion_recorded" ? completion.data.status : undefined,
    });
  }
  const approvals = mine.flatMap((event) =>
    event.type === "approval/decided"
      ? [{ approval_id: event.data.decision.approval_id, subject: event.data.decision.subject_kind, outcome: event.data.decision.outcome, decided_by: event.data.decision.decided_by, mode: event.data.decision.mode }]
      : [],
  );
  const toolApprovals = attemptEvents.flatMap((event) =>
    event.type === "approval/decided"
      ? [{ approval_id: event.data.decision.approval_id, subject: event.data.decision.subject_kind, outcome: event.data.decision.outcome, decided_by: event.data.decision.decided_by, mode: event.data.decision.mode }]
      : [],
  );
  const evidence: unknown[] = [];
  for (const event of mine) {
    if (event.type !== "attempt/completion_recorded") continue;
    try {
      const completion = completionPacketSchema.parse(JSON.parse(new TextDecoder().decode(await stores.blobs.get(event.data.blob.digest))));
      evidence.push({
        attempt_id: completion.attempt_id,
        task_id: completion.task_id,
        status: completion.status,
        changed_paths: completion.changed_paths.map((change) => change.path),
        criteria: completion.acceptance_evidence.map((entry) => ({ criterion_id: entry.criterion_id, evidence: entry.evidence.map((ref) => `${ref.kind}:${ref.ref}`) })),
        commands: completion.commands_run.map((command) => ({ command: command.command, exit_code: command.exit_code })),
      });
    } catch {
      evidence.push({ attempt_id: event.data.attempt_id, status: event.data.status, unreadable: true });
    }
  }
  const reviews = mine.flatMap((event) => (event.type === "review/recorded" ? [{ task_id: event.data.task_id, reviewer_attempt_id: event.data.reviewer_attempt_id, decision: event.data.decision }] : []));
  const routes = mine.flatMap((event) =>
    event.type === "route/decided"
      ? [{ tier: event.data.decision.tier, role: event.data.decision.role, route: `${event.data.decision.route.provider_id}/${event.data.decision.route.model_id}`, source: event.data.decision.source, fallback: event.data.decision.fallback.used }]
      : [],
  );
  return {
    run_id: runId,
    session_id: sessionId,
    goal: created?.type === "run/created" ? created.data.goal : "",
    state: last?.type === "run/state_changed" ? last.data.to : "created",
    policy_mode: created?.type === "run/created" ? created.data.policy_mode : "",
    plan:
      proposed?.type === "plan/proposed"
        ? { plan_id: proposed.data.plan.plan_id, digest: proposed.data.digest, state: planState?.type === "plan/state_changed" ? planState.data.to : "proposed", risk: proposed.data.plan.risk }
        : undefined,
    tasks: mine.flatMap((event) =>
      event.type === "task/created"
        ? [{ task_id: event.data.task_id, key: event.data.key, role: event.data.role, risk: event.data.risk, owned_paths: event.data.owned_paths, state: states.get(event.data.task_id) }]
        : [],
    ),
    attempts,
    approvals: [...approvals, ...toolApprovals],
    evidence,
    reviews,
    routes,
    usage: totalUsage([...mine, ...attemptEvents]),
  };
}

function human(report: RunReport): string {
  const lines = [`Run ${report.run_id} (${report.state}, ${report.policy_mode}) in ${report.session_id}`, `Goal: ${report.goal}`];
  lines.push(`Plan: ${JSON.stringify(report.plan ?? "none")}`);
  for (const [title, entries] of [
    ["Tasks", report.tasks],
    ["Attempts", report.attempts],
    ["Approvals", report.approvals],
    ["Evidence", report.evidence],
    ["Reviews", report.reviews],
    ["Routes", report.routes],
  ] as const) {
    lines.push(`${title} (${entries.length}):`);
    for (const entry of entries) lines.push(`  ${JSON.stringify(entry)}`);
  }
  lines.push(`Usage: ${JSON.stringify(report.usage ?? "none reported")}`);
  return `${lines.join("\n")}\n`;
}

export async function showCommand(io: InspectIO, target: string | undefined, id: RunId | SessionId, json: boolean): Promise<number> {
  const root = path.resolve(io.cwd, target ?? ".");
  const { stores: opened, runs, sessions } = await projectRuns(io, root);
  const selected = id.startsWith("run_") ? runs.filter((run) => run.run_id === id) : runs.filter((run) => run.session_id === id);
  if (selected.length === 0) {
    const known = sessions.some((summary) => summary.manifest.session_id === id);
    throw new HarnessError({
      code: "usage_invalid",
      message: known ? `${id} has no runs` : `${id} is not a run or session of ${root}`,
      workspace_effect: "none",
      retry_safe: true,
      next_command: "syn runs",
    });
  }
  const reports: RunReport[] = [];
  const cache = new Map<SessionId, SessionEvent[]>();
  for (const run of selected) {
    const events = cache.get(run.session_id) ?? (await readEvents(opened.sessions, run.session_id));
    cache.set(run.session_id, events);
    reports.push(await reportFor(opened, run.session_id, run.run_id, events));
  }
  io.stdout(json ? `${JSON.stringify(id.startsWith("run_") ? reports[0] : reports, null, 2)}\n` : reports.map(human).join("\n"));
  return EXIT_CODES.success;
}
