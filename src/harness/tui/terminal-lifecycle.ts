import { spawnSync } from "node:child_process";

/**
 * Terminal restoration on every exit path (checklist D1): normal stop, double Ctrl+C, uncaught
 * exceptions, unhandled rejections, SIGTERM, SIGHUP (Windows console close) and SIGBREAK. The
 * restore callback must be synchronous and idempotent; it runs at most once per guard.
 */

/** Ends synchronized output, bracketed paste, Kitty/modifyOtherKeys, mouse reporting and SGR state. */
export const EMERGENCY_RESTORE_SEQUENCE =
  "\x1b[?2026l" + "\x1b[?2004l" + "\x1b[<u" + "\x1b[>4;0m" + "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + "\x1b[0m" + "\x1b[?7h" + "\x1b[?25h";

export type GuardSignal = "SIGTERM" | "SIGHUP" | "SIGBREAK" | "SIGINT";

export interface GuardProcess {
  readonly platform: NodeJS.Platform;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

export interface TerminalGuardOptions {
  readonly process: GuardProcess;
  /** Synchronously puts the terminal back; called once. */
  readonly restore: () => void;
  /** After restoration: decide how the process ends for a termination signal. */
  readonly onSignal: (signal: GuardSignal) => void;
  /** After restoration: report a crash and end the process. */
  readonly onCrash: (error: unknown) => void;
  /** Also route SIGINT here (plain/JSONL); raw-mode TUIs receive Ctrl+C as input instead. */
  readonly handleSigint?: boolean;
}

export interface TerminalGuard {
  /** Runs the restore callback now (idempotent) and removes every process hook. */
  release(): void;
}

export function installTerminalGuard(options: TerminalGuardOptions): TerminalGuard {
  let restored = false;
  const restoreOnce = (): void => {
    if (restored) return;
    restored = true;
    try {
      options.restore();
    } catch {
      return;
    }
  };
  const signals: GuardSignal[] = ["SIGTERM", "SIGHUP"];
  if (options.process.platform === "win32") signals.push("SIGBREAK");
  if (options.handleSigint === true) signals.push("SIGINT");

  const onExit = (): void => restoreOnce();
  const onCrash = (error: unknown): void => {
    restoreOnce();
    options.onCrash(error);
  };
  const signalHandlers = signals.map((signal) => {
    const handler = (): void => {
      if (signal !== "SIGINT") restoreOnce();
      options.onSignal(signal);
    };
    return { signal, handler };
  });

  options.process.on("exit", onExit);
  options.process.on("uncaughtException", onCrash);
  options.process.on("unhandledRejection", onCrash);
  for (const { signal, handler } of signalHandlers) options.process.on(signal, handler);

  let released = false;
  return {
    release(): void {
      restoreOnce();
      if (released) return;
      released = true;
      options.process.removeListener("exit", onExit);
      options.process.removeListener("uncaughtException", onCrash);
      options.process.removeListener("unhandledRejection", onCrash);
      for (const { signal, handler } of signalHandlers) options.process.removeListener(signal, handler);
    },
  };
}

/**
 * Windows console codepage bookkeeping. Node writes to the console as UTF-16 (`WriteConsoleW`),
 * so a child that runs `chcp 437` cannot garble Synorch's own box drawing the way it does for
 * byte-writing runtimes; it does leave the user's console changed after exit. The guard records
 * the codepage at start and puts it back on stop when a child changed it. Other platforms no-op.
 */
export type CodepageRunner = (args: readonly string[]) => string | undefined;

export const runChcp: CodepageRunner = (args) => {
  const result = spawnSync("chcp.com", [...args], {
    stdio: ["inherit", "pipe", "ignore"],
    encoding: "utf8",
    windowsHide: true,
    timeout: 2000,
  });
  return result.status === 0 ? result.stdout : undefined;
};

export function parseCodepage(output: string | undefined): number | undefined {
  const match = /(\d+)\D*$/.exec(output ?? "");
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export class ConsoleCodepageGuard {
  private readonly enabled: boolean;
  private readonly run: CodepageRunner;
  private original: number | undefined;

  public constructor(platform: NodeJS.Platform, run: CodepageRunner = runChcp) {
    this.enabled = platform === "win32";
    this.run = run;
  }

  public get startCodepage(): number | undefined {
    return this.original;
  }

  public start(): void {
    if (!this.enabled) return;
    this.original = parseCodepage(this.run([]));
  }

  /** Returns true when the codepage had drifted and was put back. */
  public restore(): boolean {
    if (!this.enabled || this.original === undefined) return false;
    const current = parseCodepage(this.run([]));
    if (current === undefined || current === this.original) return false;
    this.run([String(this.original)]);
    return true;
  }
}
