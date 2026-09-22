import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authStatusSchema, type AuthInteraction, type CommandIO, type TerminalRenderer } from "../src/harness/contracts/index.ts";
import { createAuthCommand, createCredentialStore, resolveSynorchHome } from "../src/harness/auth/index.ts";

const KEY = "sk-ant-COMMAND-canary-0042";

interface Harness {
  readonly home: string;
  readonly run: (args: readonly string[], options?: { readonly interactive?: boolean }) => Promise<{ code: number; stdout: string; stderr: string; notices: string[] }>;
}

async function harness(body: (context: Harness) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "synorch-auth-command-"));
  const command = createAuthCommand({
    store: (root) => createCredentialStore(root, { backend: "file-0600" }),
    providerOptions: {
      env: {},
      claudeProbe: async () => ({ installed: true, version: "9.9.9" }),
      fetch: async () => new Response("offline", { status: 503 }),
      sleep: async () => undefined,
    },
  });
  try {
    await body({
      home,
      run: async (args, options = {}) => {
        let stdout = "";
        let stderr = "";
        const notices: string[] = [];
        const auth: AuthInteraction = {
          interactive: options.interactive ?? true,
          openBrowser: async () => false,
          showDeviceCode: () => undefined,
          promptSecret: async () => KEY,
          acknowledge: async (notice) => {
            notices.push(notice.id);
            return true;
          },
          notify: (message) => {
            notices.push(message);
          },
        };
        const io: CommandIO = {
          cwd: home,
          env: { SYNORCH_HOME: home },
          renderer: { auth } as unknown as TerminalRenderer,
          signal: new AbortController().signal,
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        };
        const code = await command(args, io);
        return { code, stdout, stderr, notices };
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("AC-7 `syn auth status --json` is an AuthStatus[] and never contains a secret", async () => {
  await harness(async ({ run }) => {
    const empty = await run(["auth", "status", "--json"]);
    assert.equal(empty.code, 0);
    const statuses = JSON.parse(empty.stdout) as unknown[];
    assert.equal(statuses.length, 4);
    for (const status of statuses) assert.ok(authStatusSchema.safeParse(status).success, JSON.stringify(status));

    const login = await run(["login", "anthropic", "--profile", "work"]);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Signed in: anthropic\/api-key/);
    assert.ok(login.notices.some((notice) => notice.includes("stored unencrypted")), "the plaintext file notice is shown");

    const after = await run(["auth", "status", "--json"]);
    assert.ok(!after.stdout.includes(KEY));
    const parsed = (JSON.parse(after.stdout) as unknown[]).map((status) => authStatusSchema.parse(status));
    const work = parsed.find((status) => status.profile === "work");
    assert.equal(work?.state, "connected");
    assert.equal(work?.store_backend, "file-0600");
    assert.equal(work?.billing, "metered");

    const plain = await run(["auth", "status"]);
    assert.equal(plain.code, 0);
    assert.ok(!plain.stdout.includes(KEY));
    assert.match(plain.stdout, /anthropic\/api-key · profile work · connected/);
  });
});

test("AC-7 headless `syn login` exits 7 without prompting", async () => {
  await harness(async ({ run }) => {
    for (const args of [["login", "openai"], ["login", "anthropic"], ["login", "anthropic", "--method", "cli-bridge"]]) {
      const result = await run(args, { interactive: false });
      assert.equal(result.code, 7, args.join(" "));
      assert.match(result.stderr, /interactive terminal/);
      assert.deepEqual(result.notices, []);
    }
  });
});

test("login/logout for api-key and the experimental Claude bridge; the bridge stores nothing", async () => {
  await harness(async ({ run, home }) => {
    const bridge = await run(["login", "anthropic", "--method", "cli-bridge"]);
    assert.equal(bridge.code, 0, bridge.stderr);
    assert.ok(bridge.notices.includes("claude-bridge-experimental"));
    assert.match(bridge.stdout, /anthropic\/cli-bridge/);

    assert.equal((await run(["login", "anthropic"])).code, 0);
    const file = JSON.parse(await readFile(path.join(home, "credentials.json"), "utf8")) as { profiles: Record<string, unknown> };
    assert.deepEqual(Object.keys(file.profiles), ["anthropic:api-key:default"]);

    const statuses = (JSON.parse((await run(["auth", "status", "--json"])).stdout) as unknown[]).map((status) => authStatusSchema.parse(status));
    const cli = statuses.find((status) => status.method === "cli-bridge");
    assert.equal(cli?.state, "unknown");
    assert.match(cli?.detail ?? "", /Claude Code 9\.9\.9/);

    const logout = await run(["logout", "anthropic"]);
    assert.equal(logout.code, 0);
    const cleared = JSON.parse(await readFile(path.join(home, "credentials.json"), "utf8")) as { profiles: Record<string, unknown> };
    assert.deepEqual(cleared.profiles, {});
    const afterLogout = (JSON.parse((await run(["auth", "status", "--json"])).stdout) as unknown[]).map((status) => authStatusSchema.parse(status));
    assert.equal(afterLogout.find((status) => status.method === "cli-bridge")?.state, "login_required");
  });
});

test("auth command usage errors exit 2 and provider failures exit with the auth or provider code", async () => {
  await harness(async ({ run }) => {
    for (const args of [
      ["login"],
      ["login", "gemini"],
      ["login", "openai", "--method", "cli-bridge"],
      ["login", "anthropic", "--method", "oauth-subscription"],
      ["login", "anthropic", "--device-code"],
      ["login", "openai", "--profile", "Not Kebab"],
      ["login", "openai", "--bogus"],
      ["auth", "list"],
      ["whoami"],
    ]) {
      const result = await run(args);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /error:/);
    }
    const offline = await run(["login", "openai", "--device-code"]);
    assert.equal(offline.code, 7, offline.stderr);
    assert.match(offline.stderr, /device sign-in could not start/);
  });
});

test("the Synorch home honors SYNORCH_HOME and defaults to ~/.synorch", () => {
  assert.equal(resolveSynorchHome({ SYNORCH_HOME: path.join(os.tmpdir(), "x") }), path.resolve(os.tmpdir(), "x"));
  assert.equal(resolveSynorchHome({ HOME: "/home/dev" }), path.join("/home/dev", ".synorch"));
});
