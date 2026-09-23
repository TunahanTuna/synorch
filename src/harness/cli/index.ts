import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  createId,
  deriveProjectId,
  EVENT_VERSIONS,
  EXIT_CODES,
  exitCodeFor,
  type CommandIO,
  type HarnessErrorInfo,
  type MemoryDecisionOutcome,
  type SessionEventDraft,
} from "../contracts/index.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import { createAuthCommand } from "../auth/index.ts";
import { createMemoryCommand, resolveMemoryRoot } from "../memory/index.ts";
import { createSessionStore } from "../store/index.ts";
import { formatHarnessError, JsonlRenderer, PlainLineRenderer, type FrameSink, type GuardProcess, type InputStream, type PiTuiRendererOptions } from "../tui/index.ts";
import { parseHarnessArgs, requestsJsonl, UsageError, type ParsedCommand } from "./args.ts";
import { loadRuntimeConfig, resolveHome } from "./config.ts";
import { doctorRuntime } from "./doctor.ts";
import { commandHelp } from "./help.ts";
import { runsCommand, showCommand } from "./inspect.ts";
import { failureInfo } from "./outcome.ts";
import type { RuntimeOverrides } from "./runtime.ts";
import { conversationCommand } from "./conversation.ts";
import { agentCommand, runCommand, type SessionIO } from "./session.ts";
import { resolveTerminalSettings, streamHasColors, type TerminalSettings } from "./terminal.ts";
import { trustCommand } from "./trust.ts";

/**
 * I5 — entry of the runtime commands. `src/cli.ts` reaches this module only through a literal
 * dynamic `import("./harness/cli/index.ts")`, so `inspect/init/sync/doctor` never load it. The
 * composition root itself is `createRuntime()` in `runtime.ts`.
 */
export const HARNESS_COMMANDS = ["agent", "run", "runs", "show", "login", "logout", "auth", "memory", "trust"] as const;
export type HarnessCommand = (typeof HARNESS_COMMANDS)[number];

export { harnessCommandFlags, parseHarnessArgs, requestsJsonl, UsageError, type ParsedCommand } from "./args.ts";
export { commandHelp } from "./help.ts";
export { approvalFailure, failureInfo, isAbortError } from "./outcome.ts";
export { resolveTerminalSettings, streamHasColors, type TerminalFacts, type TerminalRequest, type TerminalSettings } from "./terminal.ts";
export { createRuntime, type Runtime, type RuntimeOptions, type RuntimeOverrides, type UserPrompt } from "./runtime.ts";
export { describeCanonical, loadCanonicalStructure, type CanonicalStructure, type RoleDefinition } from "./canonical.ts";
export { narrowPolicy, withRoleDefinitions } from "./role-policy.ts";
export { loadRuntimeConfig, resolveHome, type RuntimeConfig } from "./config.ts";
export { loadScript, scriptStep } from "./scripted-script.ts";
export { promptWorkspaceTrust, recordTrustDecision, TRUST_AUDIT_TITLE, trustCommand } from "./trust.ts";

/** Title of the per-project session that records `syn memory accept|reject` decisions. */
export const MEMORY_AUDIT_TITLE = "syn memory decisions";

/** Mirrors the routing rule in `src/cli.ts`: a runtime command name, or `doctor --runtime`. */
export function isHarnessInvocation(argv: readonly string[]): boolean {
  const [command] = argv;
  if ((HARNESS_COMMANDS as readonly string[]).includes(command ?? "")) return true;
  if (command !== "doctor") return false;
  const terminator = argv.indexOf("--");
  return (terminator === -1 ? argv : argv.slice(0, terminator)).includes("--runtime");
}

export interface HarnessStream extends FrameSink {
  readonly isTTY?: boolean;
  hasColors?(): boolean;
}

export interface HarnessProcessIO {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly stdinIsTTY: boolean;
  readonly stdout: HarnessStream;
  readonly stderr: HarnessStream;
  /** User input for `syn agent`, prompts and `syn run -`; absent means no input. */
  readonly stdin?: InputStream;
  /** Aborting it cancels the running command (tests; the real process uses SIGINT). */
  readonly signal?: AbortSignal;
  /** The real process, for signal hooks and terminal restoration. */
  readonly process?: GuardProcess;
  readonly platform?: NodeJS.Platform;
  /** A terminal for the interactive renderer instead of the process console (virtual-terminal tests and smoke runs). */
  readonly terminal?: PiTuiRendererOptions["terminal"];
}

