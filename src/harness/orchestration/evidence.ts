import {
  acceptanceCriterionIdSchema,
  EVIDENCE_KINDS,
  toolCallIdSchema,
  packetDigest,
  parseToolRef,
  type CompletionPacket,
  type Digest,
  type EvidenceCandidate,
  type EvidenceProblem,
  type EvidenceRef,
  type EvidenceResolution,
  type EvidenceResolutionMethod,
  type HarnessEvidence,
  type HarnessVerification,
  type ReviewPacket,
  type TaskContextPacket,
  verificationProves,
} from "../contracts/index.ts";
import type { AttemptLog, RecordedToolCall } from "./attempt-log.ts";
import { findScopeViolations, normalizeWorkspacePath } from "./paths.ts";

/**
 * Evidence is a pointer the log can resolve, never prose (ADR-18: the harness computes the truth,
 * the model supplies the narrative and pointers). Pointers are resolved tolerantly, in the fixed
 * order of `TOOL_EVIDENCE_RESOLUTION_ORDER`, and every resolution is recorded with the method that
 * matched. A worker's evidence resolves against its own attempt; a reviewer's `produced_by:
 * reviewer` evidence resolves only against the reviewer's own attempt, so a reviewer cannot pass
 * off the implementer's tool calls as its own; `harness-*` evidence resolves only against the
 * records the harness computed itself. A compaction summary never counts as evidence (ADR-11).
 */

export interface EvidenceIndex {
  readonly log: AttemptLog;
  readonly artifactDigest: Digest | undefined;
  readonly changedPaths: readonly string[];
  /** Digest of a file in the attempt's workspace, or undefined when it does not exist. */
  fileDigest(path: string): Promise<Digest | undefined>;
  /** What the harness computed for the attempt (verification runs, the pinned diff). */
  readonly harness?: HarnessEvidence | undefined;
}

const EVENT_REF = /^(?:(ses_[0-9A-HJKMNP-TV-Z]{26})#)?(\d+)$/;
const TOOL_PREFIXES = [/^functions[./]/i, /^mcp__synorch__/i, /^tools?[./]/i];
const DIGEST_TOKEN = /sha256:[0-9a-f]{64}/;
const REASON_LIMIT = 480;

/** Control tools whose calls are never evidence of work (they report or steer, they do not observe). */
const CONTROL_TOOLS: ReadonlySet<string> = new Set(["task_report", "review_report", "plan_propose", "task_triage", "task_spawn", "task_status", "load_skill", "memory_propose", "ask_user"]);

type Target = { readonly toolCallId?: string; readonly path?: string };

function bounded(reason: string): string {
  return reason.length <= REASON_LIMIT ? reason : `${reason.slice(0, REASON_LIMIT - 3)}...`;
}

function boundedRef(ref: string): string {
  return ref.length <= 2000 ? ref : ref.slice(0, 2000);
}

function criterionField(criterionId: string | undefined): { criterion_id?: EvidenceResolution["criterion_id"] } {
  const parsed = criterionId === undefined ? undefined : acceptanceCriterionIdSchema.safeParse(criterionId);
  return parsed?.success === true ? { criterion_id: parsed.data } : {};
}

function resolved(ref: EvidenceRef, criterionId: string | undefined, method: EvidenceResolutionMethod, target: Target = {}): EvidenceResolution {
  const path = target.path === undefined ? undefined : normalizeWorkspacePath(target.path);
  const toolCallId = target.toolCallId === undefined ? undefined : toolCallIdSchema.safeParse(target.toolCallId);
  return {
    ...criterionField(criterionId),
    kind: ref.kind,
    ref: boundedRef(ref.ref),
    produced_by: ref.produced_by,
    status: "resolved",
    method,
    ...(toolCallId?.success === true ? { tool_call_id: toolCallId.data } : {}),
    ...(path === undefined || path === "." ? {} : { path }),
  };
}

/** An unresolved resolution with its reason (bounded). */
export function unresolvedPointer(ref: EvidenceRef, criterionId: string | undefined, reason: string): EvidenceResolution {
  return unresolved(ref, criterionId, reason);
}

function unresolved(ref: EvidenceRef, criterionId: string | undefined, reason: string): EvidenceResolution {
  return {
    ...criterionField(criterionId),
    kind: ref.kind,
    ref: boundedRef(ref.ref),
    produced_by: ref.produced_by,
    status: "unresolved",
    reason: bounded(reason),
  };
}

/** Why a matched call cannot serve as this kind of evidence, or undefined when it can. */
function callProblem(kind: EvidenceRef["kind"], call: RecordedToolCall, label: string): string | undefined {
  if (call.state !== "succeeded") return `${label} ended ${call.state}`;
  if (kind === "test-run" && call.exitCode !== undefined && call.exitCode !== 0) return `${label} exited ${call.exitCode}`;
  return undefined;
}

/** The pointer text without decoration: surrounding quotes/backticks and a leading `<kind>:`. */
function cleanPointer(text: string): string {
  let value = text.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  for (const kind of EVIDENCE_KINDS) {
    if (value.toLowerCase().startsWith(`${kind}:`)) {
      value = value.slice(kind.length + 1).trim();
      break;
    }
  }
  return value;
}

function stripToolPrefix(word: string): string {
  let value = word;
  for (const prefix of TOOL_PREFIXES) value = value.replace(prefix, "");
  return value;
}

function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  return into;
}

