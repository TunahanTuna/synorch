import {
  completionPacketSchema,
  reviewPacketSchema,
  WORKSPACE_UNTRUSTED_CODE,
  type BlobStore,
  type CompletionPacket,
  type ReviewPacket,
  type SessionEvent,
  type SessionEventOf,
} from "../contracts/index.ts";
import type { ContextGroupView, ContextItemView, ContextView, CriterionView, DiffView, EvidenceView, ProofView, WhyView } from "../contracts/views.ts";
import { estimateTokens, toolTokens } from "../context/index.ts";
import { rebuildModelRequest } from "../core/envelope.ts";
import { isTestCommand } from "../tui/conversation-view.ts";

/**
 * K2 trust and transparency, built from the event log only (never from what the model said):
 * `/evidence` (UX-04, X2), `/why` (X6) and "Why this context?" (`/context`, UX-07).
 */

type Plan = SessionEventOf<"plan/proposed">["data"]["plan"];

function snippet(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

function ago(timestamp: string | undefined): string {
  const then = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  if (!Number.isFinite(then)) return "earlier";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

async function readJson<T>(blobs: BlobStore, digest: string, parse: (value: unknown) => T): Promise<T | undefined> {
  try {
    return parse(JSON.parse(new TextDecoder().decode(await blobs.get(digest as never))));
  } catch {
    return undefined;
  }
}

function lastLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .join("\n");
}

// ---- /evidence ----------------------------------------------------------------------------------

export interface EvidenceRun {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
}

export interface EvidenceSources {
  readonly blobs: BlobStore;
  /** The conversation's own events. */
  readonly conversation: readonly SessionEvent[];
  /** The conversation's worker runs, oldest first. */
  readonly runs: readonly EvidenceRun[];
  /** The conversation's direct edits (from `/diff`). */
  readonly diff: DiffView;
}

const CHECK_WORDS = /^(build|check|lint|typecheck|tsc|eslint|biome|ruff|mypy|clippy|vet)$/;

/** Test, build and lint commands count as checks for a direct-mode turn. */
export function isCheckCommand(argv: readonly string[]): boolean {
  if (isTestCommand(argv)) return true;
  return argv.some((word, index) => {
    const base = word.toLowerCase().replace(/\.(cmd|exe)$/, "").split(/[\\/]/).pop() ?? "";
    return CHECK_WORDS.test(base) || (index > 0 && /^(build|check|lint|typecheck)(:[\w:-]+)?$/.test(base));
  });
}

function runGoal(run: EvidenceRun): string {
  const created = run.events.find((event): event is SessionEventOf<"run/created"> => event.type === "run/created");
  const plan = run.events.find((event): event is SessionEventOf<"plan/proposed"> => event.type === "plan/proposed");
  return created?.data.goal ?? plan?.data.plan.goal ?? "worker run";
}

function runStatus(run: EvidenceRun): string {
  const state = [...run.events].reverse().find((event): event is SessionEventOf<"run/state_changed"> => event.type === "run/state_changed");
  return state?.data.to.replaceAll("_", " ") ?? "unknown";
}

interface DirectTurn {
  readonly prompt: string;
  readonly at: string | undefined;
  readonly events: readonly SessionEvent[];
}

/** The conversation split into turns (a user message and everything up to the next one). */
function directTurns(events: readonly SessionEvent[]): DirectTurn[] {
  const turns: DirectTurn[] = [];
  let current: { prompt: string; at: string | undefined; events: SessionEvent[] } | undefined;
  for (const event of events) {
    if (event.type === "message/recorded" && event.data.role === "user") {
      if (current !== undefined) turns.push(current);
      const text = event.data.message?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ") ?? "";
      current = { prompt: (text.replace(/^\[Synorch note:[^\]]*\]\s*/u, "").split("<synorch-attachments>")[0] ?? "").trim(), at: event.timestamp, events: [] };
      continue;
    }
    current?.events.push(event);
  }
  if (current !== undefined) turns.push(current);
  return turns;
}

function turnHasWork(turn: DirectTurn): boolean {
  return turn.events.some(
    (event) =>
      event.type === "checkpoint/recorded" ||
      (event.type === "tool/policy_decided" && event.data.action.command !== undefined && isCheckCommand(event.data.action.command.argv)),
  );
}

