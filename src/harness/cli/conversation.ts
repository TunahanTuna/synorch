import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createId,
  EVENT_VERSIONS,
  EXIT_CODES,
  exitCodeFor,
  HarnessError,
  WORKSPACE_UNTRUSTED_CODE,
  workspaceDigest,
  type AgentDriver,
  type BlobRef,
  type Coordinator,
  type Digest,
  type EffectivePolicy,
  type EventStore,
  type HarnessErrorInfo,
  type RenderEvent,
  type RouteDecision,
  type RouteRule,
  type SessionEvent,
  type SessionEventDraft,
  type SessionEventOf,
  type SessionHeaderView,
  type SessionId,
  type ToolCallRequest,
  type ToolGateway,
  type TurnId,
} from "../contracts/index.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import { DEFAULT_CONTEXT_WINDOW } from "../context/index.ts";
import { evaluateExecAllowlist } from "../policy/index.ts";
import { describeEvent, formatHarnessError, GLYPH_SETS, patchPaths, selectGlyphs, type GlyphSet } from "../tui/index.ts";
import type { ParsedCommand } from "./args.ts";
import { profileHintsFor } from "./canonical.ts";
import { createCommandGrantStore, normalizeGrant, type CommandGrantStore } from "./command-grants.ts";
import { failureInfo } from "./outcome.ts";
import { createSessionRenderer, type SessionRenderer } from "./renderers.ts";
import { createRuntime, type Runtime, type RuntimeOverrides } from "./runtime.ts";
import type { SessionIO } from "./session.ts";
import { handleSlashCommand } from "./slash-commands.ts";
import { resolveTerminalSettings, streamHasColors } from "./terminal.ts";
import { promptTrustForCommand } from "./trust.ts";

/**
 * `syn agent`: the conversation-first main agent (ADR-21). Every user message is one turn of the
 * `session` role on the existing `AgentDriver`: no pre-flight model call, no plan, no run. The
 * agent answers, reads, edits the main tree and runs commands through the same tool gateway and
 * rails as every role; each edit leaves a checkpoint (`/undo`), workspace trust is asked at the
 * first command that runs repository code, and `/allow` extends the exec allowlist. `/plan <goal>`
 * hands a large goal to the existing coordinator (plan → workers → independent review).
 */

type AgentCommand = Extract<ParsedCommand, { kind: "agent" }>;

const MAX_STEPS = 50;
const CONVERSATION_TITLE = "chat: ";
const WRITE_TOOLS = new Set(["apply_patch", "write_file"]);
const REPLAY_EXCHANGES = 3;

const HELP_LINES = [
  "/undo            revert the last edit Synorch made (files only; command side effects stay)",
  "/allow <prefix>  let Synorch run commands starting with <prefix> here (/allow lists them)",
  "/trust           trust this folder so build/test commands may run",
  "/plan <goal>     plan a large goal with parallel workers and independent review",
  "/diff            files changed by Synorch in this conversation",
  "/context         what the model saw in its last request",
  "/permissions     what Synorch may do here",
  "/model           which model each role uses",
  "/log [n]         raw event log of this conversation (debug)",
  "/cancel          stop the current work (the conversation stays resumable)",
  "/help            this list · Esc interrupts · Ctrl+O tool details · Ctrl+C twice exits",
  "/exit            leave (resume with syn agent --continue)",
];

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

