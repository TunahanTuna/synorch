import path from "node:path";
import {
  askUserSummaryLine,
  EXIT_CODES,
  exitCodeFor,
  HarnessError,
  type HarnessErrorInfo,
  type RenderEvent,
  type RunOutcome,
  type SessionEvent,
} from "../contracts/index.ts";
import { formatHarnessError, type InputStream } from "../tui/index.ts";
import type { ParsedCommand } from "./args.ts";
import { failureInfo } from "./outcome.ts";
import { createSessionRenderer, type RendererIO, type SessionRenderer } from "./renderers.ts";
import { headerFor, isResultOutcome, outcomeError, resultData, runEvents } from "./run-summary.ts";
import { profileHintsFor } from "./canonical.ts";
import { createRuntime, type Runtime, type RuntimeOverrides, type UserPrompt } from "./runtime.ts";
import { resolveTerminalSettings, streamHasColors } from "./terminal.ts";
import { promptWorkspaceTrust } from "./trust.ts";

/**
 * `syn run "<goal>"`: the headless entry point. One goal goes straight to the coordinator (plan ->
 * autonomous or asked approval -> DAG -> workers -> independent review -> per-criterion report),
 * the same orchestration core the conversation's `orchestrate` tool drives. Every session event of
 * the run and of its attempt sessions, and every model stream event, reaches the renderer through
 * the runtime; `--mode jsonl` keeps the machine contract (hello first, one result or error last).
 * The interactive product is `syn agent` (`cli/conversation.ts`).
 */

export interface SessionIO extends RendererIO {
  readonly cwd: string;
  readonly stdinIsTTY: boolean;
  readonly signal: AbortSignal | undefined;
}

type RunCommand = Extract<ParsedCommand, { kind: "run" }>;

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
  const hints = profileHintsFor(runtime.canonical, "orchestrator").map((hint) => `${hint.provider}/${hint.model}`);
  throw new HarnessError({
    code: "config_invalid",
    message: `no model route is configured for tier orchestrator; add a routes entry to ${path.join(runtime.home, "config.yaml")} or pass --profile orchestrator=<provider>/<model>${hints.length === 0 ? "" : ` (the canonical model profiles suggest ${hints.join(" or ")})`}`,
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

/** The one-line red notice of `--permission-mode full` (ADR-08 revision 2026-09-24). */
const FULL_ACCESS_RUN_NOTICE =
  "Full access: workers edit and run any command in their worktree without asking (hard rails still apply); the workspace is trusted for this run only (not saved)";

function describeOutcome(outcome: RunOutcome): string {
  return `Run ${outcome.runId} ${outcome.status} (exit ${outcome.exitCode}); session ${outcome.sessionId}\n${outcome.summary}\n`;
}

/** The `ask_user` binding when a human is attached; undefined when nobody can answer (headless, JSONL). */
function userPromptFor(renderer: SessionRenderer): UserPrompt | undefined {
  const input = renderer.input;
  if (renderer.kind === "jsonl" || renderer.approvals.availability !== "interactive" || input === undefined) return undefined;
  const controls = renderer.controls;
  if (renderer.kind === "tui" && controls !== undefined) {
    // The question owns the input (a picker for choices).
    return async (question, options, signal) => {
      const answer = await controls.ask(question, options, signal);
      if (answer === undefined) throw new DOMException("the question was cancelled", "AbortError");
      return answer;
    };
  }
  return async (question, options, signal) => {
    const lines = [`Question from the orchestrator: ${question}`, ...(options === undefined || options.length === 0 ? [] : [`Options: ${options.join(" | ")}`]), "Type your answer and press Enter."];
    for (const line of lines) renderer.render({ kind: "notice", level: "info", message: line });
    for (;;) {
      const next = await input.next(signal);
      if (!("text" in next)) throw new DOMException("the question was not answered", "AbortError");
      if (next.text.trim() !== "") return next.text;
    }
  };
}

export async function runCommand(parsed: RunCommand, io: SessionIO, overrides: RuntimeOverrides): Promise<number> {
  const controller = linked(io.signal);
  const workspaceRoot = path.resolve(io.cwd, parsed.common.target ?? ".");
  let runtime: Runtime | undefined;
  let failure: HarnessErrorInfo | undefined;
  try {
    runtime = await createRuntime({
      workspaceRoot,
      env: io.env,
      policyMode: parsed.session.policy,
      routes: parsed.session.profiles,
      efforts: parsed.session.efforts,
      overrides,
      trustWorkspace: parsed.trustWorkspace,
      // Headless auto asks nothing, so it equals the default-deny policy; only full access changes a run.
      ...(parsed.session.permission === "full" ? { permissionMode: "full" as const } : {}),
    });
    requireOrchestratorRoute(runtime);
    // K3: a run's workers see the MCP tools from their first step; failures stay in `syn mcp list`.
    await runtime.mcp.startSession();
  } catch (error) {
    failure = failureInfo(error);
  }
  const settings = resolveTerminalSettings(
    { jsonl: parsed.jsonl, plain: parsed.common.plain, color: parsed.common.color, configColor: runtime?.config.color },
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
    streamDeltas: parsed.streamDeltas,
    wantsInput: false,
    interactive: io.stdinIsTTY,
    onInterrupt: () => controller.abort(),
    onExit: () => controller.abort(),
  });
  if (runtime === undefined || failure !== undefined) return reportError(renderer, io, failure ?? failureInfo(new Error("runtime unavailable")));

  const events: SessionEvent[] = [];
  const unsubscribe = runtime.subscribe((event: RenderEvent) => {
    if (event.kind === "session-event") events.push(event.event);
    renderer.render(event);
  });
  const coordinator = runtime.createCoordinator(runtime.brokerFor(renderer.approvals));
  const stopNotices = coordinator.onEvent((event) => {
    if (event.kind === "notice") renderer.render(event);
  });
  const prompt = userPromptFor(renderer);
  const controls = renderer.controls;
  // K5: in the TUI structured questions open the choice modal and leave one summary line; elsewhere they are asked as numbered text.
  const choose =
    renderer.kind === "tui" && controls !== undefined
      ? async (question: Parameters<typeof controls.choose>[0], signal: AbortSignal) => {
          const answer = await controls.choose(question, signal);
          renderer.render({ kind: "notice", level: "info", message: askUserSummaryLine(question, answer) });
          return answer;
        }
      : undefined;
  const unbind = prompt === undefined ? () => undefined : runtime.bindUserPrompt(prompt, choose);
  const onSigint = (): void => controller.abort();
  const sigintProcess = renderer.kind === "jsonl" || io.process === undefined ? io.process : undefined;
  (sigintProcess as NodeJS.Process | undefined)?.on?.("SIGINT", onSigint);
  try {
    await renderer.start(headerFor(runtime));
    if (runtime.permissionMode() === "full") renderer.render({ kind: "notice", level: "error", message: FULL_ACCESS_RUN_NOTICE });
    const goal = parsed.goalFromStdin && io.stdin !== undefined ? (await readAll(io.stdin)).trim() : parsed.goal;
    if (goal === "") return await reportError(renderer, io, { code: "usage_invalid", message: "the goal read from stdin is empty", workspace_effect: "none", retry_safe: true });
    await promptWorkspaceTrust(runtime, renderer, controller.signal);
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
    // K4.2: background processes of the run's workers never outlive the command (K3: nor MCP servers).
    runtime.processes.killAllSync();
    runtime.mcp.killAllSync();
    void runtime.mcp.close();
    unbind();
    unsubscribe();
    stopNotices();
  }
}