/** The argument values that identify a call: argv words, paths and patterns. */
function identifyingArgs(call: RecordedToolCall): string[] {
  const args = call.arguments;
  if (args === undefined) return [];
  if (Array.isArray(args.argv)) return stringsOf(args.argv).filter((word) => word.trim() !== "");
  const keys = ["path", "paths", "pattern", "file", "files", "target"];
  return keys.flatMap((key) => stringsOf(args[key])).filter((word) => word.trim() !== "" && word !== ".");
}

function pathsOf(call: RecordedToolCall): string[] {
  const args = call.arguments ?? {};
  const fromArgs = [...stringsOf(args.path), ...stringsOf(args.paths), ...stringsOf(args.file), ...stringsOf(args.files)];
  const fromArgv = Array.isArray(args.argv) ? stringsOf(args.argv).filter((word) => /[./\\]/.test(word) && !word.startsWith("-")) : [];
  return [...fromArgs, ...fromArgv, ...(call.changedPaths ?? [])]
    .map((candidate) => normalizeWorkspacePath(candidate))
    .filter((candidate): candidate is string => candidate !== undefined && candidate !== ".");
}

function samePath(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

/** Calls in log order that the model can cite (never the report/control tools themselves). */
function citableCalls(log: AttemptLog): { readonly id: string; readonly call: RecordedToolCall }[] {
  return [...log.toolCalls.entries()]
    .filter(([, call]) => call.name !== undefined && !CONTROL_TOOLS.has(call.name))
    .map(([id, call]) => ({ id, call }));
}

/** Best call for `functions.<tool> <args…>` / `<tool> <args…>` prose, or why none fits. */
function matchToolNameArgs(text: string, log: AttemptLog): { readonly id: string; readonly call: RecordedToolCall } | { readonly problem: string } | undefined {
  const head = /^([A-Za-z_][\w.]*)/.exec(text);
  if (head === null) return undefined;
  const name = stripToolPrefix(head[1] ?? "");
  const rest = text.slice(head[0].length).toLowerCase();
  const calls = citableCalls(log).filter((entry) => entry.call.name === name);
  if (calls.length === 0) return head[1] !== name ? { problem: `no ${name} call ran in this attempt` } : undefined;
  const scored = calls
    .map((entry) => {
      const identifying = identifyingArgs(entry.call);
      const found = identifying.filter((word) => rest.includes(word.toLowerCase())).length;
      const complete = identifying.length === 0 ? entry.call.arguments !== undefined && rest.trim() === "" : entry.call.arguments?.argv !== undefined ? found === identifying.length : found > 0;
      return { entry, found, complete };
    })
    .filter((candidate) => candidate.complete);
  if (scored.length === 0) return { problem: `no ${name} call of this attempt matches '${text.slice(0, 120)}'` };
  const succeeded = scored.filter((candidate) => candidate.entry.call.state === "succeeded");
  const pool = succeeded.length > 0 ? succeeded : scored;
  const best = pool.reduce((left, right) => (right.found > left.found || (right.found === left.found && (right.entry.call.ordinal ?? 0) >= (left.entry.call.ordinal ?? 0)) ? right : left));
  return best.entry;
}

/** The first path-like token of prose: `src/a.ts:1-3 — …`, `a.ts#L3`, `a.ts (post-change)`. */
export function firstPathToken(text: string): string | undefined {
  const head = text.split(/\s+[—–]\s+|\s—|\s–/)[0] ?? text;
  for (const raw of head.split(/[\s;,`'"()[\]{}<>]+/)) {
    const token = raw
      .replace(/#L?\d+(?:-L?\d+)?$/i, "")
      .replace(/:(?:L?\d+(?:[-:]L?\d+)*)?$/i, "")
      .replace(/[.:]+$/, "");
    if (token === "" || !/[./\\]/.test(token) || /^[a-z][\w-]*\.[a-z_]+$/i.test(token) && TOOL_PREFIXES.some((prefix) => prefix.test(token))) continue;
    if (/^https?:/i.test(token) || DIGEST_TOKEN.test(token)) continue;
    const normalized = normalizeWorkspacePath(token);
    if (normalized !== undefined && normalized !== ".") return normalized;
  }
  return undefined;
}

async function resolveToolPointer(ref: EvidenceRef, index: EvidenceIndex, criterionId: string | undefined): Promise<EvidenceResolution> {
  const log = index.log;
  const text = cleanPointer(ref.ref);
  const label = `${ref.kind}:${text.slice(0, 120)}`;
  const fromCall = (id: string, call: RecordedToolCall, method: EvidenceResolutionMethod): EvidenceResolution => {
    const problem = callProblem(ref.kind, call, label);
    if (problem !== undefined) return unresolved(ref, criterionId, problem);
    const path = ref.kind === "file" ? pathsOf(call)[0] : undefined;
    return resolved(ref, criterionId, method, { toolCallId: id, ...(path === undefined ? {} : { path }) });
  };

  const exact = log.toolCalls.get(text);
  if (exact !== undefined) return fromCall(text, exact, "tool-call-id");

  const ordinal = parseToolRef(text);
  if (ordinal !== undefined) {
    const id = log.ordinals?.get(ordinal);
    const call = id === undefined ? undefined : log.toolCalls.get(id);
    if (id === undefined || call === undefined) return unresolved(ref, criterionId, `#${ordinal} is not a tool call of this attempt`);
    return fromCall(id, call, "short-ref");
  }

  const firstWord = text.split(/[\s:,;]+/)[0] ?? "";
  if (firstWord !== "") {
    for (const [id, call] of log.toolCalls) {
      if (call.providerCallId !== undefined && call.providerCallId === firstWord) return fromCall(id, call, "provider-call-id");
    }
  }

  const byName = matchToolNameArgs(text, log);
  if (byName !== undefined && "id" in byName) return fromCall(byName.id, byName.call, "tool-name-args");

  const bareCandidate = ref.kind === "file" && !/\s/.test(text) && !/:\d/.test(text) ? normalizeWorkspacePath(text.split("#")[0] ?? "") : undefined;
  const bare = bareCandidate === "." ? undefined : bareCandidate;
  const prose = TOOL_PREFIXES.some((prefix) => prefix.test(text)) ? text.replace(/^\S+\s*/, "") : text;
  const token = bare ?? firstPathToken(prose);
  if (token !== undefined) {
    if (ref.kind === "file") {
      const digest = await index.fileDigest(token);
      const deleted = digest === undefined && index.changedPaths.some((path) => samePath(path, token));
      if (digest === undefined && !deleted) return unresolved(ref, criterionId, `file:${token} does not exist`);
      if (ref.digest !== undefined && digest !== undefined && ref.digest !== digest) return unresolved(ref, criterionId, `file:${token} changed since it was cited`);
      const touched = deleted || token === bare || index.changedPaths.some((path) => samePath(path, token)) || citableCalls(log).some((entry) => pathsOf(entry.call).some((path) => samePath(path, token)));
      if (!touched) return unresolved(ref, criterionId, `file:${token} was neither changed nor read in this attempt`);
      return resolved(ref, criterionId, "path-token", { path: token });
    }
    const touching = citableCalls(log).filter((entry) => pathsOf(entry.call).some((path) => samePath(path, token)));
    const usable = touching.filter((entry) => callProblem(ref.kind, entry.call, label) === undefined);
    const chosen = (usable.length > 0 ? usable : touching).at(-1);
    if (chosen !== undefined) return fromCall(chosen.id, chosen.call, "path-token");
  }

  if (byName !== undefined && "problem" in byName) return unresolved(ref, criterionId, byName.problem);
  return unresolved(ref, criterionId, `${label} is not a tool call of this attempt (cite the [#n] shown before a tool result, e.g. "#3")`);
}

/**
 * Resolves one pointer against an index and returns how it matched (or why not). The caller picks
 * the index by `produced_by`; `harness-*` pointers resolve against `index.harness`.
 */
export async function resolvePointer(ref: EvidenceRef, index: EvidenceIndex, criterionId?: string): Promise<EvidenceResolution> {
  if (ref.digest !== undefined && index.log.compactionBlobs.has(ref.digest)) {
    return unresolved(ref, criterionId, `${ref.kind}:${ref.ref} is a compaction summary, which is never evidence`);
  }
  switch (ref.kind) {
    case "tool-call":
    case "test-run":
    case "file":
      return resolveToolPointer(ref, index, criterionId);
    case "artifact": {
      const target = ref.digest ?? DIGEST_TOKEN.exec(ref.ref)?.[0] ?? ref.ref;
      if (index.log.compactionBlobs.has(target)) return unresolved(ref, criterionId, `artifact:${target} is a compaction summary, which is never evidence`);
      if (index.artifactDigest === undefined || target !== index.artifactDigest) return unresolved(ref, criterionId, `artifact:${target.slice(0, 120)} is not the pinned artifact`);
      return resolved(ref, criterionId, "artifact-digest");
    }
    case "event": {
      const match = EVENT_REF.exec(cleanPointer(ref.ref));
      if (match === null) return unresolved(ref, criterionId, `event:${ref.ref.slice(0, 120)} is not <session>#<seq>`);
      if (match[1] !== undefined && match[1] !== index.log.sessionId) return unresolved(ref, criterionId, `event:${ref.ref} belongs to another session`);
      const type = index.log.eventTypes.get(Number(match[2]));
      if (type === undefined) return unresolved(ref, criterionId, `event:${ref.ref} does not exist`);
      if (type === "context/compacted") return unresolved(ref, criterionId, `event:${ref.ref} is a compaction summary, which is never evidence`);
      return resolved(ref, criterionId, "event-ref");
    }
    case "review":
      return unresolved(ref, criterionId, `review:${ref.ref.slice(0, 120)} is a review pointer, not first-hand evidence`);
    case "harness-verification": {
      const record = index.harness?.verification.find((candidate) => candidate.evidence.ref === ref.ref.trim());
      if (record === undefined) return unresolved(ref, criterionId, `harness-verification:${ref.ref.slice(0, 120)} is not a verification the harness ran for this attempt`);
      if (record.status !== "passed") return unresolved(ref, criterionId, `the harness run of "${record.command}" ${record.status === "failed" ? `exited ${record.exit_code ?? record.termination ?? "abnormally"}` : "did not run"}`);
      return resolved(ref, criterionId, "harness-record");
    }
    case "harness-diff": {
      const diff = index.harness?.diff;
      if (diff === undefined || diff.evidence.ref !== ref.ref.trim()) return unresolved(ref, criterionId, `harness-diff:${ref.ref.slice(0, 120)} is not the pinned diff of this attempt`);
      return resolved(ref, criterionId, "harness-record");
    }
  }
}

/** Returns why the reference does not resolve, or undefined when it does. */
export async function resolveEvidence(ref: EvidenceRef, index: EvidenceIndex): Promise<string | undefined> {
  const resolution = await resolvePointer(ref, index);
  return resolution.status === "resolved" ? undefined : resolution.reason;
}

/** The valid refs a correction message offers: `#n tool summary`, newest last, bounded. */
export function evidenceCandidates(log: AttemptLog, limit = 30): EvidenceCandidate[] {
  return citableCalls(log)
    .filter((entry) => entry.call.state === "succeeded" && entry.call.ordinal !== undefined)
    .slice(-limit)
    .map((entry) => {
      const argv = entry.call.arguments?.argv;
      const summary = Array.isArray(argv)
        ? `${stringsOf(argv).join(" ")}${entry.call.exitCode === undefined ? "" : ` -> exit ${entry.call.exitCode}`}`
        : identifyingArgs(entry.call).join(" ") || "(no arguments)";
      return { ref: entry.call.ordinal ?? 0, toolName: entry.call.name ?? "tool", summary: summary.slice(0, 160) };
    });
}

/** Splits a verification command into argv when it is a plain word list (no shell syntax); else undefined. */
export function commandArgv(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (trimmed === "" || /[|&;<>`$(){}\n\\*?]/.test(trimmed) || /(^|\s)[A-Za-z_]\w*=/.test(trimmed)) return undefined;
  const words: string[] = [];
  const pattern = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (const match of trimmed.matchAll(pattern)) {
    const word = match[1] ?? match[2] ?? match[3] ?? "";
    if (match[3] !== undefined && /['"]/.test(word)) return undefined;
    words.push(word);
  }
  return words.length === 0 ? undefined : words;
}

function sameCommand(left: string, right: string): boolean {
  const a = commandArgv(left);
  const b = commandArgv(right);
  if (a !== undefined && b !== undefined) return a.length === b.length && a.every((word, index) => word === b[index]);
  return left.trim().replace(/\s+/g, " ") === right.trim().replace(/\s+/g, " ");
}

/** Every exec call of the log with a known argv and exit code, as `commands_run` entries (ADR-18: from the log, not the claim). */
export function commandsFromLog(log: AttemptLog): CompletionPacket["commands_run"] {
  return [...log.toolCalls.entries()].flatMap(([id, call]) => {
    const argv = call.arguments?.argv;
    if (call.name !== "exec" || !Array.isArray(argv) || call.exitCode === undefined) return [];
    const command = stringsOf(argv).join(" ").trim();
    if (command === "") return [];
    return [{ command: command.slice(0, 4000), exit_code: call.exitCode, evidence: { kind: "tool-call" as const, ref: id, produced_by: "worker" as const } }];
  });
}

/**
 * The passed harness verification runs that prove behaviour (review R2): build/test-class
 * commands, or commands a criterion statement names exactly; read-only commands (git
 * status/diff/log/show, listing, viewing, search) never count.
 */
export function provingVerification(packet: Pick<TaskContextPacket, "acceptance_criteria">, harness: HarnessEvidence | undefined): HarnessEvidence["verification"] {
  return (harness?.verification ?? []).filter((record) => verificationProves(record) || packet.acceptance_criteria.some((criterion) => verificationProves(record, criterion.statement)));
}

/** Whether harness facts may stand in for pointers that stayed unresolved (ADR-18 D1, review R2). */
export function harnessCanSubstitute(packet: TaskContextPacket, harness: HarnessEvidence | undefined, changedPaths: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  if (harness === undefined || harness.verification.length === 0) return false;
  if (!harness.verification.every((record) => record.status === "passed")) return false;
  if (provingVerification(packet, harness).length === 0) return false;
  if (packet.write_mode !== "owned-paths") return changedPaths.length === 0;
  if (harness.diff === undefined || changedPaths.length === 0) return false;
  return findScopeViolations(changedPaths, { owned: packet.scope.owned_paths, forbidden: packet.scope.forbidden_paths }, platform).length === 0;
}

/** The harness pointers that evidence a criterion by substitution: the proving runs, then the diff. */
export function harnessPointers(harness: HarnessEvidence, packet?: Pick<TaskContextPacket, "acceptance_criteria">): EvidenceRef[] {
  const verification = packet === undefined ? harness.verification : provingVerification(packet, harness);
  return [...verification.map((record) => record.evidence), ...(harness.diff === undefined ? [] : [harness.diff.evidence])];
}

export interface CompletionEvidence {
  readonly acceptanceEvidence: CompletionPacket["acceptance_evidence"];
  readonly resolution: EvidenceResolution[];
  readonly substituted: readonly string[];
}

/**
 * Resolves every pointer of a claim (per criterion, then `commands_run`) and, when harness facts
 * prove the work (`harnessCanSubstitute`), evidences criteria whose pointers stayed unresolved with
 * the harness records (`harness-substitute`).
 */
export async function resolveCompletionEvidence(
  packet: TaskContextPacket,
  claimed: CompletionPacket["acceptance_evidence"],
  claimedCommands: readonly CompletionPacket["commands_run"][number][],
  index: EvidenceIndex,
  platform: NodeJS.Platform = process.platform,
): Promise<CompletionEvidence> {
  const resolution: EvidenceResolution[] = [];
  const evidenced = new Set<string>();
  for (const entry of claimed) {
    for (const evidence of entry.evidence) {
      const result = evidence.produced_by === "worker" || evidence.produced_by === "harness" ? await resolvePointer(evidence, index, entry.criterion_id) : unresolved(evidence, entry.criterion_id, `${evidence.produced_by} evidence is not worker evidence`);
      resolution.push(result);
      if (result.status === "resolved") evidenced.add(entry.criterion_id);
    }
  }
  for (const command of claimedCommands) resolution.push(await resolvePointer(command.evidence, index));
  const substituted: string[] = [];
  let acceptanceEvidence = claimed.map((entry) => ({ criterion_id: entry.criterion_id, evidence: [...entry.evidence] }));
  if (index.harness !== undefined && harnessCanSubstitute(packet, index.harness, index.changedPaths, platform)) {
    const pointers = harnessPointers(index.harness, packet);
    for (const criterion of packet.acceptance_criteria) {
      if (evidenced.has(criterion.id)) continue;
      substituted.push(criterion.id);
      const existing = acceptanceEvidence.find((entry) => entry.criterion_id === criterion.id);
      if (existing === undefined) acceptanceEvidence = [...acceptanceEvidence, { criterion_id: criterion.id, evidence: [...pointers] }];
      else existing.evidence.push(...pointers);
      for (const pointer of pointers) resolution.push(resolved(pointer, criterion.id, "harness-substitute"));
    }
  }
  return { acceptanceEvidence, resolution: resolution.slice(0, 200), substituted };
}

/** The line-level problems of a set of resolutions (for `formatEvidenceCorrection`). */
export function evidenceProblems(resolutions: readonly EvidenceResolution[]): EvidenceProblem[] {
  return resolutions.flatMap((resolution) =>
    resolution.status === "resolved" ? [] : [{ criterionId: resolution.criterion_id, ref: resolution.ref.slice(0, 200), reason: resolution.reason ?? "does not resolve" }],
  );
}

export interface CompletionVerification {
  /** `revise`: only evidence (or a harness-run check) is missing; `reject`: scope or integrity is violated. */
  readonly decision: "pass" | "revise" | "reject";
  readonly problems: readonly string[];
  readonly unevidenced: readonly string[];
  /** Required verification commands the harness ran and saw fail (a `verification-repair`). */
  readonly failedVerification?: readonly string[];
  /**
   * Plan-caused verification problems (live run 01M37V2J): a required command the harness refused
   * or could not run (`not-run`), or whose program was not found (`spawn-failed`), and that the
   * worker neither ran nor skipped. The worker cannot fix the plan: these never go to a worker
   * repair; the orchestrator decides (triage). `planProblems` are their entries of `problems`.
   */
  readonly planCaused?: readonly string[];
  readonly planProblems?: readonly string[];
}

/** Whether a harness verification record failed for a reason the plan, not the worker, must fix. */
export function isPlanCausedVerification(record: Partial<Pick<HarnessVerification, "termination" | "reason">> & Pick<HarnessVerification, "status">): boolean {
  // Not plan-caused: a cancelled attempt, and an `ask`-mode command the harness never asks for (the worker can run it with approval).
  if (record.status === "not-run") return !/cancelled|never asks for approval/.test(record.reason ?? "");
  return record.status === "failed" && record.termination === "spawn-failed";
}

export interface CompletionVerificationOptions {
  /**
   * Triage acceptance of a read-only task (the orchestrator accepted its findings): these criteria
   * are waived, and a `partial`/`needs_context` status is accepted. Every other check still applies.
   */
  readonly waivedCriteria?: readonly string[];
  /**
   * Verification commands the orchestrator waived in triage because they could not run for a
   * plan-caused reason (`planCaused`); they are not required. Every other check still applies.
   */
  readonly waivedCommands?: readonly string[];
}

/** Orchestrator-side verification of a completed attempt against the real diff, the log and the harness records. */
export async function verifyCompletion(
  packet: TaskContextPacket,
  completion: CompletionPacket,
  index: EvidenceIndex,
  platform: NodeJS.Platform = process.platform,
  options: CompletionVerificationOptions = {},
): Promise<CompletionVerification> {
  const rejections: string[] = [];
  const revisions: string[] = [];
  const failedVerification: string[] = [];
  const waived = new Set(options.waivedCriteria ?? []);
  const triaged = options.waivedCriteria !== undefined;
  const harness = index.harness ?? completion.harness_evidence;
  const scoped: EvidenceIndex = { ...index, harness };
  if (completion.task_id !== packet.task_id) rejections.push("completion belongs to another task");
  if (completion.packet_digest !== packetDigest(packet)) rejections.push("completion answers another packet version");
  const accepted = completion.status === "completed" || (triaged && packet.write_mode !== "owned-paths" && (completion.status === "partial" || completion.status === "needs_context"));
  if (!accepted) rejections.push(`status is ${completion.status}`);

  const changed = index.changedPaths;
  if (packet.write_mode !== "owned-paths" && changed.length > 0) {
    rejections.push(`${packet.write_mode} attempt changed files: ${changed.join(", ")}`);
  }
  for (const violation of findScopeViolations(changed, { owned: packet.scope.owned_paths, forbidden: packet.scope.forbidden_paths }, platform)) {
    if (packet.write_mode === "owned-paths") rejections.push(`changed ${violation.path} (${violation.reason})`);
  }
  const reported = new Set(completion.changed_paths.map((change) => change.path));
  if (reported.size !== changed.length || changed.some((path) => !reported.has(path))) {
    rejections.push("reported changed paths differ from the real diff");
  }
  if (changed.length > 0 && completion.artifact_digest !== index.artifactDigest) {
    rejections.push("artifact digest does not match the workspace");
  }
  if (packet.write_mode === "rca-only" && completion.root_cause === undefined) {
    revisions.push("an rca-only attempt must report root_cause");
  }

  const known = new Set(packet.acceptance_criteria.map((criterion) => criterion.id));
  const unevidenced: string[] = [];
  for (const criterion of packet.acceptance_criteria) {
    if (waived.has(criterion.id)) continue;
    const entry = completion.acceptance_evidence.find((candidate) => candidate.criterion_id === criterion.id);
    let found = false;
    const failures: string[] = [];
    for (const evidence of entry?.evidence ?? []) {
      const result =
        evidence.produced_by === "worker" || evidence.produced_by === "harness"
          ? await resolvePointer(evidence, scoped, criterion.id)
          : unresolved(evidence, criterion.id, `${evidence.kind}:${evidence.ref} is not worker evidence`);
      if (result.status === "resolved") found = true;
      else failures.push(result.reason ?? "does not resolve");
    }
    if (!found) {
      unevidenced.push(criterion.id);
      revisions.push(`${criterion.id} has no resolvable evidence${failures.length > 0 ? ` (${failures.join("; ")})` : ""}`);
    }
  }
  for (const entry of completion.acceptance_evidence) {
    if (!known.has(entry.criterion_id)) revisions.push(`evidence for unknown criterion ${entry.criterion_id}`);
  }

  const planCaused: string[] = [];
  const planProblems: string[] = [];
  const waivedCommands = options.waivedCommands ?? [];
  for (const [position, required] of packet.verification.commands.entries()) {
    if (waivedCommands.some((command) => sameCommand(command, required))) continue;
    const record = harness?.verification.find((candidate) => candidate.ordinal === position + 1 && sameCommand(candidate.command, required)) ?? harness?.verification.find((candidate) => sameCommand(candidate.command, required));
    if (record?.status === "passed") continue;
    const planCause = record !== undefined && isPlanCausedVerification(record);
    if (record?.status === "failed" && !planCause) {
      failedVerification.push(required);
      revisions.push(`verification command "${required}" failed when the harness ran it (${record.exit_code === null ? record.termination ?? "no exit code" : `exit ${record.exit_code}`})`);
      continue;
    }
    const logged = commandsFromLog(index.log).filter((command) => sameCommand(command.command, required));
    const claimed = completion.commands_run.filter((command) => sameCommand(command.command, required));
    const claimedCalls: number[] = [];
    for (const command of claimed) {
      const result = await resolvePointer(command.evidence, scoped);
      const call = result.tool_call_id === undefined ? undefined : index.log.toolCalls.get(result.tool_call_id);
      if (call !== undefined && call.state === "succeeded") claimedCalls.push(call.exitCode ?? 0);
    }
    const exits = [...logged.map((command) => command.exit_code), ...claimedCalls];
    const skipped = completion.skipped_checks.some((check) => sameCommand(check.check, required) || check.check.includes(required.trim()));
    if (exits.includes(0)) continue;
    if (exits.length > 0) revisions.push(`verification command "${required}" exited ${exits.at(-1)}`);
    else if (skipped) continue;
    else if (planCause && record !== undefined) {
      const problem = `verification command "${required}" could not run (plan-caused: ${record.status === "not-run" ? record.reason ?? "the harness did not run it" : "the program was not found"}); the worker cannot fix this, the orchestrator decides`;
      planCaused.push(required);
      planProblems.push(problem);
      revisions.push(problem);
    } else if (!skipped) revisions.push(`verification command "${required}" was neither run nor explicitly skipped${record?.status === "not-run" ? ` (the harness could not run it: ${record.reason ?? "unknown"})` : ""}`);
  }

  const causes = planCaused.length === 0 ? {} : { planCaused, planProblems };
  if (rejections.length > 0) return { decision: "reject", problems: [...rejections, ...revisions], unevidenced, failedVerification, ...causes };
  if (revisions.length > 0) return { decision: "revise", problems: revisions, unevidenced, failedVerification, ...causes };
  return { decision: "pass", problems: [], unevidenced, failedVerification };
}

export interface ReviewVerification {
  /** `invalid`: the review itself cannot be trusted (bound to another task, attempt, artifact or completion). */
  readonly decision: "accept" | "revise" | "block" | "invalid";
  readonly problems: readonly string[];
  /** How every reviewer pointer resolved; unresolved ones were dropped (ADR-18). */
  readonly resolution?: readonly EvidenceResolution[];
}

/**
 * Whether a resolved review pointer is independent evidence for a criterion (ADR-09 as amended by
 * ADR-18 and review R1): the reviewer's own tool evidence, or a passed harness verification run
 * that proves the criterion (`verificationProves`). The pinned diff (`harness-diff`) only shows
 * that a change exists, which is the thing under review: it is supporting evidence, never enough.
 */
export function isIndependentReviewEvidence(evidence: EvidenceRef, harness: HarnessEvidence | undefined, statement: string | undefined): boolean {
  if (evidence.produced_by === "reviewer") return true;
  if (evidence.kind !== "harness-verification") return false;
  const record = harness?.verification.find((candidate) => candidate.evidence.ref === evidence.ref.trim());
  return record !== undefined && verificationProves(record, statement);
}

/** What a met verdict lacks when it has no independent evidence (shown to the reviewer and recorded). */
export const INDEPENDENT_EVIDENCE_HINT =
  "needs independent evidence: one of your own tool results (\"#n\", produced_by: reviewer) or a passed harness-verification run of a build/test command (or one the criterion names); harness-diff alone only shows that a change exists";

export async function verifyReview(
  review: ReviewPacket,
  packet: TaskContextPacket,
  completion: CompletionPacket,
  indexes: { readonly worker: EvidenceIndex; readonly reviewer: EvidenceIndex },
): Promise<ReviewVerification> {
  const invalid: string[] = [];
  const revise: string[] = [];
  const resolution: EvidenceResolution[] = [];
  if (review.task_id !== packet.task_id) invalid.push("review belongs to another task");
  if (review.reviewed_attempt_id !== completion.attempt_id) invalid.push("review names another attempt");
  if (review.reviewed_artifact_digest !== indexes.worker.artifactDigest) invalid.push("review is not bound to the pinned artifact");
  if (review.completion_digest !== packetDigest(completion)) invalid.push("review is bound to another completion packet");
  const harness = indexes.worker.harness ?? completion.harness_evidence;
  const harnessIndex: EvidenceIndex = { ...indexes.worker, harness };
  const statements = new Map<string, string>(packet.acceptance_criteria.map((criterion) => [criterion.id, criterion.statement]));
  const independent = new Map<string, string[]>();
  for (const criterion of review.criteria) {
    const reasons: string[] = [];
    let count = 0;
    for (const evidence of criterion.evidence) {
      const index = evidence.produced_by === "reviewer" ? indexes.reviewer : evidence.produced_by === "worker" ? indexes.worker : evidence.produced_by === "harness" ? harnessIndex : undefined;
      const result = index === undefined ? unresolved(evidence, criterion.criterion_id, `${evidence.produced_by} evidence is not accepted in a review`) : await resolvePointer(evidence, index, criterion.criterion_id);
      resolution.push(result);
      if (result.status === "resolved" && isIndependentReviewEvidence(evidence, harness, statements.get(criterion.criterion_id))) count += 1;
      if (result.status !== "resolved") reasons.push(result.reason ?? "does not resolve");
    }
    if (count === 0) independent.set(criterion.criterion_id, reasons);
  }
  for (const criterion of packet.acceptance_criteria) {
    const verdict = review.criteria.find((candidate) => candidate.criterion_id === criterion.id);
    if (verdict === undefined) revise.push(`${criterion.id} was not assessed`);
    else if (verdict.verdict !== "met") revise.push(`${criterion.id} is ${verdict.verdict}`);
    else if (independent.has(criterion.id)) {
      const reasons = independent.get(criterion.id) ?? [];
      revise.push(`${criterion.id} is unverifiable: it ${INDEPENDENT_EVIDENCE_HINT}${reasons.length > 0 ? ` (${reasons.slice(0, 3).join("; ")})` : ""}`);
    }
  }
  if (invalid.length > 0) return { decision: "invalid", problems: invalid, resolution };
  if (review.decision === "block") return { decision: "block", problems: revise, resolution };
  if (review.decision === "revise" || revise.length > 0) {
    return { decision: "revise", problems: revise.length > 0 ? revise : ["the reviewer requested changes"], resolution };
  }
  return { decision: "accept", problems: [], resolution };
}

/** ADR-09: standard and high-risk tasks close only through an accepting review. */
export function reviewRequired(packet: Pick<TaskContextPacket, "risk" | "role">): boolean {
  return packet.risk !== "trivial" && packet.role !== "reviewer";
}

/** The single gate for `→ completed`: a required review must exist and must be an accept. */
export function mayComplete(packet: Pick<TaskContextPacket, "risk" | "role">, review: ReviewVerification | undefined): boolean {
  if (!reviewRequired(packet)) return true;
  return review !== undefined && review.decision === "accept";
}
