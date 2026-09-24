import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { chooseCatalogRow, saveUserRoute } from "../src/harness/cli/model-picker.ts";
import { createRuntime } from "../src/harness/cli/runtime.ts";
import {
  anthropicWireModelId,
  buildClaudeArgs,
  createAnthropicMessagesAdapter,
  createClaudeCodeAdapter,
  createModelRouter,
  createOpenAIChatGPTAdapter,
  type RouteRule,
} from "../src/harness/providers/index.ts";
import { createSandbox, overridesFor } from "./fixtures/cli/runtime/support.ts";

const signal = new AbortController().signal;

function adapters() {
  return [
    createOpenAIChatGPTAdapter({}),
    createAnthropicMessagesAdapter({}),
    createClaudeCodeAdapter({ experimental: true, executable: { command: "definitely-not-installed-claude" } }),
  ];
}

const ownerRules: RouteRule[] = [
  { source: "user", tier: "orchestrator", route: { provider_id: "openai", model_id: "gpt-6-sol", adapter_id: "openai-chatgpt" } },
  { source: "user", tier: "complex_worker", route: { provider_id: "anthropic", model_id: "opus-5.5", adapter_id: "claude-code" } },
  { source: "user", tier: "fast_worker", route: { provider_id: "openai", model_id: "gpt-6-luna", adapter_id: "openai-chatgpt" } },
];

test("per-tier routes point at different providers and adapter kinds", async () => {
  const router = createModelRouter({ rules: ownerRules }, adapters());
  const orchestrator = await router.resolve({ tier: "orchestrator", role: "orchestrator" }, signal);
  const complex = await router.resolve({ tier: "complex_worker", role: "implementer" }, signal);
  const fast = await router.resolve({ tier: "fast_worker", role: "implementer" }, signal);
  assert.deepEqual([orchestrator.route.provider_id, orchestrator.route.model_id], ["openai", "gpt-6-sol"]);
  assert.deepEqual([complex.route.provider_id, complex.route.adapter_kind, complex.route.auth_method], ["anthropic", "agent-backend", "cli-bridge"]);
  assert.deepEqual([fast.route.provider_id, fast.route.model_id], ["openai", "gpt-6-luna"]);
});

test("reviewer prefers a different provider than the implementer, across tiers when needed, and says so", async () => {
  const router = createModelRouter({ rules: ownerRules }, adapters());
  const implementer = (await router.resolve({ tier: "complex_worker", role: "implementer" }, signal)).route;
  const reviewer = await router.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal);
  assert.equal(reviewer.route.provider_id, "openai");
  assert.equal(reviewer.route.tier, "complex_worker", "the borrowed route is re-tiered for the request");
  assert.match(reviewer.reason, /independent of the implementer provider anthropic/);

  const single = createModelRouter({ rules: [ownerRules[1] as RouteRule] }, adapters());
  const shared = await single.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal);
  assert.match(shared.reason, /shares the implementer model/, "no independent route: said explicitly, never silently");

  const off = createModelRouter({ rules: ownerRules, preferDifferentProvider: false }, adapters());
  const same = await off.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal);
  assert.equal(same.route.provider_id, "anthropic", "with the preference off, only a different model counts");
});

test("session routes from /model override the configured tier and can be cleared", async () => {
  const router = createModelRouter({ rules: ownerRules }, adapters());
  router.setSessionRule("fast_worker", undefined, { provider_id: "anthropic", model_id: "sonnet-5", adapter_id: "claude-code" });
  assert.equal((await router.resolve({ tier: "fast_worker", role: "implementer" }, signal)).route.model_id, "sonnet-5");
  assert.equal(router.rules()[0]?.source, "session");
  assert.equal(router.clearSessionRule("fast_worker", undefined), true);
  assert.equal((await router.resolve({ tier: "fast_worker", role: "implementer" }, signal)).route.model_id, "gpt-6-luna");
  assert.throws(() => router.setSessionRule("session", undefined, { provider_id: "openai", model_id: "x", adapter_id: "nope" }), /unknown adapter/);
});

