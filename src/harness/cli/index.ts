import process from "node:process";
import { createId, EXIT_CODES, exitCodeFor, type HarnessErrorInfo } from "../contracts/index.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import { formatHarnessError, JsonlRenderer, type FrameSink } from "../tui/index.ts";
import { parseHarnessArgs, requestsJsonl, UsageError, type ParsedCommand } from "./args.ts";
import { commandHelp } from "./help.ts";
import { resolveTerminalSettings, streamHasColors, type TerminalSettings } from "./terminal.ts";

/**
 * I5 — composition root for runtime commands. `src/cli.ts` reaches this module only through a
 * literal dynamic `import("./harness/cli/index.ts")`, so `inspect/init/sync/doctor` never load it.
 */
export const HARNESS_COMMANDS = ["agent", "run", "runs", "show", "login", "logout", "auth", "memory"] as const;
export type HarnessCommand = (typeof HARNESS_COMMANDS)[number];

export { parseHarnessArgs, requestsJsonl, UsageError, type ParsedCommand } from "./args.ts";
export { commandHelp } from "./help.ts";
export { approvalFailure, failureInfo, isAbortError } from "./outcome.ts";
export { resolveTerminalSettings, streamHasColors, type TerminalFacts, type TerminalRequest, type TerminalSettings } from "./terminal.ts";

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
}

function processIO(): HarnessProcessIO {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

/** The renderer an invocation will use once it runs; exposed so selection is testable in stage A. */
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

function commandLabel(parsed: ParsedCommand): string {
  switch (parsed.kind) {
    case "doctor-runtime":
      return "doctor --runtime";
    case "auth-status":
      return "auth status";
    case "memory":
      return `memory ${parsed.subcommand}`;
    default:
      return parsed.kind;
  }
}

/**
 * Runs one runtime command and returns its exit code. Stage A: parsing, help, renderer selection
 * and exit codes are final; execution reports that the runtime is not wired yet (I5 stage B).
 */
export async function runHarnessCommand(argv: readonly string[], io: HarnessProcessIO = processIO()): Promise<number> {
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

  const notWired: HarnessErrorInfo = {
    code: "internal",
    message: `syn ${commandLabel(parsed)} is not wired to the runtime yet (I5 stage B)`,
    workspace_effect: "none",
    retry_safe: true,
  };
  if (parsed.kind === "run" && parsed.jsonl) return reportAsFrames(notWired, io);
  io.stderr.write(formatHarnessError(notWired));
  return exitCodeFor(notWired.code);
}
