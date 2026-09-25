import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  askUserSummaryLine,
  choiceQuestionLines,
  parseTypedChoice,
  type ChoiceAnswer,
  type ChoiceQuestion,
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
import type { DiffFileView, DiffView, OrchestrationTaskView, WorkerControl, WorkerSeam } from "../contracts/views.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import { createCompactor, DEFAULT_CONTEXT_WINDOW, extractiveSummarizer, messageTokens, reconstructHistory } from "../context/index.ts";
import { WorkerStreamHub, type OrchestrationCoordinator, type WorkerControlResult, type WorkerDirectory } from "../orchestration/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, evaluateExecAllowlist } from "../policy/index.ts";
import { bindBackgroundStatus, describeEvent, formatHarnessError, GLYPH_SETS, lineDiff, patchPaths, selectGlyphs, suggestedCommandPrefix, type GlyphSet } from "../tui/index.ts";
import { DEFAULT_WEB_DOMAINS, describeProcess } from "../tools/index.ts";
import type { ParsedCommand } from "./args.ts";
import { mayContainImage, resolveAttachments } from "./attachments.ts";

/** Adapters that turn `image` message parts into provider image input. */
const IMAGE_ADAPTERS: ReadonlySet<string> = new Set(["openai-chatgpt", "openai-responses", "anthropic-messages", "claude-code"]);
import { profileHintsFor } from "./canonical.ts";
import { createCommandGrantStore, normalizeGrant, type CommandGrantStore } from "./command-grants.ts";
import { formatListing, listSettings, setUserSetting, settingFor, unsetUserSetting, type ConfigListing, type SettingRow } from "./config-command.ts";
import { DEFAULT_ADAPTER_FOR_PROVIDER } from "./config.ts";
import type { OrchestrateInput } from "./orchestrate-tool.ts";
import { OrchestrationTracker } from "./orchestration-view.ts";
import { runModelCommand } from "./model-picker.ts";
import { effortLabel, effortTarget, pickEffort, runEffortCommand, type EffortCommandHost } from "./effort-command.ts";
import { runMcpSlash } from "./mcp-command.ts";
import { isReasoningEffort } from "../providers/index.ts";
import { failureInfo } from "./outcome.ts";
import { createSessionRenderer, type SessionRenderer } from "./renderers.ts";
import { createRuntime, type Runtime, type RuntimeOverrides } from "./runtime.ts";
import type { SessionIO } from "./session.ts";
import { commitAll, commitsSince, uncommittedChanges, uncommittedDiff } from "./session-git.ts";
import {
  contextReport,
  conversationPaletteEntries,
  findConversationCommand,
  unknownConversationCommand,
  tasksReport,
  type ConversationCommandHost,
} from "./slash-commands.ts";
import { resolveTerminalSettings, streamHasColors } from "./terminal.ts";
import { buildContextView, buildEvidence, buildWhy } from "./transparency.ts";
import { memorySeam, runMemoryDesk, type MemoryDeskHost } from "./memory-desk.ts";
import { createSystemObsidianLauncher, ledgerSummary, readLedger, type MarkdownMemoryStore } from "../memory/index.ts";
import { promptTrustForCommand } from "./trust.ts";
import { runInitCommand, runMemoryInit, startOnboarding } from "./onboarding.ts";
import { profileSummaryLines } from "./project-profile.ts";
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

/** `/diff` as text lines when no view host is attached. */
function diffLines(view: DiffView): string[] {
  if (view.files.length === 0 && (view.integrated === undefined || view.integrated.length === 0)) return ["Synorch has not changed any file in this conversation."];
  const lines: string[] = [];
  if (view.files.length > 0) lines.push("Changed by Synorch (not independently reviewed):", ...view.files.map((file) => `  ${file.path} +${file.added} -${file.removed}${file.change === "modified" ? "" : ` (${file.change})`}`));
  if (view.integrated !== undefined && view.integrated.length > 0) lines.push("Integrated by workers (checked by Synorch):", ...view.integrated.map((entry) => `  ${entry.path}${entry.reviewed ? " · independently reviewed" : ""}`));
  return lines;
}