function processIO(): HarnessProcessIO {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    process: process as unknown as GuardProcess,
    platform: process.platform,
  };
}

/** The renderer an invocation will use once it runs. */
export function terminalSettingsFor(parsed: ParsedCommand, io: HarnessProcessIO): TerminalSettings | undefined {
  if (parsed.kind !== "agent" && parsed.kind !== "run") return undefined;
  return resolveTerminalSettings(
    { jsonl: parsed.kind === "run" && parsed.jsonl, plain: parsed.common.plain, color: parsed.common.color },
    {
      env: io.env,
      stdinIsTTY: io.stdinIsTTY,
      stdoutIsTTY: io.stdout.isTTY === true,
      stdoutHasColors: streamHasColors(io.stdout),
      stderrHasColors: streamHasColors(io.stderr),
    },
  );
}

async function reportAsFrames(error: HarnessErrorInfo, io: HarnessProcessIO): Promise<number> {
  const renderer = new JsonlRenderer({
    runId: createId("run"),
    sessionId: createId("session"),
    policyMode: "autonomous",
    streamDeltas: false,
    harnessVersion: SYNORCH_VERSION,
    stdout: io.stdout,
    stderr: (text) => io.stderr.write(text),
  });
  await renderer.start({ workspaceRoot: io.cwd, gitBranch: undefined, policyMode: "autonomous", routes: [], sandboxEnforcement: "unavailable", notices: [] });
  await renderer.fail(error);
  await renderer.stop("error");
  return renderer.exitCode;
}

/** Removes the CLI's common flags so the owning module sees only its own arguments. */
export function stripCommonFlags(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") {
      kept.push(...args.slice(index));
      break;
    }
    if (argument === "--plain") continue;
    if (argument === "-t" || argument === "--target" || argument === "--color") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=") || argument.startsWith("--color=")) continue;
    kept.push(argument);
  }
  return kept;
}

function commandIO(io: HarnessProcessIO, cwd: string, signal: AbortSignal, interactive: boolean): { readonly io: CommandIO; readonly close: () => Promise<void> } {
  const renderer = new PlainLineRenderer({
    stdout: (text) => void io.stdout.write(text),
    stderr: (text) => void io.stderr.write(text),
    color: false,
    policyMode: "autonomous",
    ...(interactive && io.stdin !== undefined ? { input: io.stdin } : {}),
    interactive: interactive && io.stdin !== undefined,
    environment: { platform: io.platform ?? process.platform, env: io.env },
  });
  return {
    io: {
      cwd,
      env: io.env,
      renderer,
      signal,
      stdout: (text) => void io.stdout.write(text),
      stderr: (text) => void io.stderr.write(text),
    },
    close: () => renderer.stop("completed"),
  };
}

async function recordMemoryDecision(home: string, cwd: string, platform: NodeJS.Platform, outcome: MemoryDecisionOutcome): Promise<void> {
  const sessions = createSessionStore(home);
  const projectId = deriveProjectId(cwd, platform);
  const existing = (await sessions.list(projectId)).find((summary) => summary.manifest.title === MEMORY_AUDIT_TITLE);
  const log = existing
    ? await sessions.openForWrite(existing.manifest.session_id)
    : await sessions.create({ session_id: createId("session"), project_id: projectId, workspace_root: path.resolve(cwd), created_at: new Date().toISOString(), title: MEMORY_AUDIT_TITLE });
  const actor = outcome.decided.decided_by === "orchestrator" ? ({ kind: "orchestrator", role: "orchestrator" } as const) : ({ kind: "user" } as const);
  const correlation = outcome.runId === undefined ? {} : { run_id: outcome.runId };
  try {
    await log.append({ type: "memory/proposal_decided", event_version: EVENT_VERSIONS["memory/proposal_decided"], actor, ...correlation, data: outcome.decided } as SessionEventDraft);
    if (outcome.persisted !== undefined) {
      await log.append({ type: "memory/persisted", event_version: EVENT_VERSIONS["memory/persisted"], actor, ...correlation, data: outcome.persisted } as SessionEventDraft);
    }
  } finally {
    await log.close();
  }
}

