import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createRuntime } from "../src/harness/cli/runtime.ts";
import {
  createAnthropicMessagesAdapter,
  createClaudeCodeAdapter,
  createModelRouter,
  createOpenAIChatGPTAdapter,
  pickCrossProviderReviewer,
  requestedEffort,
  type CatalogModel,
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

const openaiOnly: RouteRule[] = [
  { source: "user", tier: "orchestrator", route: { provider_id: "openai", model_id: "gpt-6-sol", adapter_id: "openai-chatgpt" } },
  { source: "user", tier: "complex_worker", route: { provider_id: "openai", model_id: "gpt-6-sol", adapter_id: "openai-chatgpt" } },
];

function row(provider: string, model: string, adapterId: string, badge: CatalogModel["badge"], connected = true, label?: string): CatalogModel {
  return {
    provider,
    model,
    adapterId,
    authMethod: badge === "subscription" ? "oauth-subscription" : badge === "bridge" ? "cli-bridge" : "api-key",
    badge,
    connected,
    source: "known",
    capability: "unknown",
    imageInput: "supported",
    ...(label === undefined ? {} : { label }),
  };
}

test("cross-provider reviewer pick: another provider's best connected model for the tier, subscriptions before API keys", () => {
  const catalog = [
    row("openai", "gpt-6-sol", "openai-chatgpt", "subscription"),
    row("anthropic", "opus-5.5", "anthropic-messages", "API key"),
    row("anthropic", "haiku-4.5", "anthropic-messages", "API key", true, "Claude Haiku 4.5 (fast)"),
    row("anthropic", "opus-5.5", "claude-code", "bridge"),
  ];
  const complex = pickCrossProviderReviewer(catalog, "openai", "complex_worker");
  assert.deepEqual([complex?.provider, complex?.model, complex?.adapterId], ["anthropic", "opus-5.5", "claude-code"]);
  assert.equal(pickCrossProviderReviewer(catalog, "openai", "fast_worker")?.model, "haiku-4.5");
  assert.equal(pickCrossProviderReviewer(catalog, "anthropic", "complex_worker")?.model, "gpt-6-sol");
  assert.equal(pickCrossProviderReviewer([row("anthropic", "opus-5.5", "claude-code", "bridge", false)], "openai", "complex_worker"), undefined, "not logged in: never picked");
});

test("reviewer routing: catalog cross-provider pick, explicit reviewer route wins, require fails clearly, off stays", async () => {
  const hook = async () => ({ provider_id: "anthropic", model_id: "opus-5.5", adapter_id: "anthropic-messages" });
  const router = createModelRouter({ rules: openaiOnly, crossProviderReviewer: hook }, adapters());
  const implementer = (await router.resolve({ tier: "complex_worker", role: "implementer" }, signal)).route;
  const reviewer = await router.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal);
  assert.deepEqual([reviewer.route.provider_id, reviewer.route.model_id], ["anthropic", "opus-5.5"]);
  assert.match(reviewer.reason, /cross-provider review.*independent of the implementer provider openai/);

  const explicit = createModelRouter(
    { rules: [...openaiOnly, { source: "user", tier: "complex_worker", role: "reviewer", route: { provider_id: "openai", model_id: "gpt-6-astra", adapter_id: "openai-chatgpt" } }], crossProviderReviewer: hook },
    adapters(),
  );
  const chosen = await explicit.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal);
  assert.equal(chosen.route.model_id, "gpt-6-astra", "routes.<tier>.reviewer always wins");
  assert.match(chosen.reason, /explicit/);

  const none = async () => undefined;
  const required = createModelRouter({ rules: openaiOnly, reviewCrossProvider: "require", crossProviderReviewer: none }, adapters());
  await assert.rejects(required.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal), /review\.cross_provider is require/);

  const preferred = createModelRouter({ rules: openaiOnly, crossProviderReviewer: none }, adapters());
  const same = await preferred.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal);
  assert.equal(same.route.provider_id, "openai");
  assert.match(same.reason, /no provider other than openai is configured or logged in/, "the reason is recorded in the route decision");

  const off = createModelRouter({ rules: openaiOnly, reviewCrossProvider: "off", crossProviderReviewer: hook }, adapters());
  assert.equal((await off.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal)).route.provider_id, "openai");
});

test("runtime: with only OpenAI routes and an Anthropic API key, the reviewer runs on Anthropic", async () => {
  const sandbox = await createSandbox({ "README.md": "# x\n" });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), "routes:\n  - { tier: complex_worker, provider: openai, model: gpt-6-sol }\n  - { tier: orchestrator, provider: openai, model: gpt-6-sol }\n");
    const runtime = await createRuntime({
      workspaceRoot: sandbox.workspace,
      env: { ANTHROPIC_API_KEY: "sk-ant-test-key" },
      policyMode: "autonomous",
      overrides: overridesFor(sandbox, { authOptions: { claudeProbe: async () => ({ installed: false, version: undefined }) } }),
    });
    const implementer = (await runtime.router.resolve({ tier: "complex_worker", role: "implementer" }, signal)).route;
    const reviewer = await runtime.router.resolve({ tier: "complex_worker", role: "reviewer", implementer }, signal);
    assert.deepEqual([reviewer.route.provider_id, reviewer.route.adapter_id], ["anthropic", "anthropic-messages"]);
  } finally {
    await sandbox.cleanup();
  }
});

test("effort precedence: session > flag > role > tier > task hint > model default", () => {
  assert.equal(requestedEffort({ session: "max", flag: "low", role: "medium", tier: "high", hint: "low" }), "max");
  assert.equal(requestedEffort({ flag: "low", role: "medium", tier: "high", hint: "xhigh" }), "low");
  assert.equal(requestedEffort({ role: "medium", tier: "high", hint: "xhigh" }), "medium");
  assert.equal(requestedEffort({ tier: "high", hint: "low" }), "high", "the user's tier setting beats the orchestrator hint");
  assert.equal(requestedEffort({ hint: "low" }), "low", "the hint fills only when nothing is set");
  assert.equal(requestedEffort({}), undefined);
});
