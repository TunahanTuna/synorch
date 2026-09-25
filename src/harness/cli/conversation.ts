import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
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
  EFFORT_SLOTS,
  HARD_RAILS,
  WORKSPACE_UNTRUSTED_CODE,
  workspaceDigest,
  type AgentDriver,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type AuthMethodKind,
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
  type PanelPage,
  type ToolCallRequest,
  type ToolExecutionContext,
  type ToolGateway,
  type ToolResult,
  type TurnId,
  type WelcomePreferences,
} from "../contracts/index.ts";
import type { DiffFileView, DiffView, OrchestrationTaskView, WorkerControl, WorkerSeam } from "../contracts/views.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import { createCompactor, DEFAULT_CONTEXT_WINDOW, extractiveSummarizer, messageTokens, reconstructHistory } from "../context/index.ts";
import {
  actionableFindings,
  artifactReviewGoal,
  fixFollowUpMessage,
  isGeneratedPath,
  parseReviewArgument,
  renderArtifactReviewBrief,
  renderReviewCard,
  WorkerStreamHub,
  type ArtifactReviewRequest,
  type ArtifactReviewResult,
  type OrchestrationCoordinator,
  type PinnedReviewArtifact,
  type WorkerControlResult,
  type WorkerDirectory,
} from "../orchestration/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, evaluateExecAllowlist } from "../policy/index.ts";
import { BUILTIN_THEMES, bindBackgroundStatus, defaultThemeName, describeEvent, formatHarnessError, GLYPH_SETS, lineDiff, patchPaths, pickHint, quotaProviderLabel, runPrompts, selectGlyphs, shortenPath, suggestedCommandPrefix, type GlyphSet } from "../tui/index.ts";
import { buildCommit, loadAppearance, planLabel, subscriptionPlan, userHome, workerModels } from "./appearance.ts";
import { DEFAULT_WEB_DOMAINS, describeProcess } from "../tools/index.ts";
import type { ParsedCommand } from "./args.ts";
import { ATTACHMENTS_OPEN, mayContainImage, resolveAttachments } from "./attachments.ts";
import { askHookApproval, runPluginsSlash, runSkillsSlash, type ExtensionSlashHost } from "./extensions-command.ts";
import type { HookEvent, HookOutcome } from "./extensions/index.ts";

