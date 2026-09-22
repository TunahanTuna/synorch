import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  FORBIDDEN_CREDENTIAL_SOURCES,
  providerIdSchema,
  type AuthInteraction,
  type CredentialRef,
  type ModelStreamEvent,
} from "../src/harness/contracts/index.ts";
import {
  createApiKeyAuthProvider,
  createChatGPTAuthProvider,
  createMemoryCredentialStore,
  createResolvedCredential,
  ProfileStateStore,
  type AuthFetch,
} from "../src/harness/auth/index.ts";
import { createAnthropicMessagesAdapter, createOpenAIChatGPTAdapter, streamAuthenticated } from "../src/harness/providers/index.ts";
import { fakeFetch, jsonResponse, sseResponse, testRequest, testRoute } from "../src/harness/providers/testing.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCESS = "access-REDACTION-canary-7f3a";
const REFRESH = "refresh-REDACTION-canary-91bc";
const REFRESHED = "access-REDACTION-canary-refreshed";
const API_KEY = "sk-ant-REDACTION-canary-key";

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

test("AC-4 ResolvedCredential serializes, inspects and stringifies as [redacted]", () => {
  const ref: CredentialRef = { provider_id: providerIdSchema.parse("openai"), method: "api-key", profile: "default" };
  const credential = createResolvedCredential(ref, { method: "api-key", api_key: API_KEY, created_at: "2026-09-22T10:00:00Z" }, (headers, secret) => {
    if (secret.method === "api-key") headers.set("authorization", `Bearer ${secret.api_key}`);
  });
  assert.equal(JSON.stringify(credential), '"[redacted]"');
  assert.equal(JSON.stringify({ nested: { credential } }), '{"nested":{"credential":"[redacted]"}}');
  assert.equal(inspect(credential, { depth: 5 }), "[redacted]");
  assert.equal(String(credential), "[redacted]");
  assert.ok(!JSON.stringify({ ...credential }).includes(API_KEY), "spreading exposes no secret field");
  assert.ok(!Object.values(credential).some((value) => typeof value === "string" && value.includes(API_KEY)));
  assert.deepEqual(credential.redactionValues(), [API_KEY]);
  const headers = new Headers();
  credential.applyTo(headers);
  assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);
});

test("AC-4 tokens never appear in stream events, statuses or user notices across login, refresh and requests", async () => {
  const captured: string[] = [];
  const authFetch: AuthFetch = async (input, init) => {
    const contentType = new Headers(init.headers).get("content-type") ?? "";
    if (input.endsWith("/oauth/token") && contentType.startsWith("application/x-www-form-urlencoded")) {
      return jsonResponse(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 1 });
    }
    return jsonResponse(200, { access_token: REFRESHED, refresh_token: `${REFRESH}-2`, expires_in: 3600 });
  };
  const interaction: AuthInteraction = {
    interactive: true,
    async openBrowser(url) {
      captured.push(url);
      const authorize = new URL(url);
      const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      void fetch(`http://127.0.0.1:${redirect.port}/auth/callback?code=c&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`).then((response) => response.text());
      return true;
    },
    showDeviceCode(prompt) {
      captured.push(JSON.stringify(prompt));
    },
    async promptSecret() {
      return API_KEY;
    },
    async acknowledge(notice) {
      captured.push(notice.text);
      return true;
    },
    notify(message) {
      captured.push(message);
    },
  };
  const store = createMemoryCredentialStore();
  const chatgpt = createChatGPTAuthProvider(store, "default", { state: new ProfileStateStore(undefined), fetch: authFetch, loopbackPort: 0 });
  captured.push(JSON.stringify(await chatgpt.login(interaction, new AbortController().signal)));
  captured.push(JSON.stringify(await chatgpt.status(new AbortController().signal)));

  const sse = await readFile(new URL("./fixtures/providers/responses-text-and-tool.sse", import.meta.url), "utf8");
  const events: ModelStreamEvent[] = [];
  const route = testRoute({ provider_id: "openai", model_id: "gpt-test", adapter_id: "openai-chatgpt", auth_method: "oauth-subscription" });
  const upstream = fakeFetch(() => sseResponse(sse));
  for await (const event of streamAuthenticated(createOpenAIChatGPTAdapter({ fetch: upstream.fetch }), chatgpt, testRequest(route), new AbortController().signal)) events.push(event);
  assert.equal(upstream.requests[0]?.headers.get("authorization"), `Bearer ${REFRESHED}`, "the token did reach the provider header");

  const apiKey = createApiKeyAuthProvider(store, "anthropic", "default", { env: {} });
  captured.push(JSON.stringify(await apiKey.login(interaction, new AbortController().signal)));
  const failing = fakeFetch(() => jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  const anthropicRoute = testRoute({ provider_id: "anthropic", model_id: "claude-api-model", adapter_id: "anthropic-messages" });
  for await (const event of streamAuthenticated(createAnthropicMessagesAdapter({ fetch: failing.fetch }), apiKey, testRequest(anthropicRoute), new AbortController().signal)) events.push(event);
  captured.push(JSON.stringify(await apiKey.status(new AbortController().signal)));

  const everything = [...captured, ...events.map((event) => JSON.stringify(event))].join("\n");
  for (const secret of [ACCESS, REFRESH, REFRESHED, API_KEY]) assert.ok(!everything.includes(secret), `leaked ${secret}`);
});

test("AC-4 recorded provider fixtures contain no credential material (grep)", async () => {
  const patterns = [
    /sk-(ant-|proj-)?[A-Za-z0-9_-]{16,}/,
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
    /"(access|refresh|id)_token"\s*:\s*"[^"]+"/,
    /authorization\s*:\s*bearer/i,
    /x-api-key\s*:/i,
  ];
  const files = await listFiles(path.join(ROOT, "tests", "fixtures", "providers"));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of patterns) assert.ok(!pattern.test(text), `${path.basename(file)} matches ${pattern}`);
  }
});

test("no auth or provider code path references another application's credential store", async () => {
  const sources = [
    ...(await listFiles(path.join(ROOT, "src", "harness", "auth"))),
    ...(await listFiles(path.join(ROOT, "src", "harness", "providers"))),
  ].filter((file) => file.endsWith(".ts"));
  const forbidden = [/\.claude[\\/"']/, /\.claude\.json/, /\.codex[\\/"']/, /Claude Code-credentials/, /CODEX_HOME/, /auth\.json/];
  for (const file of sources) {
    const text = await readFile(file, "utf8");
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `${path.relative(ROOT, file)} references ${pattern}`);
  }
  assert.ok(FORBIDDEN_CREDENTIAL_SOURCES.length === 4);
});
