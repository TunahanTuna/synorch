import {
  createId,
  type ApprovalBroker,
  type AuthInteraction,
  type HarnessErrorInfo,
  type InteractiveInputControls,
  type PolicyMode,
  type RenderEvent,
  type RunId,
  type SessionEvent,
  type SessionHeaderView,
  type SessionId,
  type TerminalRenderer,
} from "../contracts/index.ts";
import type { ViewHost } from "../contracts/views.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import {
  createPiTuiRenderer,
  HeadlessApprovalBroker,
  HeadlessAuthInteraction,
  JsonlRenderer,
  PlainLineRenderer,
  type FrameSink,
  type GlyphSet,
  type GuardProcess,
  type InputStream,
  type PiTuiRendererOptions,
  type ResultData,
} from "../tui/index.ts";

/**
 * Renderer construction for runtime commands. JSONL is special: its `hello` frame names the run
 * and session, which the coordinator creates. `DeferredJsonlRenderer` therefore buffers events
 * until the run log's `run/created` arrives and only then writes `hello`, so every frame carries
 * the real run id; a failure before that point still yields a valid `hello` + `error` sequence.
 */

export interface RendererIO {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: FrameSink & { readonly isTTY?: boolean };
  readonly stderr: FrameSink;
  readonly stdin: InputStream | undefined;
  readonly platform: NodeJS.Platform;
  /** The real process (signal hooks, terminal restore); absent in tests. */
  readonly process: GuardProcess | undefined;
  /** A terminal for the interactive renderer instead of the process console (virtual-terminal tests and smoke runs). */
  readonly terminal?: PiTuiRendererOptions["terminal"];
}

export interface RendererRequest {
  readonly kind: "tui" | "plain" | "jsonl";
  readonly color: boolean;
  readonly policyMode: PolicyMode;
  readonly streamDeltas: boolean;
  /** `syn agent` reads user input; `syn run` only needs input for prompts. */
  readonly wantsInput: boolean;
  /** A human can answer prompts (stdin is a TTY). */
  readonly interactive: boolean;
  readonly fallbackSessionId: SessionId | undefined;
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
  /** `conversation`: the quiet conversation view of `syn agent` (ADR-21). */
  readonly view?: "events" | "conversation";
  readonly glyphs?: GlyphSet;
  readonly debug?: boolean;
}

export interface SessionRenderer extends TerminalRenderer {
  /** JSONL only: writes the single terminal frame. Other renderers ignore it. */
  result(data: ResultData): Promise<void>;
  fail(error: HarnessErrorInfo): Promise<void>;
  readonly exitCode: number | undefined;
  /** Conversation view: draws the earlier messages of a resumed conversation. */
  replay?(events: readonly SessionEvent[]): void;
  /** K1-U3 view host (cards, live board, plan graph) of the pi-tui and plain renderers; absent for JSONL. */
  readonly views?: ViewHost | undefined;
}

export class DeferredJsonlRenderer implements SessionRenderer {
  public readonly kind = "jsonl" as const;
  public readonly input = undefined;
  public readonly approvals: ApprovalBroker;
  public readonly auth: AuthInteraction;
  private readonly io: RendererIO;
  private readonly request: RendererRequest;
  private inner: JsonlRenderer | undefined;
  private header: SessionHeaderView | undefined;
  private readonly buffered: RenderEvent[] = [];

  public constructor(io: RendererIO, request: RendererRequest) {
    this.io = io;
    this.request = request;
    this.approvals = new HeadlessApprovalBroker(request.policyMode);
    this.auth = new HeadlessAuthInteraction((text) => io.stderr.write(text));
  }

  public get exitCode(): number | undefined {
    return this.inner?.exitCode;
  }

  public async start(header: SessionHeaderView): Promise<void> {
    this.header = header;
  }

  public render(event: RenderEvent): void {
    if (this.inner !== undefined) {
      this.inner.render(event);
      return;
    }
    if (event.kind === "notice") {
      this.io.stderr.write(`${event.level}: ${event.message}\n`);
      return;
    }
    if (event.kind === "session-event" && event.event.type === "run/created" && event.event.run_id !== undefined) {
      this.open(event.event.run_id, event.event.session_id).render(event);
      return;
    }
    this.buffered.push(event);
  }

