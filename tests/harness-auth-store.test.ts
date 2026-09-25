import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CREDENTIAL_SERVICE_NAME,
  HarnessError,
  providerIdSchema,
  type CredentialRef,
  type CredentialSecret,
} from "../src/harness/contracts/index.ts";
import { createCredentialStore, createMemoryCredentialStore, type CommandRunner, type SyncCommandRunner } from "../src/harness/auth/index.ts";
import { acquireFileLock } from "../src/harness/auth/locks.ts";

const LOCKS_MODULE = fileURLToPath(new URL("../src/harness/auth/locks.ts", import.meta.url));

const apiRef: CredentialRef = { provider_id: providerIdSchema.parse("anthropic"), method: "api-key", profile: "default" };
const oauthRef: CredentialRef = { provider_id: providerIdSchema.parse("openai"), method: "oauth-subscription", profile: "work" };
const apiSecret: CredentialSecret = { method: "api-key", api_key: "sk-ant-store-test-secret", created_at: "2026-09-22T10:00:00Z" };
const oauthSecret: CredentialSecret = {
  method: "oauth-subscription",
  access_token: "access-store-test-secret",
  refresh_token: "refresh-store-test-secret",
  expires_at: "2026-09-22T11:00:00Z",
  originator: "synorch",
  obtained_at: "2026-09-22T10:00:00Z",
};

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "synorch-auth-store-"));
}

