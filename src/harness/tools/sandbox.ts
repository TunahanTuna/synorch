import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import {
  sandboxReportSchema,
  type ProcessResult,
  type ProcessSpec,
  type SandboxReport,
  type SandboxRunner,
} from "../contracts/index.ts";
import { runProcess } from "./process.ts";

/**
 * OS sandbox backends (ADR-06). The runner applies and reports limits; it never decides
 * permission. Linux uses bubblewrap and macOS sandbox-exec when present; Windows v1 is
 * `policy-only` (partial): writes are checked by the gateway at action time and the child runs
 * with an explicit environment, piped stdio, timeout and tree kill. A failing probe is
 * `unavailable` (fail closed).
 */

export interface SandboxProbeOptions {
  readonly platform?: NodeJS.Platform;
  /** Resolves true when the argv runs and exits 0; injectable so probes are testable without the tools. */
  readonly succeeds?: (argv: readonly [string, ...string[]]) => Promise<boolean>;
  readonly fileExists?: (path: string) => Promise<boolean>;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export async function probeSandbox(options: SandboxProbeOptions = {}): Promise<SandboxReport> {
  const platform = options.platform ?? process.platform;
  const reported = reportPlatform(platform);
  const succeeds = options.succeeds ?? commandSucceeds;
  const fileExists = options.fileExists ?? pathExists;
  try {
    if (platform === "linux") {
      if (await succeeds(["bwrap", "--ro-bind", "/", "/", "--unshare-all", "--", "true"])) return fullReport("bubblewrap", reported);
      return policyOnlyReport(reported, "bubblewrap is not installed or cannot create namespaces; writes are checked by the gateway only");
    }
    if (platform === "darwin") {
      if ((await fileExists(SANDBOX_EXEC)) && (await succeeds([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"]))) {
        return fullReport("sandbox-exec", reported);
      }
      return policyOnlyReport(reported, "sandbox-exec is unavailable; writes are checked by the gateway only");
    }
    if (platform === "win32") {
      return policyOnlyReport(reported, "no OS filesystem sandbox on Windows in v1; writes are checked by the gateway at action time");
    }
    return unavailableReport(reported, `no sandbox backend for platform ${platform}`);
  } catch (error: unknown) {
    return unavailableReport(reported, `sandbox probe failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
  }
}

export function createSandboxRunner(report: SandboxReport): SandboxRunner {
  const checked = sandboxReportSchema.parse(report);
  return {
    probe: async () => checked,
    run: async (spec: ProcessSpec, signal: AbortSignal): Promise<ProcessResult> => {
      const result = await runProcess(
        sandboxedArgv(checked, spec),
        { cwd: spec.cwd, env: spec.env, stdin: spec.stdin, timeoutMs: spec.timeoutMs, outputLimitBytes: spec.outputLimitBytes },
        signal,
      );
      const stderr = result.termination === "spawn-failed" && result.stderr.length === 0 ? `failed to start ${spec.argv[0]}: ${result.spawnError ?? "unknown error"}` : result.stderr;
      return { ...result, stderr };
    },
  };
}

/** The argv actually spawned: the command itself, wrapped by the backend when one enforces limits. */
export function sandboxedArgv(report: SandboxReport, spec: ProcessSpec): readonly [string, ...string[]] {
  if (report.enforcement === "full" && report.backend === "bubblewrap") {
    return [
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      ...spec.writeRoots.flatMap((root) => ["--bind", root, root]),
      "--unshare-all",
      ...(spec.network === "allow" ? ["--share-net"] : []),
      "--die-with-parent",
      "--new-session",
      "--chdir",
      spec.cwd,
      "--",
      ...spec.argv,
    ];
  }
  if (report.enforcement === "full" && report.backend === "sandbox-exec") {
    return [SANDBOX_EXEC, "-p", sandboxExecProfile(spec), ...spec.argv];
  }
  return spec.argv;
}

function sandboxExecProfile(spec: ProcessSpec): string {
  const quote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const writable = [
    ...spec.writeRoots.map((root) => `(subpath ${quote(root)})`),
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(literal "/dev/null")',
    '(literal "/dev/tty")',
  ].join(" ");
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${writable})${spec.network === "deny" ? "(deny network*)" : ""}`;
}

function fullReport(backend: string, platform: SandboxReport["platform"]): SandboxReport {
  return { backend, platform, enforcement: "full", filesystem: "full", network: "full", process: "full", notes: [] };
}

function policyOnlyReport(platform: SandboxReport["platform"], note: string): SandboxReport {
  return { backend: "policy-only", platform, enforcement: "partial", filesystem: "partial", network: "unavailable", process: "partial", notes: [note] };
}

function unavailableReport(platform: SandboxReport["platform"], note: string): SandboxReport {
  return { backend: "none", platform, enforcement: "unavailable", filesystem: "unavailable", network: "unavailable", process: "unavailable", notes: [note] };
}

function reportPlatform(platform: NodeJS.Platform): SandboxReport["platform"] {
  return platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "other";
}

function commandSucceeds(argv: readonly [string, ...string[]]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
