import path from "node:path";
import {
  EXIT_CODES,
  exitCodeFor,
  HarnessError,
  type Coordinator,
  type HarnessErrorInfo,
  type RenderEvent,
  type RunOutcome,
  type SessionEvent,
  type SessionId,
} from "../contracts/index.ts";
import { formatHarnessError, type InputStream } from "../tui/index.ts";
import type { ParsedCommand } from "./args.ts";
import { failureInfo } from "./outcome.ts";
import { createSessionRenderer, type RendererIO, type SessionRenderer } from "./renderers.ts";
import { headerFor, isResultOutcome, outcomeError, resultData, runEvents } from "./run-summary.ts";
import { createRuntime, type Runtime, type RuntimeOverrides } from "./runtime.ts";
import { handleSlashCommand } from "./slash-commands.ts";
import { resolveTerminalSettings, streamHasColors } from "./terminal.ts";

/**
 * `syn run` and `syn agent`: one coordinator run per goal (plan -> autonomous or asked approval ->
 * DAG -> workers -> independent review -> per-criterion report). Every session event of the run and
 * of its attempt sessions, and every model stream event, reaches the renderer through the runtime.
 */

export interface SessionIO extends RendererIO {
  readonly cwd: string;
  readonly stdinIsTTY: boolean;
  readonly signal: AbortSignal | undefined;
}

type RunCommand = Extract<ParsedCommand, { kind: "run" }>;
type AgentCommand = Extract<ParsedCommand, { kind: "agent" }>;

function linked(outer: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (outer?.aborted === true) controller.abort(outer.reason);
  else outer?.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
  return controller;
}

function readAll(stream: InputStream): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    const onData = (chunk: string | Buffer): void => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };
    const onEnd = (): void => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      resolve(text);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.resume?.();
  });
}

function requireOrchestratorRoute(runtime: Runtime): void {
  if (runtime.config.router.rules.some((rule) => rule.tier === "orchestrator")) return;
  throw new HarnessError({
    code: "config_invalid",
    message: `no model route is configured for tier orchestrator; add a routes entry to ${path.join(runtime.home, "config.yaml")} or pass --profile orchestrator=<provider>/<model>`,
    workspace_effect: "none",
    retry_safe: true,
    next_command: "syn doctor --runtime",
  });
}

async function reportError(renderer: SessionRenderer | undefined, io: SessionIO, error: HarnessErrorInfo): Promise<number> {
  if (renderer?.kind === "jsonl") {
    await renderer.fail(error);
    await renderer.stop("error");
    return renderer.exitCode ?? exitCodeFor(error.code);
  }
  await renderer?.stop("error");
  io.stderr.write(formatHarnessError(error));
  return exitCodeFor(error.code);
}

function describeOutcome(outcome: RunOutcome): string {
  return `Run ${outcome.runId} ${outcome.status} (exit ${outcome.exitCode}); session ${outcome.sessionId}\n${outcome.summary}\n`;
}

interface Session {
  readonly runtime: Runtime;
  readonly renderer: SessionRenderer;
  readonly coordinator: Coordinator;
  readonly events: SessionEvent[];
  readonly dispose: () => void;
}