function directEvidence(turn: DirectTurn, sources: EvidenceSources, restored: ReadonlySet<number>): EvidenceView {
  const changed = [...new Set(turn.events.flatMap((event) => (event.type === "checkpoint/recorded" && !restored.has(event.seq) ? event.data.files.map((file) => file.path) : [])))];
  const criteria: CriterionView[] = [];
  const results = new Map(turn.events.flatMap((event) => (event.type === "tool/result_recorded" ? [[event.data.tool_call_id, event] as const] : [])));
  for (const event of turn.events) {
    if (event.type !== "tool/policy_decided" || event.data.action.command === undefined || !isCheckCommand(event.data.action.command.argv)) continue;
    const command = event.data.action.command.argv.join(" ");
    const result = results.get(event.data.tool_call_id);
    const exit = result?.data.result.exit_code;
    const ran = result !== undefined && exit !== undefined;
    const status: CriterionView["status"] = !ran ? "not_run" : exit === 0 ? "passed" : "failed";
    const proof: ProofView = {
      kind: "command",
      command,
      ...(exit === undefined ? {} : { exitCode: exit }),
      runBy: "harness",
      ...(result === undefined ? {} : { durationMs: result.data.duration_ms }),
      ...(result === undefined || result.data.result.text.trim() === "" ? {} : { excerpt: lastLines(result.data.result.text, 3) }),
      ...(ran ? {} : { detail: result?.data.result.error?.message ?? (event.data.decision.decision === "deny" ? "refused by policy" : "did not run") }),
    };
    criteria.push({ text: `${isTestCommand(event.data.action.command.argv) ? "tests" : "check"}: ${command}`, status, proofs: [proof] });
  }
  if (!criteria.some((criterion) => criterion.text.startsWith("tests:"))) {
    criteria.unshift({ text: "tests", status: "not_run", proofs: [{ kind: "note", text: "no test command ran in this turn; ask Synorch to run the tests, or run them yourself" }] });
  }
  const files = sources.diff.files.filter((file) => changed.includes(file.path));
  for (const file of files) criteria.push({ text: `changed ${file.path}`, status: "unverifiable", proofs: [{ kind: "file", path: file.path, note: `+${file.added} -${file.removed}${file.change === "modified" ? "" : ` (${file.change})`}` }] });
  return {
    kind: "evidence",
    title: `turn "${snippet(turn.prompt, 50)}"`,
    criteria,
    review: { independent: false },
    ...(changed.length === 0 ? {} : { changedPaths: changed }),
    ...(files.length === 0 ? {} : { diffstat: { files: files.length, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) } }),
    next: changed.length === 0 ? "nothing changed in this turn" : "direct edits are not independently reviewed: /review runs a reviewer on the uncommitted diff · /diff shows the lines",
  };
}