  private open(runId: RunId, sessionId: SessionId): JsonlRenderer {
    if (this.inner !== undefined) return this.inner;
    const inner = new JsonlRenderer({
      runId,
      sessionId,
      policyMode: this.request.policyMode,
      streamDeltas: this.request.streamDeltas,
      harnessVersion: SYNORCH_VERSION,
      stdout: this.io.stdout,
      stderr: (text) => this.io.stderr.write(text),
    });
    this.inner = inner;
    void inner.start(this.header ?? emptyHeader(this.request.policyMode));
    for (const queued of this.buffered.splice(0)) inner.render(queued);
    return inner;
  }

  private ensure(): JsonlRenderer {
    return this.inner ?? this.open(createId("run"), this.request.fallbackSessionId ?? createId("session"));
  }

  public async result(data: ResultData): Promise<void> {
    await this.ensure().result(data);
  }

  public async fail(error: HarnessErrorInfo): Promise<void> {
    await this.ensure().fail(error);
  }

  public async stop(reason: "completed" | "error" | "signal"): Promise<void> {
    await this.ensure().stop(reason);
  }
}

class HumanRenderer implements SessionRenderer {
  public readonly kind: "tui" | "plain";
  public readonly exitCode = undefined;
  private readonly inner: TerminalRenderer;

  /** K1-U1 interactive controls (palette, attachments, model picker, plan and mouse modes); interactive renderer only. */
  public readonly controls?: InteractiveInputControls;

  public constructor(inner: TerminalRenderer) {
    this.inner = inner;
    this.kind = inner.kind === "tui" ? "tui" : "plain";
    if (inner.controls !== undefined) this.controls = inner.controls;
  }

  public get input() {
    return this.inner.input;
  }

  public get approvals() {
    return this.inner.approvals;
  }

  public get auth() {
    return this.inner.auth;
  }

  /** K1-U3 views, when the inner renderer hosts them. */
  public get views(): ViewHost | undefined {
    const inner = this.inner as Partial<ViewHost>;
    return typeof inner.showView === "function" && typeof inner.setBoard === "function" && typeof inner.showGraph === "function" ? (inner as ViewHost) : undefined;
  }

  public start(header: SessionHeaderView): Promise<void> {
    return this.inner.start(header);
  }

  public render(event: RenderEvent): void {
    this.inner.render(event);
  }

  public replay(events: readonly SessionEvent[]): void {
    (this.inner as { replay?: (events: readonly SessionEvent[]) => void }).replay?.(events);
  }

  public async result(): Promise<void> {}

  public async fail(): Promise<void> {}

  public stop(reason: "completed" | "error" | "signal"): Promise<void> {
    return this.inner.stop(reason);
  }
}

export function emptyHeader(policyMode: PolicyMode): SessionHeaderView {
  return { workspaceRoot: ".", gitBranch: undefined, policyMode, routes: [], sandboxEnforcement: "unavailable", notices: [] };
}

export async function createSessionRenderer(io: RendererIO, request: RendererRequest): Promise<SessionRenderer> {
  if (request.kind === "jsonl") return new DeferredJsonlRenderer(io, request);
  const environment = { platform: io.platform, env: io.env };
  const lifecycle =
    io.process === undefined
      ? undefined
      : {
          process: io.process,
          onSignal: () => request.onExit(),
          onCrash: (error: unknown) => {
            io.stderr.write(`Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
            request.onExit();
          },
        };
  if (request.kind === "tui") {
    return new HumanRenderer(
      await createPiTuiRenderer({
        color: request.color,
        policyMode: request.policyMode,
        environment,
        onInterrupt: request.onInterrupt,
        onExit: request.onExit,
        ...(lifecycle === undefined ? {} : { lifecycle }),
        ...(request.view === undefined ? {} : { view: request.view }),
        ...(request.glyphs === undefined ? {} : { glyphs: request.glyphs }),
        ...(request.debug === undefined ? {} : { debug: request.debug }),
        ...(io.terminal === undefined ? {} : { terminal: io.terminal }),
      }),
    );
  }
  return new HumanRenderer(
    new PlainLineRenderer({
      stdout: (text) => void io.stdout.write(text),
      stderr: (text) => void io.stderr.write(text),
      color: request.color,
      policyMode: request.policyMode,
      ...(io.stdin === undefined || (!request.wantsInput && !request.interactive) ? {} : { input: io.stdin }),
      interactive: request.interactive && io.stdin !== undefined,
      environment,
      onInterrupt: request.onInterrupt,
      onExit: request.onExit,
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(request.view === undefined ? {} : { view: request.view }),
      ...(request.glyphs === undefined ? {} : { glyphs: request.glyphs }),
      ...(request.debug === undefined ? {} : { debug: request.debug }),
    }),
  );
}
