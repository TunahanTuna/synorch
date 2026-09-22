import { createHash } from "node:crypto";
import path from "node:path";
import {
  credentialAccountKey,
  credentialFileSchema,
  credentialRefSchema,
  credentialSecretSchema,
  HarnessError,
  type AuthNotice,
  type CredentialFile,
  type CredentialRef,
  type CredentialSecret,
  type CredentialStore,
  type CredentialStoreBackend,
} from "../contracts/index.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import {
  defaultRunner,
  defaultSyncRunner,
  probeVault,
  type CommandRunner,
  type SecretVault,
  type SyncCommandRunner,
} from "./keychain.ts";
import { acquireFileLock, KeyedMutex } from "./locks.ts";
import { plaintextCredentialNotice } from "./notices.ts";

export const CREDENTIAL_FILE_NAME = "credentials.json";
export const DPAPI_FILE_NAME = "credentials.dpapi.json";
const VAULT_INDEX_ACCOUNT = "synorch:index";

export interface CredentialStoreOptions {
  /** `auto` probes the OS store and falls back to the 0600 file; `os-keychain`/`os-dpapi` require an OS store (whichever the platform has). `SYNORCH_CREDENTIAL_STORE` may set it. */
  readonly backend?: "auto" | Exclude<CredentialStoreBackend, "memory">;
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
  readonly runSync?: SyncCommandRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SynorchCredentialStore extends CredentialStore {
  /** Where secrets live: the file path, or the OS store kind. Never a secret. */
  readonly location: string;
  /** Set when secrets are kept in plain text; the login flow shows it. */
  readonly notice: AuthNotice | undefined;
  /** The Synorch home that holds non-secret auth state; `undefined` for the memory store. */
  readonly home: string | undefined;
}

interface Persistence {
  readonly backend: CredentialStoreBackend;
  readonly location: string;
  read(account: string): Promise<{ ref: CredentialRef; secret: CredentialSecret } | undefined>;
  write(ref: CredentialRef, secret: CredentialSecret): Promise<void>;
  remove(account: string): Promise<boolean>;
  accounts(): Promise<readonly { ref: CredentialRef }[]>;
  /** Cross-process exclusion for read-modify-write; the memory backend needs none. */
  lock(name: string, signal: AbortSignal | undefined): Promise<() => Promise<void>>;
}

/**
 * The credential store (ADR-05): OS keychain first (macOS `security`, Linux `secret-tool`, Windows
 * DPAPI through PowerShell), otherwise `<home>/credentials.json` with mode 0600 and a
 * `plaintext-credential-file` notice. `home` is the Synorch home (`~/.synorch` or `$SYNORCH_HOME`).
 * No other application's store is ever opened.
 */
export function createCredentialStore(home: string, options: CredentialStoreOptions = {}): SynorchCredentialStore {
  const platform = options.platform ?? process.platform;
  const requested = options.backend ?? backendFromEnv(options.env ?? process.env) ?? "auto";
  if (requested !== "file-0600") {
    const vault = probeVault({
      platform,
      run: options.run ?? defaultRunner,
      runSync: options.runSync ?? defaultSyncRunner,
      dpapiFile: path.join(home, DPAPI_FILE_NAME),
    });
    if (vault !== undefined) return buildStore(vaultPersistence(vault, home), home);
    if (requested === "os-keychain" || requested === "os-dpapi") {
      throw new HarnessError({
        code: "config_invalid",
        message: "the OS keychain was requested but is not available on this system",
        workspace_effect: "none",
        retry_safe: false,
        next_command: "SYNORCH_CREDENTIAL_STORE=file syn login <provider>",
      });
    }
  }
  const filePath = path.join(home, CREDENTIAL_FILE_NAME);
  return buildStore(filePersistence(filePath, home), home, plaintextCredentialNotice(filePath));
}

/** A process-local store for tests and headless runs that must not persist anything. */
export function createMemoryCredentialStore(): SynorchCredentialStore {
  const entries = new Map<string, { ref: CredentialRef; secret: CredentialSecret }>();
  return buildStore({
    backend: "memory",
    location: "memory",
    async read(account) {
      const entry = entries.get(account);
      return entry === undefined ? undefined : structuredClone(entry);
    },
    async write(ref, secret) {
      entries.set(credentialAccountKey(ref), structuredClone({ ref, secret }));
    },
    async remove(account) {
      return entries.delete(account);
    },
    async accounts() {
      return [...entries.values()].map((entry) => ({ ref: entry.ref }));
    },
    async lock() {
      return async () => undefined;
    },
  }, undefined);
}

function backendFromEnv(env: Readonly<Record<string, string | undefined>>): CredentialStoreOptions["backend"] | undefined {
  const value = env.SYNORCH_CREDENTIAL_STORE?.trim().toLowerCase();
  if (value === "file" || value === "file-0600") return "file-0600";
  if (value === "keychain" || value === "os-keychain") return "os-keychain";
  if (value === "dpapi" || value === "os-dpapi") return "os-dpapi";
  if (value === "auto") return "auto";
  return undefined;
}

function lockPath(home: string, name: string): string {
  return path.join(home, "locks", `${name}.lock`);
}

function corrupt(where: string): HarnessError {
  return new HarnessError({
    code: "config_invalid",
    message: `stored credentials in ${where} are unreadable; remove the entry with \`syn logout\` and sign in again`,
    workspace_effect: "none",
    retry_safe: false,
  });
}

function filePersistence(filePath: string, home: string): Persistence {
  async function load(): Promise<CredentialFile> {
    let raw: unknown;
    try {
      raw = await readJsonFile(filePath);
    } catch {
      throw corrupt(filePath);
    }
    if (raw === undefined) return { schema_version: 1, profiles: {} };
    const parsed = credentialFileSchema.safeParse(raw);
    if (!parsed.success) throw corrupt(filePath);
    return parsed.data;
  }
  return {
    backend: "file-0600",
    location: filePath,
    async read(account) {
      return (await load()).profiles[account];
    },
    async write(ref, secret) {
      const file = await load();
      file.profiles[credentialAccountKey(ref)] = { ref, secret };
      await writeJsonAtomic(filePath, file);
    },
    async remove(account) {
      const file = await load();
      if (file.profiles[account] === undefined) return false;
      delete file.profiles[account];
      await writeJsonAtomic(filePath, file);
      return true;
    },
    async accounts() {
      return Object.values((await load()).profiles).map((entry) => ({ ref: entry.ref }));
    },
    lock(name, signal) {
      return acquireFileLock(lockPath(home, name), signal === undefined ? {} : { signal });
    },
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8")) as unknown;
}

function vaultPersistence(vault: SecretVault, home: string): Persistence {
  const cache = new Map<string, { ref: CredentialRef; secret: CredentialSecret } | undefined>();
  async function index(): Promise<CredentialRef[]> {
    const raw = await vault.get(VAULT_INDEX_ACCOUNT);
    if (raw === undefined) return [];
    try {
      const refs = decode(raw);
      return Array.isArray(refs) ? refs.flatMap((ref) => (credentialRefSchema.safeParse(ref).success ? [ref as CredentialRef] : [])) : [];
    } catch {
      return [];
    }
  }
  async function saveIndex(refs: readonly CredentialRef[]): Promise<void> {
    await vault.set(VAULT_INDEX_ACCOUNT, encode(refs));
  }
  const persistence: Persistence & { invalidate(account: string): void } = {
    backend: vault.kind === "windows-dpapi" ? "os-dpapi" : "os-keychain",
    location: vault.kind,
    async read(account) {
      if (cache.has(account)) return structuredCloneOrUndefined(cache.get(account));
      const raw = await vault.get(account);
      if (raw === undefined) {
        cache.set(account, undefined);
        return undefined;
      }
      let entry: { ref: CredentialRef; secret: CredentialSecret };
      try {
        const value = decode(raw) as { ref?: unknown; secret?: unknown };
        entry = { ref: credentialRefSchema.parse(value.ref), secret: credentialSecretSchema.parse(value.secret) };
      } catch {
        throw corrupt(vault.kind);
      }
      cache.set(account, entry);
      return structuredClone(entry);
    },
    async write(ref, secret) {
      const account = credentialAccountKey(ref);
      await vault.set(account, encode({ ref, secret }));
      cache.set(account, structuredClone({ ref, secret }));
      const refs = await index();
      if (!refs.some((existing) => credentialAccountKey(existing) === account)) await saveIndex([...refs, ref]);
    },
    async remove(account) {
      const removed = await vault.delete(account);
      cache.set(account, undefined);
      const refs = await index();
      const remaining = refs.filter((ref) => credentialAccountKey(ref) !== account);
      if (remaining.length !== refs.length) await saveIndex(remaining);
      return removed;
    },
    async accounts() {
      return (await index()).map((ref) => ({ ref }));
    },
    lock(name, signal) {
      return acquireFileLock(lockPath(home, name), signal === undefined ? {} : { signal });
    },
    invalidate(account) {
      cache.delete(account);
    },
  };
  return persistence;
}

function structuredCloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function buildStore(persistence: Persistence, home: string | undefined, notice?: AuthNotice): SynorchCredentialStore {
  const mutex = new KeyedMutex();
  const invalidate = (account: string) => {
    (persistence as Partial<{ invalidate(account: string): void }>).invalidate?.(account);
  };
  async function exclusive<T>(task: () => Promise<T>): Promise<T> {
    return mutex.run("store", async () => {
      const release = await persistence.lock("credentials", undefined);
      try {
        return await task();
      } finally {
        await release();
      }
    });
  }
  return {
    backend: persistence.backend,
    location: persistence.location,
    notice,
    home,
    async get(ref) {
      const account = credentialAccountKey(credentialRefSchema.parse(ref));
      return (await persistence.read(account))?.secret;
    },
    async set(ref, secret) {
      const parsedRef = credentialRefSchema.parse(ref);
      const parsedSecret = credentialSecretSchema.parse(secret);
      if (parsedRef.method !== parsedSecret.method) {
        throw new HarnessError({
          code: "internal",
          message: `a ${parsedSecret.method} secret cannot be stored under a ${parsedRef.method} profile`,
          workspace_effect: "none",
          retry_safe: false,
        });
      }
      await exclusive(() => persistence.write(parsedRef, parsedSecret));
    },
    async delete(ref) {
      const account = credentialAccountKey(credentialRefSchema.parse(ref));
      return exclusive(() => persistence.remove(account));
    },
    async list() {
      return (await persistence.accounts()).map((entry) => entry.ref);
    },
    async withRefreshLock(ref, refresh, signal) {
      const account = credentialAccountKey(credentialRefSchema.parse(ref));
      const name = `refresh-${createHash("sha256").update(account).digest("hex").slice(0, 16)}`;
      return mutex.run(name, async () => {
        const release = await persistence.lock(name, signal);
        try {
          invalidate(account);
          return await refresh();
        } finally {
          await release();
        }
      });
    },
  };
}