async function openSession(
  parsed: RunCommand | AgentCommand,
  io: SessionIO,
  overrides: RuntimeOverrides,
  controls: { onInterrupt: () => void; onExit: () => void },
): Promise<Session | { readonly failed: number }> {
  const jsonl = parsed.kind === "run" && parsed.jsonl;
  const workspaceRoot = path.resolve(io.cwd, parsed.common.target ?? ".");
  let runtime: Runtime | undefined;
  let failure: HarnessErrorInfo | undefined;
  try {
    runtime = await createRuntime({ workspaceRoot, env: io.env, policyMode: parsed.session.policy, routes: parsed.session.profiles, overrides });
    requireOrchestratorRoute(runtime);
  } catch (error) {
    failure = failureInfo(error);
  }
  const settings = resolveTerminalSettings(
    { jsonl, plain: parsed.common.plain, color: parsed.common.color, configColor: runtime?.config.color },
    {
      env: io.env,
      stdinIsTTY: io.stdinIsTTY,
      stdoutIsTTY: io.stdout.isTTY === true,
      stdoutHasColors: streamHasColors(io.stdout),
      stderrHasColors: streamHasColors(io.stderr as { isTTY?: boolean; hasColors?: () => boolean }),
    },
  );
  const renderer = await createSessionRenderer(io, {
    kind: settings.kind,
    color: settings.color,
    policyMode: parsed.session.policy,
    streamDeltas: parsed.kind === "run" && parsed.streamDeltas,
    wantsInput: parsed.kind === "agent",
    interactive: io.stdinIsTTY,
    fallbackSessionId: parsed.kind === "agent" ? (parsed.resume ?? parsed.fork?.sessionId) : undefined,
    onInterrupt: controls.onInterrupt,
    onExit: controls.onExit,
  });
  if (runtime === undefined || failure !== undefined) return { failed: await reportError(renderer, io, failure ?? failureInfo(new Error("runtime unavailable"))) };

  const events: SessionEvent[] = [];
  const unsubscribe = runtime.subscribe((event: RenderEvent) => {
    if (event.kind === "session-event") events.push(event.event);
    renderer.render(event);
  });
  const coordinator = runtime.createCoordinator(runtime.brokerFor(renderer.approvals));
  const stopNotices = coordinator.onEvent((event) => {
    if (event.kind === "notice") renderer.render(event);
  });
  return {
    runtime,
    renderer,
    coordinator,
    events,
    dispose: () => {
      unsubscribe();
      stopNotices();
    },
  };
}

export async function runCommand(parsed: RunCommand, io: SessionIO, overrides: RuntimeOverrides): Promise<number> {
  const controller = linked(io.signal);
  const opened = await openSession(parsed, io, overrides, { onInterrupt: () => controller.abort(), onExit: () => controller.abort() });
  if ("failed" in opened) return opened.failed;
  const { runtime, renderer, coordinator, events } = opened;
  const onSigint = (): void => controller.abort();
  const sigintProcess = renderer.kind === "jsonl" || io.process === undefined ? io.process : undefined;
  (sigintProcess as NodeJS.Process | undefined)?.on?.("SIGINT", onSigint);
  try {
    await renderer.start(headerFor(runtime));
    const goal = parsed.goalFromStdin && io.stdin !== undefined ? (await readAll(io.stdin)).trim() : parsed.goal;
    if (goal === "") return await reportError(renderer, io, { code: "usage_invalid", message: "the goal read from stdin is empty", workspace_effect: "none", retry_safe: true });
    const outcome = await coordinator.run(
      {
        goal,
        workspaceRoot: runtime.workspaceRoot,
        policyMode: parsed.session.policy,
        headless: renderer.approvals.availability === "headless",
        resumeSessionId: undefined,
        budget: runtime.config.budget,
      },
      controller.signal,
    );
    const mine = runEvents(events, outcome.runId);
    if (renderer.kind === "jsonl") {
      if (isResultOutcome(outcome)) await renderer.result(resultData(outcome, mine));
      else await renderer.fail(outcomeError(outcome));
      await renderer.stop(outcome.exitCode === EXIT_CODES.cancelled ? "signal" : "completed");
      return outcome.exitCode;
    }
    await renderer.stop(outcome.exitCode === EXIT_CODES.success ? "completed" : "error");
    io.stdout.write(describeOutcome(outcome));
    if (!isResultOutcome(outcome)) io.stderr.write(formatHarnessError(outcomeError(outcome)));
    return outcome.exitCode;
  } catch (error) {
    return await reportError(renderer, io, failureInfo(controller.signal.aborted && !(error instanceof HarnessError) ? new DOMException("aborted", "AbortError") : error));
  } finally {
    (sigintProcess as NodeJS.Process | undefined)?.removeListener?.("SIGINT", onSigint);
    opened.dispose();
  }
}

/**
 * While a run is active in a terminal, typed messages steer it at the next safe boundary and slash
 * commands (notably /cancel) still work. Resolves true when the user asked to leave (EOF or /exit).
 */
async function steerWhileRunning(
  input: NonNullable<SessionRenderer["input"]>,
  signal: AbortSignal,
  context: Parameters<typeof handleSlashCommand>[1],
  coordinator: Coordinator,
  notify: (lines: readonly string[]) => void,
): Promise<boolean> {
  for (;;) {
    let next;
    try {
      next = await input.next(signal);
    } catch {
      return false;
    }
    if (next.kind === "exit") return true;
    if (!("text" in next)) continue;
    const text = next.text.trim();
    if (text === "") continue;
    if (next.kind === "command" || text.startsWith("/")) {
      const handled = await handleSlashCommand(text, context);
      if (handled.exit) {
        context.cancel();
        return true;
      }
      notify(handled.lines);
      continue;
    }
    coordinator.steer(text);
    notify(["queued as steering for the next safe boundary"]);
  }
}

