import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  completionPacketSchema,
  createId,
  digestOf,
  effectivePolicySchema,
  EVENT_VERSIONS,
  DEFAULT_PERMISSION_MODE,
  EXIT_CODES,
  exitCodeFor,
  HarnessError,
  MODEL_TIERS,
  HARD_RAILS,
  WORKSPACE_UNTRUSTED_CODE,
  workspaceDigest,
  type AgentDriver,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type Attachment,
  type BlobRef,
  type CompletionPacket,
  type Coordinator,
  type Digest,
  type EffectivePolicy,
  type EventStore,
  type HarnessErrorInfo,
  type ModelRequest,
  type ModelTier,
  type PermissionMode,
  type RenderEvent,
  type RouteDecision,
  type RouteRule,
  type SessionEvent,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionHeaderView,
  type SessionId,
  type ModelPickerEntry,
  type ToolCallRequest,
  type ToolExecutionContext,
  type ToolGateway,
  type ToolResult,
  type TurnId,
} from "../contracts/index.ts";
import type { CriterionView, EvidenceView, WhyView } from "../contracts/views.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import { createCompactor, DEFAULT_CONTEXT_WINDOW, extractiveSummarizer, messageTokens, reconstructHistory } from "../context/index.ts";
import { createHeadlessApprovalBroker, evaluateExecAllowlist } from "../policy/index.ts";
import { describeEvent, formatHarnessError, GLYPH_SETS, patchPaths, selectGlyphs, suggestedCommandPrefix, type GlyphSet } from "../tui/index.ts";
import type { ParsedCommand } from "./args.ts";
import { mayContainImage, resolveAttachments } from "./attachments.ts";

/** Adapters that turn `image` message parts into provider image input. */
const IMAGE_ADAPTERS: ReadonlySet<string> = new Set(["openai-chatgpt", "openai-responses", "anthropic-messages"]);
import { profileHintsFor } from "./canonical.ts";
import { createCommandGrantStore, normalizeGrant, type CommandGrantStore } from "./command-grants.ts";
import type { OrchestrateInput } from "./orchestrate-tool.ts";
import { OrchestrationTracker } from "./orchestration-view.ts";
import { failureInfo } from "./outcome.ts";
import { createSessionRenderer, type SessionRenderer } from "./renderers.ts";
import { createRuntime, type Runtime, type RuntimeOverrides } from "./runtime.ts";
import type { SessionIO } from "./session.ts";
import { commitAll, commitsSince, uncommittedChanges, uncommittedDiff } from "./session-git.ts";
import {
  contextReport,
  conversationPaletteEntries,
  evidenceReport,
  findConversationCommand,
  unknownConversationCommand,
  memoryReport,
  tasksReport,
  type ConversationCommandHost,
} from "./slash-commands.ts";
import { resolveTerminalSettings, streamHasColors } from "./terminal.ts";
import { promptTrustForCommand } from "./trust.ts";
import { UsageLedger } from "./usage-stats.ts";

/**
 * `syn agent`: the conversation-first main agent (ADR-21). Every user message is one turn of the
 * `session` role on the existing `AgentDriver`: no pre-flight model call, no plan, no run. The
 * agent answers, reads, edits the main tree and runs commands through the same tool gateway and
 * rails as every role; each edit leaves a checkpoint (`/undo`), workspace trust is asked at the
 * first command that runs repository code, and `/allow` extends the exec allowlist.
 *
 * K1 session features: a message typed while the agent works steers the current turn at its next
 * step boundary (and the coordinator while workers run); Esc interrupts (twice stops workers);
 * plan mode (`/plan`, Shift+Tab) narrows the policy to reading; the `orchestrate` tool runs the
 * existing coordinator inside the turn and projects a live worker board; one command registry
 * (`slash-commands.ts`) feeds `/help` and the renderer's palette; usage is aggregated for `/usage`,
 * `/cost` and the footer; `@path` and renderer attachments are inlined; resume shows where the
 * conversation was and what changed since.
 */

type AgentCommand = Extract<ParsedCommand, { kind: "agent" }>;

const MAX_STEPS = 50;
const CONVERSATION_TITLE = "chat: ";
const WRITE_TOOLS = new Set(["apply_patch", "write_file"]);
const REPLAY_EXCHANGES = 3;
const REVIEW_DIFF_LIMIT = 48 * 1024;
const ESC_ARM_MS = 3_000;
const GO_WORDS = /^(go|go ahead|do it|proceed|yes|ok|okay|ship it|start|evet|başla|basla|yap|devam|tamam)[.! ]*$/iu;
const SESSION_MODEL_FILE = "session-model.json";
const ORCHESTRATION_SESSION = /session (ses_[0-9A-HJKMNP-TV-Z]{26})/g;

function linked(outer: AbortSignal): AbortController {
  const controller = new AbortController();
  if (outer.aborted) controller.abort(outer.reason);
  else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
  return controller;
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function snippet(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

function sessionRouteRule(runtime: Runtime, preferred?: ModelTier): RouteRule | undefined {
  const rules = runtime.config.router.rules;
  const fits = (rule: RouteRule, tier: ModelTier): boolean => rule.tier === tier && (rule.role === undefined || rule.role === "session");
  if (preferred !== undefined) {
    const chosen = rules.find((rule) => fits(rule, preferred));
    if (chosen !== undefined) return chosen;
  }
  return rules.find((rule) => fits(rule, "session")) ?? rules.find((rule) => fits(rule, "orchestrator"));
}

function missingRoute(runtime: Runtime): HarnessError {
  const hints = profileHintsFor(runtime.canonical, "orchestrator").map((hint) => `${hint.provider}/${hint.model}`);
  return new HarnessError({
    code: "config_invalid",
    message: `no model route is configured for the conversation: add a routes entry with tier session (or orchestrator) to ${path.join(runtime.home, "config.yaml")}, or pass --profile session=<provider>/<model>${hints.length === 0 ? "" : ` (the canonical model profiles suggest ${hints.join(" or ")})`}`,
    workspace_effect: "none",
    retry_safe: true,
    next_command: "syn doctor --runtime",
  });
}

/** The conversation model the user saved with `/model <tier> --save` (a preference, not a route). */
async function savedSessionTier(home: string): Promise<ModelTier | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, SESSION_MODEL_FILE), "utf8")) as { tier?: unknown };
    return (MODEL_TIERS as readonly string[]).includes(String(parsed.tier)) ? (parsed.tier as ModelTier) : undefined;
  } catch {
    return undefined;
  }
}

/** Plan mode (ADR-21 D2): the session policy with workspace writes, commands and external writes denied. */
export function planModePolicy(base: EffectivePolicy): EffectivePolicy {
  return effectivePolicySchema.parse({
    ...base,
    effects: { ...base.effects, "workspace-write": "deny", exec: "deny", "external-write": "deny" },
    layers: [...base.layers, { layer: "task", source: "plan-mode", digest: digestOf({ plan_mode: true }) }],
  });
}

/** `ask_user` while the TUI reads input concurrently: the next typed message answers the question. */
class QuestionDesk {
  private pending: ((answer: string) => void) | undefined;

  public get waiting(): boolean {
    return this.pending !== undefined;
  }

  public ask(signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const onAbort = (): void => {
        this.pending = undefined;
        reject(new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending = (answer) => {
        signal.removeEventListener("abort", onAbort);
        this.pending = undefined;
        resolve(answer);
      };
    });
  }

  public answer(text: string): boolean {
    const pending = this.pending;
    if (pending === undefined) return false;
    pending(text);
    return true;
  }
}

interface CapturedFile {
  readonly relative: string;
  readonly absolute: string;
  readonly before: Buffer | undefined;
}

interface ActiveOrchestration {
  readonly tracker: OrchestrationTracker;
  readonly coordinator: Coordinator;
  readonly controller: AbortController;
  disarm: NodeJS.Timeout | undefined;
}

interface QueuedMessage {
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

export async function conversationCommand(parsed: AgentCommand, io: SessionIO, overrides: RuntimeOverrides): Promise<number> {
  return new Conversation(parsed, io, overrides).run();
}

class Conversation implements ConversationCommandHost {
  private readonly parsed: AgentCommand;
  private readonly io: SessionIO;
  private readonly overrides: RuntimeOverrides;
  private readonly outer: AbortController;
  private readonly desk = new QuestionDesk();
  private readonly requests = new Set<string>();
  private readonly pendingNotes: string[] = [];
  private readonly queued: QueuedMessage[] = [];
  private runtime!: Runtime;
  private renderer!: SessionRenderer;
  private usageLedger: UsageLedger | undefined;
  private glyphs: GlyphSet = GLYPH_SETS.ascii;
  private grants: CommandGrantStore | undefined;
  private grantList: readonly string[] = [];
  private routePromise: Promise<RouteDecision> | undefined;
  private routeRecorded = false;
  private sessionTier: ModelTier | undefined;
  private currentModel: string | undefined;
  private sessionId: SessionId | undefined;
  private log: EventStore | undefined;
  private driver: AgentDriver | undefined;
  private coordinator: Coordinator | undefined;
  private policyCache: EffectivePolicy | undefined;
  private active: AbortController | undefined;
  private turnRunning = false;
  private orchestration: ActiveOrchestration | undefined;
  private readonly orchestratedSessions: SessionId[] = [];
  /** The mode to return to when plan mode ends (Shift+Tab, /go, a go-word). */
  private modeBeforePlan: PermissionMode | undefined;
  /** Set while the current exec call follows a declined trust question: its prompt is answered "no" for the user. */
  private trustDeclinedNow = false;
  private sessionBroker: ApprovalBroker | undefined;
  private startedAt = Date.now();
  private lastTracker: OrchestrationTracker | undefined;
  private turnId: TurnId | undefined;
  private trustAsked = false;
  private exiting = false;
  private debug = false;
  private submittedAt: number | undefined;
  private readonly timings: string[] = [];

  public constructor(parsed: AgentCommand, io: SessionIO, overrides: RuntimeOverrides) {
    this.parsed = parsed;
    this.io = io;
    this.overrides = overrides;
    this.outer = new AbortController();
    const outer = io.signal;
    if (outer?.aborted === true) this.outer.abort(outer.reason);
    else outer?.addEventListener("abort", () => this.outer.abort(outer.reason), { once: true });
  }