/** Adapters that turn `image` message parts into provider image input. */
const IMAGE_ADAPTERS: ReadonlySet<string> = new Set(["openai-chatgpt", "openai-responses", "anthropic-messages", "claude-code"]);
import { profileHintsFor } from "./canonical.ts";
import { createCommandGrantStore, normalizeGrant, type CommandGrantStore } from "./command-grants.ts";
import { formatListing, listSettings, setUserSetting, settingFor, unsetUserSetting, type ConfigListing, type SettingRow } from "./config-command.ts";
import { DEFAULT_ADAPTER_FOR_PROVIDER } from "./config.ts";
import type { OrchestrateInput, RunCancelInput, RunStatusInput, RunSteerInput } from "./orchestrate-tool.ts";
import { OrchestrationTracker } from "./orchestration-view.ts";
import { applyRestore, planRestore, restoreConflicts, rewindPoints, type RestoreIO } from "./rewind.ts";
import { runModelCommand } from "./model-picker.ts";
import { effortLabel, effortTarget, pickEffort, runEffortCommand, type EffortCommandHost } from "./effort-command.ts";
import { runMcpSlash } from "./mcp-command.ts";
import { mcpPanel, type McpPanelHost } from "./panels/mcp.ts";
import { pluginsPanel } from "./panels/plugins.ts";
import { cardPanel, configPanel, helpPanel, memoryPanel, resumePanel, runsPanel, statusPanel } from "./panels/session.ts";
import { skillsPanel } from "./panels/skills.ts";
import { defaultEffort, isReasoningEffort } from "../providers/index.ts";
import { openBrowser } from "../tui/open-browser.ts";
import { acknowledgedNotices, acknowledgeNotice, approvalNotice, mcpStartNotices, StartupNotices } from "./startup-notices.ts";
import { failureInfo } from "./outcome.ts";
import { connectProvider, MANUAL_CONNECT_COMMANDS, signIn, type ConnectHost } from "./first-run-connect.ts";
import { createSessionRenderer, type SessionRenderer } from "./renderers.ts";
import { createRuntime, type Runtime, type RuntimeOverrides } from "./runtime.ts";
import type { SessionIO } from "./session.ts";
import { changePathspecs, commitAll, commitSelected, commitsSince, reviewDiff, uncommittedChanges, type ChangeSummary, type ReviewDiffTarget } from "./session-git.ts";
import {
  CONVERSATION_COMMANDS,
  contextReport,
  conversationHelp,
  conversationPaletteEntries,
  findConversationCommand,
  reservedCommandNames,
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
 * step boundary; Esc interrupts; plan mode (`/plan`, Shift+Tab) narrows the policy to reading; the
 * `orchestrate` tool runs the existing coordinator and projects a live worker board. K3 (UX-GATE-02):
 * interactive runs go to the background (chat stays open, completion note + follow-up turn,
 * `run_status` / `run_steer` / `run_cancel`, `/runs`, owned paths locked for the agent's edits,
 * worker prompts wait for a typing pause); headless and `wait: true` runs hold the turn as before
 * (typed messages steer the coordinator, Esc twice stops it). One command registry
 * (`slash-commands.ts`) feeds `/help` and the renderer's palette; usage is aggregated for `/usage`,
 * `/cost` and the footer; `@path` and renderer attachments are inlined; resume shows where the
 * conversation was and what changed since.
 */

type AgentCommand = Extract<ParsedCommand, { kind: "agent" }>;
type ChangedFile = ChangeSummary["files"][number];

const MAX_STEPS = 50;
/** K7: consecutive turns a Stop hook may add before Synorch stops asking it. */
const MAX_STOP_CONTINUATIONS = 3;
const CONVERSATION_TITLE = "chat: ";
const WRITE_TOOLS = new Set(["apply_patch", "write_file"]);
const REPLAY_EXCHANGES = 3;
const REVIEW_DIFF_LIMIT = 48 * 1024;
const ESC_ARM_MS = 3_000;
const GO_WORDS = /^(go|go ahead|do it|proceed|yes|ok|okay|ship it|start|evet|başla|basla|yap|devam|tamam)[.! ]*$/iu;
const SESSION_MODEL_FILE = "session-model.json";
const ORCHESTRATION_SESSION = /session (ses_[0-9A-HJKMNP-TV-Z]{26})/g;
/** K3: a worker prompt waits until the user has not typed for this long. */
const TYPING_PAUSE_MS = 1_200;
/** K3: how long a cancelled run gets to stop its workers and clean up at exit. */
const SETTLE_MS = 15_000;

function toolError(code: "execution_failed" | "cancelled" | "policy_denied", message: string, text = ""): ToolResult {
  return { status: "error", text: text.slice(0, 16 * 1024), truncated: false, redactions: 0, error: { code, message: message.slice(0, 2000) } };
}

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
/** Whether `root` lies in a git work tree (a `.git` entry here or in a parent). */
function insideGitRepository(root: string): boolean {
  for (let directory = path.resolve(root); ; ) {
    if (existsSync(path.join(directory, ".git"))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

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
    message: `no model is connected for the conversation: run ${MANUAL_CONNECT_COMMANDS} (or start syn in an interactive terminal to sign in there; --profile session=<provider>/<model> sets one for a single run)${hints.length === 0 ? "" : `; the canonical model profiles suggest ${hints.join(" or ")}`}`,
    workspace_effect: "none",
    retry_safe: true,
    next_command: "syn login openai && syn config set routes.session openai/gpt-6-sol",
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

/**
 * K3: the session policy with workspace writes denied, for one edit that touches a path a live task
 * of a background run owns. The gateway records the denial like any other; the conversation words it.
 */
export function runLockPolicy(base: EffectivePolicy): EffectivePolicy {
  return effectivePolicySchema.parse({
    ...base,
    effects: { ...base.effects, "workspace-write": "deny" },
    layers: [...base.layers, { layer: "task", source: "background-run-owned-path", digest: digestOf({ background_run_lock: true }) }],
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

/**
 * One worker run of this conversation (K3). `foreground` runs keep the agent's turn open until they
 * end (headless, or `orchestrate {wait: true}`): typed messages steer the coordinator and Esc twice
 * stops them. Background runs return the tool at once; the conversation stays free and the result
 * reaches the agent as a completion note (a follow-up turn when the session is idle).
 */
interface ActiveOrchestration {
  /** Short handle shown to the user and the agent (`run-1`); the coordinator's run id also resolves. */
  readonly id: string;
  readonly goal: string;
  readonly tracker: OrchestrationTracker;
  readonly coordinator: OrchestrationCoordinator;
  readonly controller: AbortController;
  disarm: NodeJS.Timeout | undefined;
  foreground: boolean;
  status: "running" | "succeeded" | "failed" | "cancelled" | "rejected";
  /** Settles with the tool result (the result block) when the run ends; never rejects. */
  done: Promise<ToolResult>;
  result: ToolResult | undefined;
  /** The completion note queued for the agent (removed again when the agent read the result itself). */
  notice: string | undefined;
  /** `review`: a `/review` run (ADR-09 reviewer attempt); it never becomes `this.orchestration` and cannot be steered. */
  kind?: "review";
}

interface QueuedMessage {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  /** K7: a skill / command invocation, sent as is (no @path resolution). */
  readonly verbatim?: boolean;
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
  private recoveryNotes: string[] = [];
  private readonly queued: QueuedMessage[] = [];
  private runtime!: Runtime;
  private renderer!: SessionRenderer;
  private usageLedger: UsageLedger | undefined;
  private glyphs: GlyphSet = GLYPH_SETS.ascii;
  private grants: CommandGrantStore | undefined;
  private grantList: readonly string[] = [];
  private routePromise: Promise<RouteDecision> | undefined;
  private routeRecorded = false;
  /** The current turn's model request failed for want of a signed-in identity (a sign-in is offered after it). */
  private authFailure = false;
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
  /** K3: every worker run of this process, oldest first (`/runs`, `run_status`). */
  private readonly workerRuns: ActiveOrchestration[] = [];
  /** K3: background completions the agent has not been told about yet (a follow-up turn reports them when idle). */
  private unreportedRuns = 0;
  /** K3: aborted to wake the idle loop (a background run finished). */
  private wakeIdle = new AbortController();
  /** K3: prompts (approvals, questions) are shown one at a time while a background run is active. */
  private promptQueue: Promise<void> = Promise.resolve();
  /** The mode to return to when plan mode ends (Shift+Tab, /go, a go-word). */
  private modeBeforePlan: PermissionMode | undefined;
  /** Set while the current exec call follows a declined trust question: its prompt is answered "no" for the user. */
  private trustDeclinedNow = false;
  private sessionBroker: ApprovalBroker | undefined;
  private startedAt = Date.now();
  private lastTracker: OrchestrationTracker | undefined;
  /** The last `/review` result of this process (`/review fix`). */
  private lastReview: ArtifactReviewResult | undefined;
  private turnId: TurnId | undefined;
  private trustAsked = false;
  private exiting = false;
  /** Startup notices: held until the first-run setup is done, then at most two lines (/status keeps them all). */
  private notices: StartupNotices | undefined;
  private mcpStarted: Promise<void> = Promise.resolve();
  private debug = false;
  private submittedAt: number | undefined;
  private sessionStartHooked = false;
  private stopContinuations = 0;
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
    // K8: theme, colour depth and welcome header of the interactive view (plain and JSONL keep their own).
    const appearance = runtime !== undefined && settings.kind === "tui" ? await loadAppearance(runtime.home, runtime.config, io.env, io.platform).catch(() => undefined) : undefined;
    this.renderer = await createSessionRenderer(io, {
      kind: settings.kind === "jsonl" ? "plain" : settings.kind,
      color: settings.color,
      policyMode: this.parsed.session.policy,
      streamDeltas: false,
      wantsInput: true,
      interactive: io.stdinIsTTY,
      onInterrupt: () => this.interrupt(),
      onExit: () => {
        // K3: with workers in the background the exit request reaches the input loop, which asks first.
        if (this.backgroundRun() !== undefined) return;
        this.hardExit();
      },
      view: "conversation",
      glyphs: this.glyphs,
      debug: this.debug,
      ...(runtime?.config.mouse === undefined ? {} : { mouse: runtime.config.mouse }),
      ...(appearance === undefined ? {} : { appearance: { theme: appearance.theme, themes: appearance.themes, colorDepth: appearance.colorDepth, welcome: appearance.welcome } }),
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
    let rule = sessionRouteRule(runtime, this.sessionTier);
    // First run without a route: an interactive terminal connects a provider after the view starts; headless fails with the commands.
    if (rule === undefined && !this.canConnect()) return this.fail(failureInfo(missingRoute(runtime)));
    if (rule !== undefined) this.adoptRule(rule);

    const ledger = new UsageLedger(runtime.home);
    this.usageLedger = ledger;
    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind === "session-event") ledger.observe(event.event);
      this.hub.feed(event);
      this.forward(event);
    });
    const unbind = io.stdinIsTTY && this.renderer.input !== undefined ? runtime.bindUserPrompt(
            (question, options, signal) => this.gated(signal, () => this.askUser(question, options, signal)),
            (question, signal) => this.gated(signal, () => this.chooseForAgent(question, signal)),
          ) : () => undefined;
    runtime.orchestrate.set((input, context) => this.runOrchestration(input, context));
    runtime.orchestrate.setControl({
      status: (input, context) => this.runStatus(input, context.signal),
      steer: async (input) => this.runSteer(input),
      cancel: async (input) => this.runCancel(input),
    });
    let unbindControls: () => void = () => undefined;
    const unwatchProcesses = this.watchProcesses();
    this.startedAt = Date.now();
    try {
      this.grants = createCommandGrantStore(runtime.home, runtime.trust.state().root);
      this.grantList = await this.grants.list();
      const resumed = await this.openResumed();
      const sandboxNoticeSeen = runtime.sandbox.enforcement === "full" || (await acknowledgedNotices(runtime.home)).has("sandbox-partial");
      this.notices = new StartupNotices((notice) => this.note(notice.level, notice.text), this.glyphs.sep);
      const hint = await this.welcomeHint(resumed !== undefined);
      await this.renderer.start({ ...(rule === undefined ? this.unconnectedHeader(hint) : this.header(rule, hint)), sandboxNoticeSeen });
      // The partial-sandbox warning shows once per machine; /permissions keeps it.
      if (!sandboxNoticeSeen && this.renderer.controls?.appearance !== undefined) void acknowledgeNotice(runtime.home, "sandbox-partial");
      if (rule === undefined) {
        const connected = await connectProvider(this.connectHost());
        rule = connected === undefined ? undefined : sessionRouteRule(runtime, "session");
        if (rule === undefined) {
          this.note("info", `No provider connected ${this.glyphs.sep} to set one up by hand: ${MANUAL_CONNECT_COMMANDS}`);
          await this.renderer.stop("completed");
          return EXIT_CODES.success;
        }
        this.adoptRule(rule);
        const view = this.header(rule).welcome;
        this.renderer.controls?.appearance?.updateWelcome({ model: rule.route.model_id, ...(view?.effort === undefined ? {} : { effort: view.effort }), ...(view?.plan === undefined ? {} : { plan: view.plan }) });
      }
      const controls = this.renderer.controls;
      this.refreshPalette();
      this.refreshStatus();
      // K3: MCP servers start in the background (never before the editor); problems become notes.
      this.mcpStarted = this.startMcp().catch(() => undefined);
      // Shift+Tab / Alt+M in the renderer cycles the permission mode; the session applies the policy.
      unbindControls = controls?.onPermissionModeChange((mode) => this.setMode(mode)) ?? (() => undefined);
      if (runtime.permissionMode() === "full") this.note("error", this.fullAccessNotice());
      if (resumed !== undefined) await this.showResumed(resumed);
      else await this.memoryStartLine();
      // Zero-config onboarding: the quiet "Synorch ready · …" line, the memory vault and the first-session memory bootstrap (user scope only).
      void startOnboarding(runtime, (line) => this.startupLine({ level: "info", text: line, context: true }), this.glyphs.sep);
      if (this.debug) this.note("info", `harness: runtime ready in ${runtimeMs} ms`);
      for (const problem of appearance?.problems ?? []) this.startupLine({ level: "warning", text: `${this.glyphs.warn} ${problem}` });
      // K8: the subscription's plan label (ChatGPT Plus) resolves from the stored login after the first frame.
      void subscriptionPlan(runtime, rule.route, this.outer.signal)
        .then((plan) => {
          if (plan !== undefined) this.renderer.controls?.appearance?.updateWelcome({ plan });
        })
        .catch(() => undefined);
      // K8 first-run setup (interactive terminal only, once; Esc skips) or syn setup.
      if (this.parsed.setup === true || (resumed === undefined && this.shouldOnboard())) await this.setup(true);
      // Notices after welcome and setup; MCP servers get a moment to settle so their lines join the same group.
      if (this.renderer.controls?.appearance === undefined) this.notices?.flush();
      else void Promise.race([this.mcpStarted, delay(1500)]).then(() => this.notices?.flush());
      // Credential pre-resolution (keychain, token refresh) happens in the background, never before the editor.
      void this.routePromise?.then((decision) => runtime.credentials(decision.route, this.outer.signal)).catch(() => undefined);
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
      // K3: a worker run never outlives the session either: it is cancelled and given time to clean up its worktrees.
      await this.settleRuns();
      await runtime.processes.killAll().catch(() => undefined);
      await runtime.mcp.close().catch(() => undefined);
      unwatchProcesses();
      unbindControls();
      runtime.orchestrate.set(undefined);
      runtime.orchestrate.setControl(undefined);
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

  /** A human at a terminal who can pick and sign in to a provider (first run, or a turn that needs sign-in). */
  private canConnect(): boolean {
    return this.io.stdinIsTTY && this.renderer.input !== undefined && this.renderer.auth.interactive;
  }

  private adoptRule(rule: RouteRule): void {
    this.sessionTier = rule.tier;
    this.currentModel = rule.route.model_id;
    // Resolving the route may probe the provider's capabilities: it runs while the user types.
    this.routePromise = this.runtime.router.resolve({ tier: rule.tier, role: "session" }, this.outer.signal);
    this.routePromise.catch(() => undefined);
    this.routeRecorded = false;
  }

  /** The welcome before a provider is connected (first run). */
  private unconnectedHeader(hint?: string): SessionHeaderView {
    const runtime = this.runtime;
    const permissionMode = runtime.permissionMode();
    const commit = buildCommit();
    return {
      welcome: { ...(commit === undefined ? {} : { commit }), path: shortenPath(runtime.workspaceRoot, userHome(this.io.env)), ...(hint === undefined ? {} : { hint }) },
      workspaceRoot: runtime.workspaceRoot,
      gitBranch: runtime.gitBranch,
      policyMode: runtime.policyMode,
      routes: [],
      sandboxEnforcement: runtime.sandbox.enforcement,
      notices: [...runtime.config.warnings.map((warning) => warning.message), ...runtime.canonical.diagnostics.map((diagnostic) => `canonical .ai: ${diagnostic}`)],
      version: SYNORCH_VERSION,
      model: "not connected",
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
      ...(permissionMode === undefined ? {} : { permissionMode }),
    };
  }

  private connectHost(): ConnectHost {
    return {
      runtime: this.runtime,
      renderer: this.renderer,
      overrides: this.overrides,
      env: this.io.env,
      cwd: this.runtime.workspaceRoot,
      signal: this.outer.signal,
      ok: this.glyphs.ok,
      sep: this.glyphs.sep,
      choose: (question, signal) => this.choose(question, signal),
      print: (lines) => this.print(lines),
      warn: (line) => this.note("warning", line),
    };
  }

  /** A turn failed because the route's identity is not signed in: offer the sign-in here, then the message can be sent again. */
  private async offerSignIn(provider: string, method: AuthMethodKind, typed: string): Promise<void> {
    const label = method === "oauth-subscription" ? "ChatGPT" : method === "cli-bridge" ? "Claude Code" : `${provider === "openai" ? "OpenAI" : "Anthropic"} API key`;
    const answer = await this.choose(
      { question: `Sign in to ${label} now?`, header: "Sign in", options: [{ label: "Sign in", recommended: true }, { label: "Not now" }], allowOther: false, escapeLabel: "not now", tone: "neutral" },
      this.outer.signal,
    ).catch(() => undefined);
    if (answer?.kind !== "selected" || answer.indices[0] !== 0) return;
    if (!(await signIn(this.connectHost(), provider, method))) return;
    const rule = sessionRouteRule(this.runtime, this.sessionTier);
    if (rule !== undefined) this.adoptRule(rule);
    const controls = this.renderer.controls;
    if (typed.trim() !== "" && controls?.setEditorText !== undefined) {
      controls.setEditorText(typed);
      this.print([`${this.glyphs.ok} Signed in ${this.glyphs.sep} press Enter to send your message again`]);
    } else this.print([`${this.glyphs.ok} Signed in ${this.glyphs.sep} send your message again`]);
  }

  private header(rule: RouteRule, hint?: string): SessionHeaderView {
    const permissionMode = this.runtime.permissionMode();
    const runtime = this.runtime;
    const configured = effortLabel(runtime.effortFor(rule.tier, "session", rule.route), rule.route.adapter_id);
    // Nothing set: the welcome shows the level the model runs at by default (K6), not a blank.
    const effort = configured === "default" ? (defaultEffort({ provider: rule.route.provider_id, model: rule.route.model_id, adapterId: rule.route.adapter_id }) ?? configured) : configured;
    const commit = buildCommit();
    const plan = planLabel(runtime, rule.route);
    const workers = workerModels(runtime, rule.tier, rule.route.model_id);
    return {
      welcome: {
        ...(commit === undefined ? {} : { commit }),
        ...(effort === "default" || effort === "n/a" ? {} : { effort }),
        ...(plan === undefined ? {} : { plan }),
        ...(workers.length === 0 ? {} : { workers }),
        path: shortenPath(runtime.workspaceRoot, userHome(this.io.env)),
        ...(hint === undefined ? {} : { hint }),
      },
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

  /**
   * Layered panels: in the TUI a report command opens its panel (resolves true once it is closed);
   * plain and JSONL modes, or a renderer without panels, get false and print the text report.
   */
  private async showPanel(build: () => PanelPage | Promise<PanelPage>): Promise<boolean> {
    const controls = this.renderer.controls;
    if (this.renderer.kind !== "tui" || controls?.openPanel === undefined) return false;
    const page = await build();
    await controls.openPanel(page, this.outer.signal);
    return true;
  }

  /** `/help`: the command browser in the TUI, the list otherwise. */
  public async help(): Promise<void> {
    const invocable = this.runtime.extensions.invocable(reservedCommandNames()).map((entry) => ({ name: entry.name, description: entry.meta.description, argsHint: entry.meta.argumentHint, source: entry.source }));
    const keys = conversationHelp().at(-1) ?? "";
    if (await this.showPanel(() => helpPanel(CONVERSATION_COMMANDS, invocable, keys, this.glyphs.sep))) return;
    this.print(conversationHelp());
  }

  /** Only this conversation's events and model streams reach the view; worker and coordinator traffic feeds the board instead. */
  private forward(event: RenderEvent): void {
    if (event.kind === "session-event") {
      const recorded = event.event;
      const orchestration = this.orchestration;
      // Worker, reviewer and planner requests of this process count toward the footer's quota %, cost
      // and activity tokens: their provider/usage events (with `x-codex-*` quota) reach the view too.
      if (recorded.session_id !== this.sessionId && recorded.type === "provider/usage" && this.renderer.kind !== "jsonl") this.renderer.render(event);
      // `/review` runs feed their own trackers (`/runs`, `/evidence`); they never touch the board.
      if (recorded.session_id !== this.sessionId) {
        for (const run of this.workerRuns) {
          if (run.kind !== "review" || run.status !== "running") continue;
          const before = run.tracker.sessionId;
          if (run.tracker.observe(recorded) && before === undefined && run.tracker.sessionId !== undefined && !this.orchestratedSessions.includes(run.tracker.sessionId)) this.orchestratedSessions.push(run.tracker.sessionId);
        }
      }
      if (orchestration !== undefined && recorded.session_id !== this.sessionId) {
        this.workerLine(recorded);
        this.observeOrchestration(orchestration, recorded);
        return;
      }
      if (recorded.session_id !== this.sessionId) return;
      if (recorded.type === "model/response_failed" && AUTH_FAILURES.has(recorded.data.error.code)) this.authFailure = true;
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

  private async conversations(): Promise<{ readonly sessionId: SessionId; readonly title: string; readonly at: string; readonly parentTitle: string | undefined; readonly forked: boolean }[]> {
    const summaries = await this.runtime.sessions.list(this.runtime.projectId);
    const titles = new Map(summaries.map((summary) => [summary.manifest.session_id, (summary.manifest.title ?? "").replace(CONVERSATION_TITLE, "")]));
    return summaries
      .filter((summary) => summary.manifest.title?.startsWith(CONVERSATION_TITLE) === true && !summary.locked)
      .sort((left, right) => (right.lastEventAt ?? right.manifest.created_at).localeCompare(left.lastEventAt ?? left.manifest.created_at))
      .map((summary) => ({
        sessionId: summary.manifest.session_id,
        title: (summary.manifest.title ?? "").slice(CONVERSATION_TITLE.length),
        at: summary.lastEventAt ?? summary.manifest.created_at,
        forked: summary.manifest.parent !== undefined,
        parentTitle: summary.manifest.parent === undefined ? undefined : titles.get(summary.manifest.parent.session_id),
      }));
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
    // Crash recovery (I1 AC-4): what was closed is shown with the resume card; a clean resume stays quiet.
    this.recoveryNotes = (await this.runtime.recover(sessionId))
      .filter((report) => report.recovered.length + report.interruptedToolCalls.length + report.cancelledToolCalls.length > 0 || report.tornTail !== undefined)
      .map(
        (report) =>
          `recovered ${report.sessionId}: ${report.recovered.length} open item(s) closed, ${report.interruptedToolCalls.length} tool call(s) interrupted with unknown outcome (not re-run), ${report.cancelledToolCalls.length} cancelled` +
          (report.tornTail === undefined ? "" : `, torn tail of ${report.tornTail.bytes} bytes quarantined`),
      );
    this.log = await this.runtime.sessions.openForWrite(sessionId);
    this.driver = undefined;
    const events: SessionEvent[] = [];
    for await (const item of this.log.read()) if (item.status === "ok") events.push(item.event);
    this.routeRecorded = false;
    return events;
  }

  /** The resume card (UX-06): the replayed tail, then where we were, what changed since, and the next step. */
  private async showResumed(all: readonly SessionEvent[]): Promise<void> {
    const g = this.glyphs;
    // A `syn run` session: the planner's prompts are not the person's messages; the goal stands in for them.
    const run = runPrompts(all);
    const events = run.hidden.size === 0 ? all : all.filter((event) => !run.hidden.has(event));
    const users = events.flatMap((event, index) => (event.type === "message/recorded" && event.data.role === "user" ? [index] : []));
    const last = events.at(-1);
    const ago = last === undefined ? "" : ` ${g.sep} ${relativeTime(Date.parse(last.timestamp))}`;
    const firstShown = users.length > REPLAY_EXCHANGES ? (users[users.length - REPLAY_EXCHANGES] ?? 0) : 0;
    const folded = users.length > REPLAY_EXCHANGES ? users.length - REPLAY_EXCHANGES : 0;
    this.note("info", `${g.resume} Resumed${ago} ${g.sep} ${users.length} message${users.length === 1 ? "" : "s"}${folded === 0 ? "" : ` ${g.sep} ${folded} earlier not shown`}`);
    if (run.goal !== undefined) this.note("info", `  run: ${snippet(run.goal, 160)}`);
    this.renderer.replay?.(events.slice(firstShown));
    for (const line of this.recoveryNotes.splice(0)) this.note("info", line);
    for (const line of await this.continuity(events, run.goal)) this.note("info", line);
  }

  private async continuity(events: readonly SessionEvent[], runGoal?: string): Promise<string[]> {
    const texts = (role: "user" | "assistant"): string[] =>
      events.flatMap((event) => {
        if (event.type !== "message/recorded" || event.data.role !== role || event.data.message === undefined) return [];
        const text = event.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
        return text.trim() === "" ? [] : [text.replace(/^\[Synorch note:[^\]]*\]\s*/u, "").split("<synorch-attachments>")[0] ?? ""];
      });
    const lastUser = texts("user").at(-1);
    const lastAnswer = texts("assistant").at(-1);
    const where = lastUser === undefined ? (runGoal === undefined ? "nothing asked yet" : `run "${snippet(runGoal, 70)}"${lastAnswer === undefined ? "" : ` → ${snippet(lastAnswer, 80)}`}`) : `"${snippet(lastUser, 70)}"${lastAnswer === undefined ? "" : ` → ${snippet(lastAnswer, 80)}`}`;

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
        const decision = await this.gated(signal, () => interactive.request(request, signal));
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
        // K3: a file a live task of a background run owns is refused (the gateway records the denial).
        const owned = captured === undefined ? undefined : this.ownedByRun(captured);
        this.trustDeclinedNow = declined;
        let outcome;
        try {
          outcome = await inner.invoke(request, { ...scope, policy: owned === undefined ? this.policy() : runLockPolicy(this.policy()) }, signal);
        } finally {
          this.trustDeclinedNow = false;
        }
        if (owned !== undefined && outcome.state === "denied" && outcome.result.error !== undefined) {
          const message = `${owned.path} is owned by task ${owned.task} of the background worker run ${owned.run}, which is still running: editing it now would conflict when the run integrates. Wait for the run (run_status with wait: true), relay the change to the worker (run_steer with task: ${owned.task}), or ask the user to cancel it; files no task owns can be edited now.`;
          return { ...outcome, result: { ...outcome.result, error: { ...outcome.result.error, message: message.slice(0, 2000) } } };
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

  /** K3: the first file a live task of the background run owns, if any. */
  private ownedByRun(files: readonly CapturedFile[]): { readonly path: string; readonly task: string; readonly run: string } | undefined {
    const run = this.backgroundRun();
    if (run === undefined) return undefined;
    for (const file of files) {
      const task = run.tracker.ownerOf(file.relative, this.runtime.platform);
      if (task !== undefined) return { path: file.relative, task, run: run.id };
    }
    return undefined;
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
      if (message === undefined && this.unreportedRuns > 0) {
        // K3: a background run ended while the session was idle: a short follow-up turn reports it.
        const work = this.turn("", [], true);
        const left = concurrent ? await this.alongside(work, input) : await work;
        if (left === true) return;
        continue;
      }
      if (message === undefined) {
        const wake = new AbortController();
        this.wakeIdle = wake;
        let next;
        try {
          next = await input.next(AbortSignal.any([this.outer.signal, wake.signal]));
        } catch {
          if (wake.signal.aborted && !this.outer.signal.aborted) continue;
          return;
        }
        if (next.kind === "exit") {
          if (await this.confirmExit(next.command === true)) return;
          continue;
        }
        if (!("text" in next)) continue;
        const text = next.text.trim();
        const attachments = next.attachments ?? [];
        if (text === "" && attachments.length === 0) continue;
        message = { text, attachments };
        if (next.kind === "command" && !text.startsWith("/")) message = { text: `/${text}`, attachments };
      }
      const work = message.verbatim === true ? this.turn(message.text, [], false, true) : message.text.startsWith("/") ? this.command(message.text) : this.turn(message.text, message.attachments);
      const left = concurrent ? await this.alongside(work, input) : await work;
      if (left === true && (await this.confirmExit(true))) return;
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
          if (await this.confirmExit(next.command === true)) {
            this.hardExit();
            return;
          }
          continue;
        }
        if (!("text" in next)) continue;
        const text = next.text.trim();
        const attachments = next.attachments ?? [];
        if (text === "" && attachments.length === 0) continue;
        if (next.kind === "command" || text.startsWith("/")) {
          const command = findConversationCommand(text.split(/\s+/)[0] ?? "");
          if (command?.whileBusy === true) {
            if (await this.command(text)) {
              if (!(await this.confirmExit(true))) continue;
              this.hardExit();
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

  /**
   * Mid-turn steering (ADR-21 D8): to the coordinator while a foreground run holds the turn, else to
   * the running turn, else the next turn. K3: with the run in the background a message goes to the
   * agent, which relays corrections to the workers with run_steer.
   */
  private steer(text: string, attachments: readonly Attachment[]): void {
    const arrow = this.glyphs.name === "rich" ? "↳" : "->";
    const orchestration = this.orchestration;
    if (orchestration !== undefined && orchestration.foreground) {
      orchestration.coordinator.steer(text);
      this.note("info", `${arrow} steering the workers: ${text.trim()} (applied at the next safe point)`);
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

  /** Esc: interrupts the turn; while a foreground run holds the turn, the first Esc arms and the second stops it. Background runs keep going. */
  private interrupt(): void {
    const orchestration = this.orchestration;
    if (orchestration === undefined || !orchestration.foreground) {
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
      if (orchestration !== undefined) this.note("info", `Workers keep running in the background (${orchestration.id}) ${this.glyphs.sep} /runs cancel stops them`);
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

  /** One turn; `followUp` (K3) is the harness's own turn that reports a finished background run (no user text). */
  private async turn(typed: string, attachments: readonly Attachment[], followUp = false, verbatim = false): Promise<boolean> {
    this.submittedAt = followUp ? undefined : performance.now();
    let text = followUp ? "" : typed;
    if (followUp && this.unreportedRuns === 0) return false;
    if (!followUp && this.planOn && GO_WORDS.test(text.trim())) {
      this.setPlanMode(false);
      text = `${text}\n(The plan is approved: carry it out now.)`;
    }
    let log: EventStore;
    try {
      log = await this.ensureLog(text.split(ATTACHMENTS_OPEN)[0] ?? text);
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
    if (!verbatim && (attachments.length > 0 || /(^|\s)@\S/.test(text))) {
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
    // K7 hooks: SessionStart once, UserPromptSubmit per typed prompt (a block drops the prompt).
    const claudeNative = route.route.adapter_kind === "agent-backend" && (this.runtime.config.claudeCodeMode ?? "native") === "native";
    const hookContext: string[] = [];
    if (!this.sessionStartHooked) {
      this.sessionStartHooked = true;
      await this.reviewChangedHooks();
      const source = this.parsed.resume !== undefined || this.parsed.continue ? "resume" : this.parsed.fork !== undefined ? "fork" : "startup";
      hookContext.push(...((await this.runHook("SessionStart", { source }, [source], claudeNative, log.sessionId))?.context ?? []));
    }
    if (!followUp && !verbatim) {
      const submitted = await this.runHook("UserPromptSubmit", { prompt: typed }, [], claudeNative, log.sessionId);
      if (submitted?.blocked === true) {
        this.note("error", `Prompt blocked by a UserPromptSubmit hook: ${submitted.reason ?? "no reason given"}`);
        return false;
      }
      hookContext.push(...(submitted?.context ?? []));
    }
    if (hookContext.length > 0) body = `${body}\n${ATTACHMENTS_OPEN}\nContext from hooks:\n${hookContext.join("\n")}\n</synorch-attachments>`;
    const notes = this.pendingNotes.splice(0);
    // K3: completion notes ride on this turn; a follow-up turn is only needed for later ones.
    this.unreportedRuns = 0;
    for (const run of this.workerRuns) run.notice = undefined;
    if (followUp) notes.push("there is no new message from the user: tell the user in a few lines what the finished worker run did (from the result above) and the next step.");
    const message = notes.length === 0 ? body : `[Synorch note: ${notes.join(" ").replaceAll("]", ")")}]\n${body}`;
    const active = linked(this.outer.signal);
    this.active = active;
    this.turnRunning = true;
    let outcome: Awaited<ReturnType<AgentDriver["runTurn"]>> | undefined;
    this.authFailure = false;
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
          trigger: followUp ? "follow-up" : "user",
          maxSteps: MAX_STEPS,
        },
        active.signal,
      );
    } catch (error) {
      if (!active.signal.aborted) {
        const failure = failureInfo(error);
        if (failure.code === "auth_required" || failure.code === "auth_expired") this.authFailure = true;
        this.showFailure(failure);
      }
    } finally {
      this.turnRunning = false;
      if (this.active === active) this.active = undefined;
      this.submittedAt = undefined;
    }
    if (this.authFailure && !active.signal.aborted && outcome?.outcome !== "completed" && this.canConnect()) {
      this.authFailure = false;
      await this.offerSignIn(route.route.provider_id, route.route.auth_method, followUp ? "" : typed);
      return false;
    }
    // A message typed while the last step settled could not be delivered in this turn: it starts the next one.
    const leftover = driver.drainSteers?.() ?? [];
    if (leftover.length > 0) this.queued.unshift({ text: leftover.join("\n"), attachments: [] });
    // K7 Stop hooks: a block continues the conversation with the hook's reason (at most 3 times in a row).
    if (outcome?.outcome === "completed" && leftover.length === 0 && !active.signal.aborted) {
      const stopped = await this.runHook("Stop", { stop_hook_active: this.stopContinuations > 0 }, [], claudeNative, log.sessionId);
      if (stopped?.blocked === true && this.stopContinuations < MAX_STOP_CONTINUATIONS) {
        this.stopContinuations += 1;
        this.queued.unshift({ text: `[Synorch note: a Stop hook asked you to continue: ${(stopped.reason ?? "keep going").replaceAll("]", ")")}]`, attachments: [], verbatim: true });
      } else this.stopContinuations = 0;
    } else this.stopContinuations = 0;
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
    if (summary !== undefined) this.startupLine({ level: "info", text: `${this.glyphs.bullet} ${summary}`, context: true });
  }

  private startupLine(notice: { readonly level: "info" | "warning"; readonly text: string; readonly context?: boolean }): void {
    if (this.notices === undefined) this.note(notice.level, notice.text);
    else this.notices.add(notice);
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
      const stop = orchestration.foreground ? ` ${g.sep} esc to stop` : "";
      this.note("info", `${g.bullet} Plan ${g.sep} ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} ${g.sep} risk ${plan.risk}${this.runtime.policyMode === "autonomous" ? ` ${g.sep} starting now${stop}` : ""}`);
      // Task goals are what the user checks the plan by: shown in full (the renderer wraps them).
      for (const [index, task] of plan.tasks.entries()) this.note("info", `  ${index + 1}. ${task.key} (${task.role}): ${task.objective.trim()}`);
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
    if (this.planOn) return toolError("policy_denied", "plan mode is on: present the plan; the user starts workers with /go workers");
    const current = this.orchestration;
    if (current !== undefined) {
      return toolError("execution_failed", `workers are already running in this conversation (${current.id}): check them with run_status, relay changes with run_steer, or wait for the end with run_status {wait: true}`);
    }
    const runtime = this.runtime;
    if (!this.trustAsked && !runtime.trust.state().trusted && runtime.sandbox.enforcement !== "full" && this.renderer.approvals.availability === "interactive") {
      this.trustAsked = true;
      if (await promptTrustForCommand(runtime, this.renderer, "the workers' checks", context.signal)) this.policyCache = undefined;
    }
    // K3: an interactive session runs workers in the background unless the agent asks to wait; headless always waits.
    const background = input.wait !== true && this.canRunInBackground();
    const run = this.startRun(input, !background, context.signal);
    if (!background) return run.done;
    // The tool row's summary is the one on-screen line for this ("Workers running in background (run-1) · keep chatting · /runs").
    const text = [
      `Started worker run ${run.id} in the background. The user sees the plan and a live board; the conversation is not blocked.`,
      `Goal: ${snippet(input.goal, 400)}`,
      "End your turn now with one short line to the user (or keep helping them with something else). Do not wait or poll.",
      "When the run ends you receive a Synorch note with its result block; report from it then.",
      "run_status shows progress (wait: true only if you cannot continue without the result), run_steer relays a correction to the orchestrator or one task, run_cancel stops it.",
      "Until it ends, files its tasks own are refused to your edits (run_status lists them); other small edits are fine.",
    ].join("\n");
    return { status: "ok", text, truncated: false, redactions: 0 };
  }

  /** K3: a human is attached and input is read between turns, so a run can go to the background. */
  private canRunInBackground(): boolean {
    return this.io.stdinIsTTY && this.renderer.input !== undefined && this.renderer.approvals.availability === "interactive";
  }

  /** The active run when it runs in the background (undefined for none or a foreground run). */
  private backgroundRun(): ActiveOrchestration | undefined {
    const run = this.orchestration;
    return run !== undefined && !run.foreground ? run : undefined;
  }

  private startRun(input: OrchestrateInput, foreground: boolean, turnSignal: AbortSignal): ActiveOrchestration {
    const runtime = this.runtime;
    this.coordinator ??= runtime.createCoordinator(runtime.brokerFor(this.gatedApprovals()));
    const coordinator = this.coordinator;
    this.connectWorkers(coordinator);
    const goal = input.brief === undefined ? input.goal : `${input.goal}\n\nContext from the conversation:\n${input.brief}`;
    const tracker = new OrchestrationTracker(goal, input.reason);
    this.lastTracker = tracker;
    // A background run belongs to the session (it ends with it); a foreground run also to the turn (interrupting the turn stops it).
    const controller = linked(this.outer.signal);
    if (foreground) {
      if (turnSignal.aborted) controller.abort(turnSignal.reason);
      else turnSignal.addEventListener("abort", () => controller.abort(turnSignal.reason), { once: true });
    }
    const run: ActiveOrchestration = {
      id: `run-${this.workerRuns.length + 1}`,
      goal: input.goal,
      tracker,
      coordinator,
      controller,
      disarm: undefined,
      foreground,
      status: "running",
      done: Promise.resolve({ status: "ok", text: "", truncated: false, redactions: 0 }),
      result: undefined,
      notice: undefined,
    };
    this.orchestration = run;
    this.workerRuns.push(run);
    const views = this.renderer.views;
    // The rationale is audit, not transcript: it is in the session log and in `/runs <id>` (Why:).
    // ADR-07/19: without git, writing workers edit in place one at a time (scoped-dir with a revertable snapshot).
    if (this.workerRuns.length === 1 && !insideGitRepository(runtime.workspaceRoot)) {
      this.note("info", `No git repository here: workers edit in place one at a time ${this.glyphs.sep} git init and a first commit give each worker its own worktree`);
    }
    if (this.renderer.kind === "tui") views?.setBoard(tracker.view());
    run.done = this.driveRun(run, goal);
    return run;
  }

  /** Runs the coordinator to the end; the result block (or error) is the run's tool result. Never rejects. */
  private async driveRun(run: ActiveOrchestration, goal: string): Promise<ToolResult> {
    const g = this.glyphs;
    const runtime = this.runtime;
    const { tracker, controller } = run;
    const views = this.renderer.views;
    const ticker = views === undefined || this.renderer.kind !== "tui" ? undefined : setInterval(() => views.setBoard(tracker.view()), 1000);
    ticker?.unref?.();
    const stopReading = run.foreground ? this.readWhileWorkersRun() : async (): Promise<void> => undefined;
    let result: ToolResult;
    try {
      const outcome = await run.coordinator.run(
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
      run.status = outcome.status;
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
      result =
        outcome.status === "succeeded"
          ? { status: "ok", text: block, truncated: false, redactions: 0 }
          : toolError(outcome.status === "cancelled" ? "cancelled" : "execution_failed", `the orchestration ${outcome.status}: ${snippet(outcome.summary, 400)}`, block);
    } catch (caught) {
      const cancelled = controller.signal.aborted;
      tracker.finish(cancelled ? "cancelled" : "failed");
      run.status = cancelled ? "cancelled" : "failed";
      views?.setBoard(tracker.view());
      result = toolError(cancelled ? "cancelled" : "execution_failed", failureInfo(caught).message);
    } finally {
      if (ticker !== undefined) clearInterval(ticker);
      if (run.disarm !== undefined) clearTimeout(run.disarm);
      if (this.orchestration === run) this.orchestration = undefined;
      await stopReading();
    }
    run.result = result;
    if (!run.foreground) this.completedInBackground(run, result);
    return result;
  }

  /**
   * K3 completion notice: a line for the user, and a note for the agent that rides on the next turn;
   * when the session is idle the loop wakes and a short follow-up turn reports the result.
   */
  private completedInBackground(run: ActiveOrchestration, result: ToolResult): void {
    const g = this.glyphs;
    const ok = run.status === "succeeded";
    this.note(ok ? "info" : "warning", `${ok ? g.ok : g.warn} Background workers ${run.id} ${ok ? "finished" : run.status}${this.exiting ? "" : ` ${g.sep} Synorch reports the result`}`);
    if (this.exiting) return;
    const block = result.text !== "" ? result.text : "(no result block)";
    run.notice = `background worker run ${run.id} ended: ${run.status}.${result.error === undefined ? "" : ` ${result.error.message}`} Result block: ${block}`;
    this.pendingNotes.push(run.notice);
    this.unreportedRuns += 1;
    this.wakeIdle.abort();
  }

  /** The agent read a finished run's result itself (run_status): its completion note is dropped. */
  private consumeNotice(run: ActiveOrchestration): void {
    const notice = run.notice;
    if (notice === undefined) return;
    run.notice = undefined;
    const index = this.pendingNotes.indexOf(notice);
    if (index !== -1) this.pendingNotes.splice(index, 1);
    this.unreportedRuns = Math.max(0, this.unreportedRuns - 1);
  }

  private findRun(ref: string | undefined): ActiveOrchestration | undefined {
    if (ref === undefined || ref.trim() === "") return this.orchestration ?? this.workerRuns.at(-1);
    const wanted = ref.trim();
    return this.workerRuns.find((run) => run.id === wanted || run.tracker.run === wanted);
  }

  private unknownRun(ref: string | undefined): string {
    if (this.workerRuns.length === 0) return "no worker run in this conversation yet";
    return `no worker run ${ref ?? ""}; known: ${this.workerRuns.map((run) => run.id).join(", ")}`;
  }

  private runStatusText(run: ActiveOrchestration): string {
    const lines = [
      `Run ${run.id}${run.tracker.run === undefined ? "" : ` (${run.tracker.run})`}: ${run.status === "running" ? (run.foreground ? "running" : "running in the background") : run.status}`,
      `Goal: ${snippet(run.goal, 300)}`,
      ...(run.tracker.reason === undefined || run.tracker.reason.trim() === "" ? [] : [`Why: ${snippet(run.tracker.reason, 400)}`]),
      ...run.tracker.statusLines(),
    ];
    if (run.result !== undefined) lines.push("Result:", run.result.text !== "" ? run.result.text : (run.result.error?.message ?? ""));
    return lines.join("\n").slice(0, 16 * 1024);
  }

  /** K3 `run_status`: progress, or with `wait` the end of the run (bounded by timeout_seconds). */
  private async runStatus(input: RunStatusInput, signal: AbortSignal): Promise<ToolResult> {
    const run = this.findRun(input.run);
    if (run === undefined) return toolError("execution_failed", this.unknownRun(input.run));
    if (input.wait === true && run.status === "running") {
      const stop = new AbortController();
      const timeout = (input.timeout_seconds ?? 600) * 1000;
      await Promise.race([run.done, delay(timeout, undefined, { signal: AbortSignal.any([stop.signal, signal]) }).catch(() => undefined)]);
      stop.abort();
    }
    if (run.status !== "running") this.consumeNotice(run);
    return { status: "ok", text: this.runStatusText(run), truncated: false, redactions: 0 };
  }

  /** K3 `run_steer`: to the orchestrator (next safe point) or, with `task`, to that worker (next step). */
  private async runSteer(input: RunSteerInput): Promise<ToolResult> {
    const run = this.findRun(input.run);
    if (run === undefined) return toolError("execution_failed", this.unknownRun(input.run));
    if (run.status !== "running") return toolError("execution_failed", `${run.id} already ended (${run.status}); nothing was sent`);
    if (run.kind === "review") return toolError("execution_failed", `${run.id} is an independent review; it cannot be steered (run_cancel stops it)`);
    const arrow = this.glyphs.name === "rich" ? "↳" : "->";
    if (input.task !== undefined) {
      const result = await run.coordinator.workers.message(input.task, input.message);
      if (!result.ok) return toolError("execution_failed", result.message);
      this.note("info", `${arrow} Synorch told ${input.task}: ${input.message.trim()}`);
      return { status: "ok", text: result.message, truncated: false, redactions: 0 };
    }
    run.coordinator.steer(input.message);
    this.note("info", `${arrow} Synorch steered the workers: ${input.message.trim()} (applied at the next safe point)`);
    return { status: "ok", text: `Queued for the orchestrator of ${run.id}; it applies the message at the next safe point (it may re-plan).`, truncated: false, redactions: 0 };
  }

  /** K3 `run_cancel`: one task, or the whole run (its completion note follows). */
  private async runCancel(input: RunCancelInput): Promise<ToolResult> {
    const run = this.findRun(input.run);
    if (run === undefined) return toolError("execution_failed", this.unknownRun(input.run));
    if (run.status !== "running") return toolError("execution_failed", `${run.id} already ended (${run.status})`);
    if (input.task !== undefined) {
      const result = await run.coordinator.workers.cancel(input.task);
      return result.ok ? { status: "ok", text: result.message, truncated: false, redactions: 0 } : toolError("execution_failed", result.message);
    }
    this.note("warning", `Stopping the workers (${run.id})…`);
    run.controller.abort();
    return { status: "ok", text: `Cancelling ${run.id}; work already integrated stays. A note follows when it has stopped.`, truncated: false, redactions: 0 };
  }

  /** Worker prompts go through the typing-pause gate (K3). */
  private gatedApprovals(): ApprovalBroker {
    const inner = this.renderer.approvals;
    return { availability: inner.availability, request: (request, signal) => this.gated(signal, () => inner.request(request, signal)) };
  }

  /**
   * K3: while workers run in the background, prompts (worker approvals, questions) open one at a time
   * and only once the user pauses typing, so a modal never swallows keystrokes meant for the editor.
   */
  private async gated<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (this.backgroundRun() === undefined || this.renderer.kind !== "tui") return work();
    const previous = this.promptQueue;
    let release: () => void = () => undefined;
    this.promptQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      await this.typingPause(signal);
      return await work();
    } finally {
      release();
    }
  }

  private async typingPause(signal: AbortSignal | undefined): Promise<void> {
    const controls = this.renderer.controls;
    const typing = (): boolean => {
      const activity = controls?.inputActivity?.();
      return activity !== undefined && Date.now() - activity.lastKeyAtMs < TYPING_PAUSE_MS;
    };
    if (!typing()) return;
    this.note("warning", `${this.glyphs.warn} Synorch needs your answer ${this.glyphs.sep} the prompt opens when you pause typing (your draft is kept)`);
    while (typing()) {
      if (signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      await delay(150);
    }
  }

  private hardExit(): void {
    this.exiting = true;
    this.active?.abort();
    this.orchestration?.controller.abort();
    this.outer.abort();
  }

  /**
   * K3 exit with workers in the background: /exit and /quit stop them cleanly; Ctrl+C / Ctrl+D ask
   * (stop and exit, or keep working). Without a terminal the run is awaited, never orphaned.
   * Resolves true when the session should end.
   */
  private async confirmExit(explicit: boolean): Promise<boolean> {
    const run = this.backgroundRun();
    if (run === undefined) return true;
    const g = this.glyphs;
    if (!this.io.stdinIsTTY) {
      this.note("info", `Waiting for the background workers (${run.id}) to finish before exiting…`);
      await run.done;
      return false;
    }
    if (!explicit) {
      const stop = "Stop the workers and exit";
      let answer: string | undefined;
      try {
        answer = await this.askUser(`Workers are still running in the background (${run.id}). Stop them and exit?`, ["Keep working", stop], this.outer.signal);
      } catch {
        answer = undefined;
      }
      if (answer !== stop) {
        this.note("info", `Still here ${g.sep} the workers keep running ${g.sep} /runs cancel stops them`);
        return false;
      }
    }
    this.note("warning", `Stopping the workers (${run.id})…`);
    run.controller.abort();
    await Promise.race([run.done, delay(SETTLE_MS, undefined, { ref: false })]);
    return true;
  }

  /** At session end: an active run is cancelled and given a moment to clean up its worktrees. */
  private async settleRuns(): Promise<void> {
    const run = this.orchestration;
    if (run === undefined) return;
    run.controller.abort();
    await Promise.race([run.done, delay(SETTLE_MS, undefined, { ref: false })]);
  }

  /** K3 `/runs [id | cancel [id]]`. */
  public async runs(argument: string): Promise<void> {
    const g = this.glyphs;
    const [verb = "", target] = argument.trim().split(/\s+/).filter((part) => part !== "");
    if (verb === "cancel" || verb === "stop") {
      const run = this.findRun(target);
      if (run === undefined || run.status !== "running") {
        this.print([run === undefined ? this.unknownRun(target) : `${run.id} already ended (${run.status})`]);
        return;
      }
      this.note("warning", `Stopping the workers (${run.id})…`);
      run.controller.abort();
      return;
    }
    if (this.workerRuns.length === 0) {
      this.print([`No worker runs in this conversation yet ${g.sep} /workers <goal> starts one`]);
      return;
    }
    if (verb !== "") {
      const run = this.findRun(verb);
      this.print(run === undefined ? [this.unknownRun(verb)] : this.runStatusText(run).split("\n"));
      return;
    }
    const runEntries = () =>
      this.workerRuns.map((run) => ({
        id: run.id,
        goal: run.goal,
        status: run.status === "running" ? (run.foreground ? "running" : "background") : run.status,
        running: run.status === "running",
        view: () => run.tracker.view(),
        report: () => this.runStatusText(run),
        cancel: () => run.controller.abort(),
      }));
    if (await this.showPanel(() => runsPanel(runEntries, g.sep))) return;
    this.print([
      `${g.bullet} Worker runs ${g.sep} ${this.workerRuns.filter((run) => run.status === "running").length} running`,
      ...this.workerRuns.map((run) => {
        const view = run.tracker.view();
        const done = view.tasks.filter((task) => task.state === "completed").length;
        const seconds = Math.round(((view.endedAtMs ?? Date.now()) - (view.startedAtMs ?? Date.now())) / 1000);
        const status = run.status === "running" ? (run.foreground ? "running" : "background") : run.status;
        return `  ${run.id.padEnd(8)}${status.padEnd(12)}${`${done}/${view.tasks.length} tasks`.padEnd(12)}${`${seconds}s`.padEnd(8)}${snippet(run.goal, 60)}`;
      }),
      `  /runs <id> shows one ${g.sep} /runs cancel [id] stops one ${g.sep} Ctrl+G board/graph ${g.sep} /worker <key> enters a worker`,
    ]);
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
      } else this.note("info", `${arrow} ${data.key} (${data.role}, ${data.model_id}): ${data.objective.trim()}`);
      return;
    }
    if (this.renderer.kind === "tui") return;
    const key = (taskId: string): string => this.workerDirectory?.list().find((worker) => worker.taskId === taskId)?.key ?? taskId;
    if (recorded.type === "task/user_message") {
      this.note("info", `${g.name === "rich" ? "↳" : "->"} you ${arrow} ${key(recorded.data.task_id)}: ${recorded.data.text.trim()}`);
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
      // K7: a skill or markdown command runs as the next message (its body plus the arguments).
      const entry = name.startsWith("/") ? this.runtime.extensions.find(name.slice(1)) : undefined;
      const expanded = entry === undefined ? undefined : await this.runtime.extensions.invocationText(entry, argument).catch(() => undefined);
      if (expanded !== undefined) {
        this.queued.unshift({ text: expanded, attachments: [], verbatim: true });
        return false;
      }
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

  /** `/cancel`: the running turn first; a background run only when no turn runs (K3). */
  public cancel(): void {
    const run = this.orchestration;
    if (run !== undefined && (run.foreground || this.active === undefined)) {
      if (!run.foreground) this.note("warning", `Stopping the workers (${run.id})…`);
      run.controller.abort();
    } else if (this.active === undefined) this.print(["Nothing is running."]);
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
    if (this.turnRunning || this.orchestration?.foreground === true) this.note("info", `queued > /workers ${snippet(goal, 80)} (runs when Synorch is done)`);
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
      `Sandbox         ${runtime.sandbox.backend} (${runtime.sandbox.enforcement})${runtime.sandbox.enforcement === "full" ? "" : ` ${g.sep} allowed commands can write outside this folder`}`,
      `Always allowed  ${rules.length === 0 ? "none yet (answer \"Always allow\" in a prompt, or /permissions allow <prefix>)" : rules.join(` ${g.sep} `)}`,
      ...(rules.length === 0 ? [] : ["                /permissions remove <prefix> deletes a rule"]),
      `Web             search free except in ask mode; fetch asks at a new domain (auto/plan) ${g.sep} your domains: ${runtime.web.grantedDomains().length === 0 ? "none" : runtime.web.grantedDomains().join(", ")} ${g.sep} /permissions web`,
      `Always asks     destructive commands (force push, publish, recursive delete, reset --hard…), in every mode`,
      `Never           ${HARD_RAILS.filter((rail) => rail !== "destructive-command").join(", ")} (hard rails, every mode); git history changes stay with you`,
    ];
  }

  /** `/status`: mode, sandbox, MCP servers and every notice of this session's start. */
  public async status(): Promise<void> {
    const lines = this.statusLines();
    if (await this.showPanel(() => statusPanel(lines, this.mcpPanelHost(), this.glyphs.sep))) return;
    this.print(lines);
  }

  private statusLines(): string[] {
    const runtime = this.runtime;
    const g = this.glyphs;
    const mode = runtime.permissionMode();
    const mcp = runtime.mcp.status();
    const count = (state: string): number => mcp.filter((entry) => entry.state === state).length;
    const mcpParts = [
      count("connected") > 0 ? `${count("connected")} connected` : undefined,
      count("idle") > 0 ? `${count("idle")} ready` : undefined,
      count("starting") > 0 ? `${count("starting")} starting` : undefined,
      count("needs-auth") > 0 ? `${count("needs-auth")} need sign-in` : undefined,
      count("needs-approval") > 0 ? `${count("needs-approval")} need approval` : undefined,
      count("failed") > 0 ? `${count("failed")} failed` : undefined,
      count("disabled") > 0 ? `${count("disabled")} off` : undefined,
    ].filter((part): part is string => part !== undefined);
    const lines = [
      `Model           ${this.currentModel ?? "none"}`,
      `Mode            ${mode === undefined ? "default-deny (no prompts; headless)" : `${mode} ${g.sep} ${MODE_MEANINGS[mode]}`}`,
      `Sandbox         ${runtime.sandbox.backend} (${runtime.sandbox.enforcement})${runtime.sandbox.enforcement === "full" ? "" : ` ${g.sep} allowed commands can write outside this folder`}`,
      `MCP             ${mcp.length === 0 ? "no servers" : mcpParts.join(` ${g.sep} `)}${mcp.length === 0 ? "" : ` ${g.sep} /mcp`}`,
    ];
    for (const entry of mcp) {
      if (entry.state === "needs-auth") lines.push(`                ${entry.name}: needs sign-in ${g.sep} /mcp login ${entry.name}`);
      else if (entry.state === "needs-approval") lines.push(`                ${entry.name}: declared by this repo ${g.sep} /mcp approve ${entry.name}`);
      else if (entry.state === "failed") lines.push(`                ${entry.name}: ${entry.error ?? "did not start"} ${g.sep} /mcp ${entry.name}`);
    }
    const notices = this.notices?.all ?? [];
    lines.push(`Notices         ${notices.length === 0 ? "none" : notices.length}`);
    for (const notice of notices) lines.push(`                ${notice.text}`);
    return lines;
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
    if (argument.trim() === "" && (await this.showPanel(() => mcpPanel(this.mcpPanelHost())))) return;
    await runMcpSlash(this.mcpPanelHost(), argument);
  }

  private mcpPanelHost(): McpPanelHost {
    return {
      manager: this.runtime.mcp,
      home: this.runtime.home,
      sep: this.glyphs.sep,
      env: this.io.env,
      print: (lines) => this.print(lines),
      openBrowser: (url) => openBrowser(url, { platform: process.platform, env: this.io.env }),
      signal: this.outer.signal,
    };
  }

  /** K7 `/skills [show | enable | disable <name>]`. */
  public async skills(argument: string): Promise<void> {
    if (argument.trim() === "" && (await this.showPanel(() => skillsPanel(this.extensionHost())))) return;
    await runSkillsSlash(this.extensionHost(), argument);
  }

  /** K7 `/plugins [install <spec> | remove | enable | disable <name>]`. */
  public async plugins(argument: string): Promise<void> {
    if (argument.trim() === "" && (await this.showPanel(() => pluginsPanel(this.extensionHost())))) return;
    await runPluginsSlash(this.extensionHost(), argument);
  }

  /** K7: runs one hook event (notes for hook messages); undefined when no active hook listens. */
  private async runHook(event: HookEvent, payload: Readonly<Record<string, unknown>>, match: readonly string[], claudeNative: boolean, sessionId: string): Promise<HookOutcome | undefined> {
    const hooks = this.runtime.extensions.hooks;
    if (!hooks.has(event, { claudeNative })) return undefined;
    const outcome = await hooks
      .run(event, payload, match, { sessionId, cwd: this.runtime.workspaceRoot, permissionMode: this.runtime.permissionMode(), claudeNative, signal: this.outer.signal })
      .catch(() => undefined);
    for (const message of outcome?.messages ?? []) this.note("warning", message);
    return outcome;
  }

  /** K7: a Synorch plugin whose approved hooks changed asks again (interactive sessions only); Claude plugins wait for /plugins hooks approve. */
  private async reviewChangedHooks(): Promise<void> {
    const changed = this.runtime.extensions.hooks.sources().filter((source) => source.state === "changed");
    if (changed.length === 0) return;
    if (this.renderer.approvals.availability !== "interactive") {
      this.note("warning", `Hooks changed since you approved them and do not run: ${changed.map((source) => source.key).join(", ")} ${this.glyphs.sep} /plugins hooks approve <plugin>`);
      return;
    }
    for (const source of changed) await askHookApproval(this.extensionHost(), source).catch(() => false);
  }

  private extensionHost(): ExtensionSlashHost {
    return {
      extensions: this.runtime.extensions,
      home: this.runtime.home,
      workspaceRoot: this.runtime.workspaceRoot,
      env: this.runtime.extensions.env,
      sep: this.glyphs.sep,
      print: (lines) => this.print(lines),
      choose: (question) => this.choose(question, this.outer.signal).catch(() => undefined),
      changed: async () => {
        this.refreshPalette();
        // Plugin MCP servers follow the plugin set: re-resolve the definitions (a new server starts lazily).
        const mcp = this.runtime.mcp;
        const before = new Set(mcp.definitions().map((definition) => definition.name));
        await mcp.load().catch(() => undefined);
        for (const definition of mcp.definitions()) if (!before.has(definition.name) && definition.enabled) await mcp.reconnect(definition.name).catch(() => undefined);
      },
    };
  }

  /** The command palette: built-in commands, then every active skill and markdown command (K7). */
  private refreshPalette(): void {
    const extensions = this.runtime.extensions.invocable(reservedCommandNames()).map((entry) => ({
      name: entry.name,
      description: `${entry.kind === "skill" ? "skill" : "command"} (${entry.source}) ${entry.meta.description.replace(/\s+/g, " ").slice(0, 90)}`,
      argsHint: entry.meta.argumentHint ?? "[args]",
    }));
    this.renderer.controls?.setCommands([...conversationPaletteEntries(), ...extensions]);
  }

  /** K3: session start of the MCP servers; approvals the repository needs and start failures become notes. */
  private async startMcp(): Promise<void> {
    const mcp = this.runtime.mcp;
    const sep = this.glyphs.sep;
    if (mcp.problems.length > 0) this.startupLine({ level: "warning", text: `MCP configuration: ${mcp.problems.length === 1 ? "1 problem" : `${mcp.problems.length} problems`} ${sep} /mcp` });
    const approval = approvalNotice(mcp.pendingApprovals().map((definition) => definition.name), sep);
    if (approval !== undefined) this.startupLine(approval);
    await mcp.startSession().catch(() => undefined);
    if (this.exiting) return;
    for (const notice of mcpStartNotices(mcp.status(), sep)) this.startupLine(notice);
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

  /**
   * `/review [--staged | <commit> | <from>..<to> | run-<n> | fix] [focus]` (ADR-09): pins the target's
   * diff (digest of the full content, generated files left out), resolves the reviewer route
   * (cross-provider when possible) and runs a read-only reviewer attempt through the worker manager
   * as its own background run (`/runs`); the verdict card, `/evidence` and "Fix these?" follow.
   */
  public async review(argument: string): Promise<void> {
    const g = this.glyphs;
    const runtime = this.runtime;
    const root = runtime.workspaceRoot;
    const parsed = parseReviewArgument(argument);
    if (parsed.fix) {
      if (this.lastReview === undefined) this.print(["No review in this conversation yet; /review runs one."]);
      else await this.offerReviewFixes(this.lastReview, true);
      return;
    }
    let target: ReviewDiffTarget;
    let runLabel: string | undefined;
    if (parsed.target.kind === "run") {
      const run = this.findRun(parsed.target.ref);
      if (run === undefined || run.kind === "review") {
        this.print([run === undefined ? this.unknownRun(parsed.target.ref) : `${run.id} is a review run; review a worker run instead`]);
        return;
      }
      const paths = run.tracker.integratedPaths();
      if (paths.length === 0) {
        this.print([`${run.id} integrated no files${run.status === "running" ? " yet" : ""}; nothing to review.`]);
        return;
      }
      target = { kind: "workspace", paths };
      runLabel = `files integrated by ${run.id}`;
    } else target = parsed.target;
    let diff = await reviewDiff(root, target, isGeneratedPath, this.outer.signal);
    if (typeof diff === "string") {
      this.print([`/review: ${diff === "not a git repository" ? "needs a git repository (the diff is what gets reviewed)" : diff}`]);
      return;
    }
    if (diff.text.trim() === "" && parsed.target.kind === "workspace") {
      // Nothing uncommitted (e.g. the last run was committed): review the last commit instead.
      const last = await reviewDiff(root, { kind: "commit", rev: "HEAD" }, isGeneratedPath, this.outer.signal);
      if (typeof last !== "string" && last.text.trim() !== "") diff = { ...last, label: `last ${last.label}` };
    }
    if (diff.text.trim() === "") {
      this.print([diff.excluded.length > 0 ? `Only generated files changed (${diff.excluded.slice(0, 3).join(", ")}); nothing to review.` : `Nothing to review in ${diff.label}.`]);
      return;
    }
    const label = runLabel ?? diff.label;
    // ADR-09 reviewer routing, as for workers: routes.<tier>.reviewer wins, otherwise review.cross_provider
    // prefers a provider other than the one that wrote the changes (the conversation's route).
    const rules = runtime.routeRules();
    const explicit = rules.find((candidate) => candidate.role === "reviewer");
    const tier: ModelTier = explicit?.tier ?? (rules.some((candidate) => candidate.tier === "complex_worker") ? "complex_worker" : (sessionRouteRule(runtime, this.sessionTier)?.tier ?? "complex_worker"));
    const implementer = await this.routePromise?.then((decision) => decision.route).catch(() => undefined);
    let route: RouteDecision;
    try {
      route = await runtime.router.resolve({ tier, role: "reviewer", ...(implementer === undefined ? {} : { implementer }) }, this.outer.signal);
    } catch (error) {
      this.showFailure(failureInfo(error));
      return;
    }
    const digest = digestOf({ diff: diff.text });
    const truncated = Buffer.byteLength(diff.text, "utf8") > REVIEW_DIFF_LIMIT;
    const shown = truncated ? Buffer.from(diff.text, "utf8").subarray(0, REVIEW_DIFF_LIMIT).toString("utf8") : diff.text;
    const resolved = diff.resolved;
    const artifact: PinnedReviewArtifact = {
      digest,
      brief: renderArtifactReviewBrief({ label, digest, diff: shown, truncated, changedPaths: diff.files, excludedPaths: diff.excluded, focus: parsed.focus }),
      repin: async (signal) => {
        const again = await reviewDiff(root, resolved, isGeneratedPath, signal);
        return typeof again === "string" ? undefined : digestOf({ diff: again.text });
      },
    };
    const request: ArtifactReviewRequest = {
      workspaceRoot: root,
      policyMode: runtime.policyMode,
      headless: this.renderer.approvals.availability === "headless",
      target: parsed.target,
      label,
      focus: parsed.focus,
      tier: tier === "session" ? "complex_worker" : tier,
      route,
      implementer,
      changedPaths: diff.files,
      excludedPaths: diff.excluded,
      artifact,
    };
    this.coordinator ??= runtime.createCoordinator(runtime.brokerFor(this.gatedApprovals()));
    const goal = artifactReviewGoal(label, parsed.focus);
    const background = this.canRunInBackground();
    const run: ActiveOrchestration = {
      id: `run-${this.workerRuns.length + 1}`,
      goal,
      tracker: new OrchestrationTracker(goal, undefined),
      coordinator: this.coordinator,
      controller: linked(this.outer.signal),
      disarm: undefined,
      foreground: !background,
      status: "running",
      done: Promise.resolve({ status: "ok", text: "", truncated: false, redactions: 0 }),
      result: undefined,
      notice: undefined,
      kind: "review",
    };
    this.workerRuns.push(run);
    const reviewer = `${route.route.provider_id}/${route.route.model_id}`;
    const crossProvider = implementer !== undefined && implementer.provider_id !== route.route.provider_id;
    this.note(
      "info",
      `${g.bullet} Reviewing ${diff.files.length} file${diff.files.length === 1 ? "" : "s"} (${label}) with ${reviewer}${crossProvider ? " (another provider)" : ""} ${g.sep} fresh context, read-only, artifact ${digest.slice(0, 19)}… pinned ${g.sep} ${background ? `background ${run.id} · /runs` : "waiting"}`,
    );
    run.done = this.driveReview(run, request);
    if (!background) await run.done;
  }

  /** Runs one `/review` to its card; never rejects. */
  private async driveReview(run: ActiveOrchestration, request: ArtifactReviewRequest): Promise<ToolResult> {
    const g = this.glyphs;
    const result = await run.coordinator.review(request, run.controller.signal).catch((error: unknown): ArtifactReviewResult => ({
      kind: "artifact-review",
      runId: "",
      sessionId: "",
      reviewerAttemptId: undefined,
      reviewerSessionId: undefined,
      target: request.label,
      targetKind: request.target.kind,
      artifactDigest: request.artifact.digest,
      changedPaths: request.changedPaths,
      excludedPaths: request.excludedPaths,
      reviewer: { provider_id: request.route.route.provider_id, model_id: request.route.route.model_id },
      sameProvider: undefined,
      status: "failed",
      verdict: undefined,
      criteria: [],
      findings: [],
      evidence: [],
      problems: [failureInfo(error).message],
    }));
    run.status = result.status === "reviewed" || result.status === "artifact_changed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
    run.tracker.finish(run.status);
    if (result.sessionId !== "" && !this.orchestratedSessions.includes(result.sessionId as SessionId)) this.orchestratedSessions.push(result.sessionId as SessionId);
    this.lastReview = result;
    const card = renderReviewCard(result, g);
    const level = result.verdict === "approve" ? "info" : "warning";
    for (const [index, line] of card.entries()) this.note(index === 0 ? level : "info", line);
    const text = JSON.stringify(result);
    run.result = { status: "ok", text: text.slice(0, 16 * 1024), truncated: text.length > 16 * 1024, redactions: 0 };
    if (!this.exiting && result.verdict !== undefined) {
      const findings = result.findings.map((finding) => `${finding.severity} ${finding.path ?? ""}${finding.line === undefined ? "" : `:${finding.line}`} ${finding.summary}`.replace(/\s+/g, " ").trim());
      this.pendingNotes.push(
        snippet(`the user ran /review (${result.target}); the independent reviewer (${result.reviewer.provider_id}/${result.reviewer.model_id}, fresh context) verdict: ${result.verdict.replaceAll("_", " ")}${findings.length === 0 ? ", no findings" : `; findings: ${findings.join("; ")}`}`, 1500),
      );
    }
    if (!this.exiting && actionableFindings(result).length > 0) await this.offerReviewFixes(result, false);
    return run.result;
  }

  /**
   * "Fix these?" after a review: the TUI's choice modal (every finding checked); the accepted ones
   * reach the session agent as a follow-up message. Plain mode sends them on `/review fix`.
   */
  private async offerReviewFixes(result: ArtifactReviewResult, explicit: boolean): Promise<void> {
    const g = this.glyphs;
    const findings = actionableFindings(result);
    if (findings.length === 0) {
      if (explicit) this.print(["The last review has no findings to fix."]);
      return;
    }
    let chosen = findings;
    if (this.renderer.kind === "tui" && this.renderer.controls !== undefined) {
      const answer = await this.typingPause(this.outer.signal)
        .then(() =>
          this.choose(
            {
              question: `Fix these? ${findings.length} finding${findings.length === 1 ? "" : "s"} from the review of ${result.target}`,
              header: "Review",
              subtitle: "checked findings go to Synorch as a follow-up message",
              options: findings.map((finding) => ({
                label: snippet(`${finding.severity} ${finding.path === undefined ? "" : `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} `}${finding.summary}`, 140),
                ...(finding.recommendation === undefined ? {} : { description: snippet(finding.recommendation, 160) }),
              })),
              multiSelect: true,
              initialChecked: findings.map((_, index) => index),
              allowOther: false,
              escapeLabel: "not now",
              tone: "neutral",
            },
            this.outer.signal,
          ),
        )
        .catch(() => undefined);
      if (answer?.kind !== "selected" || answer.indices.length === 0) {
        this.note("info", `Not sent ${g.sep} /review fix sends the findings later`);
        return;
      }
      chosen = answer.indices.flatMap((index) => (findings[index] === undefined ? [] : [findings[index]]));
    } else if (!explicit) {
      this.note("info", `/review fix sends ${findings.length === 1 ? "this finding" : `these ${findings.length} findings`} to Synorch`);
      return;
    }
    this.queued.push({ text: fixFollowUpMessage(result, chosen), attachments: [], verbatim: true });
    this.note("info", `${g.name === "rich" ? "→" : "->"} ${chosen.length} finding${chosen.length === 1 ? "" : "s"} sent to Synorch${this.turnRunning ? " (after the current turn)" : ""}`);
    this.wakeIdle.abort();
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
    const tui = this.renderer.kind === "tui" && this.renderer.controls !== undefined;
    let selected: readonly ChangedFile[] = changes.files;
    if (tui && changes.files.length > 1) {
      // Selective staging: every changed file is checked; Space unchecks what stays out of this commit.
      const picked = await this.pickCommitFiles(changes.files);
      if (picked === undefined) {
        this.print(["Not committed."]);
        return;
      }
      selected = picked;
    }
    const all = (): boolean => selected.length === changes.files.length;
    const statFor = (): string => (all() ? changes.stat : changes.stat.split(/\r?\n/).filter((line) => selected.some((file) => changePathspecs(file).some((spec) => line.includes(spec)))).join("\n"));
    const statTail = all() ? (changes.stat.split(/\r?\n/).at(-1)?.trim() ?? "") : "";
    let message = argument.trim() === "" ? await this.proposeCommitMessage(selected.map((file) => file.path), statFor()) : argument.trim();
    const countOf = (files: readonly ChangedFile[]): string => `${files.length} file${files.length === 1 ? "" : "s"}`;
    const views = this.renderer.views;
    if (views !== undefined) {
      // UX-03 action card: what, why, consequence, reversibility — before the human decides.
      views.showView({
        kind: "action",
        title: `Commit ${countOf(selected)}?`,
        what: `git commit -m "${snippet(message.split(/\r?\n/)[0] ?? message, 90)}"`,
        why: "you ran /commit",
        consequence: all()
          ? `stages every uncommitted change (git add -A) and records one commit${statTail === "" ? "" : ` · ${statTail}`}`
          : `stages and commits only the ${countOf(selected)} you selected; the other ${changes.files.length - selected.length} stay uncommitted`,
        effect: "local",
        reversible: true,
        paths: selected.map((file) => file.path),
        scope: "this commit once; nothing is pushed",
      });
      this.print(["Message:", ...message.split(/\r?\n/).map((line) => `  ${line}`)]);
    } else {
      const lines = [`${g.bullet} Commit ${g.sep} ${countOf(selected)}`];
      for (const file of selected.slice(0, 15)) lines.push(`  ${file.status.padEnd(3)}${file.path}`);
      if (selected.length > 15) lines.push(`  … ${selected.length - 15} more`);
      if (statTail !== "") lines.push(`  ${statTail}`);
      this.print([...lines, "Proposed message:", ...message.split(/\r?\n/).map((line) => `  ${line}`)]);
    }
    const choices = ["Commit", "Edit the message", ...(!tui && changes.files.length > 1 ? ["Choose files"] : []), "Cancel"];
    const answer = (await this.askUser(`Commit ${countOf(selected)} with this message?`, choices, this.outer.signal).catch(() => "Cancel")).trim();
    if (/^(edit|e$)/i.test(answer)) {
      message = (await this.askUser("Type the commit message", undefined, this.outer.signal).catch(() => "")).trim();
      if (message === "") {
        this.print(["Not committed."]);
        return;
      }
    } else if (/^choose/i.test(answer)) {
      const picked = await this.pickCommitFiles(changes.files);
      if (picked === undefined) {
        this.print(["Not committed."]);
        return;
      }
      selected = picked;
    } else if (!/^(y|yes|commit|evet)/i.test(answer)) {
      this.print(["Not committed."]);
      return;
    }
    const result = all() ? await commitAll(root, message, this.outer.signal) : await commitSelected(root, message, selected, this.outer.signal);
    if (!result.ok) {
      this.note("error", `${g.fail} git commit failed: ${snippet(result.stderr || result.stdout, 300)}`);
      return;
    }
    const subject = message.split(/\r?\n/)[0] ?? message;
    const left = changes.files.length - selected.length;
    this.print([`${g.ok} Committed ${countOf(selected)}: ${subject}${left === 0 ? "" : ` ${g.sep} ${left} left uncommitted`}`]);
    this.pendingNotes.push(`the user committed ${all() ? "the working tree" : `${selected.map((file) => file.path).join(", ")}`} (/commit) with the message "${snippet(subject, 120)}".`);
  }

  /** The changed files as a multi-select, all checked; undefined when dismissed or nothing is left checked. */
  private async pickCommitFiles(files: readonly ChangedFile[]): Promise<readonly ChangedFile[] | undefined> {
    const answer = await this.choose(
      {
        question: "Files to commit",
        subtitle: "Space toggles · Enter continues with the checked files · Esc cancels",
        options: files.map((file) => ({ label: `${file.status.padEnd(2)} ${file.path}` })),
        multiSelect: true,
        initialChecked: files.map((_, index) => index),
        allowOther: false,
        escapeLabel: "cancel",
        tone: "neutral",
      },
      this.outer.signal,
    ).catch(() => undefined);
    if (answer?.kind !== "selected") return undefined;
    const picked = answer.indices.flatMap((index) => (files[index] === undefined ? [] : [files[index]]));
    return picked.length === 0 ? undefined : picked;
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
    const usagePage = async (): Promise<PanelPage> => cardPanel("Usage", await ledger.view(Date.now() - this.startedAt), [], usagePage);
    if (await this.showPanel(usagePage)) return;
    const views = this.renderer.views;
    if (views !== undefined) views.showView(await ledger.view(Date.now() - this.startedAt, await this.quotaPlans(), quotaProviderLabel));
    else this.print(await ledger.report());
  }

  /** Provider id → plan label (`ChatGPT Plus`, `Claude Code`) for `/usage`, subscription routes first. No network request. */
  private async quotaPlans(): Promise<Map<string, string>> {
    const runtime = this.runtime;
    const plans = new Map<string, string>();
    const method = (adapterId: string): string | undefined => runtime.adapters.find((adapter) => adapter.adapterId === adapterId)?.authMethod;
    const rules = [...runtime.routeRules()].sort((left, right) => Number(method(left.route.adapter_id) === "api-key") - Number(method(right.route.adapter_id) === "api-key"));
    for (const rule of rules) {
      if (plans.has(rule.route.provider_id)) continue;
      const plan = (await subscriptionPlan(runtime, rule.route, this.outer.signal).catch(() => undefined)) ?? planLabel(runtime, rule.route);
      if (plan !== undefined) plans.set(rule.route.provider_id, plan);
    }
    return plans;
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
        if (view !== undefined && (await this.showPanel(() => cardPanel("Context", view)))) return;
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
        if (argument.trim() === "" && (await this.showPanel(() => memoryPanel(this.memoryDesk())))) return;
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
    this.unreportedRuns = 0;
    this.requests.clear();
    this.lastTracker = undefined;
    this.print([`${this.glyphs.ok} New conversation${previous === undefined ? "" : ` ${this.glyphs.sep} the previous one is saved (/resume)`}`]);
  }

  public async resume(argument: string): Promise<void> {
    const list = (await this.conversations()).filter((entry) => entry.sessionId !== this.sessionId).slice(0, 20);
    const g = this.glyphs;
    const forkLabel = (entry: (typeof list)[number]): string => (entry.forked ? ` ${g.sep} fork of ${entry.parentTitle === undefined ? "an earlier conversation" : `"${snippet(entry.parentTitle, 40)}"`}` : "");
    let chosen: SessionId | undefined;
    if (argument === "") {
      if (list.length === 0) {
        this.print(["No other conversations in this folder."]);
        return;
      }
      const resumeEntries = list.map((entry) => ({ sessionId: entry.sessionId, title: snippet(entry.title, 90), when: relativeTime(Date.parse(entry.at)), forkOf: entry.forked ? (entry.parentTitle === undefined ? "an earlier conversation" : `"${snippet(entry.parentTitle, 40)}"`) : undefined }));
      if (await this.showPanel(() => resumePanel(resumeEntries, g.sep))) return;
      if (this.renderer.kind !== "tui" || this.renderer.controls === undefined) {
        this.print(["Recent conversations (/resume <n>):", ...list.map((entry, index) => `  ${String(index + 1).padStart(2)}. ${snippet(entry.title, 70)} ${g.sep} ${relativeTime(Date.parse(entry.at))}${forkLabel(entry)}`)]);
        return;
      }
      if (this.turnRunning || this.orchestration !== undefined) {
        this.print(["Synorch is working; /cancel first."]);
        return;
      }
      const answer = await this.choose(
        {
          question: "Resume a conversation",
          subtitle: "Enter switches · Esc cancels · this one stays saved",
          options: list.map((entry) => ({ label: `${entry.forked ? (g.name === "rich" ? "↳ " : "-> ") : ""}${snippet(entry.title, 70)}`, description: `${relativeTime(Date.parse(entry.at))}${forkLabel(entry)}` })),
          allowOther: false,
          escapeLabel: "cancel",
          tone: "neutral",
        },
        this.outer.signal,
      ).catch(() => undefined);
      if (answer?.kind !== "selected") return;
      chosen = list[answer.indices[0] ?? -1]?.sessionId;
      if (chosen === undefined) return;
    }
    if (this.turnRunning || this.orchestration !== undefined) {
      this.print(["Synorch is working; /cancel first."]);
      return;
    }
    if (chosen === undefined) {
      const index = Number(argument);
      chosen = Number.isInteger(index) && index >= 1 ? list[index - 1]?.sessionId : list.find((entry) => entry.sessionId === argument)?.sessionId;
    }
    if (chosen === undefined) {
      this.print([`No conversation "${argument}"; /resume lists them.`]);
      return;
    }
    await this.leaveConversation();
    await this.showResumed(await this.openSession(chosen));
  }

  /** Closes the current conversation's log (it stays resumable) and resets per-conversation state. */
  private async leaveConversation(): Promise<void> {
    await this.log?.close().catch(() => undefined);
    this.log = undefined;
    this.driver = undefined;
    this.turnId = undefined;
    this.orchestratedSessions.length = 0;
    this.pendingNotes.length = 0;
    this.requests.clear();
    this.lastTracker = undefined;
  }

  // ---- K3 time travel: /fork and /rewind ------------------------------------------------------------

  /**
   * Continues in a new conversation whose history is this one's events up to `upToSeq` (the store
   * reads the parent prefix through the fork pointer; nothing is copied). The original is closed and
   * stays resumable. `upToSeq` 0 (before the first event) starts an empty conversation instead.
   */
  private async forkAt(upToSeq: number, title: string | undefined): Promise<readonly SessionEvent[] | undefined> {
    const source = this.sessionId;
    if (source === undefined || this.log === undefined) return undefined;
    if (upToSeq < 1) {
      await this.leaveConversation();
      this.sessionId = undefined;
      this.routeRecorded = false;
      return [];
    }
    const forked = await this.runtime.sessions.fork(source, upToSeq, title === undefined ? {} : { title });
    const forkedId = forked.sessionId;
    await forked.close();
    await this.leaveConversation();
    return this.openSession(forkedId);
  }

  /** The last few exchanges of a conversation, as the resume card shows them. */
  private replayTail(events: readonly SessionEvent[]): void {
    const users = events.flatMap((event, index) => (event.type === "message/recorded" && event.data.role === "user" ? [index] : []));
    const firstShown = users.length > REPLAY_EXCHANGES ? (users[users.length - REPLAY_EXCHANGES] ?? 0) : 0;
    if (users.length > 0) this.renderer.replay?.(events.slice(firstShown));
  }

  /** `/fork [name]`: branch the conversation here; the original stays resumable. */
  public async fork(argument: string): Promise<void> {
    if (this.turnRunning || this.orchestration !== undefined) {
      this.print(["Synorch is working; /cancel first."]);
      return;
    }
    const log = this.log;
    if (log === undefined || this.sessionId === undefined) {
      this.print(["Nothing to fork yet: send a message first."]);
      return;
    }
    const name = argument.replace(/\s+/g, " ").trim();
    const previous = this.sessionId;
    await this.forkAt(log.lastSeq, name === "" ? undefined : `${CONVERSATION_TITLE}${name.slice(0, 120)}`);
    this.print([`${this.glyphs.ok} Forked${name === "" ? "" : ` "${snippet(name, 60)}"`} ${this.glyphs.sep} you are in the new branch ${this.glyphs.sep} the original (${previous}) stays saved: /resume`]);
  }

  private restoreIO(): RestoreIO {
    return {
      resolve: (relative) => this.inside(relative)?.absolute,
      read: async (absolute) => {
        const bytes = await readOptional(absolute);
        return bytes === undefined ? undefined : new Uint8Array(bytes);
      },
      write: async (absolute, bytes) => {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, bytes);
      },
      remove: (absolute) => unlink(absolute),
      blob: (ref) => this.runtime.blobs.get(ref.digest),
    };
  }

  /**
   * `/rewind` (Esc Esc on an empty editor): pick an earlier message; the conversation forks from just
   * before it and the message goes back into the editor. Optionally the files Synorch changed after
   * that point are restored from its `/undo` checkpoints (files the user changed since are kept).
   */
  public async rewind(): Promise<void> {
    const g = this.glyphs;
    if (this.turnRunning || this.orchestration !== undefined) {
      this.print(["Synorch is working; /cancel first."]);
      return;
    }
    const events = await this.readEvents();
    const points = rewindPoints(events).reverse().slice(0, 50);
    if (points.length === 0) {
      this.print(["Nothing to rewind yet: send a message first."]);
      return;
    }
    const picked = await this.choose(
      {
        question: "Rewind to before which message?",
        subtitle: "the conversation forks from just before it · the original stays saved (/resume) · Esc cancels",
        options: points.map((point) => ({ label: snippet(point.text === "" ? "(attachment only)" : point.text, 72), description: relativeTime(Date.parse(point.at)) })),
        allowOther: false,
        escapeLabel: "cancel",
        tone: "neutral",
      },
      this.outer.signal,
    ).catch(() => undefined);
    const point = picked?.kind === "selected" ? points[picked.indices[0] ?? -1] : undefined;
    if (point === undefined) return;
    const plan = planRestore(events, point.forkSeq);
    const io = this.restoreIO();
    const conflicts = plan.files.length === 0 ? [] : await restoreConflicts(plan, io);
    const restorable = plan.files.length - conflicts.length;
    const count = (n: number): string => `${n} file${n === 1 ? "" : "s"}`;
    const options = [
      { label: "Fork conversation from here", description: "new conversation up to just before this message; your message returns to the editor; files stay as they are" },
      ...(plan.files.length === 0
        ? []
        : [
            {
              label: "Fork and restore files to that point",
              description: `${count(restorable)} Synorch changed after it go back${conflicts.length === 0 ? "" : ` ${g.sep} ${count(conflicts.length)} you changed since are kept: ${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? ", …" : ""}`} ${g.sep} command side effects are not undone`,
              ...(restorable === 0 ? { disabled: "every file Synorch changed was changed again since" } : {}),
            },
          ]),
    ];
    const action = await this.choose(
      { question: `Rewind to "${snippet(point.text, 50)}"`, options, allowOther: false, escapeLabel: "cancel", tone: "neutral" },
      this.outer.signal,
    ).catch(() => undefined);
    if (action?.kind !== "selected") return;
    const restore = action.indices[0] === 1;
    let restoredFiles: readonly string[] = [];
    if (restore) {
      const result = await applyRestore(plan, io);
      restoredFiles = result.restored;
      // The original conversation records what was undone, so its /diff and /undo stay truthful.
      for (const checkpoint of plan.checkpoints) {
        const mine = (file: string): boolean => checkpoint.data.files.some((entry) => entry.path === file);
        await this.append("checkpoint/restored", { checkpoint_seq: checkpoint.seq, restored: result.restored.filter(mine), skipped: result.skipped.filter((entry) => mine(entry.path)) }, "user").catch(() => undefined);
      }
      for (const entry of result.skipped) this.note("warning", `${g.warn} Kept ${entry.path}: ${entry.reason}`);
    }
    const previous = this.sessionId;
    const forked = await this.forkAt(point.forkSeq, undefined);
    if (forked === undefined) return;
    this.replayTail(forked);
    const kept = plan.files.map((file) => file.path).filter((file) => !restoredFiles.includes(file));
    if (kept.length > 0) this.pendingNotes.push(`the user rewound the conversation to this point; files you changed after it were kept as they are now: ${kept.join(", ")} (re-read before editing).`);
    this.print([
      `${g.resume} Rewound ${g.sep} new branch from before "${snippet(point.text, 50)}"${restoredFiles.length === 0 ? "" : ` ${g.sep} restored ${restoredFiles.join(", ")}`} ${g.sep} the original${previous === undefined ? "" : ` (${previous})`} stays saved: /resume`,
    ]);
    const controls = this.renderer.controls;
    if (point.text !== "") {
      if (controls?.setEditorText !== undefined) controls.setEditorText(point.text);
      else this.print(["Your message, to edit and send again:", ...point.text.split(/\r?\n/).map((line) => `  ${line}`)]);
    }
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
    const panelShown = await this.showPanel(() =>
      configPanel({
        sep: this.glyphs.sep,
        rows: listing,
        edit: async (row) => {
          const value = await this.pickSettingValue(row, controls);
          return value === undefined ? undefined : this.applySetting(row.key, value);
        },
      }),
    );
    if (panelShown) return;
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
    if (row.key === "ui.theme") choices = (controls.appearance?.themes ?? BUILTIN_THEMES).map((theme) => theme.name);
    const typeIt = "Type a value…";
    if (row.kind === "route" || row.kind === "int" || row.kind === "number" || row.kind === "string" || row.kind === "list") choices.push(typeIt);
    choices.push(unset);
    const entries: ModelPickerEntry[] = choices.map((choice, index) => ({ id: String(index), tier: "", provider: "", model: "", label: choice, auth: badges.get(choice) ?? "", current: choice === row.value }));
    const picked = choices.length === 2 && choices[0] === typeIt ? { id: "0" } : await controls.openModelPicker(entries, this.outer.signal, { title: row.key, hint: `${row.description} — Enter selects, Esc cancels` }).catch(() => undefined);
    const choice = picked === undefined ? undefined : choices[Number(picked.id)];
    if (choice === undefined) return undefined;
    if (choice === unset) return UNSET_SETTING;
    if (choice !== typeIt) return choice;
    const hint = row.kind === "route" ? "provider/model[@adapter], e.g. openai/gpt-6-sol" : row.kind === "string" ? "text" : row.kind === "list" ? `comma-separated: ${(row.choices ?? []).join(",")}` : "a positive number";
    const answer = await this.askUser(`New value for ${row.key} (${hint}; empty cancels)`, undefined, this.outer.signal).catch(() => "");
    return answer.trim() === "" ? undefined : answer.trim();
  }

  private async applySetting(key: string, value: string): Promise<string> {
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
      } else if (change.key === "ui.theme") {
        // K8: a theme applies at once in the interactive view (a file created after start: next conversation).
        effect = this.renderer.controls?.appearance?.setTheme(change.value ?? defaultThemeName(this.io.env)) === true ? "applied now" : "new conversations use it";
      } else if (change.key.startsWith("ui.welcome.")) {
        const appearance = this.renderer.controls?.appearance;
        if (appearance !== undefined) {
          appearance.setWelcome(welcomeWith(appearance.welcome, change.key, change.value));
          effect = "applied now";
        }
      } else if (change.key === "ui.glyphs") effect = "applies from the next session"; else if (change.key.startsWith("routes.")) effect = "new conversations use it; /model switches this one";
      else if (change.key.startsWith("effort.")) {
        // K6: set or unset, a tier or role level applies to this session at once: the live configured level
        // changes, and a session override of that tier (an earlier /effort) gives way to it.
        const slot = EFFORT_SLOTS.find((candidate) => `effort.${candidate}` === change.key);
        if (slot !== undefined) {
          this.runtime.setConfiguredEffort(slot, change.value === undefined || !isReasoningEffort(change.value) ? undefined : change.value);
          const tier = MODEL_TIERS.find((candidate) => candidate === slot);
          if (tier !== undefined) this.runtime.setSessionEffort(tier, undefined);
          this.refreshStatus();
          effect = "applied from the next request";
        }
      }
      const line = `${g.ok} ${change.key} = ${shown}${change.previous !== undefined && change.previous !== change.value ? ` (was ${change.previous})` : ""} ${g.sep} ${effect}`;
      this.print([line]);
      return line;
    } catch (error) {
      const line = `${g.warn} ${error instanceof Error ? error.message : String(error)}`;
      this.print([line]);
      return line;
    }
  }

  // ---- K8 appearance -------------------------------------------------------------------------

  /** The welcome's hint: first run, a conversation from the last hours to resume, else a rotating tip. */
  private async welcomeHint(resumed: boolean): Promise<string | undefined> {
    try {
      const list = resumed ? [] : await this.conversations();
      const recent = list[0];
      const recentAt = recent === undefined ? Number.NaN : Date.parse(recent.at);
      let skills: number | undefined;
      try {
        skills = this.runtime.extensions.invocable(reservedCommandNames()).length;
      } catch {
        skills = undefined;
      }
      return pickHint({
        firstRun: !resumed && list.length === 0,
        resumable: Number.isFinite(recentAt) && Date.now() - recentAt < RESUME_HINT_MS ? relativeTime(recentAt) : undefined,
        skills,
        seed: Math.floor(Date.now() / 1000),
        sep: this.glyphs.sep,
      });
    } catch {
      return undefined;
    }
  }

  /** The first-run setup shows once, in an interactive terminal, unless CI or SYN_NO_SETUP says otherwise. */
  private shouldOnboard(): boolean {
    const on = (name: string): boolean => {
      const value = this.io.env[name];
      return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
    };
    return this.renderer.controls?.appearance !== undefined && this.io.stdinIsTTY && this.runtime.config.onboarded !== true && !on("CI") && !on("SYN_NO_SETUP");
  }

  private async saveQuietly(key: string, value: string): Promise<void> {
    try {
      await setUserSetting(this.runtime.home, key, value);
    } catch (error) {
      this.note("warning", `${this.glyphs.warn} ${key} not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** `/setup` (and the first run): theme, welcome style and symbols, each with a live preview; Esc skips the rest. */
  public async setup(first = false): Promise<void> {
    const g = this.glyphs;
    const appearance = this.renderer.controls?.appearance;
    if (appearance === undefined) {
      this.print([`Setup runs in the interactive terminal view ${g.sep} here: /config ui.theme <name>, ui.welcome.style, ui.glyphs (or syn config set)`]);
      return;
    }
    if (first) this.note("info", `${g.bullet} Welcome to Synorch ${g.sep} three quick choices ${g.sep} Esc skips (/setup runs it again)`);
    const signal = this.outer.signal;
    const done: string[] = [];
    const finish = async (skipped: boolean): Promise<void> => {
      if (first || !skipped) await this.saveQuietly("ui.onboarded", "true");
      if (done.length === 0) this.print([first ? `Setup skipped ${g.sep} /setup runs it any time` : "Setup cancelled"]);
      else this.print([`${g.ok} Saved: ${done.join(", ")}${skipped ? " (rest skipped)" : ""} ${g.sep} /setup to change`]);
    };
    const theme = await appearance.pickTheme(signal, "1/3");
    if (theme === undefined) return finish(true);
    await this.saveQuietly("ui.theme", theme);
    done.push(`${theme} theme`);
    const style = await appearance.pickWelcomeStyle(signal, "2/3");
    if (style === undefined) return finish(true);
    await this.saveQuietly("ui.welcome.style", style);
    done.push(`${style} welcome`);
    const glyphs = await appearance.pickGlyphs(signal, "3/3");
    if (glyphs === undefined) return finish(true);
    await this.saveQuietly("ui.glyphs", glyphs);
    done.push(`${glyphs} symbols${glyphs === this.glyphs.name ? "" : " (next session)"}`);
    return finish(false);
  }

  /** `/theme [name]`: the picker with a live preview, or switch directly; saved to ui.theme. */
  public async theme(argument: string): Promise<void> {
    const name = argument.trim().toLowerCase();
    if (name !== "") {
      await this.applySetting("ui.theme", name);
      return;
    }
    const appearance = this.renderer.controls?.appearance;
    if (appearance === undefined) {
      this.print([`Themes: ${BUILTIN_THEMES.map((theme) => theme.name).join(", ")} ${this.glyphs.sep} /theme <name> saves one (the interactive view previews them)`]);
      return;
    }
    const picked = await appearance.pickTheme(this.outer.signal);
    if (picked !== undefined) await this.applySetting("ui.theme", picked);
  }

  /** `/welcome [full|compact|minimal|off]`: the header's style directly, or the whole customization with a live preview. */
  public async welcome(argument: string): Promise<void> {
    const g = this.glyphs;
    const word = argument.trim().toLowerCase();
    if (word !== "") {
      if ((["full", "compact", "minimal", "off"] as const).some((style) => style === word)) await this.applySetting("ui.welcome.style", word);
      else this.print([`/welcome [full | compact | minimal | off] ${g.sep} alone: customize it with a live preview`]);
      return;
    }
    const appearance = this.renderer.controls?.appearance;
    if (appearance === undefined) {
      this.print([`The welcome header belongs to the interactive view ${g.sep} /config ui.welcome.style | ui.welcome.logo | ui.welcome.fields | ui.welcome.tips`]);
      return;
    }
    const before = appearance.welcome;
    const chosen = await appearance.pickWelcome(this.outer.signal);
    if (chosen === undefined) return;
    if (chosen.style !== before.style) await this.saveQuietly("ui.welcome.style", chosen.style);
    if (chosen.logo !== before.logo) await this.saveQuietly("ui.welcome.logo", chosen.logo);
    if (chosen.fields.join(",") !== before.fields.join(",")) await this.saveQuietly("ui.welcome.fields", chosen.fields.length === 0 ? "none" : chosen.fields.join(","));
    if (chosen.tips !== before.tips) await this.saveQuietly("ui.welcome.tips", String(chosen.tips));
    this.print([`${g.ok} Welcome: ${chosen.style} ${g.sep} logo ${chosen.logo} ${g.sep} ${chosen.fields.length} fact${chosen.fields.length === 1 ? "" : "s"} ${g.sep} tips ${chosen.tips ? "on" : "off"} ${g.sep} saved`]);
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

/** Provider failures a sign-in fixes. */
const AUTH_FAILURES: ReadonlySet<string> = new Set(["unauthenticated", "auth_expired"]);

const PERMISSION_MODE_WORDS = ["ask", "auto", "full", "plan"] as const;

/** K8: the welcome hint offers /resume for a conversation newer than this. */
const RESUME_HINT_MS = 12 * 60 * 60 * 1000;

/** `ui.welcome.<key>` set (or unset: the default) applied to the live welcome preferences. */
function welcomeWith(current: WelcomePreferences, key: string, value: string | undefined): WelcomePreferences {
  const field = key.slice("ui.welcome.".length);
  if (field === "style") return { ...current, style: (["full", "compact", "minimal", "off"] as const).find((style) => style === value) ?? "full" };
  if (field === "logo") return { ...current, logo: (["on", "art", "glyph", "off", "custom"] as const).find((logo) => logo === value) ?? "on" };
  if (field === "tips") return { ...current, tips: value === undefined ? true : value === "true" };
  if (field === "fields") {
    const all = ["version", "model", "plan", "workers", "folder", "mode"] as const;
    const wanted = value?.split(",").map((part) => part.trim());
    return { ...current, fields: wanted === undefined ? [...all] : all.filter((name) => wanted.includes(name)) };
  }
  return current;
}

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
