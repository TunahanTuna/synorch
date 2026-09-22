import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessResult } from "../contracts/index.ts";
import { planLaunch, type LaunchPlan } from "./windows-launch.ts";

export interface ProcessOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string | undefined;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}

const INTERRUPT_GRACE_MS = 1_500;
const CLOSE_GRACE_MS = 5_000;

/**
 * Runs one argv without a shell (on Windows a `.cmd`/`.bat` shim is launched as `planLaunch`
 * decides: its node target directly, or cmd.exe with every argument quoted), with piped stdio (no console code-page inheritance), an explicit
 * environment, a wall-clock timeout and cancellation that terminates the whole process tree:
 * `taskkill /T /F` on Windows, SIGINT then SIGKILL to the process group elsewhere. Output beyond
 * the limit is dropped (the pipes keep draining) and reported as truncated.
 */
export async function runProcess(argv: readonly [string, ...string[]], options: ProcessOptions, signal: AbortSignal): Promise<ProcessResult> {
  const started = performance.now();
  let launch: LaunchPlan;
  try {
    launch = await planLaunch(argv, { cwd: options.cwd, env: options.env });
  } catch (error: unknown) {
    return failedSpawn(error, started);
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.file, [...launch.args], {
        cwd: options.cwd,
        env: { ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        detached: process.platform !== "win32",
      });
    } catch (error: unknown) {
      resolve(failedSpawn(error, started));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      const room = options.outputLimitBytes - captured;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      target.push(kept);
      captured += kept.length;
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin ?? "");

    const finish = (exitCode: number | null, exitSignal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      signal.removeEventListener("abort", onAbort);
      const neverStarted = spawnError !== undefined && child.pid === undefined;
      resolve({
        termination: neverStarted ? "spawn-failed" : cancelled ? "cancelled" : timedOut ? "timeout" : "exited",
        exitCode,
        signal: exitSignal,
        stdout: decode(stdout),
        stderr: decode(stderr),
        truncated,
        spawnError,
        durationMs: Math.round(performance.now() - started),
      });
    };
    const terminate = (): void => {
      void killTree(child).finally(() => {
        forceTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(child.exitCode, child.signalCode);
        }, CLOSE_GRACE_MS);
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };

    child.on("error", (error: Error) => {
      spawnError = error.message;
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", (code: number | null, closeSignal: NodeJS.Signals | null) => finish(code, closeSignal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Terminates a child and every descendant it started. */
export async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }
  signalGroup(pid, "SIGINT");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signalGroup(pid, "SIGKILL");
      resolve();
    }, INTERRUPT_GRACE_MS);
    child.once("close", () => {
      clearTimeout(timer);
      signalGroup(pid, "SIGKILL");
      resolve();
    });
  });
}

function signalGroup(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch {
    try {
      process.kill(pid, name);
    } catch {
      return;
    }
  }
}

function decode(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").replace(/�$/, "");
}

function failedSpawn(error: unknown, started: number): ProcessResult {
  return {
    termination: "spawn-failed",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    spawnError: error instanceof Error ? error.message : String(error),
    durationMs: Math.round(performance.now() - started),
  };
}