async function runEvidence(run: EvidenceRun, blobs: BlobStore): Promise<EvidenceView> {
  const events = run.events;
  const keys = new Map<string, string>();
  const states = new Map<string, string>();
  const attempts = new Map<string, string>();
  let plan: Plan | undefined;
  for (const event of events) {
    if (event.type === "task/created") keys.set(event.data.task_id, event.data.key);
    if (event.type === "task/state_changed") states.set(event.data.task_id, event.data.to);
    if (event.type === "attempt/started") attempts.set(event.data.attempt_id, event.data.task_id);
    if (event.type === "plan/proposed") plan = event.data.plan;
  }
  const reviews = new Map<string, ReviewPacket>();
  const reviewEvents = events.filter((event): event is SessionEventOf<"review/recorded"> => event.type === "review/recorded");
  for (const event of reviewEvents) {
    const packet = await readJson(blobs, event.data.blob.digest, (value) => reviewPacketSchema.parse(value));
    if (packet !== undefined) reviews.set(event.data.task_id, packet);
  }
  const cited = new Map<string, CompletionPacket["acceptance_evidence"]>();
  for (const event of events) {
    if (event.type !== "attempt/completion_recorded") continue;
    const completion = await readJson(blobs, event.data.blob.digest, (value) => completionPacketSchema.parse(value));
    const taskId = attempts.get(event.data.attempt_id);
    if (completion !== undefined && taskId !== undefined) cited.set(taskId, completion.acceptance_evidence);
  }
  const criteria: CriterionView[] = [];
  for (const [taskId, key] of keys) {
    const task = plan?.tasks.find((candidate) => candidate.key === key);
    const review = reviews.get(taskId);
    for (const criterion of task?.acceptance_criteria ?? []) {
      const verdict = review?.criteria.find((entry) => entry.criterion_id === criterion.id);
      const proofs: ProofView[] = [];
      for (const entry of cited.get(taskId)?.filter((item) => item.criterion_id === criterion.id) ?? []) {
        for (const ref of entry.evidence) proofs.push({ kind: "note", text: `${ref.kind} ${ref.ref} (cited by the ${ref.produced_by})`, inferred: ref.produced_by !== "harness" });
      }
      if (review !== undefined && verdict !== undefined) {
        proofs.push({
          kind: "review",
          verdict: verdict.verdict === "met" ? "accepted" : verdict.verdict === "not_met" ? "rejected" : "changes_requested",
          reviewer: review.reviewer_route.model_id,
          independent: !review.independence.same_model,
        });
        if (verdict.note !== undefined) proofs.push({ kind: "note", text: verdict.note });
      }
      const status: CriterionView["status"] =
        verdict === undefined ? (states.get(taskId) === "failed" ? "failed" : "unverifiable") : verdict.verdict === "met" ? "passed" : verdict.verdict === "not_met" ? "failed" : "unverifiable";
      criteria.push({ text: `${key}: ${criterion.statement}`, status, proofs });
    }
  }
  for (const event of events) {
    if (event.type !== "attempt/verification_ran") continue;
    criteria.push({
      text: `${keys.get(event.data.task_id) ?? "task"}: check ${event.data.command}`,
      status: event.data.status === "passed" ? "passed" : event.data.status === "failed" ? "failed" : "not_run",
      proofs: [
        {
          kind: "command",
          command: event.data.command,
          ...(event.data.exit_code === null ? {} : { exitCode: event.data.exit_code }),
          runBy: "harness",
          durationMs: event.data.duration_ms,
          ...(event.data.output_excerpt.trim() === "" ? {} : { excerpt: lastLines(event.data.output_excerpt, 3) }),
          ...(event.data.reason === undefined ? {} : { detail: event.data.reason }),
        },
      ],
    });
  }
  const lastReview = [...reviews.values()].at(-1);
  const lastDecision = reviewEvents.at(-1)?.data.decision;
  const findings = [...reviews.values()].flatMap((review) =>
    review.findings.map((finding) => `${finding.severity} ${finding.path === undefined ? "" : `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} `}${finding.summary}`),
  );
  const integrated = [...new Set(events.flatMap((event) => (event.type === "task/integrated" ? event.data.paths : [])))];
  return {
    kind: "evidence",
    title: `workers: ${snippet(runGoal(run), 50)} (${runStatus(run)})`,
    criteria,
    review:
      lastReview === undefined
        ? { independent: false }
        : {
            independent: true,
            reviewer: lastReview.reviewer_route.model_id,
            verdict: lastDecision === "accept" ? "accepted" : lastDecision === "revise" ? "changes_requested" : "rejected",
            findings,
          },
    ...(integrated.length === 0 ? {} : { changedPaths: integrated }),
    ...(lastReview === undefined ? { next: "no independent review was recorded for this run" } : {}),
  };
}

/**
 * `/evidence [turn | <n>]`: the latest worker run or direct-mode turn (whichever is newer), the
 * latest direct turn, or the n-th most recent worker run.
 */
