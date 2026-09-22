import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { BRIDGE_STRIPPED_ENV } from "../../contracts/index.ts";

/** How to start the backend: an executable plus fixed leading arguments (tests use `node fake.mjs`). */
export interface ExecutableSpec {
  readonly command: string;
  readonly args?: readonly string[];
}

/** A native executable is preferred over an npm `.cmd` shim. */
const WINDOWS_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"] as const;

/** Finds `name` on PATH without a shell; on Windows it tries the executable extensions in order. */
export async function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const pathValue = envValue(env, "PATH", platform) ?? "";
  const flavor = platform === "win32" ? path.win32 : path.posix;
  const extensions = platform === "win32" ? WINDOWS_EXTENSIONS : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = flavor.join(directory.replace(/^"|"$/g, ""), `${name}${extension}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function envValue(env: Readonly<Record<string, string | undefined>>, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === key);
  return match === undefined ? undefined : env[match];
}

/**
 * The child environment: the caller's env minus every `BRIDGE_STRIPPED_ENV` name (case-insensitive
 * on Windows), so a subscription bridge can never bill an API key silently.
 */
export function bridgeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const stripped = new Set<string>(BRIDGE_STRIPPED_ENV.map((name) => (platform === "win32" ? name.toUpperCase() : name)));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...env, ...extra })) {
    if (value === undefined) continue;
    if (stripped.has(platform === "win32" ? key.toUpperCase() : key)) continue;
    result[key] = value;
  }
  return result;
}

const CMD_UNSAFE = /["%\r\n]/;

/**
 * Quotes one argument for `cmd.exe /s /c`. Inside double quotes cmd treats `& | < > ^ ( )` as
 * literals; only quotes, `%` expansion and line breaks cannot be neutralized, so they are refused.
 */
export function quoteForCmd(argument: string): string {
  if (CMD_UNSAFE.test(argument)) throw new Error(`argument cannot be passed through cmd.exe safely: ${argument.slice(0, 40)}`);
  return `"${argument}"`;
}

export interface SpawnedBackend {
  readonly child: ChildProcess;
}

/**
 * Spawns without a shell. A Windows `.cmd`/`.bat` shim cannot be executed directly (Node refuses
 * since CVE-2024-27980), so it runs through `cmd.exe /d /s /c` with every argument quoted.
 */
export function spawnBackend(
  executable: ExecutableSpec,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly platform?: NodeJS.Platform },
): ChildProcess {
  const platform = options.platform ?? process.platform;
  const all = [...(executable.args ?? []), ...args];
  if (platform === "win32" && /\.(cmd|bat)$/i.test(executable.command)) {
    const line = [executable.command, ...all].map(quoteForCmd).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  return spawn(executable.command, all, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

/**
 * Stops the backend. On Windows there are no POSIX signals and a `.cmd` shim leaves its node child
 * running when only `cmd.exe` is killed, so the whole tree is ended with `taskkill /T /F`.
 */
export function terminate(child: ChildProcess, signal: "SIGINT" | "SIGTERM", platform: NodeJS.Platform = process.platform): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill(signal);
}

/** Runs a short command (e.g. `claude --version`) and returns its stdout, bounded by a timeout. */
export function runCaptured(
  executable: ExecutableSpec,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnBackend(executable, args, options);
    } catch (error: unknown) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    const onAbort = () => child.kill();
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-16_384);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.stdin?.end();
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}
