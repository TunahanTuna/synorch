import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  authStatusSchema,
  HarnessError,
  providerIdSchema,
  ProviderFailure,
  type AuthInteraction,
  type AuthNotice,
  type CredentialRef,
  type CredentialSecret,
  type DeviceCodePrompt,
  type ModelStreamEvent,
} from "../src/harness/contracts/index.ts";
import {
  createChatGPTAuthProvider,
  createCredentialStore,
  createMemoryCredentialStore,
  ProfileStateStore,
  type AuthFetch,
} from "../src/harness/auth/index.ts";
import { createOpenAIChatGPTAdapter, streamAuthenticated } from "../src/harness/providers/index.ts";
import { fakeFetch, jsonResponse, sseResponse, testRequest, testRoute } from "../src/harness/providers/testing.ts";

const ref: CredentialRef = { provider_id: providerIdSchema.parse("openai"), method: "oauth-subscription", profile: "default" };
const signal = () => new AbortController().signal;
const instant = async () => undefined;

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.signature`;
}

const ID_TOKEN = jwt({
  email: "tunahan@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture", chatgpt_plan_type: "plus" },
});

interface TokenServer {
  readonly fetch: AuthFetch;
  readonly calls: { url: string; body: string; contentType: string | null }[];
}

/** A fake auth.openai.com: token exchange, refresh and device endpoints. No network. */
function tokenServer(options: {
  readonly refresh?: (count: number) => Response;
  readonly devicePending?: number;
  readonly exchange?: () => Response;
} = {}): TokenServer {
  const calls: TokenServer["calls"] = [];
  let refreshes = 0;
  let polls = 0;
  const fetchImpl: AuthFetch = async (input, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    const headers = new Headers(init.headers);
    calls.push({ url: input, body, contentType: headers.get("content-type") });
    const url = new URL(input);
    if (url.pathname === "/oauth/token" && headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return options.exchange?.() ?? jsonResponse(200, { access_token: "access-initial-secret", refresh_token: "refresh-initial-secret", id_token: ID_TOKEN, expires_in: 3600 });
    }
    if (url.pathname === "/oauth/token") {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return options.refresh?.(refreshes) ?? jsonResponse(200, { access_token: `access-refreshed-${refreshes}`, refresh_token: `refresh-rotated-${refreshes}`, expires_in: 3600 });
    }
    if (url.pathname === "/api/accounts/deviceauth/usercode") return jsonResponse(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
    if (url.pathname === "/api/accounts/deviceauth/token") {
      polls += 1;
      if (polls <= (options.devicePending ?? 1)) return new Response("pending", { status: 403 });
      return jsonResponse(200, { authorization_code: "device-code-1", code_challenge: "x", code_verifier: "server-verifier" });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

interface RecordingInteraction extends AuthInteraction {
  readonly opened: string[];
  readonly notices: string[];
  readonly deviceCodes: DeviceCodePrompt[];
  readonly acknowledged: AuthNotice[];
}

function interaction(
  browser: (url: URL) => Promise<void> = async () => undefined,
  options: { readonly interactive?: boolean; readonly accept?: boolean } = {},
): RecordingInteraction {
  const opened: string[] = [];
  const notices: string[] = [];
  const deviceCodes: DeviceCodePrompt[] = [];
  const acknowledged: AuthNotice[] = [];
  return {
    interactive: options.interactive ?? true,
    opened,
    notices,
    deviceCodes,
    acknowledged,
    async openBrowser(url) {
      opened.push(url);
      void browser(new URL(url));
      return true;
    },
    showDeviceCode(prompt) {
      deviceCodes.push(prompt);
    },
    async promptSecret() {
      return "unused";
    },
    async acknowledge(notice) {
      acknowledged.push(notice);
      return options.accept ?? true;
    },
    notify(message) {
      notices.push(message);
    },
  };
}

/** Plays the browser: follows the authorize URL's redirect_uri with the given query. */
function callback(query: (authorize: URL) => Record<string, string>) {
  return async (authorize: URL) => {
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    const target = new URL(`http://127.0.0.1:${redirect.port}${redirect.pathname}`);
    for (const [key, value] of Object.entries(query(authorize))) target.searchParams.set(key, value);
    await fetch(target).then((response) => response.text());
  };
}