async function dispatch(parsed: Exclude<ParsedCommand, { kind: "help" }>, io: HarnessProcessIO, overrides: RuntimeOverrides): Promise<number> {
  const platform = io.platform ?? process.platform;
  const home = overrides.home ?? resolveHome(io.env);
  const signal = io.signal ?? new AbortController().signal;
  switch (parsed.kind) {
    case "run":
    case "agent": {
      const sessionIO: SessionIO = {
        env: io.env,
        cwd: io.cwd,
        stdinIsTTY: io.stdinIsTTY,
        stdout: io.stdout,
        stderr: io.stderr,
        stdin: io.stdin,
        platform,
        process: io.process,
        signal: io.signal,
        ...(io.terminal === undefined ? {} : { terminal: io.terminal }),
      };
      if (parsed.kind === "run") return runCommand(parsed, sessionIO, overrides);
      return parsed.legacy ? agentCommand(parsed, sessionIO, overrides) : conversationCommand(parsed, sessionIO, overrides);
    }
    case "runs":
    case "show": {
      const inspectIO = { cwd: io.cwd, env: io.env, home, platform, stdout: (text: string) => void io.stdout.write(text) };
      return parsed.kind === "runs" ? runsCommand(inspectIO, parsed.common.target, parsed.json) : showCommand(inspectIO, parsed.common.target, parsed.id, parsed.json);
    }
    case "doctor-runtime":
      return doctorRuntime(
        { cwd: io.cwd, env: io.env, stdinIsTTY: io.stdinIsTTY, stdoutIsTTY: io.stdout.isTTY === true, platform, stdout: (text) => void io.stdout.write(text) },
        parsed.common.target,
        parsed.probeModel,
        parsed.json,
        overrides,
      );
    case "login":
    case "logout":
    case "auth-status": {
      const handler = createAuthCommand({
        home: () => home,
        ...(overrides.credentialStore === undefined ? {} : { store: overrides.credentialStore }),
        providerOptions: { ...(overrides.authOptions ?? {}), ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }), env: io.env },
      });
      const name = parsed.kind === "auth-status" ? "auth" : parsed.kind;
      const cwd = path.resolve(io.cwd, parsed.common.target ?? ".");
      const command = commandIO(io, cwd, signal, parsed.kind === "login" && io.stdinIsTTY);
      try {
        return await handler([name, ...stripCommonFlags(parsed.args)], command.io);
      } finally {
        await command.close();
      }
    }
    case "trust":
      return trustCommand(
        { cwd: io.cwd, home, platform, stdout: (text) => void io.stdout.write(text), stderr: (text) => void io.stderr.write(text) },
        parsed.common.target,
        parsed.revoke,
      );
    case "memory": {
      const config = await loadRuntimeConfig(home, io.cwd, [], {
        platform,
        ...(overrides.configCeiling === undefined ? {} : { ceiling: overrides.configCeiling }),
      }).catch(() => undefined);
      const handler = createMemoryCommand({
        config: config?.memory,
        platform,
        root: (projectId) => (config?.memory?.root !== undefined ? resolveMemoryRoot(config.memory, projectId, os.homedir()) : path.join(home, "memory", projectId)),
        onDecision: async (outcome) => {
          try {
            await recordMemoryDecision(home, io.cwd, platform, outcome);
          } catch (error) {
            io.stderr.write(`warning: the decision was applied but its audit event could not be recorded: ${failureInfo(error).message}\n`);
          }
        },
      });
      const command = commandIO(io, io.cwd, signal, false);
      try {
        return await handler(parsed.args, command.io);
      } finally {
        await command.close();
      }
    }
  }
}

/** Runs one runtime command and returns its exit code. */
export async function runHarnessCommand(argv: readonly string[], io: HarnessProcessIO = processIO(), overrides: RuntimeOverrides = {}): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseHarnessArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (requestsJsonl(argv)) {
      return reportAsFrames({ code: "usage_invalid", message: error.message, workspace_effect: "none", retry_safe: true }, io);
    }
    const hint = error.command === undefined ? "" : `Run \`syn ${error.command} --help\` for usage.\n`;
    io.stderr.write(`Error: ${error.message}\n${hint}`);
    return EXIT_CODES.usage;
  }

  if (parsed.kind === "help") {
    io.stdout.write(commandHelp(parsed.command));
    return EXIT_CODES.success;
  }

  try {
    return await dispatch(parsed, io, overrides);
  } catch (error) {
    const info = failureInfo(error);
    if (parsed.kind === "run" && parsed.jsonl) return reportAsFrames(info, io);
    io.stderr.write(formatHarnessError(info));
    return exitCodeFor(info.code);
  }
}