const noKeychain: SyncCommandRunner = () => ({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" });

test("file-0600 store round-trips, lists and deletes secrets with restrictive modes and a plaintext notice", async () => {
  const home = await tempHome();
  try {
    const store = createCredentialStore(home, { backend: "file-0600" });
    assert.equal(store.backend, "file-0600");
    assert.equal(store.location, path.join(home, "credentials.json"));
    assert.equal(store.notice?.id, "plaintext-credential-file");
    assert.equal(await store.get(apiRef), undefined);
    await store.set(apiRef, apiSecret);
    await store.set(oauthRef, oauthSecret);
    assert.deepEqual(await store.get(apiRef), apiSecret);
    assert.deepEqual(await store.get(oauthRef), oauthSecret);
    assert.deepEqual((await store.list()).map((ref) => `${ref.provider_id}:${ref.method}:${ref.profile}`).sort(), [
      "anthropic:api-key:default",
      "openai:oauth-subscription:work",
    ]);
    if (process.platform !== "win32") {
      assert.equal((await stat(store.location)).mode & 0o777, 0o600);
      assert.equal((await stat(home)).mode & 0o077, 0);
    }
    const reopened = createCredentialStore(home, { backend: "file-0600" });
    assert.deepEqual(await reopened.get(oauthRef), oauthSecret);
    assert.equal(await store.delete(apiRef), true);
    assert.equal(await store.delete(apiRef), false);
    assert.equal(await store.get(apiRef), undefined);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("store negative: mismatched methods, invalid secrets and cli-bridge secrets are refused; corrupt files are never overwritten", async () => {
  const home = await tempHome();
  try {
    const store = createCredentialStore(home, { backend: "file-0600" });
    await assert.rejects(store.set(oauthRef, apiSecret), HarnessError);
    await assert.rejects(store.set(apiRef, { method: "api-key", api_key: "", created_at: "2026-09-22T10:00:00Z" } as CredentialSecret));
    await assert.rejects(store.set({ ...apiRef, method: "cli-bridge" }, { method: "cli-bridge", token: "copied" } as unknown as CredentialSecret));
    await writeFile(store.location, "{ not json");
    await assert.rejects(store.get(apiRef), (error: unknown) => error instanceof HarnessError && error.info.code === "config_invalid");
    await assert.rejects(store.set(apiRef, apiSecret), HarnessError);
    assert.equal(await readFile(store.location, "utf8"), "{ not json");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("backend selection: SYNORCH_CREDENTIAL_STORE=file wins, keychain requests fail loudly when unavailable", async () => {
  const home = await tempHome();
  try {
    const availableMac: SyncCommandRunner = () => ({ code: 0, stdout: "", stderr: "" });
    assert.equal(createCredentialStore(home, { platform: "darwin", runSync: availableMac, env: { SYNORCH_CREDENTIAL_STORE: "file" } }).backend, "file-0600");
    assert.equal(createCredentialStore(home, { platform: "darwin", runSync: availableMac, env: {} }).backend, "os-keychain");
    assert.equal(createCredentialStore(home, { platform: "linux", runSync: noKeychain, env: {} }).backend, "file-0600");
    assert.throws(
      () => createCredentialStore(home, { platform: "linux", runSync: noKeychain, backend: "os-keychain" }),
      (error: unknown) => error instanceof HarnessError && error.info.code === "config_invalid",
    );
    const linuxNoDbus: SyncCommandRunner = () => ({ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11" });
    assert.equal(createCredentialStore(home, { platform: "linux", runSync: linuxNoDbus, env: {} }).backend, "file-0600");
    assert.equal(createMemoryCredentialStore().backend, "memory");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
});

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string | undefined;
}

function fakeMacSecurity(invocations: Invocation[]): CommandRunner {
  const items = new Map<string, string>();
  return async (command, args, input) => {
    invocations.push({ command, args, input });
    assert.equal(command, "security");
    const account = (list: readonly string[]) => list[list.indexOf("-a") + 1] ?? "";
    if (args[0] === "-i") {
      const match = /-a "([^"]+)" -s "([^"]+)" -w "([^"]+)"/.exec(input ?? "");
      assert.ok(match !== null, "security -i receives the add command on stdin");
      assert.equal(match[2], CREDENTIAL_SERVICE_NAME);
      items.set(match[1] ?? "", match[3] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      const value = items.get(account(args));
      return value === undefined ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      return items.delete(account(args)) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

function fakeSecretTool(invocations: Invocation[]): CommandRunner {
  const items = new Map<string, string>();
  return async (command, args, input) => {
    invocations.push({ command, args, input });
    const account = args[args.indexOf("account") + 1] ?? "";
    if (args[0] === "store") {
      items.set(account, input ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "lookup") {
      const value = items.get(account);
      return value === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: value, stderr: "" };
    }
    if (args[0] === "clear") {
      items.delete(account);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

function fakeDpapi(invocations: Invocation[]): CommandRunner {
  return async (command, args, input) => {
    invocations.push({ command, args, input });
    const script = args.at(-1) ?? "";
    if (script.includes("ConvertFrom-SecureString")) {
      return { code: 0, stdout: Buffer.from([...(input ?? "")].reverse().join(""), "utf8").toString("hex"), stderr: "" };
    }
    return { code: 0, stdout: [...Buffer.from((input ?? "").trim(), "hex").toString("utf8")].reverse().join(""), stderr: "" };
  };
}

test("OS keychain backends keep secrets out of argv and round-trip through the platform CLI", async () => {
  const home = await tempHome();
  try {
    const cases: [NodeJS.Platform, (invocations: Invocation[]) => CommandRunner][] = [
      ["darwin", fakeMacSecurity],
      ["linux", fakeSecretTool],
      ["win32", fakeDpapi],
    ];
    for (const [platform, makeRunner] of cases) {
      const invocations: Invocation[] = [];
      const run = makeRunner(invocations);
      const runSync: SyncCommandRunner = (command, args, input) => {
        if (platform === "win32") {
          const script = args.at(-1) ?? "";
          const stdout = script.includes("ConvertFrom-SecureString")
            ? Buffer.from([...(input ?? "")].reverse().join(""), "utf8").toString("hex")
            : [...Buffer.from((input ?? "").trim(), "hex").toString("utf8")].reverse().join("");
          return { code: 0, stdout, stderr: "" };
        }
        return { code: platform === "linux" ? 1 : 0, stdout: "", stderr: "" };
      };
      const store = createCredentialStore(path.join(home, platform), { platform, run, runSync, env: {} });
      assert.equal(store.backend, platform === "win32" ? "os-dpapi" : "os-keychain", platform);
      assert.equal(store.notice, undefined);
      await store.set(oauthRef, oauthSecret);
      await store.set(apiRef, apiSecret);
      const fresh = createCredentialStore(path.join(home, platform), { platform, run, runSync, env: {} });
      assert.deepEqual(await fresh.get(oauthRef), oauthSecret, platform);
      assert.equal((await fresh.list()).length, 2);
      assert.equal(await fresh.delete(apiRef), true);
      assert.equal((await fresh.list()).length, 1);
      for (const invocation of invocations) {
        const argv = invocation.args.join(" ");
        for (const secret of ["access-store-test-secret", "refresh-store-test-secret", "sk-ant-store-test-secret"]) {
          assert.ok(!argv.includes(secret), `${platform}: secret in argv`);
          assert.ok(!argv.includes(Buffer.from(secret).toString("base64")), `${platform}: encoded secret in argv`);
        }
      }
      if (platform === "win32") {
        const onDisk = await readFile(path.join(home, platform, "credentials.dpapi.json"), "utf8");
        assert.ok(!onDisk.includes("access-store-test-secret"));
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("Windows DPAPI round trip through real PowerShell", { skip: process.platform !== "win32" }, async () => {
  const home = await tempHome();
  try {
    const store = createCredentialStore(home, { backend: "os-keychain" });
    assert.equal(store.backend, "os-dpapi");
    await store.set(oauthRef, oauthSecret);
    const fresh = createCredentialStore(home, { backend: "os-keychain" });
    assert.deepEqual(await fresh.get(oauthRef), oauthSecret);
    const onDisk = await readFile(path.join(home, "credentials.dpapi.json"), "utf8");
    assert.ok(!onDisk.includes("access-store-test-secret"));
    assert.ok(!onDisk.includes(Buffer.from(JSON.stringify(oauthSecret)).toString("base64").slice(0, 24)));
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("withRefreshLock serializes refreshes across store instances sharing one home", async () => {
  const home = await tempHome();
  try {
    const first = createCredentialStore(home, { backend: "file-0600" });
    const second = createCredentialStore(home, { backend: "file-0600" });
    const timeline: string[] = [];
    const task = (name: string) => async () => {
      timeline.push(`${name}:enter`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      timeline.push(`${name}:exit`);
      return name;
    };
    const signal = new AbortController().signal;
    const results = await Promise.all([
      first.withRefreshLock(oauthRef, task("a"), signal),
      second.withRefreshLock(oauthRef, task("b"), signal),
      first.withRefreshLock(oauthRef, task("c"), signal),
    ]);
    assert.deepEqual(results, ["a", "b", "c"]);
    for (let index = 0; index < timeline.length; index += 2) {
      assert.equal(timeline[index]?.split(":")[0], timeline[index + 1]?.split(":")[0], `overlap in ${timeline.join(",")}`);
    }
    const other = await first.withRefreshLock(apiRef, async () => "independent profile", signal);
    assert.equal(other, "independent profile");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("withRefreshLock waits for a lock held by another process and takes over abandoned locks", async () => {
  const home = await tempHome();
  try {
    const store = createCredentialStore(home, { backend: "file-0600" });
    const lockDirectory = path.join(home, "locks");
    const { createHash } = await import("node:crypto");
    const lockFile = path.join(lockDirectory, `refresh-${createHash("sha256").update("openai:oauth-subscription:work").digest("hex").slice(0, 16)}.lock`);
    const script = [
      `import { acquireFileLock } from ${JSON.stringify(new URL(`file:///${LOCKS_MODULE.replaceAll("\\", "/")}`).href)};`,
      `const release = await acquireFileLock(${JSON.stringify(lockFile)});`,
      `process.stdout.write("held\\n");`,
      `await new Promise((resolve) => setTimeout(resolve, 400));`,
      `await release();`,
    ].join("\n");
    const child = execFile(process.execPath, ["--input-type=module", "-e", script]);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
    const started = Date.now();
    await store.withRefreshLock(oauthRef, async () => undefined, new AbortController().signal);
    assert.ok(Date.now() - started >= 250, "the refresh waited for the other process");
    await exited;

    await writeFile(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead", acquired_at: "2026-01-01T00:00:00Z" }));
    const release = await acquireFileLock(lockFile, { timeoutMs: 2_000 });
    await release();
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
});