function sessionRouteRule(runtime: Runtime): RouteRule | undefined {
  const rules = runtime.config.router.rules;
  return rules.find((rule) => rule.tier === "session" && (rule.role === undefined || rule.role === "session")) ?? rules.find((rule) => rule.tier === "orchestrator" && (rule.role === undefined || rule.role === "session"));
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

/** `ask_user` while the TUI reads input concurrently: the next typed message answers the question. */
class QuestionDesk {
  private pending: ((answer: string) => void) | undefined;

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

export async function conversationCommand(parsed: AgentCommand, io: SessionIO, overrides: RuntimeOverrides): Promise<number> {
  return new Conversation(parsed, io, overrides).run();
}

class Conversation {
  private readonly parsed: AgentCommand;
  private readonly io: SessionIO;
  private readonly overrides: RuntimeOverrides;
  private readonly outer: AbortController;
  private readonly desk = new QuestionDesk();
  private readonly requests = new Set<string>();
  private readonly pendingNotes: string[] = [];
  private runtime!: Runtime;
  private renderer!: SessionRenderer;
  private glyphs: GlyphSet = GLYPH_SETS.ascii;
  private grants: CommandGrantStore | undefined;
  private grantList: readonly string[] = [];
  private routePromise: Promise<RouteDecision> | undefined;
  private routeRecorded = false;
  private sessionId: SessionId | undefined;
  private log: EventStore | undefined;
  private driver: AgentDriver | undefined;
  private coordinator: Coordinator | undefined;
  private policyCache: EffectivePolicy | undefined;
  private active: AbortController | undefined;
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
      runtime = await createRuntime({ workspaceRoot, env: io.env, policyMode: this.parsed.session.policy, routes: this.parsed.session.profiles, overrides: this.overrides });
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
      onInterrupt: () => this.active?.abort(),
      onExit: () => {
        this.exiting = true;
        this.active?.abort();
        this.outer.abort();
      },
      view: "conversation",
      glyphs: this.glyphs,
      debug: this.debug,
    });
    if (runtime === undefined || failure !== undefined) return this.fail(failure ?? failureInfo(new Error("runtime unavailable")));
    this.runtime = runtime;
    const rule = sessionRouteRule(runtime);
    if (rule === undefined) return this.fail(failureInfo(missingRoute(runtime)));
    // Resolving the route may probe the provider's capabilities: it runs while the user types.
    this.routePromise = runtime.router.resolve({ tier: rule.tier, role: "session" }, this.outer.signal);
    this.routePromise.catch(() => undefined);

    const unsubscribe = runtime.subscribe((event) => this.forward(event));
    const unbind = io.stdinIsTTY && this.renderer.input !== undefined ? runtime.bindUserPrompt((question, options, signal) => this.askUser(question, options, signal)) : () => undefined;
    try {
      this.grants = createCommandGrantStore(runtime.home, runtime.trust.state().root);
      this.grantList = await this.grants.list();
      const resumed = await this.openResumed();
      await this.renderer.start(this.header(rule));
      if (resumed !== undefined) this.showResumed(resumed);
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
      unbind();
      unsubscribe();
      await this.log?.close().catch(() => undefined);
    }
  }

  private async fail(error: HarnessErrorInfo): Promise<number> {
    await this.renderer.stop("error").catch(() => undefined);
    this.io.stderr.write(formatHarnessError(error));
    return exitCodeFor(error.code);
  }

  private header(rule: RouteRule): SessionHeaderView {
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
    };
  }

  private note(level: "info" | "warning" | "error", message: string): void {
    this.renderer.render({ kind: "notice", level, message });
  }

  /** Only this conversation's events and model streams reach the view; worker and coordinator traffic stays out (K1 adds the board). */
  private forward(event: RenderEvent): void {
    if (event.kind === "session-event") {
      const recorded = event.event;
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
    this.renderer.render(event);
  }

  // ---- sessions -------------------------------------------------------------------------------

  private async latestConversation(): Promise<SessionId | undefined> {
    const summaries = await this.runtime.sessions.list(this.runtime.projectId);
    const chats = summaries
      .filter((summary) => summary.manifest.title?.startsWith(CONVERSATION_TITLE) === true && !summary.locked)
      .sort((left, right) => (right.lastEventAt ?? right.manifest.created_at).localeCompare(left.lastEventAt ?? left.manifest.created_at));
    return chats[0]?.manifest.session_id;
  }

  private async openResumed(): Promise<{ readonly events: readonly SessionEvent[]; readonly createdAt: string | undefined } | undefined> {
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
    if (sessionId === undefined && this.parsed.continue) {
      sessionId = await this.latestConversation();
      if (sessionId === undefined) this.pendingNotes.length = 0;
    }
    if (sessionId === undefined) return undefined;
    this.sessionId = sessionId;
    await this.runtime.recover(sessionId);
    this.log = await this.runtime.sessions.openForWrite(sessionId);
    const events: SessionEvent[] = [];
    for await (const item of this.log.read()) if (item.status === "ok") events.push(item.event);
    this.routeRecorded = events.some((event) => event.type === "route/decided");
    return { events, createdAt: events[0]?.timestamp };
  }

  private showResumed(resumed: { readonly events: readonly SessionEvent[]; readonly createdAt: string | undefined }): void {
    const events = resumed.events;
    const users = events.flatMap((event, index) => (event.type === "message/recorded" && event.data.role === "user" ? [index] : []));
    const last = events.at(-1);
    const ago = last === undefined ? "" : ` ${this.glyphs.sep} ${relativeTime(Date.parse(last.timestamp))}`;
    const firstShown = users.length > REPLAY_EXCHANGES ? (users[users.length - REPLAY_EXCHANGES] ?? 0) : 0;
    const folded = users.length > REPLAY_EXCHANGES ? users.length - REPLAY_EXCHANGES : 0;
    this.note("info", `${this.glyphs.resume} Resumed${ago} ${this.glyphs.sep} ${users.length} message${users.length === 1 ? "" : "s"}${folded === 0 ? "" : ` ${this.glyphs.sep} ${folded} earlier not shown`}`);
    this.renderer.replay?.(events.slice(firstShown));
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

  private policy(): EffectivePolicy {
    this.policyCache ??= this.runtime.sessionPolicy(this.grantList);
    return this.policyCache;
  }

  private ensureDriver(log: EventStore): AgentDriver {
    this.driver ??= this.runtime.createSessionDriver(this.runtime.brokerFor(this.renderer.approvals), log, (gateway) => this.wrap(gateway));
    return this.driver;
  }

  /**
   * The conversation's decorations around the one gateway: the trust question at the first command
   * that runs repository code, the current policy (a trust or /allow decision applies at once), and
   * a checkpoint of every successful edit. Policy, rails and audit stay in the gateway.
   */
  private wrap(inner: ToolGateway): ToolGateway {
    return {
      invoke: async (request, scope, signal) => {
        if (request.tool_name === "exec") await this.trustGate(request, signal);
        const captured = WRITE_TOOLS.has(request.tool_name) ? await this.capture(request).catch(() => undefined) : undefined;
        const outcome = await inner.invoke(request, { ...scope, policy: this.policy() }, signal);
        if (captured !== undefined && captured.length > 0 && outcome.state === "succeeded") {
          await this.checkpoint(request, captured, outcome.result.changed_paths ?? []).catch(() => undefined);
        }
        return outcome;
      },
    };
  }

  private async trustGate(request: ToolCallRequest, signal: AbortSignal): Promise<void> {
    const runtime = this.runtime;
    if (this.trustAsked || runtime.trust.state().trusted || runtime.sandbox.enforcement === "full") return;
    if (this.renderer.approvals.availability !== "interactive") return;
    const argv = strings(request.arguments.argv);
    if (argv === undefined || argv.length === 0) return;
    const policy = this.policy();
    const verdict = evaluateExecAllowlist({
      argv,
      readOnly: false,
      confinement: policy.exec_confinement ?? "allowlist",
      mode: policy.mode,
      verificationCommands: [],
      workspaceTrusted: false,
      commandGrants: policy.command_grants ?? [],
    });
    if (verdict?.code !== WORKSPACE_UNTRUSTED_CODE) return;
    this.trustAsked = true;
    if (await promptTrustForCommand(runtime, this.renderer, argv.join(" "), signal)) this.policyCache = undefined;
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

  private async loop(input: NonNullable<SessionRenderer["input"]>): Promise<void> {
    const queued: string[] = [];
    const concurrent = this.renderer.kind === "tui";
    for (;;) {
      if (this.exiting || this.outer.signal.aborted) return;
      let text = queued.shift();
      if (text === undefined) {
        let next;
        try {
          next = await input.next(this.outer.signal);
        } catch {
          return;
        }
        if (next.kind === "exit") return;
        if (!("text" in next)) continue;
        text = next.text.trim();
        if (text === "") continue;
        if (next.kind === "command" || text.startsWith("/")) {
          if (await this.command(text)) return;
          continue;
        }
      } else if (text.startsWith("/")) {
        if (await this.command(text)) return;
        continue;
      }
      const work = this.turn(text);
      if (concurrent) await this.alongside(work, input, queued);
      else await work;
    }
  }

  /**
   * While work runs in the TUI, typed messages queue for the next turn (or answer a pending
   * question) and slash commands still work; /exit and Ctrl+D leave.
   */
  private async alongside(work: Promise<void>, input: NonNullable<SessionRenderer["input"]>, queued: string[]): Promise<void> {
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
          this.outer.abort();
          return;
        }
        if (!("text" in next)) continue;
        const text = next.text.trim();
        if (text === "") continue;
        if (next.kind === "command" || text.startsWith("/")) {
          const command = text.split(/\s+/)[0]?.toLowerCase() ?? "";
          if (command === "/cancel" || command === "/exit" || command === "/quit" || command === "/help" || command === "/allow" || command === "/log" || command === "/diff") {
            if (await this.command(text)) {
              this.exiting = true;
              this.active?.abort();
              this.outer.abort();
              return;
            }
          } else {
            queued.push(text);
            this.note("info", `queued ${this.glyphs.name === "rich" ? "›" : ">"} ${text}`);
          }
          continue;
        }
        if (this.desk.answer(text)) continue;
        queued.push(text);
        this.note("info", `queued ${this.glyphs.name === "rich" ? "›" : ">"} ${text}`);
      }
    })();
    try {
      await work;
    } finally {
      stop.abort();
      await reader;
    }
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

  private async turn(text: string): Promise<void> {
    this.submittedAt = performance.now();
    let log: EventStore;
    try {
      log = await this.ensureLog(text);
    } catch (error) {
      this.showFailure(failureInfo(error));
      return;
    }
    const driver = this.ensureDriver(log);
    let route: RouteDecision;
    try {
      route = await (this.routePromise ?? Promise.reject(new Error("no route")));
    } catch (error) {
      this.showFailure(failureInfo(error));
      this.routePromise = this.runtime.router.resolve({ tier: sessionRouteRule(this.runtime)?.tier ?? "orchestrator", role: "session" }, this.outer.signal);
      this.routePromise.catch(() => undefined);
      return;
    }
    if (!this.routeRecorded) {
      this.routeRecorded = true;
      await this.append("route/decided", { decision: route }, "agent").catch(() => undefined);
    }
    const notes = this.pendingNotes.splice(0);
    const message = notes.length === 0 ? text : `[Synorch note: ${notes.join(" ")}]\n${text}`;
    const active = linked(this.outer.signal);
    this.active = active;
    try {
      await driver.runTurn(
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
          trigger: "user",
          maxSteps: MAX_STEPS,
        },
        active.signal,
      );
    } catch (error) {
      if (!active.signal.aborted) this.showFailure(failureInfo(error));
    } finally {
      if (this.active === active) this.active = undefined;
      this.submittedAt = undefined;
    }
  }

  private showFailure(error: HarnessErrorInfo): void {
    const workspace = error.workspace_effect === "none" ? "unchanged" : error.workspace_effect === "unknown" ? "may have changed · check git status" : "partly changed";
    this.note("error", `${this.glyphs.fail} ${error.message}`);
    this.note("info", `  Workspace  ${workspace}`);
    if (error.next_command !== undefined) this.note("info", `  Next       ${error.next_command}`);
  }

  // ---- slash commands ---------------------------------------------------------------------------

  /** Resolves true when the user asked to leave. */
  private async command(text: string): Promise<boolean> {
    const [name = "", ...rest] = text.split(/\s+/);
    const argument = text.slice(name.length).trim();
    const lines = (entries: readonly string[]): void => {
      for (const entry of entries) this.note("info", entry);
    };
    switch (name.toLowerCase()) {
      case "/exit":
      case "/quit":
        return true;
      case "/help":
        lines(HELP_LINES);
        return false;
      case "/cancel":
        if (this.active === undefined) lines(["Nothing is running."]);
        else this.active.abort();
        return false;
      case "/undo":
        await this.undo();
        return false;
      case "/allow":
        await this.allow(argument);
        return false;
      case "/trust": {
        this.trustAsked = true;
        if (this.runtime.trust.state().trusted || this.runtime.sandbox.enforcement === "full") lines(["This folder is already trusted."]);
        else if (await promptTrustForCommand(this.runtime, this.renderer, "build and test commands", this.outer.signal)) this.policyCache = undefined;
        return false;
      }
      case "/plan":
      case "/workers":
        await this.orchestrate(argument);
        return false;
      case "/diff":
        lines(await this.diff());
        return false;
      case "/log": {
        const count = Number(rest[0] ?? "20");
        const events = await this.readEvents();
        const shown = events.slice(-Math.max(1, Number.isFinite(count) ? count : 20));
        lines(shown.length === 0 ? ["Nothing recorded yet."] : shown.map((event) => `[event] #${event.seq} ${event.type}${(() => {
          const line = describeEvent(event);
          return line === undefined ? "" : ` · ${line.text}`;
        })()}`));
        return false;
      }
      case "/context":
      case "/permissions":
      case "/model": {
        const result = await handleSlashCommand(name.toLowerCase(), { runtime: this.runtime, events: await this.readEvents(), sessionId: this.sessionId, cancel: () => this.active?.abort() });
        lines(result.lines);
        return false;
      }
      default:
        lines([`Unknown command ${name} ${this.glyphs.sep} /help lists the commands`]);
        return false;
    }
  }

  private async undo(): Promise<void> {
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

  private async allow(argument: string): Promise<void> {
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
    this.grantList = await grants.add(normalized.prefix);
    this.policyCache = undefined;
    await this.ensureLog(`/allow ${normalized.prefix}`).catch(() => undefined);
    await this.append("command/allowed", { workspace_root: this.runtime.trust.state().root, prefix: normalized.prefix }, "user").catch(() => undefined);
    const trustNote = this.runtime.sandbox.enforcement !== "full" && !this.runtime.trust.state().trusted ? " (it runs repository code, so this folder must be trusted too; Synorch asks when it first runs)" : "";
    this.note("info", `${this.glyphs.ok} Allowed commands starting with "${normalized.prefix}" in this folder${trustNote}`);
    this.pendingNotes.push(`the user allowed commands starting with "${normalized.prefix}" (/allow); you may run them now.`);
  }

  private async diff(): Promise<string[]> {
    const events = await this.readEvents();
    const restored = new Set(events.flatMap((event) => (event.type === "checkpoint/restored" ? [event.data.checkpoint_seq] : [])));
    const paths = new Map<string, number>();
    for (const event of events) {
      if (event.type !== "checkpoint/recorded" || restored.has(event.seq)) continue;
      for (const file of event.data.files) paths.set(file.path, (paths.get(file.path) ?? 0) + 1);
    }
    if (paths.size === 0) return ["Synorch has not changed any file in this conversation."];
    return [`Changed by Synorch (not independently reviewed):`, ...[...paths].map(([file, edits]) => `  ${file}${edits > 1 ? ` (${edits} edits)` : ""}`)];
  }

  /** `/plan <goal>` (K0): the existing coordinator path, with a compact summary (the live board is K1). */
  private async orchestrate(goal: string): Promise<void> {
    const g = this.glyphs;
    if (goal === "") {
      this.note("info", "Usage: /plan <goal>  ·  plans the goal, runs parallel workers in their own worktrees and has an independent reviewer check the result");
      return;
    }
    const runtime = this.runtime;
    if (!this.trustAsked && !runtime.trust.state().trusted && runtime.sandbox.enforcement !== "full" && this.renderer.approvals.availability === "interactive") {
      this.trustAsked = true;
      if (await promptTrustForCommand(runtime, this.renderer, "the workers' checks", this.outer.signal)) this.policyCache = undefined;
    }
    this.coordinator ??= runtime.createCoordinator(runtime.brokerFor(this.renderer.approvals));
    const collected: SessionEvent[] = [];
    const stopCollecting = runtime.subscribe((event) => {
      if (event.kind === "session-event") collected.push(event.event);
    });
    this.note("info", `${g.bullet} Workers ${g.sep} planning "${goal}" ${g.sep} this can take a few minutes ${g.sep} /cancel stops it`);
    const active = linked(this.outer.signal);
    this.active = active;
    const started = performance.now();
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
        active.signal,
      );
      const mine = collected.filter((event) => event.run_id === outcome.runId);
      const tasks = new Map<string, { key: string; role: string; state: string }>();
      for (const event of mine) {
        if (event.type === "task/created") tasks.set(event.data.task_id, { key: event.data.key, role: event.data.role, state: "waiting" });
        if (event.type === "task/state_changed") {
          const task = tasks.get(event.data.task_id);
          if (task !== undefined) task.state = event.data.to;
        }
      }
      const elapsed = Math.round((performance.now() - started) / 1000);
      const status = outcome.status === "succeeded" ? "done" : outcome.status;
      this.note(outcome.status === "succeeded" ? "info" : "warning", `${g.bullet} Workers ${g.sep} ${tasks.size} task${tasks.size === 1 ? "" : "s"} ${g.sep} ${status} in ${elapsed}s`);
      for (const task of tasks.values()) {
        const glyph = task.state === "completed" ? g.ok : task.state === "failed" || task.state === "cancelled" || task.state === "blocked" ? g.fail : g.bullet;
        this.note("info", `  ${glyph} ${task.key.padEnd(18)} ${task.role.padEnd(12)} ${task.state.replaceAll("_", " ")}`);
      }
      const summary = outcome.summary.trim().split("\n").filter((line) => line.trim() !== "").slice(0, 6);
      for (const line of summary) this.note("info", `  ${line}`);
      this.pendingNotes.push(`the user ran /plan "${goal}" with workers; the run ${outcome.status}: ${outcome.summary.replace(/\s+/g, " ").slice(0, 600)}`);
    } catch (error) {
      this.showFailure(failureInfo(error));
    } finally {
      stopCollecting();
      if (this.active === active) this.active = undefined;
    }
  }
}

function relativeTime(then: number): string {
  if (!Number.isFinite(then)) return "earlier";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