export async function buildEvidence(sources: EvidenceSources, argument: string): Promise<EvidenceView> {
  const restored = new Set(sources.conversation.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
  const turns = directTurns(sources.conversation).filter(turnHasWork);
  const runs = [...sources.runs].reverse();
  const others = runs.map((run, index) => `${index + 1}. ${snippet(runGoal(run), 40)} · ${runStatus(run)} · ${ago(run.events.at(-1)?.timestamp)}`);
  const wanted = argument.trim().toLowerCase();
  const lastTurn = turns.at(-1);
  const withOthers = (view: EvidenceView): EvidenceView => (others.length === 0 ? view : { ...view, others: [...(lastTurn === undefined ? [] : ["turn"]), ...others] });
  if (/^\d+$/.test(wanted)) {
    const run = runs[Number(wanted) - 1];
    if (run !== undefined) return withOthers(await runEvidence(run, sources.blobs));
    return { kind: "evidence", title: `no worker run ${wanted}`, criteria: [], next: runs.length === 0 ? "no worker runs in this conversation yet" : `/evidence 1…${runs.length}` };
  }
  const latestRun = runs[0];
  const runAt = latestRun?.events.at(-1)?.timestamp ?? "";
  const turnAt = lastTurn?.events.at(-1)?.timestamp ?? lastTurn?.at ?? "";
  if (wanted !== "turn" && latestRun !== undefined && (lastTurn === undefined || runAt >= turnAt)) return withOthers(await runEvidence(latestRun, sources.blobs));
  if (lastTurn !== undefined) return withOthers(directEvidence(lastTurn, sources, restored));
  return { kind: "evidence", title: "this conversation", criteria: [], review: { independent: false }, next: "nothing changed and no checks ran yet" };
}

// ---- /why ---------------------------------------------------------------------------------------

export interface WhyFacts {
  readonly mode: string;
  readonly trust: string;
  readonly sandbox: string;
  readonly grants: readonly string[];
  readonly planOn: boolean;
  readonly noPermissionMode: boolean;
}

type Decided = SessionEventOf<"tool/policy_decided">;

function target(event: Decided): string {
  const action = event.data.action;
  return action.command !== undefined ? action.command.argv.join(" ") : action.paths.map((entry) => entry.path).join(", ") || action.network_hosts.join(", ");
}

function subjectOf(event: Decided): string {
  return `${event.data.action.tool_name} ${snippet(target(event), 100)}`.trim();
}

const DECISION_WORD = { allow: "allowed", ask: "asked you", deny: "denied" } as const;

function routeWhy(events: readonly SessionEvent[]): WhyView | undefined {
  const decided = [...events].reverse().find((event): event is SessionEventOf<"route/decided"> => event.type === "route/decided");
  if (decided === undefined) return undefined;
  const decision = decided.data.decision;
  const facts = [
    { label: "Tier", text: `${decision.tier}${decision.role === undefined ? "" : ` (role ${decision.role})`}` },
    { label: "Source", text: `${decision.source} configuration` },
    { label: "Reason", text: decision.reason },
    { label: "Adapter", text: decision.route.adapter_id },
    { label: "Fallback", text: decision.fallback.used ? `yes, from ${decision.fallback.from?.provider_id ?? "?"}/${decision.fallback.from?.model_id ?? "?"} (approved)` : "no" },
  ];
  return {
    kind: "why",
    question: "Why this model?",
    subject: `${decision.route.provider_id}/${decision.route.model_id}`,
    decision: "allow",
    reasons: [],
    howToChange: [
      { command: "/model", effect: "every logged-in provider's models; switch this conversation" },
      { command: `/config routes.${decision.tier}`, effect: "change the default route for this tier" },
    ],
    facts,
  };
}

/**
 * `/why [last | <n> | <tool> | model]`: the latest (or the n-th most recent, or the latest of one
 * tool) policy decision — layer, rule, who answered a prompt, the mode and trust it ran under and
 * what would change it — or why the conversation's model route was chosen.
 */
export function buildWhy(events: readonly SessionEvent[], argument: string, facts: WhyFacts): WhyView | string {
  const wanted = argument.trim().toLowerCase();
  if (wanted === "model" || wanted === "route") return routeWhy(events) ?? "No model route recorded yet in this conversation.";
  const decided = [...events].reverse().filter((event): event is Decided => event.type === "tool/policy_decided");
  let chosen: Decided | undefined;
  if (wanted === "" || wanted === "last") chosen = decided[0];
  else if (/^\d+$/.test(wanted)) chosen = decided[Number(wanted) - 1];
  else chosen = decided.find((event) => event.data.action.tool_name.toLowerCase().includes(wanted));
  if (chosen === undefined) {
    if (decided.length === 0) return "No action recorded yet in this conversation. /why model explains the model route.";
    return /^\d+$/.test(wanted) ? `Only ${decided.length} decision${decided.length === 1 ? "" : "s"} recorded; /why 1…${decided.length}` : `No ${wanted} action recorded in this conversation.`;
  }
  const action = chosen.data.action;
  const decision = chosen.data.decision;
  const index = events.indexOf(chosen);
  const result = events.find((event): event is SessionEventOf<"tool/result_recorded"> => event.type === "tool/result_recorded" && event.data.tool_call_id === chosen.data.tool_call_id);
  const resultIndex = result === undefined ? events.length : events.indexOf(result);
  const answered = events.slice(index, resultIndex).find((event): event is SessionEventOf<"approval/decided"> => event.type === "approval/decided");
  const howToChange: { command: string; effect: string }[] = [];
  const add = (command: string, effect: string): void => {
    if (!howToChange.some((entry) => entry.command === command)) howToChange.push({ command, effect });
  };
  for (const reason of decision.reasons) {
    // `/allow` extends only the conversation agent's partial-sandbox allowlist; a hard refusal (layer role) or a worker refusal is explained, never answered with /allow.
    if (reason.code === "exec-not-allowlisted" && reason.layer === "sandbox" && action.role === "session" && decision.decision === "deny" && action.command !== undefined) add(`/allow ${action.command.argv.slice(0, 2).join(" ")}`, "lets Synorch run commands starting with this prefix here");
    if (reason.code === WORKSPACE_UNTRUSTED_CODE) add("/trust", "lets build and test commands run in this folder");
    if (reason.code === "approval-required" || reason.code === "permission-prompt") add("/permissions auto (or Shift+Tab)", "fewer questions: auto asks only for risky commands, full asks nothing (hard rails still apply)");
    if (reason.code === "exec-not-allowlisted" && facts.noPermissionMode) add("--permission-mode auto", "asks you instead of refusing commands outside the allowlist");
    if (reason.code === "sandbox-insufficient") add("syn doctor --runtime", "shows why a full sandbox is required and missing");
  }
  if (facts.planOn && decision.decision === "deny" && decision.reasons.some((reason) => reason.code === "workspace-write-denied" || reason.code === "exec-denied")) add("/plan (or Shift+Tab)", "leaves plan mode so edits and commands are allowed");
  if (answered?.data.decision.outcome === "allowed-for-scope" && action.command !== undefined) add("/permissions remove <prefix>", "removes an \"Always allow\" rule again");
  if (decision.decision === "allow" && howToChange.length === 0 && action.command !== undefined && facts.grants.some((grant) => action.command?.argv.join(" ").startsWith(grant))) add("/permissions remove <prefix>", "stops auto-allowing this command prefix");
  const whyFacts = [
    { label: "Mode", text: facts.mode },
    ...(action.command === undefined ? [] : [{ label: "Trust", text: facts.trust }]),
    { label: "Sandbox", text: facts.sandbox },
    ...(answered === undefined ? [] : [{ label: "Answered", text: `${answered.data.decision.outcome.replaceAll("-", " ")} by ${answered.data.decision.decided_by === "user" ? "you" : answered.data.decision.decided_by}${answered.data.decision.reason === undefined ? "" : `: ${snippet(answered.data.decision.reason, 120)}`}` }]),
    ...(action.destructive ? [{ label: "Note", text: "destructive: asks in every mode" }] : []),
    ...(decision.rail === undefined ? [] : [{ label: "Rail", text: `${decision.rail} (hard rail, every mode)` }]),
    ...(result?.data.result.error === undefined ? [] : [{ label: "Result", text: snippet(result.data.result.error.message, 200) }]),
  ];
  return {
    kind: "why",
    subject: `${subjectOf(chosen)}${result === undefined ? "" : ` (${result.data.state})`}`,
    decision: decision.decision,
    reasons: decision.reasons.map((reason) => ({ layer: reason.layer, code: reason.code, message: reason.message })),
    howToChange,
    facts: whyFacts,
    recent: decided.slice(0, 6).map((event, position) => `${position + 1}. ${snippet(subjectOf(event), 60)} · ${DECISION_WORD[event.data.decision.decision]}`),
  };
}

// ---- /context (UX-07) ---------------------------------------------------------------------------

function instructionLabel(blockId: string): string {
  if (blockId.startsWith("harness:")) return `Synorch harness rules (${blockId.slice(8)})`;
  if (blockId === "constitution") return ".ai constitution";
  if (blockId.startsWith("protocol:")) return `protocol ${blockId.slice(9)}`;
  if (blockId.startsWith("entrypoint:")) return `${blockId.slice(11)} (repository guidance)`;
  if (blockId === "project-profile") return "Project profile (auto-detected: stack, package manager, commands)";
  if (blockId.startsWith("role:")) return `role manifest (${blockId.slice(5)})`;
  return blockId;
}

/** `/context`: every block of the last model request with its origin, why it is there and its token estimate. */
export async function buildContextView(events: readonly SessionEvent[], blobs: BlobStore, windowTokens: number | undefined): Promise<ContextView | undefined> {
  const request = [...events].reverse().find((event): event is SessionEventOf<"model/request_prepared"> => event.type === "model/request_prepared");
  if (request === undefined) return undefined;
  const envelope = await rebuildModelRequest(request, blobs).catch(() => undefined);
  const text = new Map((envelope?.system ?? []).map((block) => [block.id, block.text]));
  const groups: { title: string; items: ContextItemView[] }[] = [
    { title: "Instructions", items: [] },
    { title: "Skills", items: [] },
    { title: "Task packet", items: [] },
    { title: "Memory recalled", items: [] },
    { title: "Files inlined", items: [] },
    { title: "History", items: [] },
    { title: "Tools", items: [] },
  ];
  const group = (title: string): ContextItemView[] => groups.find((entry) => entry.title === title)?.items ?? [];
  const compaction = [...events].reverse().find((event): event is SessionEventOf<"context/compacted"> => event.type === "context/compacted");
  let total = 0;
  for (const block of request.data.context) {
    total += block.tokens_estimate;
    const base = { tokens: block.tokens_estimate, trust: block.trust, ...(block.truncated ? { truncated: true } : {}) };
    const body = text.get(block.block_id) ?? "";
    switch (block.source) {
      case "harness":
      case "constitution":
      case "protocol":
      case "role":
        group("Instructions").push({ label: instructionLabel(block.block_id), detail: block.source === "harness" ? "harness priority" : "project instructions", ...base });
        break;
      case "skill-catalog": {
        const count = body.split(/\r?\n/).filter((line) => /^\s*[-*]\s/.test(line)).length;
        group("Skills").push({ label: "skill catalog", detail: count === 0 ? "names and triggers; load_skill loads one" : `${count} skills listed; load_skill loads one`, ...base });
        break;
      }
      case "skill":
        group("Skills").push({ label: `skill ${block.block_id.replace(/^skill:/, "")}`, detail: "loaded in full (primary for the role or triggered by the request)", ...base });
        break;
      case "packet":
        group("Task packet").push({ label: block.trust === "untrusted" ? "inlined sources" : "task packet", ...base });
        break;
      case "memory": {
        const id = block.block_id.replace(/^memory:/, "");
        const title = /^# (.+)$/m.exec(body)?.[1] ?? "";
        const why = /^Why recalled: (.+)$/m.exec(body)?.[1];
        group("Memory recalled").push({ label: `${id}${title === "" ? "" : ` ${title}`}`, ...(why === undefined ? {} : { detail: why }), ...base, ...(/^STALE:/m.test(body) ? { stale: true } : {}) });
        break;
      }
      case "compaction":
        group("History").push({ label: "summary of earlier messages", detail: compaction === undefined ? "compacted" : `compacted ${compaction.data.trigger}: ~${compaction.data.tokens_before} → ~${compaction.data.tokens_after} tokens`, ...base });
        break;
      case "history": {
        const messages = envelope?.messages.filter((message) => message.role !== "tool").length;
        group("History").push({ label: "conversation messages", detail: `${messages === undefined ? "" : `${messages} messages `}${compaction === undefined ? "since the start" : "since the last compaction"}`, ...base });
        break;
      }
      case "tool-result":
        group("History").push({ label: "tool results", detail: "output of the tools this conversation called (data)", ...base });
        break;
      default:
        group("Instructions").push({ label: block.block_id, ...base });
    }
  }
  // Files the user attached (@path) to the latest message: part of the history above, listed for provenance.
  const lastUser = [...(envelope?.messages ?? [])].reverse().find((message) => message.role === "user");
  const userText = lastUser?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? "";
  for (const match of userText.matchAll(/<(file|directory) path="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const truncated = /^<file[^>]* truncated="true"/.test(match[0]);
    group("Files inlined").push({ label: `${match[2] ?? "?"}${match[1] === "directory" ? "/" : ""}`, detail: "attached with @ in your last message (counted in history)", tokens: estimateTokens(match[3] ?? ""), trust: "untrusted", ...(truncated ? { truncated: true } : {}) });
  }
  if (envelope !== undefined && envelope.tools.length > 0) {
    const tokens = toolTokens(envelope.tools);
    total += tokens;
    group("Tools").push({ label: `${envelope.tools.length} tool schemas`, detail: envelope.tools.map((tool) => tool.name).slice(0, 8).join(", ") + (envelope.tools.length > 8 ? ", …" : ""), tokens });
  }
  const memoryCount = group("Memory recalled").length;
  return {
    kind: "context",
    model: `${request.data.route.provider_id}/${request.data.route.model_id}`,
    totalTokens: total,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    groups: groups.filter((entry) => entry.items.length > 0) as ContextGroupView[],
    notes: [
      memoryCount === 0 ? "no memory was recalled for this request (/memory shows the ledger)" : "memory is data, not instructions · /memory retire <id> stops a note from being recalled",
      "token counts are estimates (about 4 characters per token)",
    ],
  };
}