function expiredSecret(overrides: Partial<CredentialSecret> = {}): CredentialSecret {
  return {
    method: "oauth-subscription",
    access_token: "access-expired-secret",
    refresh_token: "refresh-current-secret",
    id_token: ID_TOKEN,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    account_id: "acct-fixture",
    plan_type: "plus",
    originator: "synorch",
    obtained_at: new Date(Date.now() - 7_200_000).toISOString(),
    ...overrides,
  } as CredentialSecret;
}

test("ChatGPT browser login: PKCE S256 on the loopback callback, originator=synorch, tokens stored in Synorch's store", async () => {
  const server = tokenServer();
  const store = createMemoryCredentialStore();
  const auth = createChatGPTAuthProvider(store, "default", { state: new ProfileStateStore(undefined), fetch: server.fetch, loopbackPort: 0 });
  const ui = interaction(callback((authorize) => ({ code: "auth-code-1", state: authorize.searchParams.get("state") ?? "" })));
  const status = await auth.login(ui, signal());

  const authorize = new URL(ui.opened[0] ?? "");
  assert.equal(authorize.origin + authorize.pathname, "https://auth.openai.com/oauth/authorize");
  const params = Object.fromEntries(authorize.searchParams);
  assert.equal(params.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(params.response_type, "code");
  assert.equal(params.code_challenge_method, "S256");
  assert.equal(params.originator, "synorch");
  assert.equal(params.codex_cli_simplified_flow, "true");
  assert.equal(params.id_token_add_organizations, "true");
  assert.equal(params.scope, "openid profile email offline_access api.connectors.read api.connectors.invoke");
  assert.match(params.redirect_uri ?? "", /^http:\/\/localhost:\d+\/auth\/callback$/);
  assert.ok((params.state ?? "").length >= 32);

  const exchange = server.calls.find((call) => call.contentType?.startsWith("application/x-www-form-urlencoded"));
  assert.ok(exchange !== undefined);
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "auth-code-1");
  assert.equal(form.get("redirect_uri"), params.redirect_uri);
  const verifier = form.get("code_verifier") ?? "";
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), params.code_challenge, "the verifier matches the challenge");

  const secret = await store.get(ref);
  assert.ok(secret?.method === "oauth-subscription");
  assert.equal(secret.originator, "synorch");
  assert.equal(secret.account_id, "acct-fixture");
  assert.equal(secret.plan_type, "plus");
  assert.ok(authStatusSchema.safeParse(status).success);
  assert.equal(status.state, "connected");
  assert.equal(status.account_label, "t***@example.com");
  assert.equal(status.plan_label, "plus");
  assert.deepEqual(ui.acknowledged.map((notice) => notice.id), ["chatgpt-subscription"]);

  const again = interaction(callback((authorize) => ({ code: "auth-code-2", state: authorize.searchParams.get("state") ?? "" })));
  await auth.login(again, signal());
  assert.equal(again.acknowledged.length, 0, "the notice is acknowledged once per profile");
});

test("ChatGPT login negative: a forged state is refused and missing_codex_entitlement maps to entitlement_missing", async () => {
  const server = tokenServer();
  const auth = createChatGPTAuthProvider(createMemoryCredentialStore(), "default", { state: new ProfileStateStore(undefined), fetch: server.fetch, loopbackPort: 0 });
  const forged: number[] = [];
  const ui = interaction(async (authorize) => {
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    const response = await fetch(`http://127.0.0.1:${redirect.port}/auth/callback?code=evil&state=forged`);
    forged.push(response.status);
    await response.text();
    await callback(() => ({ error: "access_denied", error_description: "missing_codex_entitlement" }))(authorize).catch(() => undefined);
    await callback((url) => ({ error: "access_denied", error_description: "missing_codex_entitlement", state: url.searchParams.get("state") ?? "" }))(authorize);
  });
  await assert.rejects(auth.login(ui, signal()), (error: unknown) => error instanceof ProviderFailure && error.error.code === "entitlement_missing");
  assert.deepEqual(forged, [400]);
  assert.ok(!server.calls.some((call) => new URLSearchParams(call.body).get("code") === "evil"), "a forged callback is never exchanged");
});