/** A `git push` with no destructive form (no force, no history rewrite): approving one lets auto push for the session. */
function isPlainGitPush(argv: readonly string[] | undefined): boolean {
  if (argv === undefined || argv.length === 0) return false;
  const classified = classifyCommand(argv, { cwd: ".", writeScope: ["**"], forbidden: [] });
  return classified.findings.length === 0 && classified.external.length > 0 && classified.external.every((entry) => entry.code === "git-push");
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function snippet(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

function sessionRouteRule(runtime: Runtime, preferred?: ModelTier): RouteRule | undefined {
  const rules = runtime.routeRules();
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
  readonly coordinator: OrchestrationCoordinator;
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
  private coordinator: OrchestrationCoordinator | undefined;
  /** K1.7: live streams of this process's worker attempts (the conversation's own session is never kept). */
  private readonly hub = new WorkerStreamHub((sessionId) => sessionId === this.sessionId);
  private workerDirectory: WorkerDirectory | undefined;
  private workerSeam: WorkerSeam | undefined;
  /** Plain interactive mode: input is read while workers run (steering, answers, /worker). */
  private readingDuringWorkers = false;
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
  /** K4.2: the first Esc (with background processes running) armed "Esc again stops them". */
  private processStopArmedAt: number | undefined;

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
        efforts: this.parsed.session.efforts,
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
    const configuredGlyphs = runtime?.config.glyphs;
    this.glyphs =
      configuredGlyphs !== undefined && configuredGlyphs !== "auto" && (io.env.SYN_GLYPHS ?? "").trim() === "" && settings.kind !== "plain"
        ? GLYPH_SETS[configuredGlyphs]
        : selectGlyphs(io.env, io.platform, settings.kind === "plain");
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
      ...(runtime?.config.mouse === undefined ? {} : { mouse: runtime.config.mouse }),
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
      this.hub.feed(event);
      this.forward(event);
    });
    const unbind = io.stdinIsTTY && this.renderer.input !== undefined ? runtime.bindUserPrompt(
            (question, options, signal) => this.askUser(question, options, signal),
            (question, signal) => this.chooseForAgent(question, signal),
          ) : () => undefined;
    runtime.orchestrate.set((input, context) => this.runOrchestration(input, context));
    let unbindControls: () => void = () => undefined;
    const unwatchProcesses = this.watchProcesses();
    this.startedAt = Date.now();
    try {
      this.grants = createCommandGrantStore(runtime.home, runtime.trust.state().root);
      this.grantList = await this.grants.list();
      const resumed = await this.openResumed();
      await this.renderer.start(this.header(rule));
      const controls = this.renderer.controls;
      controls?.setCommands(conversationPaletteEntries());
      this.refreshStatus();
      // K3: MCP servers start in the background (never before the editor); problems become notes.
      void this.startMcp();
      // Shift+Tab / Alt+M in the renderer cycles the permission mode; the session applies the policy.
      unbindControls = controls?.onPermissionModeChange((mode) => this.setMode(mode)) ?? (() => undefined);
      if (runtime.permissionMode() === "full") this.note("error", this.fullAccessNotice());
      if (resumed !== undefined) await this.showResumed(resumed);
      else await this.memoryStartLine();
      // Zero-config onboarding: the quiet "Synorch ready · …" line, the memory vault and the first-session memory bootstrap (user scope only).
      void startOnboarding(runtime, (line) => this.note("info", line), this.glyphs.sep);
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
      // Background processes never outlive the session (K4.2): the whole tree of each is killed.
      this.exiting = true;
      await runtime.processes.killAll().catch(() => undefined);
      await runtime.mcp.close().catch(() => undefined);
      unwatchProcesses();
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
        this.workerLine(recorded);
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
    // K2 (UX-06): what changed in memory since, and the todo list the agent kept, if any.
    const since = lastAt ?? "";
    const pending = await this.runtime.memory.pending().catch(() => []);
    const ledger = await readLedger(this.runtime.memory as MarkdownMemoryStore, this.runtime.projectId, this.runtime.gitBranch).catch(() => undefined);
    const index = await (this.runtime.memory as MarkdownMemoryStore).index().catch(() => undefined);
    const lastMs = Date.parse(since);
    const freshNotes = index === undefined || !Number.isFinite(lastMs) ? 0 : index.notes.filter((note) => note.mtimeMs > lastMs && (note.project_id === this.runtime.projectId || note.scope === "user")).length;
    if (freshNotes > 0 || pending.length > 0) changes.push(`memory: ${freshNotes > 0 ? `${freshNotes} note${freshNotes === 1 ? "" : "s"} changed` : ""}${freshNotes > 0 && pending.length > 0 ? ", " : ""}${pending.length > 0 ? `${pending.length} proposal${pending.length === 1 ? "" : "s"} waiting` : ""}`);
    const todo = lastTodo(events);
    const lastTurn = [...events].reverse().find((event): event is SessionEventOf<"turn/ended"> => event.type === "turn/ended");
    const next =
      lastTurn !== undefined && lastTurn.data.outcome !== "completed"
        ? `the last turn ended ${lastTurn.data.outcome.replaceAll("_", " ")}; say "continue" to pick it up`
        : todo?.next !== undefined
          ? `continue with "${snippet(todo.next, 60)}"`
          : pending.length > 0
            ? `/memory review (${pending.length} waiting), then continue where we left off`
            : "continue where we left off, or ask something new";
    const summary = ledger === undefined ? undefined : ledgerSummary(ledger);
    const extra = [...(todo === undefined ? [] : [`  Todo            ${todo.done}/${todo.total} done${todo.next === undefined ? "" : ` · next: ${snippet(todo.next, 60)}`}`]), ...(summary === undefined ? [] : [`  Memory          ${summary.replace(/^memory: /, "")}`])];
    if (todo !== undefined && todo.next !== undefined) this.pendingNotes.push(`your todo list from before the resume: ${todo.done}/${todo.total} done; next open item: ${snippet(todo.next, 200)}.`);
    if (lastTurn !== undefined && lastTurn.data.outcome !== "completed") this.pendingNotes.push(`the previous turn ended ${lastTurn.data.outcome}; the conversation was resumed.`);
    if (touched.length > 0) this.pendingNotes.push(`since the last turn, ${touched.join(", ")} changed outside Synorch (re-read before editing).`);
    return [`  Where we were   ${where}`, `  Since then      ${changes.length === 0 ? "no changes to files Synorch edited, no new commits" : changes.join(" · ")}`, ...extra, `  Next            ${next}`];
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
    if (decision.decided_by !== "user" || request.subject_kind !== "action") return;
    if ((decision.outcome === "allowed-once" || decision.outcome === "allowed-for-scope") && isPlainGitPush(request.command)) this.runtime.approveGitPushForSession();
    if (decision.outcome !== "allowed-for-scope") return;
    const prefix = suggestedCommandPrefix(request.command);
    if (prefix !== undefined) {
      await this.addGrant(prefix, "prompt");
      return;
    }
    if (request.effect === "workspace-write" && this.runtime.permissionMode() === "ask") this.setMode("auto");
  }

  private fullAccessNotice(): string {
    const trusted = this.runtime.trust.recorded().trusted;
    return `${this.glyphs.warn} Full access: Synorch edits and runs any command in this folder without asking, except destructive commands (hard rails still apply)${trusted ? "" : "; the folder is trusted for this session only (not saved)"} ${this.glyphs.sep} Shift+Tab leaves`;
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
    if (!this.trustAsked && runtime.permissionMode() === "auto" && !runtime.trust.recorded().trusted && runtime.sandbox.enforcement !== "full") {
      // Owner revision 3: auto trusts the folder for this session without a question; one notice, nothing saved.
      this.trustAsked = true;
      this.renderer.render({ kind: "notice", level: "info", message: "Auto mode: trusting this folder for this session (not saved) so commands run without asking; /trust saves it." });
      return false;
    }
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
      // K4.2: background processes survive an interrupted turn; a second Esc within the window stops them.
      const running = this.runtime.processes.running().length;
      if (running > 0) {
        if (this.processStopArmedAt !== undefined && Date.now() - this.processStopArmedAt <= ESC_ARM_MS) {
          this.processStopArmedAt = undefined;
          void this.runtime.processes.killAll().then((count) => this.note("warning", `Stopped ${count} background process${count === 1 ? "" : "es"}`));
        } else {
          this.processStopArmedAt = Date.now();
          this.note("info", `${running} background process${running === 1 ? " is" : "es are"} still running ${this.glyphs.sep} Esc again stops ${running === 1 ? "it" : "them"} ${this.glyphs.sep} /ps lists them`);
        }
      }
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

  /**
   * Every question the session asks the user (ask_user, /init, /memory review, /config, /commit,
   * /model --save). The TUI opens a prompt that owns the input (a picker for choices); plain mode
   * reads a numbered answer. Either way the answer never becomes a conversation message. A numeric
   * answer resolves to its option's text.
   */
  /**
   * K5 structured question (the agent's ask_user, Claude Code's AskUserQuestion): the TUI's choice
   * modal, or in plain mode the numbered question read from the input. Undefined when dismissed.
   */
  private async choose(question: ChoiceQuestion, signal: AbortSignal): Promise<ChoiceAnswer | undefined> {
    const controls = this.renderer.controls;
    if (this.renderer.kind === "tui" && controls !== undefined) return controls.choose(question, signal);
    for (const line of choiceQuestionLines(question)) this.note(line.startsWith("?") ? "warning" : "info", line);
    const input = this.renderer.input;
    for (;;) {
      let typed: string;
      if (this.readingDuringWorkers || input === undefined) typed = await this.desk.ask(signal);
      else {
        const next = await input.next(signal);
        if (!("text" in next)) return undefined;
        typed = next.text;
      }
      if (typed.trim() === "") continue;
      const answer = parseTypedChoice(question, typed);
      if (answer !== undefined) return answer;
      this.note("info", "  type one of the numbers above");
    }
  }

  /** An agent's question leaves one short line in the transcript (`? Auth method → OAuth`), not the modal. */
  private async chooseForAgent(question: ChoiceQuestion, signal: AbortSignal): Promise<ChoiceAnswer | undefined> {
    const answer = await this.choose(question, signal);
    this.note("info", askUserSummaryLine(question, answer));
    return answer;
  }

  private async askUser(question: string, options: readonly string[] | undefined, signal: AbortSignal): Promise<string> {
    const controls = this.renderer.controls;
    if (this.renderer.kind === "tui" && controls !== undefined) {
      const answer = await controls.ask(question, options, signal);
      if (answer === undefined) throw new DOMException("the question was cancelled", "AbortError");
      return answer;
    }
    this.note("warning", `? ${question}`);
    if (options !== undefined && options.length > 0) this.note("info", `  ${options.map((option, index) => `${index + 1}. ${option}`).join("   ")}`);
    this.note("info", options !== undefined && options.length > 0 ? "  type a number (or your answer) and press Enter" : "  type your answer and press Enter");
    const resolve = (typed: string): string => {
      const answer = typed.trim();
      const picked = options?.[Number(answer) - 1];
      return /^\d+$/.test(answer) && picked !== undefined ? picked : answer;
    };
    if (this.renderer.kind === "tui" || this.readingDuringWorkers) return resolve(await this.desk.ask(signal));
    const input = this.renderer.input;
    if (input === undefined) throw new DOMException("no input", "AbortError");
    for (;;) {
      const next = await input.next(signal);
      if (!("text" in next)) throw new DOMException("the question was not answered", "AbortError");
      if (next.text.trim() === "") continue;
      return resolve(next.text);
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
    await this.memoryNudge();
    return false;
  }

  // ---- K2 memory: start summary, proposal nudge, the desk --------------------------------------

  private memoryNudged = 0;

  /** `memory: 3 decisions, 1 open assumption` at session start (nothing for an empty vault). */
  private async memoryStartLine(): Promise<void> {
    const store = this.runtime.memory as MarkdownMemoryStore;
    const summary = await readLedger(store, this.runtime.projectId, this.runtime.gitBranch).then(ledgerSummary, () => undefined);
    if (summary !== undefined) this.note("info", `${this.glyphs.bullet} ${summary}`);
  }

  /** After a turn: `📌 2 memory proposals · /memory review` when the agent proposed something new this session. */
  private async memoryNudge(): Promise<void> {
    const since = new Date(this.startedAt).toISOString();
    const fresh = await this.runtime.memory.pending().then((pending) => pending.filter((proposal) => proposal.state === "pending" && proposal.created_at >= since).length, () => 0);
    if (fresh <= this.memoryNudged) return;
    this.memoryNudged = fresh;
    this.note("info", `${this.glyphs.name === "rich" ? "📌" : "*"} ${fresh} memory proposal${fresh === 1 ? "" : "s"} ${this.glyphs.sep} /memory review`);
  }

  private memoryDesk(): MemoryDeskHost {
    const views = this.renderer.views;
    const host: MemoryDeskHost = {
      store: this.runtime.memory as MarkdownMemoryStore,
      projectId: this.runtime.projectId,
      branch: this.runtime.gitBranch,
      obsidian: createSystemObsidianLauncher(this.io.env, this.io.platform),
      print: (lines) => this.print(lines),
      show: (view) => {
        if (views === undefined) return false;
        views.showView(view);
        return true;
      },
      ask: (question, options) => this.askUser(question, options, this.outer.signal),
      append: async (type, data) => {
        await this.append(type, data, "user");
      },
      bootstrap: () => runMemoryInit(this.runtime),
    };
    views?.connectMemory?.(memorySeam(host));
    return host;
  }

  /**
   * Whether this route sends images: the direct OpenAI Responses and Anthropic Messages adapters do
   * unless the model's capability says `unsupported`; other routes (the Claude Code bridge, Codex
   * app-server, scripted) get a notice instead.
   */
  private async imageSupport(route: RouteDecision): Promise<{ readonly send: boolean; readonly reason: string }> {
    const adapterId = route.route.adapter_id;
    if (!IMAGE_ADAPTERS.has(adapterId)) {
      return { send: false, reason: `the ${adapterId} route does not take image input` };
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
    this.connectWorkers(this.coordinator);
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
    const stopReading = this.readWhileWorkersRun();
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
      await stopReading();
    }
  }

  // ---- K1.7: entering workers ---------------------------------------------------------------

  /** Connects the worker seam (live streams + control, keyed by board key) to the renderer when an orchestration starts. */
  private connectWorkers(coordinator: OrchestrationCoordinator): void {
    const directory = coordinator.workers;
    this.workerDirectory = directory;
    this.hub.assignments = (taskKey) => directory.assignment(taskKey);
    const rejecting = (run: (taskKey: string, text: string) => Promise<WorkerControlResult>) => async (taskKey: string, text = ""): Promise<void> => {
      const result = await run(taskKey, text);
      if (!result.ok) throw new Error(result.message);
    };
    const control: WorkerControl = {
      message: rejecting((taskKey, text) => directory.message(taskKey, text)),
      pause: rejecting((taskKey) => directory.pause(taskKey)),
      resume: rejecting((taskKey) => directory.resume(taskKey)),
      cancel: rejecting((taskKey) => directory.cancel(taskKey)),
    };
    this.workerSeam = { stream: this.hub, control };
    this.renderer.views?.connectWorkers?.(this.workerSeam);
  }

  /**
   * Main-chat lines: a delegation card when the orchestrator dispatches work (every renderer), and in
   * plain mode the user's messages to workers and pause/resume/cancel (the TUI draws its own).
   */
  private workerLine(recorded: SessionEvent): void {
    const g = this.glyphs;
    const arrow = g.name === "rich" ? "→" : "->";
    if (recorded.type === "task/delegated") {
      const data = recorded.data;
      const views = this.renderer.views;
      if (views !== undefined) {
        const assignment = this.workerDirectory?.assignment(data.key);
        views.showView({ kind: "delegation", taskKey: data.key, role: data.role, model: data.model_id, objective: data.objective, ...(assignment === undefined ? {} : { assignment }) });
      } else this.note("info", `${arrow} ${data.key} (${data.role}, ${data.model_id}): ${snippet(data.objective, 100)}`);
      return;
    }
    if (this.renderer.kind === "tui") return;
    const key = (taskId: string): string => this.workerDirectory?.list().find((worker) => worker.taskId === taskId)?.key ?? taskId;
    if (recorded.type === "task/user_message") {
      this.note("info", `${g.name === "rich" ? "↳" : "->"} you ${arrow} ${key(recorded.data.task_id)}: ${snippet(recorded.data.text, 120)}`);
    } else if (recorded.type === "attempt/user_control") {
      const verb = recorded.data.action === "pause" ? "paused" : recorded.data.action === "resume" ? "resumed" : "cancelled";
      this.note(recorded.data.action === "cancel" ? "warning" : "info", `${g.bullet} ${key(recorded.data.task_id)} ${verb} by you`);
    }
  }

  /**
   * Plain interactive mode reads no input while a turn runs; while workers run it does, so a typed
   * line steers the workers, answers the orchestrator, or runs a `whileBusy` command (`/worker`).
   * The TUI reads concurrently anyway (`alongside`). Resolves the stop function.
   */
  private readWhileWorkersRun(): () => Promise<void> {
    const input = this.renderer.input;
    if (this.renderer.kind === "tui" || !this.io.stdinIsTTY || input === undefined || this.readingDuringWorkers) return async () => undefined;
    const stop = new AbortController();
    this.readingDuringWorkers = true;
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
          this.orchestration?.controller.abort();
          this.active?.abort();
          this.outer.abort();
          return;
        }
        if (!("text" in next)) continue;
        const text = next.text.trim();
        if (text === "") continue;
        if (next.kind === "command" || text.startsWith("/")) {
          const command = findConversationCommand(text.split(/\s+/)[0] ?? "");
          if (command?.whileBusy === true) await this.command(text);
          else {
            this.enqueue(text);
            this.note("info", `queued > ${text} (runs when Synorch is done)`);
          }
          continue;
        }
        if (this.desk.answer(text)) continue;
        this.steer(text, []);
      }
    })();
    return async () => {
      stop.abort();
      await reader;
      this.readingDuringWorkers = false;
    };
  }

  /** `/worker [key] [message | --pause | --resume | --cancel]`. */
  public async worker(argument: string): Promise<void> {
    const directory = this.workerDirectory;
    const [key = "", ...rest] = argument.split(/\s+/).filter((part) => part !== "");
    if (directory === undefined || directory.list().length === 0) {
      this.print([`No workers yet in this conversation ${this.glyphs.sep} /workers <goal> runs a goal with workers`]);
      return;
    }
    if (key === "") {
      this.print(this.workerList(directory));
      return;
    }
    const worker = directory.list().find((candidate) => candidate.key === key || candidate.taskId === key);
    if (worker === undefined) {
      this.print([`No worker ${key} ${this.glyphs.sep} known: ${directory.list().map((candidate) => candidate.key).join(", ")}`]);
      return;
    }
    const message = rest.join(" ").trim();
    const flag = /^--(pause|resume|cancel)$/i.exec(message)?.[1]?.toLowerCase();
    if (flag !== undefined || message !== "") {
      const result = flag === "pause" ? await directory.pause(worker.key) : flag === "resume" ? await directory.resume(worker.key) : flag === "cancel" ? await directory.cancel(worker.key) : await directory.message(worker.key, message);
      this.note(result.ok ? "info" : "warning", result.message);
      return;
    }
    const views = this.renderer.views;
    if (this.renderer.kind === "tui" && views?.openWorkerView?.(worker.key) === true) return;
    if (views === undefined) {
      this.print(this.workerDetail(directory, worker.key));
      return;
    }
    const task: OrchestrationTaskView = this.lastTracker?.view().tasks.find((candidate) => candidate.key === worker.key) ?? { key: worker.key, role: worker.role, model: worker.model, state: worker.state as OrchestrationTaskView["state"] };
    // The hub's assignment carries delivery state (a steer the worker already took is no longer "queued").
    const snapshot = this.hub.snapshot(worker.key);
    const latest = snapshot.filter((event) => event.kind === "assignment").at(-1);
    const assignment = latest?.kind === "assignment" ? latest.assignment : directory.assignment(worker.key);
    const events = snapshot.filter((event) => event.kind !== "assignment");
    views.showView({ kind: "worker", task: worker.paused ? { ...task, paused: true } : task, ...(assignment === undefined ? {} : { assignment }), events });
  }

  private workerList(directory: WorkerDirectory): string[] {
    const g = this.glyphs;
    const rows = directory.list();
    const width = Math.max(4, ...rows.map((row) => row.key.length));
    return [
      `${g.bullet} Workers ${g.sep} ${rows.filter((row) => row.live).length} running`,
      ...rows.map((row) => {
        const status = row.live ? (row.paused ? "paused" : "running") : row.state.replaceAll("_", " ");
        return `  ${row.key.padEnd(width + 2)}${row.role.padEnd(12)}${status.padEnd(18)}${row.model ?? ""}${row.attempt > 1 ? ` ${g.sep} attempt ${row.attempt}` : ""}`;
      }),
      `  /worker <key> shows one ${g.sep} /worker <key> <message> messages it ${g.sep} --pause / --resume / --cancel`,
    ];
  }

  /** Text fallback of `/worker <key>` when the renderer hosts no views. */
  private workerDetail(directory: WorkerDirectory, key: string): string[] {
    const g = this.glyphs;
    const assignment = directory.assignment(key);
    const lines: string[] = [];
    if (assignment !== undefined) {
      lines.push(`${g.bullet} ${assignment.taskKey} ${g.sep} ${assignment.objective}`);
      lines.push(`  Owns        ${assignment.owned_paths.join(", ") || "nothing (read-only)"}`);
      for (const [index, criterion] of assignment.acceptance_criteria.entries()) lines.push(`  ${index === 0 ? "Criteria    " : "            "}${criterion}`);
      lines.push(`  Checks      ${assignment.verification_commands.join("; ") || "none"}`);
      for (const note of assignment.steering) lines.push(`  ${note.from === "user" ? "You said    " : "Orchestrator"} ${snippet(note.text, 160)}`);
    }
    const activity = this.hub
      .recent(key, 200)
      .filter((event) => event.type !== "session/opened" && event.type !== "tool/execution_started")
      .map((event) => describeEvent(event))
      .filter((line): line is NonNullable<typeof line> => line !== undefined)
      .slice(-12);
    lines.push(activity.length === 0 ? "  (no activity recorded yet)" : "  Recent activity:");
    for (const line of activity) lines.push(`    ${snippet(line.text, 160)}`);
    return lines;
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
      this.note("info", `${g.bullet} Auto mode ${g.sep} edits and commands in this workspace run (workers too); pushes, publishing and destructive commands ask you first`);
      if (previous === "ask" || previous === "full") this.pendingNotes.push("the user switched to auto mode: edits and any command inside the workspace run without asking (workers too); only outward actions (push, publish, deploy) and destructive commands are asked for.");
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
      if (this.workerDirectory !== undefined && this.workerDirectory.list().length > 0) {
        this.print(this.workerList(this.workerDirectory));
        return;
      }
      this.print(["Usage: /workers <goal>  ·  plans the goal, runs parallel workers in their own worktrees and has an independent reviewer check the result"]);
      return;
    }
    this.setPlanMode(false);
    this.enqueue(`Use workers for this (call the orchestrate tool): ${goal}`);
    if (this.turnRunning || this.orchestration !== undefined) this.note("info", `queued > /workers ${snippet(goal, 80)} (runs when Synorch is done)`);
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
    if (verb === "web") {
      await this.webDomains(rest);
      return;
    }
    if (verb !== "") {
      this.print(["Usage: /permissions [ask|auto|full|plan] · /permissions allow <prefix> · /permissions remove <prefix> · /permissions web [allow|remove <domain>]"]);
      return;
    }
    this.print(await this.permissionLines());
  }

  /** `/permissions web [allow|remove <domain>]`: the web domains web_fetch reads without asking (K4.1, global user scope). */
  private async webDomains(args: readonly string[]): Promise<void> {
    const web = this.runtime.web;
    const [action = "", domain = ""] = args;
    if (action === "allow" || action === "add") {
      const added = await web.allowDomain(domain);
      if (added) await this.append("network/host_allowed", { host: domain.trim().toLowerCase(), scope: "global" }, "user").catch(() => undefined);
      this.print([added ? `${this.glyphs.ok} Always allowed: ${domain} (every project)` : `${domain} is already allowed or is not a domain name`]);
      return;
    }
    if (action === "remove" || action === "rm") {
      this.print([(await web.removeDomain(domain)) ? `${this.glyphs.ok} Removed: ${domain}` : `${domain} was not among your allowed domains`]);
      return;
    }
    const granted = web.grantedDomains();
    this.print([
      `Web domains     ${granted.length === 0 ? "none of your own yet (answer \"Always allow\" at a fetch prompt, or /permissions web allow <domain>)" : granted.join(` ${this.glyphs.sep} `)}`,
      `Built in        ${DEFAULT_WEB_DOMAINS.length} documentation and registry sites (github.com, docs.python.org, …)`,
    ]);
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
      `Web             search free except in ask mode; fetch asks at a new domain (auto/plan) ${g.sep} your domains: ${runtime.web.grantedDomains().length === 0 ? "none" : runtime.web.grantedDomains().join(", ")} ${g.sep} /permissions web`,
      `Always asks     destructive commands (force push, publish, recursive delete, reset --hard…), in every mode`,
      `Never           ${HARD_RAILS.filter((rail) => rail !== "destructive-command").join(", ")} (hard rails, every mode); git history changes stay with you`,
    ];
  }

  public async trust(): Promise<void> {
    this.trustAsked = true;
    if (this.runtime.trust.state().trusted || this.runtime.sandbox.enforcement === "full") this.print(["This folder is already trusted."]);
    else if (await promptTrustForCommand(this.runtime, this.renderer, "build and test commands", this.outer.signal)) this.policyCache = undefined;
  }

  /** Tiers whose route the conversation may use (a rule without a role, or one narrowed to `session`). */
  private sessionRules(): RouteRule[] {
    return this.runtime.routeRules().filter((rule) => rule.role === undefined || rule.role === "session");
  }

  private authLabel(rule: RouteRule): string {
    const method = this.runtime.adapters.find((adapter) => adapter.adapterId === rule.route.adapter_id)?.authMethod;
    return method === "oauth-subscription" ? "oauth" : method === "cli-bridge" ? "cli" : method === "api-key" ? "api-key" : "unknown";
  }

  public async model(argument: string): Promise<void> {
    // K1.5: every logged-in provider's models, per-tier session routes and --save (cli/model-picker.ts).
    await runModelCommand(
      {
        runtime: this.runtime,
        controls: this.renderer.controls,
        signal: this.outer.signal,
        ok: this.glyphs.ok,
        sep: this.glyphs.sep,
        conversationTier: () => this.sessionTier,
        print: (lines) => this.print(lines),
        ask: (question, options) => this.askUser(question, options, this.outer.signal),
        switchConversation: (tier, save) => this.switchModel(tier, save),
        showFailure: (error) => this.showFailure(failureInfo(error)),
        pickEffort: async (tier) => {
          const host = this.effortHost();
          const target = effortTarget(host, tier === "session" || tier === this.sessionTier ? undefined : tier);
          if (!("error" in target)) await pickEffort(host, target);
        },
      },
      argument,
    );
  }

  public async effort(argument: string): Promise<void> {
    await runEffortCommand(this.effortHost(), argument);
  }

  /** K3 `/mcp [list | tools [name] | reconnect | enable | disable | approve | revoke <name>]`. */
  public async mcp(argument: string): Promise<void> {
    await runMcpSlash({ manager: this.runtime.mcp, home: this.runtime.home, sep: this.glyphs.sep, print: (lines) => this.print(lines) }, argument);
  }

  /** K3: session start of the MCP servers; approvals the repository needs and start failures become notes. */
  private async startMcp(): Promise<void> {
    const mcp = this.runtime.mcp;
    for (const problem of mcp.problems) this.note("warning", `MCP ${problem.file}: ${problem.message}`);
    const pending = mcp.pendingApprovals().map((definition) => definition.name);
    if (pending.length > 0) {
      this.note("info", `This repository declares MCP server${pending.length === 1 ? "" : "s"} ${pending.join(", ")}; ${pending.length === 1 ? "it stays" : "they stay"} off until you approve: /mcp approve <name>`);
    }
    await mcp.startSession().catch(() => undefined);
    if (this.exiting) return;
    for (const entry of mcp.status()) {
      if (entry.state === "failed") this.note("warning", `MCP ${entry.name} did not start: ${entry.error ?? "unknown error"} ${this.glyphs.sep} /mcp reconnect ${entry.name}`);
    }
  }

  private effortHost(): EffortCommandHost {
    return {
      runtime: this.runtime,
      controls: this.renderer.controls,
      signal: this.outer.signal,
      ok: this.glyphs.ok,
      sep: this.glyphs.sep,
      conversationRule: () => sessionRouteRule(this.runtime, this.sessionTier),
      print: (lines) => this.print(lines),
      showFailure: (error) => this.showFailure(failureInfo(error)),
      refreshStatus: () => this.refreshStatus(),
    };
  }

  /** K3: the footer's model and effort from live state (after start, /model, /effort). */
  private refreshStatus(): void {
    const controls = this.renderer.controls;
    const rule = sessionRouteRule(this.runtime, this.sessionTier);
    if (controls?.setSessionStatus === undefined || rule === undefined) return;
    const resolution = this.runtime.effortFor(rule.tier, "session", rule.route);
    const effort = effortLabel(resolution, rule.route.adapter_id);
    controls.setSessionStatus({ model: rule.route.model_id, effort: effort === "default" || effort === "n/a" ? undefined : effort });
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
    this.refreshStatus();
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
    const rules = runtime.routeRules();
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

  /** `/ps [kill <handle|all>]`: background processes of this session (conversation and workers). */
  public async ps(argument: string): Promise<void> {
    const processes = this.runtime.processes;
    const [verb, target] = argument.trim().split(/\s+/);
    if (verb === "kill" || verb === "stop") {
      if (target === undefined || target === "all") {
        const count = await processes.killAll();
        this.print([count === 0 ? "No background process is running." : `Stopped ${count} background process${count === 1 ? "" : "es"}.`]);
        return;
      }
      const stopped = await processes.kill(target);
      this.print([stopped === undefined ? `No background process ${target}; /ps lists them.` : `Stopped ${describeProcess(stopped)}`]);
      return;
    }
    const all = processes.list();
    if (all.length === 0) {
      this.print(["No background processes. The agent starts one with exec {background: true} (dev servers, watchers, long test runs)."]);
      return;
    }
    const g = this.glyphs;
    this.print([
      ...all.map((info) => `${info.state === "running" ? (g.name === "rich" ? "◌" : "o") : info.state === "exited" && info.exitCode === 0 ? g.ok : g.fail} ${describeProcess(info)}${info.owner === "session" ? "" : ` ${g.sep} worker`}`),
      `/ps kill <handle|all> stops them ${g.sep} all are stopped when the session ends`,
    ]);
  }

  /** Background process lifecycle in the view: live row status and a note when one ends by itself. */
  private watchProcesses(): () => void {
    const processes = this.runtime.processes;
    const unbindStatus = bindBackgroundStatus((handle) => {
      const info = processes.get(handle);
      if (info === undefined) return undefined;
      const ended = info.state === "running" ? undefined : info.state === "exited" ? `exited ${info.exitCode ?? info.signal ?? "?"}` : info.state === "killed" ? "stopped" : info.state === "timeout" ? "timed out" : "failed to start";
      return { running: info.state === "running", startedAt: info.startedAt, endedAt: info.endedAt, ended };
    });
    const unsubscribe = processes.onChange((info, change) => {
      if (change !== "ended" || info.state === "killed" || this.exiting) return;
      const failed = info.state !== "exited" || info.exitCode !== 0;
      this.note(failed ? "warning" : "info", `${failed ? this.glyphs.warn : this.glyphs.ok} background ${describeProcess(info)}`);
    });
    const onExit = (): void => {
      processes.killAllSync();
      this.runtime.mcp.killAllSync();
    };
    process.once("exit", onExit);
    return () => {
      unbindStatus();
      unsubscribe();
      process.removeListener("exit", onExit);
    };
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

  /** The conversation's worker runs (this process, or recorded in orchestrate results when resumed), oldest first. */
  private async orchestrationRuns(): Promise<{ readonly sessionId: string; readonly events: readonly SessionEvent[] }[]> {
    const ids = new Set<string>(this.orchestratedSessions);
    for (const event of await this.readEvents()) {
      if (event.type !== "message/recorded" || event.data.role !== "tool" || event.data.message === undefined) continue;
      for (const part of event.data.message.content) {
        if (part.type !== "tool_result") continue;
        for (const match of part.text.matchAll(ORCHESTRATION_SESSION)) if (match[1] !== undefined) ids.add(match[1]);
      }
    }
    const runs: { sessionId: string; events: SessionEvent[] }[] = [];
    for (const id of ids) {
      try {
        const reader = await this.runtime.sessions.openForRead(id as SessionId);
        const events: SessionEvent[] = [];
        for await (const item of reader.read()) if (item.status === "ok") events.push(item.event);
        runs.push({ sessionId: id, events });
      } catch {
        continue;
      }
    }
    return runs.sort((left, right) => (left.events[0]?.timestamp ?? "").localeCompare(right.events[0]?.timestamp ?? ""));
  }

  /** K2 `/evidence [turn | <n>]` (UX-04): the last turn or worker run, criterion by criterion, from the log only. */
  public async evidence(argument = ""): Promise<void> {
    const view = await buildEvidence({ blobs: this.runtime.blobs, conversation: await this.readEvents(), runs: await this.orchestrationRuns(), diff: await this.diffView() }, argument);
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

  /** K2 `/why [last | <n> | <tool> | model]` (X6): mode, layer, rule, who answered, and what would change it. */
  public async why(argument: string): Promise<void> {
    const runtime = this.runtime;
    const mode = runtime.permissionMode();
    const recorded = runtime.trust.recorded();
    const trusted = runtime.sandbox.enforcement === "full" ? "not needed (full sandbox)" : recorded.trusted ? "trusted" : runtime.trust.state().trusted ? "trusted for this session" : "not trusted (build/test commands ask first; /trust)";
    const result = buildWhy(await this.readEvents(), argument, {
      mode: mode === undefined ? "default-deny (no prompts; headless)" : `${mode}: ${MODE_MEANINGS[mode]}`,
      trust: trusted,
      sandbox: `${runtime.sandbox.backend} (${runtime.sandbox.enforcement})`,
      grants: this.grantList,
      planOn: this.planOn,
      noPermissionMode: mode === undefined,
    });
    if (typeof result === "string") {
      this.print([result]);
      return;
    }
    const views = this.renderer.views;
    if (views !== undefined) {
      views.showView(result);
      return;
    }
    const lines = [`${result.subject} ${this.glyphs.sep} ${result.decision}`];
    for (const reason of result.reasons) lines.push(`  ${reason.layer}: ${reason.message} (${reason.code})`);
    for (const fact of result.facts ?? []) lines.push(`  ${fact.label}: ${fact.text}`);
    for (const entry of result.howToChange) lines.push(`  ${this.glyphs.name === "rich" ? "→" : "->"} ${entry.command}: ${entry.effect}`);
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

  public async init(argument: string): Promise<void> {
    await runInitCommand({ runtime: this.runtime, print: (lines) => this.print(lines), ask: (question, options) => this.askUser(question, options, this.outer.signal) }, argument);
  }

  public async report(name: "context" | "permissions" | "tasks" | "memory" | "diff" | "log", argument: string): Promise<void> {
    switch (name) {
      case "context": {
        // K2 "Why this context?" (UX-07): provenance and token estimate of every block of the last request.
        const events = await this.readEvents();
        const view = await buildContextView(events, this.runtime.blobs, DEFAULT_CONTEXT_WINDOW).catch(() => undefined);
        const views = this.renderer.views;
        if (view !== undefined && views !== undefined) views.showView(view);
        else if (view !== undefined) this.print(view.groups.flatMap((group) => [`${group.title}:`, ...group.items.map((item) => `  ${item.label} ~${item.tokens}${item.detail === undefined ? "" : ` (${item.detail})`}`)]));
        else {
          const profile = this.runtime.profile.current();
          this.print([...contextReport(events), ...(profile === undefined ? [] : ["Project profile (sent with every request):", ...profileSummaryLines(profile).map((line) => `  ${line}`)])]);
        }
        return;
      }
      case "permissions":
        await this.permissions(argument);
        return;
      case "tasks": {
        const events = await this.orchestrationEvents();
        this.print(events.length === 0 ? ["No worker runs in this conversation yet."] : tasksReport(events));
        return;
      }
      case "memory":
        await runMemoryDesk(this.memoryDesk(), argument);
        return;
      case "diff": {
        const view = await this.diffView();
        const views = this.renderer.views;
        if (views !== undefined) views.showView(view);
        else this.print(diffLines(view));
        return;
      }
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

  /**
   * `/diff`: every file Synorch changed in this conversation (undone edits excluded), diffed from
   * the content before Synorch's first edit to the content on disk now, plus files workers integrated.
   */
  private async diffView(): Promise<DiffView> {
    const events = await this.readEvents();
    const restored = new Set(events.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
    const firstBefore = new Map<string, SessionEventOf<"checkpoint/recorded">["data"]["files"][number]["before"]>();
    for (const event of events) {
      if (event.type !== "checkpoint/recorded" || restored.has(event.seq)) continue;
      for (const file of event.data.files) if (!firstBefore.has(file.path)) firstBefore.set(file.path, file.before);
    }
    const files: DiffFileView[] = [];
    for (const [file, before] of firstBefore) {
      const place = this.inside(file);
      const current = place === undefined ? undefined : await readOptional(place.absolute).catch(() => undefined);
      const original = before === null ? undefined : await this.runtime.blobs.get(before.digest).then((bytes) => Buffer.from(bytes)).catch(() => undefined);
      const change = before === null ? "added" : current === undefined ? "deleted" : "modified";
      if ((original !== undefined && original.includes(0)) || (current !== undefined && current.includes(0))) {
        files.push({ path: file, change, added: 0, removed: 0, lines: [], note: "binary file" });
        continue;
      }
      if (before !== null && original === undefined) {
        files.push({ path: file, change, added: 0, removed: 0, lines: [], note: "the content before Synorch's edit is no longer available" });
        continue;
      }
      const diff = lineDiff(original?.toString("utf8") ?? "", current?.toString("utf8") ?? "");
      if (diff.added === 0 && diff.removed === 0) continue;
      files.push({ path: file, change, added: diff.added, removed: diff.removed, lines: diff.lines, ...(diff.tooLarge ? { note: "large change: shown as removed and added lines" } : {}) });
    }
    const runEvents = await this.orchestrationEvents();
    const reviewed = new Set(runEvents.flatMap((event) => (event.type === "review/recorded" && event.data.decision === "accept" ? [event.data.task_id] : [])));
    const integrated = new Map<string, boolean>();
    for (const event of runEvents) if (event.type === "task/integrated") for (const file of event.data.paths) integrated.set(file, (integrated.get(file) ?? false) || reviewed.has(event.data.task_id));
    return { kind: "diff", files, ...(integrated.size === 0 ? {} : { integrated: [...integrated].map(([file, accepted]) => ({ path: file, reviewed: accepted })) }) };
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

  /**
   * `/config` (K1.5-3): the settings screen built on the picker (Enter edits, booleans toggle, enums
   * and routes offer choices, Esc closes); `/config <key>` shows one value, `/config <key> <value>`
   * sets it. Only the user configuration is written; the permission mode and mouse apply at once.
   */
  public async config(argument: string): Promise<void> {
    const [key, ...rest] = argument.split(/\s+/).filter((part) => part !== "");
    const listing = async (): Promise<ConfigListing | undefined> =>
      listSettings(this.runtime.home, this.runtime.workspaceRoot).catch((error: unknown) => {
        this.print([`${this.glyphs.warn} ${failureInfo(error).message}`, "Fix it with syn config edit"]);
        return undefined;
      });
    if (key !== undefined) {
      if (rest.length > 0) {
        await this.applySetting(key, rest.join(" "));
        return;
      }
      try {
        const definition = settingFor(key);
        const row = (await listing())?.rows.find((candidate) => candidate.key === definition.key);
        this.print([`${definition.key} = ${row?.value ?? "(not set)"} (${row?.source ?? "default"}) ${this.glyphs.sep} ${definition.description}`]);
      } catch (error) {
        this.print([failureInfo(error).message]);
      }
      return;
    }
    const controls = this.renderer.controls;
    if (controls === undefined) {
      const current = await listing();
      if (current !== undefined) this.print([...formatListing(current).slice(0, -1), "Change: /config <key> <value> (or syn config set)"]);
      return;
    }
    for (;;) {
      const current = await listing();
      if (current === undefined) return;
      const entries: ModelPickerEntry[] = current.rows.map((row, index) => ({
        id: String(index),
        tier: row.key,
        provider: "",
        model: "",
        label: row.value ?? "(not set)",
        auth: row.source === "workspace" || row.source === "project" ? `${row.source} (narrowed)` : row.source,
        current: false,
        description: row.description,
      }));
      const chosen = await controls
        .openModelPicker(entries, this.outer.signal, { title: "Settings", hint: `Enter changes · Esc closes · saved to ${current.userFile}` })
        .catch(() => undefined);
      const row = chosen === undefined ? undefined : current.rows[Number(chosen.id)];
      if (row === undefined) return;
      const value = await this.pickSettingValue(row, controls);
      if (value !== undefined) await this.applySetting(row.key, value);
    }
  }

  private async pickSettingValue(row: SettingRow, controls: NonNullable<SessionRenderer["controls"]>): Promise<string | undefined> {
    if (row.kind === "boolean") return row.value === "true" ? "false" : "true";
    const unset = "(unset: use the default)";
    let choices: string[] = [];
    const badges = new Map<string, string>();
    if (row.kind === "enum") choices = [...(row.choices ?? [])];
    if (row.kind === "route") {
      // Connected models from the catalog (K1.5-A), then the configured routes; the adapter is spelled out when it is not the provider default.
      const catalog = await this.runtime.modelCatalog(this.outer.signal).catch(() => []);
      for (const model of catalog.filter((candidate) => candidate.connected)) {
        const value = `${model.provider}/${model.model}${model.adapterId === DEFAULT_ADAPTER_FOR_PROVIDER[model.provider] ? "" : `@${model.adapterId}`}`;
        badges.set(value, model.badge);
      }
      for (const rule of this.runtime.config.router.rules) {
        const value = `${rule.route.provider_id}/${rule.route.model_id}${rule.route.adapter_id === DEFAULT_ADAPTER_FOR_PROVIDER[rule.route.provider_id] ? "" : `@${rule.route.adapter_id}`}`;
        if (!badges.has(value)) badges.set(value, "configured");
      }
      choices = [...badges.keys()];
    }
    const typeIt = "Type a value…";
    if (row.kind === "route" || row.kind === "int" || row.kind === "number" || row.kind === "string") choices.push(typeIt);
    choices.push(unset);
    const entries: ModelPickerEntry[] = choices.map((choice, index) => ({ id: String(index), tier: "", provider: "", model: "", label: choice, auth: badges.get(choice) ?? "", current: choice === row.value }));
    const picked = choices.length === 2 && choices[0] === typeIt ? { id: "0" } : await controls.openModelPicker(entries, this.outer.signal, { title: row.key, hint: `${row.description} — Enter selects, Esc cancels` }).catch(() => undefined);
    const choice = picked === undefined ? undefined : choices[Number(picked.id)];
    if (choice === undefined) return undefined;
    if (choice === unset) return UNSET_SETTING;
    if (choice !== typeIt) return choice;
    const hint = row.kind === "route" ? "provider/model[@adapter], e.g. openai/gpt-6-sol" : row.kind === "string" ? "text" : "a positive number";
    const answer = await this.askUser(`New value for ${row.key} (${hint}; empty cancels)`, undefined, this.outer.signal).catch(() => "");
    return answer.trim() === "" ? undefined : answer.trim();
  }

  private async applySetting(key: string, value: string): Promise<void> {
    const g = this.glyphs;
    try {
      const change = value === UNSET_SETTING ? await unsetUserSetting(this.runtime.home, key) : await setUserSetting(this.runtime.home, key, value);
      const shown = change.value ?? "default";
      let effect = "new conversations use it";
      if (change.key === "ui.permission_mode") {
        this.setMode((change.value ?? "auto") as PermissionMode);
        effect = "applied now";
      } else if (change.key === "ui.mouse" && this.renderer.controls !== undefined) {
        this.renderer.controls.setMouseMode(change.value === "true");
        effect = "applied now";
      } else if (change.key.startsWith("routes.")) effect = "new conversations use it; /model switches this one";
      else if (change.key.startsWith("effort.")) {
        // K6: a tier level also applies to this session at once (role levels apply to new sessions).
        const tier = MODEL_TIERS.find((candidate) => `effort.${candidate}` === change.key);
        if (tier !== undefined) {
          this.runtime.setSessionEffort(tier, change.value === undefined || !isReasoningEffort(change.value) ? undefined : change.value);
          this.refreshStatus();
          effect = "applied from the next request";
        }
      }
      this.print([`${g.ok} ${change.key} = ${shown}${change.previous !== undefined && change.previous !== change.value ? ` (was ${change.previous})` : ""} ${g.sep} ${effect}`]);
    } catch (error) {
      this.print([`${g.warn} ${error instanceof Error ? error.message : String(error)}`]);
    }
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

/** `/config` picker choice that removes the key from the user configuration. */
const UNSET_SETTING = "(unset)";

const MODE_MEANINGS: Readonly<Record<PermissionMode, string>> = {
  ask: "asks before every edit and command",
  auto: "edits and commands in this workspace run, workers included; pushes, publishing and destructive commands ask you first",
  full: "no prompts except destructive commands (force push, publish, recursive delete…); hard rails stay",
  plan: "read-only: reads and plans, no edits or commands",
};

/**
 * The last todo list the agent wrote with a todo tool (any tool whose name contains `todo`, with a
 * `todos`/`items` array of `{ content | text | title, status }`), for the resume card (UX-06).
 */
function lastTodo(events: readonly SessionEvent[]): { readonly done: number; readonly total: number; readonly next: string | undefined } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "message/recorded" || event.data.role !== "assistant" || event.data.message === undefined) continue;
    for (const part of [...event.data.message.content].reverse()) {
      if (part.type !== "tool_call" || !/todo/i.test(part.name)) continue;
      const list = Array.isArray(part.arguments.todos) ? part.arguments.todos : Array.isArray(part.arguments.items) ? part.arguments.items : undefined;
      if (list === undefined) continue;
      const items = list.flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as Record<string, unknown>;
        const text = [record.content, record.text, record.title].find((value): value is string => typeof value === "string");
        return text === undefined ? [] : [{ text, done: /^(done|completed|complete)$/i.test(String(record.status ?? "")) }];
      });
      if (items.length === 0) continue;
      return { done: items.filter((item) => item.done).length, total: items.length, next: items.find((item) => !item.done)?.text };
    }
  }
  return undefined;
}

function relativeTime(then: number): string {
  if (!Number.isFinite(then)) return "earlier";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