async function lastSeqOf(runtime: Runtime, sessionId: SessionId): Promise<number> {
  const reader = await runtime.sessions.openForRead(sessionId);
  let last = 0;
  for await (const item of reader.read()) if (item.status === "ok") last = item.event.seq;
  return last;
}

export async function agentCommand(parsed: AgentCommand, io: SessionIO, overrides: RuntimeOverrides): Promise<number> {
  const outer = linked(io.signal);
  let active: AbortController | undefined;
  let exiting = false;
  const opened = await openSession(parsed, io, overrides, {
    onInterrupt: () => active?.abort(),
    onExit: () => {
      exiting = true;
      active?.abort();
      outer.abort();
    },
  });
  if ("failed" in opened) return opened.failed;
  const { runtime, renderer, coordinator, events } = opened;
  const notify = (lines: readonly string[], level: "info" | "warning" = "info"): void => {
    for (const line of lines) renderer.render({ kind: "notice", level, message: line });
  };
  let exitCode: number = EXIT_CODES.success;
  try {
    let sessionId: SessionId | undefined;
    const notices: string[] = [];
    if (parsed.resume !== undefined) {
      const reports = await runtime.recover(parsed.resume);
      sessionId = parsed.resume;
      for (const report of reports) {
        notices.push(
          `recovered ${report.sessionId}: ${report.recovered.length} open item(s) closed, ${report.interruptedToolCalls.length} tool call(s) interrupted with unknown outcome (not re-run), ${report.cancelledToolCalls.length} cancelled` +
            (report.tornTail === undefined ? "" : `, torn tail of ${report.tornTail.bytes} bytes quarantined`),
        );
      }
    } else if (parsed.fork !== undefined) {
      const upTo = parsed.fork.upToSeq ?? (await lastSeqOf(runtime, parsed.fork.sessionId));
      const forked = await runtime.sessions.fork(parsed.fork.sessionId, upTo);
      sessionId = forked.sessionId;
      await forked.close();
      notices.push(`forked ${parsed.fork.sessionId}@${upTo} into ${forked.sessionId}`);
    }
    await renderer.start(headerFor(runtime, notices));
    const input = renderer.input;
    if (input === undefined) {
      notify(["syn agent needs input: attach a terminal or pipe goals on stdin, one per line"], "warning");
      return EXIT_CODES.usage;
    }
    for (;;) {
      if (exiting || outer.signal.aborted) break;
      let next;
      try {
        next = await input.next(outer.signal);
      } catch {
        break;
      }
      if (next.kind === "exit") break;
      if (!("text" in next)) continue;
      const text = next.text.trim();
      if (text === "") continue;
      if (next.kind === "command" || text.startsWith("/")) {
        const handled = await handleSlashCommand(text, { runtime, events, sessionId, cancel: () => active?.abort() });
        if (handled.exit) break;
        notify(handled.lines);
        continue;
      }
      active = linked(outer.signal);
      const running = active;
      const pending = coordinator.run(
        {
          goal: text,
          workspaceRoot: runtime.workspaceRoot,
          policyMode: parsed.session.policy,
          headless: renderer.approvals.availability === "headless",
          resumeSessionId: sessionId,
          budget: runtime.config.budget,
        },
        running.signal,
      );
      const stopReading = new AbortController();
      const reader = io.stdinIsTTY ? steerWhileRunning(input, stopReading.signal, { runtime, events, sessionId, cancel: () => running.abort() }, coordinator, notify) : Promise.resolve(false);
      const outcome = await pending;
      stopReading.abort();
      const ended = await reader;
      active = undefined;
      sessionId = outcome.sessionId;
      exitCode = outcome.exitCode;
      notify(describeOutcome(outcome).trimEnd().split("\n"), outcome.exitCode === EXIT_CODES.success ? "info" : "warning");
      if (ended) break;
    }
    await renderer.stop("completed");
    if (sessionId !== undefined) io.stderr.write(`Session saved: ${sessionId} (resume with syn agent --resume ${sessionId})\n`);
    return exitCode;
  } catch (error) {
    return await reportError(renderer, io, failureInfo(error));
  } finally {
    opened.dispose();
  }
}