  public async run(): Promise<number> {
    const started = performance.now();
    const io = this.io;
    const workspaceRoot = path.resolve(io.cwd, this.parsed.common.target ?? ".");
    let failure: HarnessErrorInfo | undefined;
    let runtime: Runtime | undefined;
    try {
      runtime = await createRuntime({
        workspaceRoot,
        env: io.env,
        policyMode: this.parsed.session.policy,
        routes: this.parsed.session.profiles,
        overrides: this.overrides,
        ...(this.parsed.session.permission === undefined ? {} : { permissionMode: this.parsed.session.permission }),
      });
    } catch (error) {
      failure = failureInfo(error);
    }
    const runtimeMs = Math.round(performance.now() - started);
    const settings = resolveTerminalSettings(
      { jsonl: false, plain: this.parsed.common.plain, color: this.parsed.common.color, configColor: runtime?.config.color },
      {
        env: io.env,
        stdinIsTTY: io.stdinIsTTY,
        stdoutIsTTY: io.stdout.isTTY === true,
        stdoutHasColors: streamHasColors(io.stdout),
        stderrHasColors: streamHasColors(io.stderr as { isTTY?: boolean; hasColors?: () => boolean }),
      },
    );
    this.glyphs = selectGlyphs(io.env, io.platform, settings.kind === "plain");
    const debugEnv = io.env.SYN_DEBUG;
    this.debug = this.parsed.debug || (debugEnv !== undefined && debugEnv !== "" && debugEnv !== "0");
    this.renderer = await createSessionRenderer(io, {
      kind: settings.kind === "jsonl" ? "plain" : settings.kind,
      color: settings.color,
      policyMode: this.parsed.session.policy,
      streamDeltas: false,
      wantsInput: true,
      interactive: io.stdinIsTTY,
      fallbackSessionId: undefined,
      onInterrupt: () => this.interrupt(),
      onExit: () => {
        this.exiting = true;
        this.active?.abort();
        this.orchestration?.controller.abort();
        this.outer.abort();
      },
      view: "conversation",
      glyphs: this.glyphs,
      debug: this.debug,
    });
    if (runtime === undefined || failure !== undefined) return this.fail(failure ?? failureInfo(new Error("runtime unavailable")));
    this.runtime = runtime;
    // ADR-08 revision (2026-09-24): an interactive conversation starts in `ui.permission_mode` (default auto);
    // headless keeps default-deny unless --permission-mode was passed; --policy ask means ask mode.
    const interactive = io.stdinIsTTY && this.renderer.approvals.availability === "interactive";
    const startMode = interactive ? (runtime.config.permissionMode ?? DEFAULT_PERMISSION_MODE) : undefined;
    if (this.parsed.session.permission === undefined) runtime.setPermissionMode(this.parsed.session.policy === "ask" ? "ask" : startMode);
    if (runtime.permissionMode() === "plan") this.modeBeforePlan = startMode === "plan" ? DEFAULT_PERMISSION_MODE : startMode;
    this.sessionTier = await savedSessionTier(runtime.home);
    const rule = sessionRouteRule(runtime, this.sessionTier);
    if (rule === undefined) return this.fail(failureInfo(missingRoute(runtime)));
    this.sessionTier = rule.tier;
    this.currentModel = rule.route.model_id;
    // Resolving the route may probe the provider's capabilities: it runs while the user types.
    this.routePromise = runtime.router.resolve({ tier: rule.tier, role: "session" }, this.outer.signal);
    this.routePromise.catch(() => undefined);

    const ledger = new UsageLedger(runtime.home);
    this.usageLedger = ledger;
    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind === "session-event") ledger.observe(event.event);
      this.forward(event);
    });
    const unbind = io.stdinIsTTY && this.renderer.input !== undefined ? runtime.bindUserPrompt((question, options, signal) => this.askUser(question, options, signal)) : () => undefined;
    runtime.orchestrate.set((input, context) => this.runOrchestration(input, context));
    let unbindControls: () => void = () => undefined;
    this.startedAt = Date.now();
    try {
      this.grants = createCommandGrantStore(runtime.home, runtime.trust.state().root);
      this.grantList = await this.grants.list();
      const resumed = await this.openResumed();
      await this.renderer.start(this.header(rule));
      const controls = this.renderer.controls;
      controls?.setCommands(conversationPaletteEntries());
      // Shift+Tab / Alt+M in the renderer cycles the permission mode; the session applies the policy.
      unbindControls = controls?.onPermissionModeChange((mode) => this.setMode(mode)) ?? (() => undefined);
      if (runtime.permissionMode() === "full") this.note("error", this.fullAccessNotice());
      if (resumed !== undefined) await this.showResumed(resumed);
      if (this.debug) this.note("info", `harness: runtime ready in ${runtimeMs} ms`);
      // Credential pre-resolution (keychain, token refresh) happens in the background, never before the editor.
      void this.routePromise.then((decision) => runtime.credentials(decision.route, this.outer.signal)).catch(() => undefined);
      const input = this.renderer.input;
      if (input === undefined) {
        this.note("warning", "syn agent needs input: attach a terminal or pipe messages on stdin, one per line");
        return EXIT_CODES.usage;
      }
      await this.loop(input);
      await this.renderer.stop("completed");
      if (this.debug && this.timings.length > 0) io.stderr.write(`timing: ${this.timings.join("; ")}\n`);
      if (this.sessionId !== undefined && this.log !== undefined) io.stderr.write(`Saved · resume with syn agent --continue (or --resume ${this.sessionId})\n`);
      return EXIT_CODES.success;
    } catch (error) {
      return await this.fail(failureInfo(error));
    } finally {
      unbindControls();
      runtime.orchestrate.set(undefined);
      unbind();
      unsubscribe();
      await ledger.flush().catch(() => undefined);
      await this.log?.close().catch(() => undefined);
    }
  }

  private async fail(error: HarnessErrorInfo): Promise<number> {
    await this.renderer.stop("error").catch(() => undefined);
    this.io.stderr.write(formatHarnessError(error));
    return exitCodeFor(error.code);
  }

  private header(rule: RouteRule): SessionHeaderView {
    const permissionMode = this.runtime.permissionMode();
    const runtime = this.runtime;
    return {
      workspaceRoot: runtime.workspaceRoot,
      gitBranch: runtime.gitBranch,
      policyMode: runtime.policyMode,
      routes: [],
      sandboxEnforcement: runtime.sandbox.enforcement,
      // Quiet by default: a successful load says nothing; only problems reach the header.
      notices: [...runtime.config.warnings.map((warning) => warning.message), ...runtime.canonical.diagnostics.map((diagnostic) => `canonical .ai: ${diagnostic}`)],
      version: SYNORCH_VERSION,
      model: rule.route.model_id,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
      ...(permissionMode === undefined ? {} : { permissionMode }),
    };
  }

  private note(level: "info" | "warning" | "error", message: string): void {
    this.renderer.render({ kind: "notice", level, message });
  }

  public print(lines: readonly string[]): void {
    for (const line of lines) this.note("info", line);
  }

  /** Only this conversation's events and model streams reach the view; worker and coordinator traffic feeds the board instead. */
  private forward(event: RenderEvent): void {
    if (event.kind === "session-event") {
      const recorded = event.event;
      const orchestration = this.orchestration;
      // Worker, reviewer and planner requests of this process count toward the footer's quota %, cost
      // and activity tokens: their provider/usage events (with `x-codex-*` quota) reach the view too.
      if (recorded.session_id !== this.sessionId && recorded.type === "provider/usage" && this.renderer.kind !== "jsonl") this.renderer.render(event);
      if (orchestration !== undefined && recorded.session_id !== this.sessionId) {
        this.observeOrchestration(orchestration, recorded);
        return;
      }
      if (recorded.session_id !== this.sessionId) return;
      if (recorded.type === "turn/started") this.turnId = recorded.data.turn_id;
      if (recorded.type === "model/request_prepared") {
        this.requests.add(recorded.data.request_id);
        if (this.submittedAt !== undefined) {
          this.timings.push(`Enter → request ${Math.round(performance.now() - this.submittedAt)} ms`);
          this.submittedAt = undefined;
        }
      }
      this.renderer.render(event);
      return;
    }
    if (event.kind === "stream") {
      if (this.requests.has(event.requestId)) this.renderer.render(event);
      return;
    }
    // Coordinator notices while workers run stay on the board; everything else is shown.
    if (event.kind === "notice" && this.orchestration !== undefined && event.level === "info") return;
    this.renderer.render(event);
  }

  // ---- sessions -------------------------------------------------------------------------------

  private async conversations(): Promise<{ readonly sessionId: SessionId; readonly title: string; readonly at: string }[]> {
    const summaries = await this.runtime.sessions.list(this.runtime.projectId);
    return summaries
      .filter((summary) => summary.manifest.title?.startsWith(CONVERSATION_TITLE) === true && !summary.locked)
      .sort((left, right) => (right.lastEventAt ?? right.manifest.created_at).localeCompare(left.lastEventAt ?? left.manifest.created_at))
      .map((summary) => ({ sessionId: summary.manifest.session_id, title: (summary.manifest.title ?? "").slice(CONVERSATION_TITLE.length), at: summary.lastEventAt ?? summary.manifest.created_at }));
  }

  private async openResumed(): Promise<readonly SessionEvent[] | undefined> {
    let sessionId = this.parsed.resume;
    if (sessionId === undefined && this.parsed.fork !== undefined) {
      const source = this.parsed.fork.sessionId;
      let upTo = this.parsed.fork.upToSeq;
      if (upTo === undefined) {
        upTo = 0;
        for await (const item of (await this.runtime.sessions.openForRead(source)).read()) if (item.status === "ok") upTo = item.event.seq;
      }
      const forked = await this.runtime.sessions.fork(source, upTo);
      sessionId = forked.sessionId;
      await forked.close();
    }
    if (sessionId === undefined && this.parsed.continue) sessionId = (await this.conversations())[0]?.sessionId;
    if (sessionId === undefined) return undefined;
    return this.openSession(sessionId);
  }

  private async openSession(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    this.sessionId = sessionId;
    await this.runtime.recover(sessionId);
    this.log = await this.runtime.sessions.openForWrite(sessionId);
    this.driver = undefined;
    const events: SessionEvent[] = [];
    for await (const item of this.log.read()) if (item.status === "ok") events.push(item.event);
    this.routeRecorded = false;
    return events;
  }

  /** The resume card (UX-06): the replayed tail, then where we were, what changed since, and the next step. */
  private async showResumed(events: readonly SessionEvent[]): Promise<void> {
    const g = this.glyphs;
    const users = events.flatMap((event, index) => (event.type === "message/recorded" && event.data.role === "user" ? [index] : []));
    const last = events.at(-1);
    const ago = last === undefined ? "" : ` ${g.sep} ${relativeTime(Date.parse(last.timestamp))}`;
    const firstShown = users.length > REPLAY_EXCHANGES ? (users[users.length - REPLAY_EXCHANGES] ?? 0) : 0;
    const folded = users.length > REPLAY_EXCHANGES ? users.length - REPLAY_EXCHANGES : 0;
    this.note("info", `${g.resume} Resumed${ago} ${g.sep} ${users.length} message${users.length === 1 ? "" : "s"}${folded === 0 ? "" : ` ${g.sep} ${folded} earlier not shown`}`);
    this.renderer.replay?.(events.slice(firstShown));
    for (const line of await this.continuity(events)) this.note("info", line);
  }

  private async continuity(events: readonly SessionEvent[]): Promise<string[]> {
    const texts = (role: "user" | "assistant"): string[] =>
      events.flatMap((event) => {
        if (event.type !== "message/recorded" || event.data.role !== role || event.data.message === undefined) return [];
        const text = event.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
        return text.trim() === "" ? [] : [text.replace(/^\[Synorch note:[^\]]*\]\s*/u, "").split("<synorch-attachments>")[0] ?? ""];
      });
    const lastUser = texts("user").at(-1);
    const lastAnswer = texts("assistant").at(-1);
    const where = lastUser === undefined ? "nothing asked yet" : `"${snippet(lastUser, 70)}"${lastAnswer === undefined ? "" : ` → ${snippet(lastAnswer, 80)}`}`;

    const changes: string[] = [];
    const restored = new Set(events.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
    const latestAfter = new Map<string, Digest | null>();
    for (const event of events) if (event.type === "checkpoint/recorded" && !restored.has(event.seq)) for (const file of event.data.files) latestAfter.set(file.path, file.after);
    const touched: string[] = [];
    for (const [file, after] of latestAfter) {
      const place = this.inside(file);
      if (place === undefined) continue;
      const current = await readOptional(place.absolute).catch(() => undefined);
      const digest = current === undefined ? null : workspaceDigest(new Uint8Array(current));
      if (digest !== after) touched.push(file);
    }
    if (touched.length > 0) changes.push(`${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ` +${touched.length - 3}` : ""} changed outside Synorch`);
    const lastAt = events.at(-1)?.timestamp;
    if (lastAt !== undefined) {
      const commits = await commitsSince(this.runtime.workspaceRoot, lastAt).catch(() => []);
      if (commits.length > 0) changes.push(`${commits.length} commit${commits.length === 1 ? "" : "s"} (latest: ${snippet(commits[0] ?? "", 50)})`);
    }
    const lastTurn = [...events].reverse().find((event): event is SessionEventOf<"turn/ended"> => event.type === "turn/ended");
    const next =
      lastTurn === undefined || lastTurn.data.outcome === "completed"
        ? "continue where we left off, or ask something new"
        : `the last turn ended ${lastTurn.data.outcome.replaceAll("_", " ")}; say "continue" to pick it up`;
    if (lastTurn !== undefined && lastTurn.data.outcome !== "completed") this.pendingNotes.push(`the previous turn ended ${lastTurn.data.outcome}; the conversation was resumed.`);
    if (touched.length > 0) this.pendingNotes.push(`since the last turn, ${touched.join(", ")} changed outside Synorch (re-read before editing).`);
    return [`  Where we were   ${where}`, `  Since then      ${changes.length === 0 ? "no changes to files Synorch edited, no new commits" : changes.join(" · ")}`, `  Next            ${next}`];
  }

  private async ensureLog(firstMessage: string): Promise<EventStore> {
    if (this.log !== undefined) return this.log;
    const runtime = this.runtime;
    const sessionId = this.sessionId ?? createId("session");
    this.sessionId = sessionId;
    this.log = await runtime.sessions.create({
      session_id: sessionId,
      project_id: runtime.projectId,
      workspace_root: runtime.workspaceRoot,
      created_at: new Date().toISOString(),
      title: `${CONVERSATION_TITLE}${firstMessage.replace(/\s+/g, " ").slice(0, 120)}`,
    });
    return this.log;
  }

  private async append(type: SessionEventDraft["type"], data: unknown, actor: "user" | "agent"): Promise<SessionEvent | undefined> {
    const log = this.log;
    if (log === undefined) return undefined;
    return log.append({
      type,
      event_version: EVENT_VERSIONS[type],
      actor: actor === "user" ? { kind: "user" } : { kind: "agent", role: "session" },
      data,
    } as SessionEventDraft);
  }

  private async readEvents(): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    if (this.log === undefined) return events;
    for await (const item of this.log.read()) if (item.status === "ok") events.push(item.event);
    return events;
  }

  // ---- policy, trust, checkpoints --------------------------------------------------------------

  private basePolicy(): EffectivePolicy {
    this.policyCache ??= this.runtime.sessionPolicy(this.grantList);
    return this.policyCache;
  }

  private get planOn(): boolean {
    return this.runtime.permissionMode() === "plan";
  }

  private policy(): EffectivePolicy {
    // Plan mode is computed into the policy itself (permission_mode plan); without a mode (headless) nothing narrows further.
    return this.basePolicy();
  }

  private ensureDriver(log: EventStore): AgentDriver {
    this.driver ??= this.runtime.createSessionDriver(this.broker(), log, (gateway) => this.wrap(gateway));
    return this.driver;
  }

  /**
   * The conversation's approval broker (ADR-08 revision 2026-09-24): with a permission mode and a
   * human attached, prompts go to the renderer's action card, and "Always allow <prefix>" is
   * persisted per workspace (user scope, audited as `command/allowed`). Headless, a prompt is a
   * refusal. `--policy ask` without a mode keeps the renderer broker too.
   */
  private broker(): ApprovalBroker {
    if (this.sessionBroker !== undefined) return this.sessionBroker;
    const interactive = this.renderer.approvals;
    const headless = createHeadlessApprovalBroker({ mode: this.runtime.policyMode });
    this.sessionBroker = {
      availability: interactive.availability,
      request: async (request, signal) => {
        const mode = this.runtime.permissionMode();
        const human = interactive.availability === "interactive" && (mode !== undefined || this.runtime.policyMode === "ask");
        if (!human) return headless.request(request, signal);
        if (this.trustDeclinedNow && request.subject_kind === "action") {
          return {
            approval_id: request.approval_id,
            subject_kind: request.subject_kind,
            subject_digest: request.subject_digest,
            outcome: "rejected",
            decided_by: "user",
            mode: this.basePolicy().mode,
            decided_at: new Date().toISOString(),
            reason: "the user chose not to trust this folder (Not now), so this command was not run",
          };
        }
        const decision = await interactive.request(request, signal);
        await this.afterDecision(request, decision);
        return decision;
      },
    };
    return this.sessionBroker;
  }

  /** "Always allow <prefix>" persists a grant; "Allow all edits" switches to auto mode. */
  private async afterDecision(request: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    if (decision.decided_by !== "user" || decision.outcome !== "allowed-for-scope" || request.subject_kind !== "action") return;
    const prefix = suggestedCommandPrefix(request.command);
    if (prefix !== undefined) {
      await this.addGrant(prefix, "prompt");
      return;
    }
    if (request.effect === "workspace-write" && this.runtime.permissionMode() === "ask") this.setMode("auto");
  }

  private fullAccessNotice(): string {
    const trusted = this.runtime.trust.recorded().trusted;
    return `${this.glyphs.warn} Full access: Synorch edits and runs any command in this folder without asking (hard rails still apply)${trusted ? "" : "; the folder is trusted for this session only (not saved)"} ${this.glyphs.sep} Shift+Tab leaves`;
  }

  /**
   * The conversation's decorations around the one gateway: the trust question at the first command
   * that runs repository code, the current policy (a trust, /allow or plan-mode change applies at
   * once), and a checkpoint of every successful edit. Policy, rails and audit stay in the gateway.
   */
  private wrap(inner: ToolGateway): ToolGateway {
    return {
      invoke: async (request, scope, signal) => {
        const declined = request.tool_name === "exec" && !this.planOn ? await this.trustGate(request, signal) : false;
        const captured = WRITE_TOOLS.has(request.tool_name) && !this.planOn ? await this.capture(request).catch(() => undefined) : undefined;
        this.trustDeclinedNow = declined;
        let outcome;
        try {
          outcome = await inner.invoke(request, { ...scope, policy: this.policy() }, signal);
        } finally {
          this.trustDeclinedNow = false;
        }
        if (captured !== undefined && captured.length > 0 && outcome.state === "succeeded") {
          await this.checkpoint(request, captured, outcome.result.changed_paths ?? []).catch(() => undefined);
        }
        if (this.planOn && outcome.state === "denied" && outcome.result.error !== undefined && (WRITE_TOOLS.has(request.tool_name) || request.tool_name === "exec")) {
          const message = `${outcome.result.error.message} (plan mode is on: read, discuss and propose the plan; the user leaves plan mode to carry it out)`.slice(0, 2000);
          return { ...outcome, result: { ...outcome.result, error: { ...outcome.result.error, message } } };
        }
        return outcome;
      },
    };
  }

  /** The trust question at the first repo-code command; resolves true when the user just declined it for this call. */
  private async trustGate(request: ToolCallRequest, signal: AbortSignal): Promise<boolean> {
    const runtime = this.runtime;
    if (this.trustAsked || runtime.trust.state().trusted || runtime.sandbox.enforcement === "full") return false;
    if (this.renderer.approvals.availability !== "interactive") return false;
    const argv = strings(request.arguments.argv);
    if (argv === undefined || argv.length === 0) return false;
    const policy = this.basePolicy();
    const verdict = evaluateExecAllowlist({
      argv,
      readOnly: false,
      confinement: policy.exec_confinement ?? "allowlist",
      mode: policy.mode,
      verificationCommands: [],
      workspaceTrusted: false,
      commandGrants: policy.command_grants ?? [],
    });
    if (verdict?.code !== WORKSPACE_UNTRUSTED_CODE) return false;
    this.trustAsked = true;
    if (await promptTrustForCommand(runtime, this.renderer, argv.join(" "), signal)) {
      this.policyCache = undefined;
      return false;
    }
    return true;
  }

  private inside(declared: string): { relative: string; absolute: string } | undefined {
    const root = this.runtime.workspaceRoot;
    const absolute = path.resolve(root, declared);
    const relative = path.relative(root, absolute);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return { relative: relative.split(path.sep).join("/"), absolute };
  }

  private async capture(request: ToolCallRequest): Promise<CapturedFile[]> {
    const args = request.arguments;
    const declared = request.tool_name === "write_file" ? [typeof args.path === "string" ? args.path : ""] : patchPaths(typeof args.patch === "string" ? args.patch : "");
    const files: CapturedFile[] = [];
    for (const entry of declared) {
      const target = entry === "" ? undefined : this.inside(entry);
      if (target === undefined || files.some((file) => file.relative === target.relative)) continue;
      files.push({ ...target, before: await readOptional(target.absolute) });
    }
    return files;
  }

  private async checkpoint(request: ToolCallRequest, captured: readonly CapturedFile[], changed: readonly string[]): Promise<void> {
    const fold = (value: string): string => (this.runtime.platform === "win32" || this.runtime.platform === "darwin" ? value.toLowerCase() : value);
    const touched = new Set(changed.map(fold));
    const files: { path: string; before: BlobRef | null; after: Digest | null }[] = [];
    for (const file of captured) {
      if (!touched.has(fold(file.relative))) continue;
      const after = await readOptional(file.absolute);
      files.push({
        path: file.relative,
        before: file.before === undefined ? null : await this.runtime.blobs.put(new Uint8Array(file.before), "application/octet-stream"),
        after: after === undefined ? null : workspaceDigest(new Uint8Array(after)),
      });
    }
    if (files.length === 0) return;
    await this.append("checkpoint/recorded", { ...(this.turnId === undefined ? {} : { turn_id: this.turnId }), tool_call_id: request.tool_call_id, files }, "agent");
  }

  // ---- the loop ---------------------------------------------------------------------------------

  private enqueue(text: string, attachments: readonly Attachment[] = []): void {
    this.queued.push({ text, attachments });
  }

  private async loop(input: NonNullable<SessionRenderer["input"]>): Promise<void> {
    const concurrent = this.renderer.kind === "tui";
    for (;;) {
      if (this.exiting || this.outer.signal.aborted) return;
      let message = this.queued.shift();
      if (message === undefined) {
        let next;
        try {
          next = await input.next(this.outer.signal);
        } catch {
          return;
        }
        if (next.kind === "exit") return;
        if (!("text" in next)) continue;
        const text = next.text.trim();
        const attachments = next.attachments ?? [];
        if (text === "" && attachments.length === 0) continue;
        message = { text, attachments };
        if (next.kind === "command" && !text.startsWith("/")) message = { text: `/${text}`, attachments };
      }
      const work = message.text.startsWith("/") ? this.command(message.text) : this.turn(message.text, message.attachments);
      const left = concurrent ? await this.alongside(work, input) : await work;
      if (left === true) return;
    }
  }

  /**
   * While work runs in the TUI: a typed message answers a pending question, steers the running
   * workers (coordinator) or the running turn (next step boundary); commands marked `whileBusy` run
   * at once, other commands wait for the turn to end; /exit and Ctrl+D leave.
   */
  private async alongside<T>(work: Promise<T>, input: NonNullable<SessionRenderer["input"]>): Promise<T> {
    const stop = new AbortController();
    const reader = (async () => {
      for (;;) {
        let next;
        try {
          next = await input.next(AbortSignal.any([stop.signal, this.outer.signal]));
        } catch {
          return;
        }
        if (next.kind === "exit") {
          this.exiting = true;
          this.active?.abort();
          this.orchestration?.controller.abort();
          this.outer.abort();
          return;
        }
        if (!("text" in next)) continue;
        const text = next.text.trim();
        const attachments = next.attachments ?? [];
        if (text === "" && attachments.length === 0) continue;
        if (next.kind === "command" || text.startsWith("/")) {
          const command = findConversationCommand(text.split(/\s+/)[0] ?? "");
          if (command?.whileBusy === true) {
            if (await this.command(text)) {
              this.exiting = true;
              this.active?.abort();
              this.orchestration?.controller.abort();
              this.outer.abort();
              return;
            }
          } else {
            this.enqueue(text);
            this.note("info", `queued ${this.glyphs.name === "rich" ? "›" : ">"} ${text} (runs when Synorch is done)`);
          }
          continue;
        }
        if (this.desk.answer(text)) continue;
        this.steer(text, attachments);
      }
    })();
    try {
      return await work;
    } finally {
      stop.abort();
      await reader;
    }
  }

  /** Mid-turn steering (ADR-21 D8): to the coordinator while workers run, else to the running turn, else the next turn. */
  private steer(text: string, attachments: readonly Attachment[]): void {
    const arrow = this.glyphs.name === "rich" ? "↳" : "->";
    const orchestration = this.orchestration;
    if (orchestration !== undefined) {
      orchestration.coordinator.steer(text);
      this.note("info", `${arrow} steering the workers: ${snippet(text, 80)} (applied at the next safe point)`);
      return;
    }
    if (this.turnRunning && this.driver !== undefined && attachments.length === 0) {
      this.driver.steer(text);
      this.note("info", `${arrow} Synorch reads this at its next step`);
      return;
    }
    this.enqueue(text, attachments);
    this.note("info", `queued ${this.glyphs.name === "rich" ? "›" : ">"} ${text}`);
  }

  /** Esc: interrupts the turn; while workers run, the first Esc arms and the second stops them. */
  private interrupt(): void {
    const orchestration = this.orchestration;
    if (orchestration === undefined) {
      this.active?.abort();
      return;
    }
    if (!orchestration.tracker.stopArmed) {
      orchestration.tracker.stopArmed = true;
      this.renderer.views?.setBoard(orchestration.tracker.view());
      this.note("warning", `Press Esc again to stop the workers ${this.glyphs.sep} messages you type steer them instead`);
      orchestration.disarm = setTimeout(() => {
        orchestration.tracker.stopArmed = false;
        this.renderer.views?.setBoard(orchestration.tracker.view());
      }, ESC_ARM_MS);
      orchestration.disarm.unref?.();
      return;
    }
    this.note("warning", "Stopping the workers…");
    orchestration.controller.abort();
  }

  private async askUser(question: string, options: readonly string[] | undefined, signal: AbortSignal): Promise<string> {
    this.note("warning", `? ${question}`);
    if (options !== undefined && options.length > 0) this.note("info", `  ${options.map((option, index) => `${index + 1}. ${option}`).join("   ")}`);
    this.note("info", "  type your answer and press Enter");
    if (this.renderer.kind === "tui") return this.desk.ask(signal);
    const input = this.renderer.input;
    if (input === undefined) throw new DOMException("no input", "AbortError");
    for (;;) {
      const next = await input.next(signal);
      if (!("text" in next)) throw new DOMException("the question was not answered", "AbortError");
      const answer = next.text.trim();
      if (answer === "") continue;
      const picked = options?.[Number(answer) - 1];
      return /^\d+$/.test(answer) && picked !== undefined ? picked : answer;
    }
  }

  private async currentRoute(): Promise<RouteDecision | undefined> {
    try {
      return await (this.routePromise ?? Promise.reject(new Error("no route")));
    } catch (error) {
      this.showFailure(failureInfo(error));
      this.routePromise = this.runtime.router.resolve({ tier: sessionRouteRule(this.runtime, this.sessionTier)?.tier ?? "orchestrator", role: "session" }, this.outer.signal);
      this.routePromise.catch(() => undefined);
      return undefined;
    }
  }

  private async turn(typed: string, attachments: readonly Attachment[]): Promise<boolean> {
    this.submittedAt = performance.now();
    let text = typed;
    if (this.planOn && GO_WORDS.test(text.trim())) {
      this.setPlanMode(false);
      text = `${text}\n(The plan is approved: carry it out now.)`;
    }
    let log: EventStore;
    try {
      log = await this.ensureLog(text);
    } catch (error) {
      this.showFailure(failureInfo(error));
      return false;
    }
    const driver = this.ensureDriver(log);
    const route = await this.currentRoute();
    if (route === undefined) return false;
    if (!this.routeRecorded) {
      this.routeRecorded = true;
      await this.append("route/decided", { decision: route }, "agent").catch(() => undefined);
    }
    let body = text;
    let images: readonly BlobRef[] = [];
    if (attachments.length > 0 || /(^|\s)@\S/.test(text)) {
      const support = mayContainImage(text, attachments) ? await this.imageSupport(route) : { send: false, reason: "" };
      const blobs = this.runtime.blobs;
      const resolved = await resolveAttachments(text, attachments, {
        workspaceRoot: this.runtime.workspaceRoot,
        model: route.route.model_id,
        images: { ...support, put: (bytes, mediaType) => blobs.put(bytes, mediaType) },
      });
      for (const entry of resolved.notices) this.note(entry.level, entry.text);
      body = resolved.message;
      images = resolved.images;
    }
    const notes = this.pendingNotes.splice(0);
    const message = notes.length === 0 ? body : `[Synorch note: ${notes.join(" ").replaceAll("]", ")")}]\n${body}`;
    const active = linked(this.outer.signal);
    this.active = active;
    this.turnRunning = true;
    let outcome: Awaited<ReturnType<AgentDriver["runTurn"]>> | undefined;
    try {
      outcome = await driver.runTurn(
        {
          sessionId: log.sessionId,
          runId: undefined,
          taskId: undefined,
          attemptId: undefined,
          role: "session",
          route: route.route,
          policy: this.policy(),
          packet: undefined,
          userMessage: message,
          ...(images.length === 0 ? {} : { userImages: images }),
          trigger: "user",
          maxSteps: MAX_STEPS,
        },
        active.signal,
      );
    } catch (error) {
      if (!active.signal.aborted) this.showFailure(failureInfo(error));
    } finally {
      this.turnRunning = false;
      if (this.active === active) this.active = undefined;
      this.submittedAt = undefined;
    }
    // A message typed while the last step settled could not be delivered in this turn: it starts the next one.
    const leftover = driver.drainSteers?.() ?? [];
    if (leftover.length > 0) this.queued.unshift({ text: leftover.join("\n"), attachments: [] });
    if (this.planOn && outcome?.outcome === "completed" && leftover.length === 0) {
      this.note("info", `${this.glyphs.bullet} Plan mode ${this.glyphs.sep} /go carries it out here ${this.glyphs.sep} /go workers runs it with workers ${this.glyphs.sep} or keep refining`);
    }
    return false;
  }

  /**
   * Whether this route sends images: the direct OpenAI Responses and Anthropic Messages adapters do
   * unless the model's capability says `unsupported`; other routes (the Claude Code bridge, Codex
   * app-server, scripted) get a notice instead.
   */
  private async imageSupport(route: RouteDecision): Promise<{ readonly send: boolean; readonly reason: string }> {
    const adapterId = route.route.adapter_id;
    if (!IMAGE_ADAPTERS.has(adapterId)) {
      return { send: false, reason: adapterId === "claude-code" ? "images are not sent through the Claude Code bridge yet" : `the ${adapterId} route does not take image input` };
    }
    let level = "unknown";
    try {
      const adapter = this.runtime.router.adapterFor(route.route);
      const capabilities = await adapter.discoverCapabilities(this.outer.signal);
      level = capabilities.models.find((model) => model.id === route.route.model_id)?.image_input ?? "unknown";
    } catch {
      // Capability discovery failing does not block the image; the provider will refuse it if needed.
    }
    return level === "unsupported" ? { send: false, reason: `${route.route.model_id} does not take image input` } : { send: true, reason: "" };
  }

  private showFailure(error: HarnessErrorInfo): void {
    const workspace = error.workspace_effect === "none" ? "unchanged" : error.workspace_effect === "unknown" ? "may have changed · check git status" : "partly changed";
    this.note("error", `${this.glyphs.fail} ${error.message}`);
    this.note("info", `  Workspace  ${workspace}`);
    if (error.next_command !== undefined) this.note("info", `  Next       ${error.next_command}`);
  }

  // ---- orchestration (the `orchestrate` tool, ADR-21 D4/D5) -----------------------------------

  private observeOrchestration(orchestration: ActiveOrchestration, event: SessionEvent): void {
    const tracker = orchestration.tracker;
    const before = tracker.sessionId;
    if (!tracker.observe(event)) return;
    const g = this.glyphs;
    if (event.type === "plan/proposed" && event.session_id === tracker.sessionId) {
      const plan = event.data.plan;
      this.note("info", `${g.bullet} Plan ${g.sep} ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} ${g.sep} risk ${plan.risk}${this.runtime.policyMode === "autonomous" ? ` ${g.sep} starting now ${g.sep} esc to stop` : ""}`);
      for (const [index, task] of plan.tasks.entries()) this.note("info", `  ${index + 1}. ${task.key} (${task.role}): ${snippet(task.objective, 90)}`);
    }
    if (before === undefined && tracker.sessionId !== undefined) this.orchestratedSessions.push(tracker.sessionId);
    const views = this.renderer.views;
    if (views !== undefined) {
      // The TUI board updates in place (and ticks at 1 Hz); the plain board prints only on task changes.
      if (this.renderer.kind === "tui" || event.type === "task/state_changed" || event.type === "task/created") views.setBoard(tracker.view());
      return;
    }
    if (event.type === "task/state_changed") {
      const line = tracker.line(event.data.task_id);
      if (line !== undefined) this.note("info", line);
    }
  }

  private async runOrchestration(input: OrchestrateInput, context: ToolExecutionContext): Promise<ToolResult> {
    const g = this.glyphs;
    const error = (code: "execution_failed" | "cancelled" | "policy_denied", message: string, text = ""): ToolResult => ({
      status: "error",
      text: text.slice(0, 16 * 1024),
      truncated: false,
      redactions: 0,
      error: { code, message: message.slice(0, 2000) },
    });
    if (this.planOn) return error("policy_denied", "plan mode is on: present the plan; the user starts workers with /go workers");
    if (this.orchestration !== undefined) return error("execution_failed", "workers are already running in this conversation; wait for them to finish");
    const runtime = this.runtime;
    if (!this.trustAsked && !runtime.trust.state().trusted && runtime.sandbox.enforcement !== "full" && this.renderer.approvals.availability === "interactive") {
      this.trustAsked = true;
      if (await promptTrustForCommand(runtime, this.renderer, "the workers' checks", context.signal)) this.policyCache = undefined;
    }
    this.coordinator ??= runtime.createCoordinator(runtime.brokerFor(this.renderer.approvals));
    const goal = input.brief === undefined ? input.goal : `${input.goal}\n\nContext from the conversation:\n${input.brief}`;
    const tracker = new OrchestrationTracker(goal, input.reason);
    this.lastTracker = tracker;
    const controller = linked(context.signal);
    const orchestration: ActiveOrchestration = { tracker, coordinator: this.coordinator, controller, disarm: undefined };
    this.orchestration = orchestration;
    const views = this.renderer.views;
    this.note("info", `${g.bullet} Starting workers ${g.sep} ${input.reason}`);
    if (this.renderer.kind === "tui") views?.setBoard(tracker.view());
    const ticker = views === undefined || this.renderer.kind !== "tui" ? undefined : setInterval(() => views.setBoard(tracker.view()), 1000);
    ticker?.unref?.();
    try {
      const outcome = await this.coordinator.run(
        {
          goal,
          workspaceRoot: runtime.workspaceRoot,
          policyMode: runtime.policyMode,
          headless: this.renderer.approvals.availability === "headless",
          resumeSessionId: undefined,
          budget: runtime.config.budget,
        },
        controller.signal,
      );
      if (!this.orchestratedSessions.includes(outcome.sessionId)) this.orchestratedSessions.push(outcome.sessionId);
      tracker.finish(outcome.status);
      const block = tracker.resultBlock({ status: outcome.status, summary: outcome.summary, runId: outcome.runId, sessionId: outcome.sessionId });
      if (ticker !== undefined) clearInterval(ticker);
      const view = tracker.view();
      // A done board collapses to its summary, pinned once (U3); the plain renderer prints it.
      views?.setBoard(view);
      if (views === undefined) {
        const seconds = Math.round(((view.endedAtMs ?? Date.now()) - (view.startedAtMs ?? Date.now())) / 1000);
        const status = outcome.status === "succeeded" ? "done" : outcome.status;
        this.note(outcome.status === "succeeded" ? "info" : "warning", `${g.bullet} Workers ${g.sep} ${view.tasks.length} task${view.tasks.length === 1 ? "" : "s"} ${g.sep} ${status} in ${seconds}s`);
        for (const task of view.tasks) {
          const glyph = task.state === "completed" ? g.ok : task.state === "failed" || task.state === "cancelled" || task.state === "blocked" ? g.fail : g.bullet;
          this.note("info", `  ${glyph} ${task.key.padEnd(18)} ${task.role.padEnd(12)} ${task.summary ?? task.reason ?? task.state.replaceAll("_", " ")}`);
        }
      }
      for (const line of tracker.resultLines()) this.note("info", `  ${line}`);
      if (outcome.status === "succeeded") return { status: "ok", text: block, truncated: false, redactions: 0 };
      return error(outcome.status === "cancelled" ? "cancelled" : "execution_failed", `the orchestration ${outcome.status}: ${snippet(outcome.summary, 400)}`, block);
    } catch (caught) {
      tracker.finish(controller.signal.aborted ? "cancelled" : "failed");
      views?.setBoard(tracker.view());
      const info = failureInfo(caught);
      return error(controller.signal.aborted ? "cancelled" : "execution_failed", info.message);
    } finally {
      if (ticker !== undefined) clearInterval(ticker);
      if (orchestration.disarm !== undefined) clearTimeout(orchestration.disarm);
      this.orchestration = undefined;
    }
  }

  // ---- slash commands ---------------------------------------------------------------------------

  /** Resolves true when the user asked to leave. */
  private async command(text: string): Promise<boolean> {
    const [name = ""] = text.split(/\s+/);
    const argument = text.slice(name.length).trim();
    const command = findConversationCommand(name);
    if (command === undefined) {
      this.print([unknownConversationCommand(name, this.glyphs.sep)]);
      return false;
    }
    try {
      return (await command.run(this, argument)) === true;
    } catch (error) {
      if (!this.outer.signal.aborted) this.showFailure(failureInfo(error));
      return false;
    }
  }

  public cancel(): void {
    if (this.orchestration !== undefined) this.orchestration.controller.abort();
    else if (this.active === undefined) this.print(["Nothing is running."]);
    else this.active.abort();
  }

  /**
   * The permission mode from Shift+Tab, `/permissions <mode>`, `/plan`, `/go` or a go-word
   * (ADR-08 revision 2026-09-24); idempotent. The policy is recomputed at once, the footer follows,
   * and the agent is told at its next message.
   */
  private setMode(mode: PermissionMode | undefined): void {
    const runtime = this.runtime;
    const previous = runtime.permissionMode();
    if (previous === mode) return;
    if (mode === "plan") this.modeBeforePlan = previous;
    runtime.setPermissionMode(mode);
    this.policyCache = undefined;
    const g = this.glyphs;
    if (mode !== undefined) this.renderer.controls?.setPermissionMode(mode);
    if (mode === "plan") {
      this.note("info", `${g.bullet} Plan mode on ${g.sep} Synorch reads and plans but does not edit or run commands ${g.sep} Shift+Tab or /plan leaves`);
      this.pendingNotes.push(
        "plan mode is ON: you may read, search and discuss, but not edit files or run commands. Produce a concrete plan (steps, files, risks, how it will be verified); say whether it is small enough to do directly or big enough for workers.",
      );
      return;
    }
    if (previous === "plan") {
      this.pendingNotes.push("plan mode is OFF: you may edit files and run commands again.");
      if (mode !== "full") {
        this.note("info", `${g.bullet} Plan mode off ${g.sep} Synorch may edit and run commands again${mode === undefined ? "" : ` ${g.sep} ${mode} mode`}`);
        return;
      }
    }
    if (mode === "full") {
      this.note("error", this.fullAccessNotice());
      this.pendingNotes.push("the user switched to full access: edits and commands in this folder run without asking (hard rails still apply).");
    } else if (mode === "ask") {
      this.note("info", `${g.bullet} Ask mode ${g.sep} Synorch asks before every edit and command`);
      this.pendingNotes.push("the user switched to ask mode: each edit and command is confirmed by the user first.");
    } else if (mode === "auto") {
      this.note("info", `${g.bullet} Auto mode ${g.sep} edits and allowlisted commands run; anything risky asks you first`);
      if (previous === "ask" || previous === "full") this.pendingNotes.push("the user switched to auto mode: edits and allowlisted commands run, anything else is asked for.");
    } else this.note("info", `${g.bullet} Default-deny ${g.sep} commands outside the allowlist are refused`);
  }

  /** Plan mode on/off from `/plan`, `/go` or a go-word; leaving returns to the mode before it. */
  private setPlanMode(on: boolean): void {
    if (this.planOn === on) return;
    if (on) this.setMode("plan");
    else this.setMode(this.modeBeforePlan);
  }

  public async planMode(goal: string): Promise<void> {
    if (goal === "") {
      this.setPlanMode(!this.planOn);
      return;
    }
    this.setPlanMode(true);
    this.enqueue(goal);
  }

  public async go(mode: string): Promise<void> {
    const workers = /^(workers?|w|parallel)$/i.test(mode.trim());
    this.setPlanMode(false);
    this.enqueue(
      workers
        ? "The plan is approved. Carry it out with workers now: call the orchestrate tool with the goal, a one-sentence reason and the plan as the brief."
        : "The plan is approved. Carry it out here directly now.",
    );
  }

  public async workers(goal: string): Promise<void> {
    if (goal === "") {
      this.print(["Usage: /workers <goal>  ·  plans the goal, runs parallel workers in their own worktrees and has an independent reviewer check the result"]);
      return;
    }
    this.setPlanMode(false);
    this.enqueue(`Use workers for this (call the orchestrate tool): ${goal}`);
  }

  public async undo(): Promise<void> {
    const g = this.glyphs;
    const events = await this.readEvents();
    const restoredSeqs = new Set(events.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
    const target = [...events].reverse().find((event): event is SessionEventOf<"checkpoint/recorded"> => event.type === "checkpoint/recorded" && !restoredSeqs.has(event.seq));
    if (target === undefined) {
      this.note("info", "Nothing to undo: Synorch has not edited a file in this conversation (or every edit was already undone).");
      return;
    }
    const restored: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const file of target.data.files) {
      const place = this.inside(file.path);
      if (place === undefined) {
        skipped.push({ path: file.path, reason: "outside the workspace" });
        continue;
      }
      const current = await readOptional(place.absolute);
      const digest = current === undefined ? null : workspaceDigest(new Uint8Array(current));
      if (digest !== file.after) {
        skipped.push({ path: file.path, reason: "it changed after the edit, so it was left as is" });
        continue;
      }
      if (file.before === null) await unlink(place.absolute);
      else {
        await mkdir(path.dirname(place.absolute), { recursive: true });
        await writeFile(place.absolute, await this.runtime.blobs.get(file.before.digest));
      }
      restored.push(file.path);
    }
    await this.append("checkpoint/restored", { checkpoint_seq: target.seq, restored, skipped }, "user");
    if (restored.length > 0) {
      this.note("info", `${g.resume} Reverted ${restored.join(", ")} ${g.sep} command side effects are not undone`);
      this.pendingNotes.push(`the user ran /undo; ${restored.join(", ")} ${restored.length === 1 ? "is" : "are"} back to the content before your last edit (re-read before editing again).`);
    }
    for (const entry of skipped) this.note("warning", `${g.warn} Kept ${entry.path}: ${entry.reason}`);
  }

  public async allow(argument: string): Promise<void> {
    const grants = this.grants;
    if (grants === undefined) return;
    if (argument === "") {
      const list = await grants.list();
      this.note("info", list.length === 0 ? "No commands allowed yet. /allow <command prefix> adds one, for example /allow node check.mjs" : `Allowed here: ${list.join(" · ")}`);
      return;
    }
    const removing = /^(-r|--remove)\s+/.exec(argument);
    const normalized = normalizeGrant(removing === null ? argument : argument.slice(removing[0].length));
    if ("error" in normalized) {
      this.note("warning", `${this.glyphs.warn} ${normalized.error}`);
      return;
    }
    if (removing !== null) {
      this.grantList = await grants.remove(normalized.prefix);
      this.policyCache = undefined;
      this.note("info", `${this.glyphs.ok} Removed: ${normalized.prefix}`);
      return;
    }
    await this.addGrant(normalized.prefix, "command");
  }

  /** Persists a command prefix for this folder (user scope), audits it and applies it to the policy at once. */
  private async addGrant(raw: string, source: "command" | "prompt"): Promise<void> {
    const grants = this.grants;
    if (grants === undefined) return;
    const normalized = normalizeGrant(raw);
    if ("error" in normalized) {
      this.note("warning", `${this.glyphs.warn} Not saved as a rule: ${normalized.error}`);
      return;
    }
    this.grantList = await grants.add(normalized.prefix);
    this.policyCache = undefined;
    // A prompt answer arrives inside a turn whose log is already open; /allow may be the first thing typed.
    if (source === "command") await this.ensureLog(`/allow ${normalized.prefix}`).catch(() => undefined);
    await this.append("command/allowed", { workspace_root: this.runtime.trust.state().root, prefix: normalized.prefix }, "user").catch(() => undefined);
    const trustNote = this.runtime.sandbox.enforcement !== "full" && !this.runtime.trust.state().trusted ? " (it runs repository code, so this folder must be trusted too; Synorch asks when it first runs)" : "";
    this.note("info", `${this.glyphs.ok} Always allowed: commands starting with "${normalized.prefix}" in this folder${trustNote} ${this.glyphs.sep} /permissions lists the rules`);
    this.pendingNotes.push(`the user allowed commands starting with "${normalized.prefix}"; you may run them now.`);
  }

  /**
   * `/permissions`: the mode, the persisted allow rules and the trust state; `/permissions <mode>`
   * switches the mode, `allow <prefix>` / `remove <prefix>` edit the rules (like /allow).
   */
  public async permissions(argument: string): Promise<void> {
    const [verb = "", ...rest] = argument.split(/\s+/).filter((part) => part !== "");
    const tail = rest.join(" ");
    const wanted = (PERMISSION_MODE_WORDS as readonly string[]).includes(verb.toLowerCase()) ? verb.toLowerCase() : verb.toLowerCase() === "mode" ? rest[0]?.toLowerCase() : undefined;
    if (wanted !== undefined) {
      if (!(PERMISSION_MODE_WORDS as readonly string[]).includes(wanted)) {
        this.print([`Unknown mode "${wanted}". Modes: ${PERMISSION_MODE_WORDS.join(", ")}`]);
        return;
      }
      if (this.renderer.approvals.availability !== "interactive" && wanted !== "full" && wanted !== "plan") {
        this.note("warning", `${this.glyphs.warn} No terminal can answer prompts here: ${wanted} mode questions become refusals`);
      }
      this.setMode(wanted as PermissionMode);
      return;
    }
    if (verb === "allow" || verb === "add") {
      await this.allow(tail);
      return;
    }
    if (verb === "remove" || verb === "rm" || verb === "-r") {
      await this.allow(tail === "" ? "" : `-r ${tail}`);
      return;
    }
    if (verb !== "") {
      this.print(["Usage: /permissions [ask|auto|full|plan] · /permissions allow <prefix> · /permissions remove <prefix>"]);
      return;
    }
    this.print(await this.permissionLines());
  }

  private async permissionLines(): Promise<string[]> {
    const runtime = this.runtime;
    const g = this.glyphs;
    const mode = runtime.permissionMode();
    const recorded = runtime.trust.recorded();
    const state = runtime.trust.state();
    const rules = (await this.grants?.list()) ?? this.grantList;
    const trust =
      runtime.sandbox.enforcement === "full"
        ? "not needed (full sandbox)"
        : recorded.trusted
          ? recorded.source === "store" || recorded.source === undefined ? "trusted (saved; syn trust --revoke removes it)" : "trusted for this session"
          : state.trusted
            ? "trusted for this session by full access (not saved)"
            : "not trusted (Synorch asks at the first build or test command; /trust asks now)";
    return [
      `Mode            ${mode === undefined ? `default-deny (no prompts; headless)` : `${mode} ${g.sep} ${MODE_MEANINGS[mode]}`}`,
      `                Shift+Tab cycles ask ${g.name === "rich" ? "→" : "->"} auto ${g.name === "rich" ? "→" : "->"} full ${g.name === "rich" ? "→" : "->"} plan; /permissions <mode> switches`,
      `Trust           ${trust}`,
      `Sandbox         ${runtime.sandbox.backend} (${runtime.sandbox.enforcement})`,
      `Always allowed  ${rules.length === 0 ? "none yet (answer \"Always allow\" in a prompt, or /permissions allow <prefix>)" : rules.join(` ${g.sep} `)}`,
      ...(rules.length === 0 ? [] : ["                /permissions remove <prefix> deletes a rule"]),
      `Never           ${HARD_RAILS.join(", ")} (hard rails, every mode); git history changes stay with you`,
    ];
  }

  public async trust(): Promise<void> {
    this.trustAsked = true;
    if (this.runtime.trust.state().trusted || this.runtime.sandbox.enforcement === "full") this.print(["This folder is already trusted."]);
    else if (await promptTrustForCommand(this.runtime, this.renderer, "build and test commands", this.outer.signal)) this.policyCache = undefined;
  }

  /** Tiers whose route the conversation may use (a rule without a role, or one narrowed to `session`). */
  private sessionRules(): RouteRule[] {
    return this.runtime.config.router.rules.filter((rule) => rule.role === undefined || rule.role === "session");
  }

  private authLabel(rule: RouteRule): string {
    const method = this.runtime.adapters.find((adapter) => adapter.adapterId === rule.route.adapter_id)?.authMethod;
    return method === "oauth-subscription" ? "oauth" : method === "cli-bridge" ? "cli" : method === "api-key" ? "api-key" : "unknown";
  }

  public async model(argument: string): Promise<void> {
    const g = this.glyphs;
    const runtime = this.runtime;
    const rules = runtime.config.router.rules;
    const [tierArg = "", ...flags] = argument.split(/\s+/).filter((part) => part !== "");
    if (tierArg === "") {
      const controls = this.renderer.controls;
      if (controls !== undefined) {
        // The K1-U1 picker: rows per tier, the conversation's current one marked; Esc keeps it.
        const entries: ModelPickerEntry[] = rules.map((rule, index) => ({
          id: String(index),
          tier: rule.role === undefined ? rule.tier : `${rule.tier}/${rule.role}`,
          provider: rule.route.provider_id,
          model: rule.route.model_id,
          auth: this.authLabel(rule),
          current: rule.tier === this.sessionTier && (rule.role === undefined || rule.role === "session"),
          description: rule.tier === "session" ? "conversation tier" : `${rule.source} route`,
          ...(rule.role === undefined || rule.role === "session" ? {} : { disabled: `only for the ${rule.role} role` }),
        }));
        const chosen = await controls.openModelPicker(entries, this.outer.signal).catch(() => undefined);
        const rule = chosen === undefined ? undefined : rules[Number(chosen.id)];
        if (rule === undefined || chosen?.current === true) return;
        await this.switchModel(rule.tier, false);
        return;
      }
      const lines = [`Conversation model: ${this.currentModel ?? "?"} (${this.sessionTier ?? "?"} tier)${this.planOn ? ` ${g.sep} plan mode` : ""}`];
      for (const tier of MODEL_TIERS) {
        const tierRules = rules.filter((rule) => rule.tier === tier);
        if (tierRules.length === 0) {
          lines.push(`  ${tier.padEnd(15)} not configured${tier === "session" ? " (the conversation uses the orchestrator route)" : ""}`);
          continue;
        }
        for (const rule of tierRules) {
          const current = tier === this.sessionTier && (rule.role === undefined || rule.role === "session") ? `  ${g.name === "rich" ? "←" : "<-"} conversation` : "";
          lines.push(`  ${`${tier}${rule.role === undefined ? "" : `/${rule.role}`}`.padEnd(15)} ${rule.route.provider_id}/${rule.route.model_id} via ${rule.route.adapter_id} (${this.authLabel(rule)}, ${rule.source})${current}`);
        }
      }
      if (!rules.some((rule) => rule.tier === "session") && rules.some((rule) => rule.tier === "fast_worker")) {
        lines.push("Tip: /model fast_worker makes the conversation answer faster; /model fast_worker --save keeps it for new conversations");
      }
      lines.push("Switch: /model <tier> (this conversation) · add --save to make it the default");
      this.print(lines);
      return;
    }
    const tier = MODEL_TIERS.find((candidate) => candidate === tierArg);
    if (tier === undefined || !this.sessionRules().some((rule) => rule.tier === tier)) {
      this.print([`No route for "${tierArg}". Configured tiers: ${[...new Set(this.sessionRules().map((candidate) => candidate.tier))].join(", ") || "none"}`]);
      return;
    }
    await this.switchModel(tier, flags.includes("--save"));
  }

  /** Switches the conversation's route for this session; `save` persists it as the default only after the human confirms. */
  private async switchModel(tier: ModelTier, save: boolean): Promise<void> {
    const g = this.glyphs;
    const runtime = this.runtime;
    const rule = this.sessionRules().find((candidate) => candidate.tier === tier);
    if (rule === undefined) return;
    const decision = runtime.router.resolve({ tier, role: "session" }, this.outer.signal);
    try {
      await decision;
    } catch (error) {
      this.showFailure(failureInfo(error));
      return;
    }
    this.routePromise = decision;
    this.routeRecorded = false;
    this.sessionTier = tier;
    this.currentModel = rule.route.model_id;
    this.print([`${g.ok} Conversation model: ${rule.route.model_id} (${tier}) for this conversation${save ? "" : ` ${g.sep} /model ${tier} --save makes it the default`}`]);
    if (!save) return;
    const answer = await this.askUser(`Make ${rule.route.model_id} (${tier}) the default conversation model for new conversations?`, ["Yes", "No"], this.outer.signal).catch(() => "No");
    if (!/^(1|y|yes|evet|e)$/i.test(answer.trim())) {
      this.print(["Not saved; the default is unchanged."]);
      return;
    }
    await mkdir(runtime.home, { recursive: true });
    await writeFile(path.join(runtime.home, SESSION_MODEL_FILE), `${JSON.stringify({ tier }, null, 2)}\n`, "utf8");
    this.print([`${g.ok} Saved: new conversations use the ${tier} route (${path.join(runtime.home, SESSION_MODEL_FILE)})`]);
  }

  public async review(focus: string): Promise<void> {
    const g = this.glyphs;
    const runtime = this.runtime;
    const diff = await uncommittedDiff(runtime.workspaceRoot, REVIEW_DIFF_LIMIT, this.outer.signal);
    if (diff === undefined) {
      this.print(["/review needs a git repository: the uncommitted diff is what gets reviewed."]);
      return;
    }
    if (diff.text.trim() === "") {
      this.print(["No uncommitted changes to review."]);
      return;
    }
    const rules = runtime.config.router.rules;
    const rule = rules.find((candidate) => candidate.role === "reviewer") ?? rules.find((candidate) => candidate.tier === "complex_worker") ?? sessionRouteRule(runtime, this.sessionTier);
    if (rule === undefined) return;
    let route: RouteDecision;
    try {
      route = await runtime.router.resolve({ tier: rule.tier, role: rule.role }, this.outer.signal);
    } catch (error) {
      this.showFailure(failureInfo(error));
      return;
    }
    const files = (diff.text.match(/^diff --git /gm) ?? []).length;
    this.note("info", `${g.bullet} Reviewing ${files} changed file${files === 1 ? "" : "s"} with ${route.route.model_id} ${g.sep} independent: fresh context, no conversation history ${g.sep} Esc stops`);
    const reviewLog = await runtime.sessions.create({
      session_id: createId("session"),
      project_id: runtime.projectId,
      workspace_root: runtime.workspaceRoot,
      created_at: new Date().toISOString(),
      title: `review: ${focus === "" ? "uncommitted changes" : focus.slice(0, 100)}`,
    });
    const driver = runtime.createSessionDriver(runtime.brokerFor(undefined), reviewLog, (gateway) => gateway);
    const active = linked(this.outer.signal);
    this.active = active;
    const prompt = [
      "You are an independent code reviewer. You did not write these changes and you have no conversation history.",
      "Review the uncommitted diff below for correctness bugs, security problems, missing tests and risky behaviour changes. You may read files to check context; you cannot edit or run commands.",
      "Reply with: a one-line verdict (accept / changes requested / block), then findings as a short list with file:line, severity and why. Say plainly when you found nothing important.",
      ...(focus === "" ? [] : [`Focus: ${focus}`]),
      "",
      "```diff",
      diff.text,
      "```",
    ].join("\n");
    try {
      await driver.runTurn(
        {
          sessionId: reviewLog.sessionId,
          runId: undefined,
          taskId: undefined,
          attemptId: undefined,
          role: "session",
          route: route.route,
          policy: planModePolicy(this.basePolicy()),
          packet: undefined,
          userMessage: prompt,
          trigger: "user",
          maxSteps: 20,
        },
        active.signal,
      );
      const events: SessionEvent[] = [];
      for await (const item of reviewLog.read()) if (item.status === "ok") events.push(item.event);
      const answer = [...events]
        .reverse()
        .flatMap((event) => (event.type === "message/recorded" && event.data.role === "assistant" && event.data.message !== undefined ? [event.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")] : []))
        .find((entry) => entry.trim() !== "");
      if (answer === undefined) {
        this.note("warning", `${g.warn} The reviewer gave no answer${active.signal.aborted ? " (stopped)" : ""}.`);
        return;
      }
      this.note("info", `${g.bullet} Review ${g.sep} independent (fresh context, ${route.route.model_id}) ${g.sep} advisory, not a harness-verified review`);
      for (const line of answer.trim().split(/\r?\n/)) this.note("info", `  ${line}`);
      this.pendingNotes.push(`the user ran /review; an independent reviewer (${route.route.model_id}, fresh context) said: ${snippet(answer, 1500)}`);
    } catch (error) {
      if (!active.signal.aborted) this.showFailure(failureInfo(error));
    } finally {
      if (this.active === active) this.active = undefined;
      await reviewLog.close().catch(() => undefined);
    }
  }

  public async commit(argument: string): Promise<void> {
    const g = this.glyphs;
    const root = this.runtime.workspaceRoot;
    const changes = await uncommittedChanges(root, this.outer.signal);
    if (changes === undefined) {
      this.print(["/commit needs a git repository."]);
      return;
    }
    if (changes.files.length === 0) {
      this.print(["Nothing to commit: the working tree is clean."]);
      return;
    }
    const statTail = changes.stat.split(/\r?\n/).at(-1)?.trim() ?? "";
    let message = argument.trim() === "" ? await this.proposeCommitMessage(changes.files.map((file) => file.path), changes.stat) : argument.trim();
    const count = `${changes.files.length} file${changes.files.length === 1 ? "" : "s"}`;
    const views = this.renderer.views;
    if (views !== undefined) {
      // UX-03 action card: what, why, consequence, reversibility — before the human decides.
      views.showView({
        kind: "action",
        title: `Commit ${count}?`,
        what: `git commit -m "${snippet(message.split(/\r?\n/)[0] ?? message, 90)}"`,
        why: "you ran /commit",
        consequence: `stages every uncommitted change (git add -A) and records one commit${statTail === "" ? "" : ` · ${statTail}`}`,
        effect: "local",
        reversible: true,
        paths: changes.files.map((file) => file.path),
        scope: "this commit once; nothing is pushed",
      });
      this.print(["Message:", ...message.split(/\r?\n/).map((line) => `  ${line}`)]);
    } else {
      const lines = [`${g.bullet} Commit ${g.sep} ${count}`];
      for (const file of changes.files.slice(0, 15)) lines.push(`  ${file.status.padEnd(3)}${file.path}`);
      if (changes.files.length > 15) lines.push(`  … ${changes.files.length - 15} more`);
      if (statTail !== "") lines.push(`  ${statTail}`);
      this.print([...lines, "Proposed message:", ...message.split(/\r?\n/).map((line) => `  ${line}`)]);
    }
    const answer = await this.askUser(`Commit ${changes.files.length} file${changes.files.length === 1 ? "" : "s"} with this message?`, ["Commit", "Edit the message", "Cancel"], this.outer.signal).catch(() => "Cancel");
    if (/^(2|e|edit)/i.test(answer.trim())) {
      message = (await this.askUser("Type the commit message", undefined, this.outer.signal).catch(() => "")).trim();
      if (message === "") {
        this.print(["Not committed."]);
        return;
      }
    } else if (!/^(1|y|yes|commit|evet)/i.test(answer.trim())) {
      this.print(["Not committed."]);
      return;
    }
    const result = await commitAll(root, message, this.outer.signal);
    if (!result.ok) {
      this.note("error", `${g.fail} git commit failed: ${snippet(result.stderr || result.stdout, 300)}`);
      return;
    }
    const subject = message.split(/\r?\n/)[0] ?? message;
    this.print([`${g.ok} Committed ${changes.files.length} file${changes.files.length === 1 ? "" : "s"}: ${subject}`]);
    this.pendingNotes.push(`the user committed the working tree (/commit) with the message "${snippet(subject, 120)}".`);
  }

  /** A one-shot request to the conversation model for a commit message; a plain summary when that is not possible. */
  private async proposeCommitMessage(files: readonly string[], stat: string): Promise<string> {
    const fallback = `chore: update ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
    const route = await this.routePromise?.catch(() => undefined);
    if (route === undefined) return fallback;
    const adapter = this.runtime.router.adapterFor(route.route);
    if (adapter.kind !== "model") return fallback;
    const goals = (await this.readEvents())
      .flatMap((event) => (event.type === "message/recorded" && event.data.role === "user" && event.data.message !== undefined ? [event.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")] : []))
      .map((text) => snippet(text.replace(/^\[Synorch note:[^\]]*\]\s*/u, "").split("<synorch-attachments>")[0] ?? "", 160))
      .slice(-5);
    const request: ModelRequest = {
      request_id: createId("request"),
      route: route.route,
      system: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Write a git commit message for these changes: a conventional-commit subject line of at most 72 characters, then optionally a blank line and a short body. Reply with the message only.\n\nWhat the user asked for:\n${goals.map((goal) => `- ${goal}`).join("\n") || "- (no conversation yet)"}\n\nDiff stat:\n${stat.slice(0, 4000) || files.join("\n")}`,
            },
          ],
        },
      ],
      tools: [],
      max_output_tokens: 300,
    };
    try {
      const signal = AbortSignal.any([this.outer.signal, AbortSignal.timeout(30_000)]);
      const credential = await this.runtime.credentials(route.route, signal);
      let text = "";
      for await (const event of adapter.stream(request, credential, signal)) {
        if (event.type === "text_delta") text += event.text;
        if (event.type === "done" && text === "") text = event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
        if (event.type === "error") return fallback;
      }
      const cleaned = text.trim().replace(/^```\w*\n?|```$/g, "").trim();
      return cleaned === "" ? fallback : cleaned.slice(0, 2000);
    } catch {
      return fallback;
    }
  }

  public async usage(): Promise<void> {
    const ledger = this.usageLedger;
    if (ledger === undefined) return;
    const views = this.renderer.views;
    if (views !== undefined) views.showView(await ledger.view(Date.now() - this.startedAt));
    else this.print(await ledger.report());
  }

  public async cost(): Promise<void> {
    this.print(this.usageLedger?.cost() ?? ["No usage recorded yet."]);
  }

  /** Events of this conversation's worker runs (this process, or recorded in orchestrate results when resumed). */
  private async orchestrationEvents(): Promise<SessionEvent[]> {
    const ids = new Set<string>(this.orchestratedSessions);
    for (const event of await this.readEvents()) {
      if (event.type !== "message/recorded" || event.data.role !== "tool" || event.data.message === undefined) continue;
      for (const part of event.data.message.content) {
        if (part.type !== "tool_result") continue;
        for (const match of part.text.matchAll(ORCHESTRATION_SESSION)) if (match[1] !== undefined) ids.add(match[1]);
      }
    }
    const events: SessionEvent[] = [];
    for (const id of ids) {
      try {
        const reader = await this.runtime.sessions.openForRead(id as SessionId);
        for await (const item of reader.read()) if (item.status === "ok") events.push(item.event);
      } catch {
        continue;
      }
    }
    return events;
  }

  /** `/evidence` as U3's `EvidenceView`: checks run by Synorch, worker-cited criteria, independent reviews, changed paths. */
  private async evidenceView(): Promise<EvidenceView> {
    const events = await this.orchestrationEvents();
    const conversation = await this.readEvents();
    const restored = new Set(conversation.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
    const direct = [...new Set(conversation.flatMap((event) => (event.type === "checkpoint/recorded" && !restored.has(event.seq) ? event.data.files.map((file) => file.path) : [])))];
    if (events.length === 0) {
      return {
        kind: "evidence",
        title: "This conversation",
        criteria: [],
        review: { independent: false },
        ...(direct.length === 0 ? {} : { changedPaths: direct }),
        next: direct.length === 0 ? "nothing changed yet" : "direct edits are not independently reviewed: /review runs a reviewer on the uncommitted diff",
      };
    }
    const keys = new Map<string, string>();
    const states = new Map<string, string>();
    for (const event of events) {
      if (event.type === "task/created") keys.set(event.data.task_id, event.data.key);
      if (event.type === "task/state_changed") states.set(event.data.task_id, event.data.to);
    }
    const criteria: CriterionView[] = [];
    for (const event of events) {
      if (event.type === "attempt/verification_ran") {
        criteria.push({
          text: `${keys.get(event.data.task_id) ?? "task"}: ${event.data.command}`,
          status: event.data.status === "passed" ? "passed" : event.data.status === "failed" ? "failed" : "not_run",
          proofs: [{ kind: "command", command: event.data.command, ...(event.data.exit_code === null ? {} : { exitCode: event.data.exit_code }), runBy: "harness", durationMs: event.data.duration_ms }],
        });
      }
      if (event.type === "attempt/completion_recorded") {
        let completion: CompletionPacket | undefined;
        try {
          completion = completionPacketSchema.parse(JSON.parse(new TextDecoder().decode(await this.runtime.blobs.get(event.data.blob.digest))));
        } catch {
          completion = undefined;
        }
        const task = completion === undefined ? undefined : [...keys.entries()].find(([id]) => events.some((candidate) => candidate.type === "attempt/started" && candidate.data.attempt_id === event.data.attempt_id && candidate.data.task_id === id));
        for (const entry of completion?.acceptance_evidence ?? []) {
          criteria.push({
            text: `${task?.[1] ?? "task"}: ${entry.criterion_id}`,
            status: task !== undefined && states.get(task[0]) === "completed" ? "passed" : "unverifiable",
            proofs: entry.evidence.map((ref) => ({ kind: "note" as const, text: `${ref.kind} ${ref.ref} (cited by the ${ref.produced_by})` })),
          });
        }
      }
    }
    const reviews = events.filter((event): event is SessionEventOf<"review/recorded"> => event.type === "review/recorded");
    const lastReview = reviews.at(-1);
    const integrated = [...new Set(events.flatMap((event) => (event.type === "task/integrated" ? event.data.paths : [])))];
    return {
      kind: "evidence",
      title: "Worker runs in this conversation",
      criteria,
      ...(lastReview === undefined
        ? { review: { independent: false } }
        : { review: { independent: true, verdict: lastReview.data.decision === "accept" ? "accepted" : lastReview.data.decision === "revise" ? "changes_requested" : "rejected" } }),
      changedPaths: [...integrated, ...direct.filter((file) => !integrated.includes(file))],
      ...(direct.length === 0 ? {} : { next: `${direct.length} direct edit${direct.length === 1 ? " is" : "s are"} not independently reviewed: /review` }),
    };
  }

  public async evidence(): Promise<void> {
    const view = await this.evidenceView();
    const views = this.renderer.views;
    if (views !== undefined) {
      views.showView(view);
      return;
    }
    if (view.criteria.length === 0) {
      this.print([view.next ?? "No evidence recorded yet."]);
      return;
    }
    this.print(view.criteria.map((criterion) => `${criterion.status}: ${criterion.text}`));
  }

  /** `/why` as U3's `WhyView`: the latest (or the named tool's latest) policy decision, its reasons and what would change it. */
  public async why(argument: string): Promise<void> {
    const events = await this.readEvents();
    const filter = argument.trim().toLowerCase();
    const decided = [...events].reverse().find((event): event is SessionEventOf<"tool/policy_decided"> => event.type === "tool/policy_decided" && (filter === "" || event.data.action.tool_name.toLowerCase().includes(filter)));
    if (decided === undefined) {
      this.print([filter === "" ? "No action recorded yet in this conversation." : `No ${filter} action recorded in this conversation.`]);
      return;
    }
    const action = decided.data.action;
    const decision = decided.data.decision;
    const result = events.find((event): event is SessionEventOf<"tool/result_recorded"> => event.type === "tool/result_recorded" && event.data.tool_call_id === decided.data.tool_call_id);
    const target = action.command !== undefined ? action.command.argv.join(" ") : action.paths.map((entry) => entry.path).join(", ") || "(no path)";
    const howToChange: { command: string; effect: string }[] = [];
    const add = (command: string, effect: string): void => {
      if (!howToChange.some((entry) => entry.command === command)) howToChange.push({ command, effect });
    };
    const planDenied = this.planOn && decision.decision === "deny" && decision.reasons.some((reason) => reason.code === "workspace-write-denied" || reason.code === "exec-denied");
    for (const reason of decision.reasons) {
      if (reason.code === "exec-not-allowlisted" && action.command !== undefined) add(`/allow ${action.command.argv.slice(0, 2).join(" ")}`, "lets Synorch run commands starting with this prefix here");
      if (reason.code === WORKSPACE_UNTRUSTED_CODE) add("/trust", "lets build and test commands run in this folder");
      if (reason.code === "approval-required" || reason.code === "permission-prompt") add("Shift+Tab (auto or full)", "fewer questions: auto asks only for risky commands, full asks nothing (hard rails still apply)");
      if (reason.code === "exec-not-allowlisted" && this.runtime.permissionMode() === undefined) add("--permission-mode auto", "asks you instead of refusing commands outside the allowlist");
      if (reason.code === "sandbox-insufficient") add("syn doctor --runtime", "shows why a full sandbox is required and missing");
    }
    if (planDenied) add("/plan (or Shift+Tab)", "leaves plan mode so edits and commands are allowed");
    const subject = `${action.tool_name} ${snippet(target, 100)}${result === undefined ? "" : ` (${result.data.state})`}`;
    const view: WhyView = {
      kind: "why",
      subject,
      decision: decision.decision,
      reasons: decision.reasons.map((reason) => ({ layer: reason.layer, code: reason.code, message: reason.message })),
      howToChange,
    };
    const views = this.renderer.views;
    if (views !== undefined) {
      views.showView(view);
      if (result?.data.result.error !== undefined && decision.decision === "allow") this.print([`  result: ${snippet(result.data.result.error.message, 200)}`]);
      return;
    }
    const lines = [`${subject} ${this.glyphs.sep} ${decision.decision}`];
    for (const reason of view.reasons) lines.push(`  ${reason.layer}: ${reason.message} (${reason.code})`);
    for (const entry of howToChange) lines.push(`  ${this.glyphs.name === "rich" ? "→" : "->"} ${entry.command}: ${entry.effect}`);
    this.print(lines);
  }

  public async compact(focus: string): Promise<void> {
    const log = this.log;
    if (log === undefined) {
      this.print(["Nothing to compact yet."]);
      return;
    }
    const events = await this.readEvents();
    const history = await reconstructHistory(events, this.runtime.blobs, { role: "session", taskId: undefined, attemptId: undefined });
    const tokensBefore = history.messages.reduce((sum, entry) => sum + messageTokens(entry.message), 0);
    const compactor = createCompactor({
      blobs: this.runtime.blobs,
      writerFor: (sessionId) => (sessionId === log.sessionId ? log : undefined),
      keepRecentTokens: 6_000,
      summarize: async (input, signal) => {
        const content = await extractiveSummarizer(input, signal);
        return focus === "" ? content : { ...content, summary: `Focus requested by the user: ${focus}\n${content.summary}` };
      },
    });
    const outcome = await compactor.compact({ sessionId: log.sessionId, events, messages: history.messages, trigger: "manual", tokensBefore }, this.outer.signal);
    if (outcome.status === "compacted") {
      const data = outcome.event.type === "context/compacted" ? outcome.event.data : undefined;
      this.print([`${this.glyphs.ok} Compacted: ~${data?.tokens_before ?? tokensBefore} → ~${data?.tokens_after ?? "?"} tokens ${this.glyphs.sep} older messages are summarized (the log keeps everything)`]);
    } else if (outcome.status === "nothing-to-compact") this.print(["Nothing to compact: the conversation is still short."]);
    else if (outcome.status === "thrash") this.print(["Just compacted; try again after a few more steps."]);
    else this.print(["Compaction is unavailable for this conversation."]);
  }

  public async report(name: "context" | "permissions" | "tasks" | "memory" | "diff" | "log", argument: string): Promise<void> {
    switch (name) {
      case "context":
        this.print(contextReport(await this.readEvents()));
        return;
      case "permissions":
        await this.permissions(argument);
        return;
      case "tasks": {
        const events = await this.orchestrationEvents();
        this.print(events.length === 0 ? ["No worker runs in this conversation yet."] : tasksReport(events));
        return;
      }
      case "memory":
        this.print(await memoryReport(this.runtime));
        return;
      case "diff":
        this.print(await this.diff());
        return;
      case "log": {
        const count = Number(argument.split(/\s+/)[0] || "20");
        const events = await this.readEvents();
        const shown = events.slice(-Math.max(1, Number.isFinite(count) ? count : 20));
        this.print(
          shown.length === 0
            ? ["Nothing recorded yet."]
            : shown.map((event) => {
                const line = describeEvent(event);
                return `[event] #${event.seq} ${event.type}${line === undefined ? "" : ` · ${line.text}`}`;
              }),
        );
      }
    }
  }

  private async diff(): Promise<string[]> {
    const events = await this.readEvents();
    const restored = new Set(events.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
    const paths = new Map<string, number>();
    for (const event of events) {
      if (event.type !== "checkpoint/recorded" || restored.has(event.seq)) continue;
      for (const file of event.data.files) paths.set(file.path, (paths.get(file.path) ?? 0) + 1);
    }
    const runEvents = await this.orchestrationEvents();
    const reviewed = new Set(runEvents.flatMap((event) => (event.type === "review/recorded" && event.data.decision === "accept" ? [event.data.task_id] : [])));
    const integrated = new Map<string, boolean>();
    for (const event of runEvents) if (event.type === "task/integrated") for (const file of event.data.paths) integrated.set(file, (integrated.get(file) ?? false) || reviewed.has(event.data.task_id));
    if (paths.size === 0 && integrated.size === 0) return ["Synorch has not changed any file in this conversation."];
    const lines: string[] = [];
    if (paths.size > 0) lines.push(`Changed by Synorch (not independently reviewed):`, ...[...paths].map(([file, edits]) => `  ${file}${edits > 1 ? ` (${edits} edits)` : ""}`));
    if (integrated.size > 0) lines.push("Integrated by workers (checked by Synorch):", ...[...integrated].map(([file, accepted]) => `  ${file}${accepted ? " · independently reviewed" : ""}`));
    return lines;
  }

  public async clear(): Promise<void> {
    if (this.turnRunning || this.orchestration !== undefined) {
      this.print(["Synorch is working; /cancel first."]);
      return;
    }
    const previous = this.sessionId;
    await this.log?.close().catch(() => undefined);
    this.log = undefined;
    this.sessionId = undefined;
    this.driver = undefined;
    this.turnId = undefined;
    this.routeRecorded = false;
    this.orchestratedSessions.length = 0;
    this.pendingNotes.length = 0;
    this.requests.clear();
    this.lastTracker = undefined;
    this.print([`${this.glyphs.ok} New conversation${previous === undefined ? "" : ` ${this.glyphs.sep} the previous one is saved (/resume)`}`]);
  }

  public async resume(argument: string): Promise<void> {
    const list = (await this.conversations()).filter((entry) => entry.sessionId !== this.sessionId).slice(0, 10);
    if (argument === "") {
      this.print(
        list.length === 0
          ? ["No other conversations in this folder."]
          : ["Recent conversations (/resume <n>):", ...list.map((entry, index) => `  ${String(index + 1).padStart(2)}. ${snippet(entry.title, 70)} ${this.glyphs.sep} ${relativeTime(Date.parse(entry.at))}`)],
      );
      return;
    }
    if (this.turnRunning || this.orchestration !== undefined) {
      this.print(["Synorch is working; /cancel first."]);
      return;
    }
    const index = Number(argument);
    const chosen = Number.isInteger(index) && index >= 1 ? list[index - 1]?.sessionId : list.find((entry) => entry.sessionId === argument)?.sessionId;
    if (chosen === undefined) {
      this.print([`No conversation "${argument}"; /resume lists them.`]);
      return;
    }
    await this.log?.close().catch(() => undefined);
    this.log = undefined;
    this.orchestratedSessions.length = 0;
    this.pendingNotes.length = 0;
    this.lastTracker = undefined;
    await this.showResumed(await this.openSession(chosen));
  }

  /** `/mouse [on|off]` when it reaches the session (the interactive renderer normally handles it itself). */
  public async mouse(argument: string): Promise<void> {
    const controls = this.renderer.controls;
    if (controls === undefined) {
      this.print(["Mouse mode needs the interactive terminal view."]);
      return;
    }
    const wanted = /^on$/i.test(argument) ? true : /^off$/i.test(argument) ? false : !controls.mouseMode;
    controls.setMouseMode(wanted);
    this.print([`Mouse mode ${wanted ? "on: wheel scrolls, click expands; /select for native text selection" : "off: the terminal selects text"}`]);
  }

  /** `/graph`: the plan graph of the running or last worker run of this conversation. */
  public async graph(): Promise<void> {
    const tracker = this.orchestration?.tracker ?? this.lastTracker;
    if (tracker === undefined || tracker.view().tasks.length === 0) {
      this.print(["No worker run in this conversation yet: the graph shows a run's tasks and their dependencies."]);
      return;
    }
    const views = this.renderer.views;
    if (views !== undefined) views.showGraph(tracker.view());
    else this.print(tracker.view().tasks.map((task) => `${task.key} (${task.role}) ${task.state.replaceAll("_", " ")}${task.dependsOn === undefined || task.dependsOn.length === 0 ? "" : ` after ${task.dependsOn.join(", ")}`}`));
  }
}

const PERMISSION_MODE_WORDS = ["ask", "auto", "full", "plan"] as const;

const MODE_MEANINGS: Readonly<Record<PermissionMode, string>> = {
  ask: "asks before every edit and command",
  auto: "edits and allowlisted commands run; anything outside the allowlist asks you first",
  full: "no prompts: everything in this folder is allowed except the hard rails",
  plan: "read-only: reads and plans, no edits or commands",
};

function relativeTime(then: number): string {
  if (!Number.isFinite(then)) return "earlier";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