test("ChatGPT login falls back to device code when port 1455 is busy; --device-code forces it", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const address = blocker.address();
  const busyPort = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const server = tokenServer({ devicePending: 2 });
    const store = createMemoryCredentialStore();
    const auth = createChatGPTAuthProvider(store, "default", { state: new ProfileStateStore(undefined), fetch: server.fetch, loopbackPort: busyPort, sleep: instant });
    const ui = interaction();
    const status = await auth.login(ui, signal());
    assert.equal(status.state, "connected");
    assert.equal(ui.opened.length, 0);
    assert.match(ui.notices.join("\n"), /busy; using device-code/);
    assert.equal(ui.deviceCodes[0]?.verificationUri, "https://auth.openai.com/codex/device");
    assert.equal(ui.deviceCodes[0]?.userCode, "ABCD-1234");
    const polls = server.calls.filter((call) => call.url.endsWith("/deviceauth/token"));
    assert.equal(polls.length, 3);
    assert.deepEqual(JSON.parse(polls[0]?.body ?? "{}"), { device_auth_id: "dev-1", user_code: "ABCD-1234" });
    const exchange = new URLSearchParams(server.calls.find((call) => call.contentType?.startsWith("application/x-www-form-urlencoded"))?.body);
    assert.equal(exchange.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
    assert.equal(exchange.get("code_verifier"), "server-verifier");

    const forced = createChatGPTAuthProvider(createMemoryCredentialStore(), "default", {
      state: new ProfileStateStore(undefined),
      fetch: tokenServer().fetch,
      deviceCode: true,
      sleep: instant,
    });
    const forcedUi = interaction();
    await forced.login(forcedUi, signal());
    assert.equal(forcedUi.opened.length, 0);
    assert.equal(forcedUi.deviceCodes.length, 1);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("ChatGPT login refuses headless sessions and declined notices without any network call", async () => {
  const server = tokenServer();
  const auth = createChatGPTAuthProvider(createMemoryCredentialStore(), "default", { state: new ProfileStateStore(undefined), fetch: server.fetch, loopbackPort: 0 });
  await assert.rejects(auth.login(interaction(undefined, { interactive: false }), signal()), (error: unknown) => error instanceof HarnessError && error.exitCode === 7);
  await assert.rejects(auth.login(interaction(undefined, { accept: false }), signal()), (error: unknown) => error instanceof HarnessError && error.info.code === "auth_required");
  assert.equal(server.calls.length, 0);
});

test("AC-3 an expired token is refreshed once under the profile lock even for concurrent resolves", async () => {
  const server = tokenServer();
  const store = createMemoryCredentialStore();
  await store.set(ref, expiredSecret());
  const auth = createChatGPTAuthProvider(store, "default", { state: new ProfileStateStore(undefined), fetch: server.fetch });
  const [first, second] = await Promise.all([auth.resolve(signal()), auth.resolve(signal())]);
  const refreshCalls = server.calls.filter((call) => call.contentType === "application/json" && call.url.endsWith("/oauth/token"));
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(JSON.parse(refreshCalls[0]?.body ?? "{}"), { grant_type: "refresh_token", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", refresh_token: "refresh-current-secret" });
  for (const credential of [first, second]) {
    const headers = new Headers();
    credential.applyTo(headers);
    assert.equal(headers.get("authorization"), "Bearer access-refreshed-1");
    assert.equal(headers.get("chatgpt-account-id"), "acct-fixture");
  }
  const stored = await store.get(ref);
  assert.ok(stored?.method === "oauth-subscription");
  assert.equal(stored.refresh_token, "refresh-rotated-1");
  assert.ok(stored.last_refresh_at !== undefined);
  assert.equal(stored.id_token, ID_TOKEN, "fields absent from the refresh response are kept");

  await auth.resolve(signal());
  assert.equal(server.calls.filter((call) => call.contentType === "application/json").length, 1, "a fresh token is not refreshed again");
});

test("AC-3 two processes sharing one home refresh once: the second sees the new token under the lock", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synorch-auth-oauth-"));
  try {
    const server = tokenServer();
    const seed = createCredentialStore(home, { backend: "file-0600" });
    await seed.set(ref, expiredSecret());
    const processA = createChatGPTAuthProvider(createCredentialStore(home, { backend: "file-0600" }), "default", { state: new ProfileStateStore(home), fetch: server.fetch });
    const processB = createChatGPTAuthProvider(createCredentialStore(home, { backend: "file-0600" }), "default", { state: new ProfileStateStore(home), fetch: server.fetch });
    await Promise.all([processA.resolve(signal()), processB.resolve(signal())]);
    assert.equal(server.calls.filter((call) => call.contentType === "application/json").length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("AC-3 a permanent refresh failure marks login_required, keeps the secret and stops further refreshes", async () => {
  const server = tokenServer({ refresh: () => jsonResponse(400, { error: "invalid_grant" }) });
  const store = createMemoryCredentialStore();
  await store.set(ref, expiredSecret());
  const state = new ProfileStateStore(undefined);
  const auth = createChatGPTAuthProvider(store, "default", { state, fetch: server.fetch });
  await assert.rejects(auth.resolve(signal()), (error: unknown) => error instanceof ProviderFailure && error.error.code === "auth_expired");
  assert.ok((await store.get(ref)) !== undefined, "the old secret is not deleted");
  const status = await auth.status(signal());
  assert.equal(status.state, "login_required");
  await assert.rejects(auth.resolve(signal()), ProviderFailure);
  assert.equal(server.calls.length, 1, "no second refresh after a permanent failure");
  await auth.logout(signal());
  assert.equal((await auth.status(signal())).state, "disconnected");
});

test("AC-3 negative: transient refresh failures do not require login; a missing secret is unauthenticated", async () => {
  const server = tokenServer({ refresh: () => new Response("upstream", { status: 503 }) });
  const store = createMemoryCredentialStore();
  await store.set(ref, expiredSecret());
  const auth = createChatGPTAuthProvider(store, "default", { state: new ProfileStateStore(undefined), fetch: server.fetch });
  await assert.rejects(auth.resolve(signal()), (error: unknown) => error instanceof ProviderFailure && error.error.code === "provider_internal" && error.error.retryable);
  assert.equal((await auth.status(signal())).state, "expired");
  const empty = createChatGPTAuthProvider(createMemoryCredentialStore(), "default", { state: new ProfileStateStore(undefined), fetch: server.fetch });
  await assert.rejects(empty.resolve(signal()), (error: unknown) => error instanceof ProviderFailure && error.error.code === "unauthenticated");
  assert.equal((await empty.status(signal())).state, "disconnected");
});

test("AC-2 a 401 triggers exactly one forced refresh; a second 401 ends in auth_expired", async () => {
  const route = testRoute({ provider_id: "openai", model_id: "gpt-test", adapter_id: "openai-chatgpt", auth_method: "oauth-subscription" });
  const authServer = tokenServer();
  const store = createMemoryCredentialStore();
  await store.set(ref, expiredSecret({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  const auth = createChatGPTAuthProvider(store, "default", { state: new ProfileStateStore(undefined), fetch: authServer.fetch });

  const rejecting = fakeFetch(() => jsonResponse(401, { error: { message: "token revoked" } }));
  const events: ModelStreamEvent[] = [];
  for await (const event of streamAuthenticated(createOpenAIChatGPTAdapter({ fetch: rejecting.fetch }), auth, testRequest(route), signal())) events.push(event);
  assert.equal(authServer.calls.length, 1, "one refresh");
  assert.equal(rejecting.requests.length, 2, "one resend");
  assert.equal(rejecting.requests[0]?.headers.get("authorization"), "Bearer access-expired-secret");
  assert.equal(rejecting.requests[1]?.headers.get("authorization"), "Bearer access-refreshed-1");
  const last = events.at(-1);
  assert.ok(last?.type === "error");
  assert.equal(last.error.code, "auth_expired");
  assert.equal(events.length, 1);

  let attempt = 0;
  const recovering = fakeFetch(() => {
    attempt += 1;
    return attempt === 1
      ? jsonResponse(401, { error: { message: "expired" } })
      : sseResponse('data: {"type":"response.output_text.delta","output_index":0,"delta":"ok"}\n\ndata: {"type":"response.completed","response":{}}\n\n');
  });
  const recovered: ModelStreamEvent[] = [];
  for await (const event of streamAuthenticated(createOpenAIChatGPTAdapter({ fetch: recovering.fetch }), auth, testRequest(route), signal())) recovered.push(event);
  assert.equal(recovered.at(-1)?.type, "done");
});
