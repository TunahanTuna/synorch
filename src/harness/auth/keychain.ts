import { spawn, spawnSync } from "node:child_process";
import { CREDENTIAL_SERVICE_NAME } from "../contracts/index.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: string;
}

/** Runs an OS credential CLI. Secrets travel through `input` (stdin), never through argv. */
export type CommandRunner = (command: string, args: readonly string[], input: string | undefined) => Promise<CommandResult>;
export type SyncCommandRunner = (command: string, args: readonly string[], input: string | undefined) => CommandResult;

const COMMAND_TIMEOUT_MS = 20_000;

export const defaultRunner: CommandRunner = (command, args, input) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, stdout, stderr, spawnError: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });

export const defaultSyncRunner: SyncCommandRunner = (command, args, input) => {
  const result = spawnSync(command, args, { input: input ?? "", encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { spawnError: result.error.message }),
  };
};

/** A per-account secret slot in an OS-protected store. Values are opaque ASCII strings. */
export interface SecretVault {
  readonly kind: "macos-keychain" | "secret-service" | "windows-dpapi";
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

class VaultError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

function failed(action: string, result: CommandResult): VaultError {
  return new VaultError(`${action} failed (${result.spawnError ?? `exit ${String(result.code)}`})`);
}

/** macOS: the `security` CLI. Writes go through `security -i` on stdin so the value never hits argv. */
export function macosKeychainVault(run: CommandRunner): SecretVault {
  const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;
  return {
    kind: "macos-keychain",
    async get(account) {
      const result = await run("security", ["find-generic-password", "-a", account, "-s", CREDENTIAL_SERVICE_NAME, "-w"], undefined);
      if (result.code === 0) return result.stdout.replace(/\r?\n$/, "");
      if (result.code === 44) return undefined;
      throw failed("keychain read", result);
    },
    async set(account, value) {
      const line = `add-generic-password -U -a ${quote(account)} -s ${quote(CREDENTIAL_SERVICE_NAME)} -w ${quote(value)}\n`;
      const result = await run("security", ["-i"], line);
      if (result.code !== 0 || /error/i.test(result.stderr)) throw failed("keychain write", result);
    },
    async delete(account) {
      const result = await run("security", ["delete-generic-password", "-a", account, "-s", CREDENTIAL_SERVICE_NAME], undefined);
      if (result.code === 0) return true;
      if (result.code === 44) return false;
      throw failed("keychain delete", result);
    },
  };
}

/** Linux: libsecret's `secret-tool` (Secret Service); the value is read from stdin by `store`. */
export function secretServiceVault(run: CommandRunner): SecretVault {
  const attributes = (account: string) => ["service", CREDENTIAL_SERVICE_NAME, "account", account];
  return {
    kind: "secret-service",
    async get(account) {
      const result = await run("secret-tool", ["lookup", ...attributes(account)], undefined);
      if (result.code === 0) return result.stdout.replace(/\r?\n$/, "");
      if (result.code === 1 && result.stderr.trim() === "") return undefined;
      throw failed("secret service read", result);
    },
    async set(account, value) {
      const result = await run("secret-tool", ["store", `--label=Synorch ${account}`, ...attributes(account)], value);
      if (result.code !== 0) throw failed("secret service write", result);
    },
    async delete(account) {
      const existing = await this.get(account);
      if (existing === undefined) return false;
      const result = await run("secret-tool", ["clear", ...attributes(account)], undefined);
      if (result.code !== 0) throw failed("secret service delete", result);
      return true;
    },
  };
}

const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;
const DPAPI_PROTECT =
  "$ErrorActionPreference='Stop';$s=[Console]::In.ReadToEnd();" +
  "$ss=ConvertTo-SecureString -String $s -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString -SecureString $ss))";
const DPAPI_UNPROTECT =
  "$ErrorActionPreference='Stop';$c=[Console]::In.ReadToEnd().Trim();$ss=ConvertTo-SecureString -String $c;" +
  "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss);" +
  "try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}";

interface DpapiFile {
  schema_version: 1;
  entries: Record<string, string>;
}

/**
 * Windows: values are encrypted with DPAPI (bound to the current Windows user) through PowerShell's
 * `ConvertFrom-SecureString`, and only the ciphertext is written to `credentials.dpapi.json`.
 */
export function windowsDpapiVault(run: CommandRunner, filePath: string): SecretVault {
  async function load(): Promise<DpapiFile> {
    const parsed = await readJsonFile(filePath);
    if (typeof parsed === "object" && parsed !== null && (parsed as DpapiFile).schema_version === 1) {
      const entries = (parsed as DpapiFile).entries;
      if (typeof entries === "object" && entries !== null) return { schema_version: 1, entries: { ...entries } };
    }
    return { schema_version: 1, entries: {} };
  }
  return {
    kind: "windows-dpapi",
    async get(account) {
      const cipher = (await load()).entries[account];
      if (cipher === undefined) return undefined;
      const result = await run("powershell.exe", [...POWERSHELL_ARGS, DPAPI_UNPROTECT], cipher);
      if (result.code !== 0) throw failed("DPAPI decrypt", result);
      return result.stdout;
    },
    async set(account, value) {
      const result = await run("powershell.exe", [...POWERSHELL_ARGS, DPAPI_PROTECT], value);
      const cipher = result.stdout.trim();
      if (result.code !== 0 || !/^[0-9a-f]+$/i.test(cipher)) throw failed("DPAPI encrypt", result);
      const file = await load();
      file.entries[account] = cipher;
      await writeJsonAtomic(filePath, file);
    },
    async delete(account) {
      const file = await load();
      if (file.entries[account] === undefined) return false;
      delete file.entries[account];
      await writeJsonAtomic(filePath, file);
      return true;
    },
  };
}

export interface VaultProbe {
  readonly platform: NodeJS.Platform;
  readonly runSync: SyncCommandRunner;
  readonly run: CommandRunner;
  readonly dpapiFile: string;
}

/**
 * Feature probe for an OS store, run once when the credential store is created. Anything short of
 * a clean answer (missing CLI, no D-Bus session, locked-down PowerShell) means "unavailable".
 */
export function probeVault(input: VaultProbe): SecretVault | undefined {
  if (input.platform === "darwin") {
    const result = input.runSync("security", ["list-keychains"], undefined);
    return result.code === 0 ? macosKeychainVault(input.run) : undefined;
  }
  if (input.platform === "linux") {
    const result = input.runSync("secret-tool", ["lookup", "service", CREDENTIAL_SERVICE_NAME, "account", "synorch:probe"], undefined);
    const reachable = result.spawnError === undefined && (result.code === 0 || result.code === 1) && result.stderr.trim() === "";
    return reachable ? secretServiceVault(input.run) : undefined;
  }
  if (input.platform === "win32") {
    const sample = "synorch-probe";
    const encrypted = input.runSync("powershell.exe", [...POWERSHELL_ARGS, DPAPI_PROTECT], sample);
    const cipher = encrypted.stdout.trim();
    if (encrypted.code !== 0 || !/^[0-9a-f]+$/i.test(cipher)) return undefined;
    const decrypted = input.runSync("powershell.exe", [...POWERSHELL_ARGS, DPAPI_UNPROTECT], cipher);
    return decrypted.code === 0 && decrypted.stdout === sample ? windowsDpapiVault(input.run, input.dpapiFile) : undefined;
  }
  return undefined;
}