test("our Claude ids map to the ids Claude Code and the Messages API accept", () => {
  assert.equal(anthropicWireModelId("opus-5.5"), "claude-opus-5-5");
  assert.equal(anthropicWireModelId("sonnet-5"), "claude-sonnet-5");
  assert.equal(anthropicWireModelId("haiku-4.5"), "claude-haiku-4-5");
  assert.equal(anthropicWireModelId("opus"), "opus");
  assert.equal(anthropicWireModelId("claude-opus-5"), "claude-opus-5");
  const args = buildClaudeArgs({ mcpConfigPath: "m", systemPromptPath: "s", modelId: "opus-5.5", maxTurns: 2, sessionId: "a", resume: false });
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5-5");
});

test("model catalog: both providers grouped with badges; only logged-in identities are selectable; routes persist", async () => {
  const sandbox = await createSandbox({ "README.md": "# x\n" });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), "# my config\nroutes:\n  - { tier: orchestrator, provider: openai, model: gpt-6-sol }\nbudget: { max_wall_time_seconds: 900 }\n");
    const runtime = await createRuntime({
      workspaceRoot: sandbox.workspace,
      env: { ANTHROPIC_API_KEY: "sk-ant-test-key" },
      policyMode: "autonomous",
      overrides: overridesFor(sandbox, { authOptions: { claudeProbe: async () => ({ installed: false, version: undefined }) } }),
    });
    const catalog = await runtime.modelCatalog(signal);
    const providers = [...new Set(catalog.map((row) => row.provider))];
    assert.deepEqual(providers.slice(0, 2), ["openai", "anthropic"], "grouped by provider");
    const apiKey = catalog.filter((row) => row.adapterId === "anthropic-messages");
    assert.ok(apiKey.length > 0 && apiKey.every((row) => row.connected && row.badge === "API key"));
    assert.ok(apiKey.some((row) => row.model === "opus-5.5" && row.imageInput === "supported"));
    const subscription = catalog.filter((row) => row.adapterId === "openai-chatgpt");
    assert.ok(subscription.every((row) => !row.connected && row.badge === "subscription" && /syn login openai/.test(row.unavailable ?? "")));
    assert.ok(subscription.some((row) => row.model === "gpt-6-sol" && row.source === "configured"));
    assert.ok(catalog.some((row) => row.adapterId === "claude-code" && row.badge === "bridge" && !row.connected));

    const refused = chooseCatalogRow(catalog, "openai", "gpt-6-luna", undefined);
    assert.ok("error" in refused && /not logged in/.test(refused.error), "a provider that is not logged in is never chosen");
    const chosen = chooseCatalogRow(catalog, "anthropic", "opus-5.5", undefined);
    assert.ok(!("error" in chosen) && chosen.adapterId === "anthropic-messages");
    await assert.rejects(runtime.setSessionRoute("complex_worker", undefined, { provider_id: "openai", model_id: "gpt-6-luna", adapter_id: "openai-chatgpt" }), /not logged in/);
    await runtime.setSessionRoute("complex_worker", undefined, { provider_id: "anthropic", model_id: "opus-5.5", adapter_id: "anthropic-messages" });
    assert.equal((await runtime.router.resolve({ tier: "complex_worker", role: "implementer" }, signal)).route.model_id, "opus-5.5");

    await saveUserRoute(sandbox.home, "complex_worker", undefined, { provider_id: "anthropic", model_id: "opus-5.5", adapter_id: "claude-code" });
    await saveUserRoute(sandbox.home, "orchestrator", undefined, { provider_id: "openai", model_id: "gpt-6-sol", adapter_id: "openai-chatgpt" });
    const text = await readFile(path.join(sandbox.home, "config.yaml"), "utf8");
    assert.match(text, /# my config/, "comments survive");
    const parsed = parseYaml(text) as { routes: Record<string, string>[]; budget: unknown };
    assert.deepEqual(parsed.routes, [
      { tier: "complex_worker", provider: "anthropic", model: "opus-5.5", adapter: "claude-code" },
      { tier: "orchestrator", provider: "openai", model: "gpt-6-sol" },
    ]);
    assert.deepEqual(parsed.budget, { max_wall_time_seconds: 900 });
  } finally {
    await sandbox.cleanup();
  }
});
