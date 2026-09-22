import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalRequestSchema,
  createId,
  HarnessError,
  ProviderFailure,
  routeDecisionSchema,
  type ApprovalDecision,
  type ModelCapability,
} from "../src/harness/contracts/index.ts";
import {
  createAnthropicMessagesAdapter,
  createClaudeCodeAdapter,
  createModelRouter,
  createOpenAIChatGPTAdapter,
  createOpenAIResponsesAdapter,
  providerError,
  RouteBlockedFailure,
  type RouteRule,
} from "../src/harness/providers/index.ts";

const signal = new AbortController().signal;

function capability(id: string): ModelCapability {
  return {
    id: id as ModelCapability["id"],
    context_window: 200_000,
    max_output_tokens: 32_000,
    tool_calls: "supported",
    streaming: "supported",
    cancellation: "supported",
    image_input: "unknown",
    structured_output: "unknown",
    reasoning: "supported",
    prompt_cache: "unknown",
    system_message_updates: "unsupported",
    usage_reporting: "exact",
  };
}

function adapters() {
  return [
    createOpenAIChatGPTAdapter({ models: [capability("gpt-sub")] }),
    createOpenAIResponsesAdapter({ models: [capability("gpt-sub"), capability("gpt-api")] }),
    createAnthropicMessagesAdapter({ models: [capability("claude-api-model")] }),
    createClaudeCodeAdapter({ experimental: false, executable: { command: "definitely-not-installed-claude" } }),
  ];
}

const rules: RouteRule[] = [
  { source: "provider-default", tier: "complex_worker", route: { provider_id: "openai", model_id: "gpt-api", adapter_id: "openai-responses" } },
  { source: "user", tier: "complex_worker", route: { provider_id: "openai", model_id: "gpt-sub", adapter_id: "openai-chatgpt" } },
  { source: "project", tier: "complex_worker", role: "reviewer", route: { provider_id: "openai", model_id: "gpt-sub", adapter_id: "openai-chatgpt" } },
  { source: "workspace", tier: "complex_worker", role: "reviewer", route: { provider_id: "anthropic", model_id: "claude-api-model", adapter_id: "anthropic-messages" } },
  { source: "user", tier: "fast_worker", route: { provider_id: "openai", model_id: "gpt-sub", adapter_id: "openai-chatgpt", profile: "work" } },
];

function userDecision(approval: { approval_id: string; subject_digest: string }, overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    approval_id: approval.approval_id,
    subject_kind: "provider-change",
    subject_digest: approval.subject_digest,
    outcome: "allowed-for-scope",
    decided_by: "user",
    mode: "autonomous",
    decided_at: "2026-09-22T10:00:00Z",
    ...overrides,
  } as ApprovalDecision;
}

test("router resolves by source precedence and records the capability probe", async () => {
  const router = createModelRouter({ rules }, adapters());
  const decision = await router.resolve({ tier: "complex_worker", role: "implementer" }, signal);
  assert.ok(routeDecisionSchema.safeParse(decision).success);
  assert.equal(decision.source, "user");
  assert.equal(decision.route.adapter_id, "openai-chatgpt");
  assert.equal(decision.route.auth_method, "oauth-subscription");
  assert.equal(decision.route.adapter_kind, "model");
  assert.equal(decision.fallback.used, false);
  assert.ok(decision.capabilities_probed_at !== undefined);
  const fast = await router.resolve({ tier: "fast_worker", role: undefined }, signal);
  assert.equal(fast.route.profile, "work");
  assert.equal(router.adapterFor(decision.route).adapterId, "openai-chatgpt");
});

test("reviewer prefers a model independent of the implementer (ADR-09)", async () => {
  const router = createModelRouter({ rules }, adapters());
  const reviewer = await router.resolve({ tier: "complex_worker", role: "reviewer" }, signal);
  assert.equal(reviewer.route.provider_id, "anthropic");
  assert.equal(reviewer.source, "workspace");
  assert.match(reviewer.reason, /independent/);

  const lowerPrecedence = createModelRouter({ rules: rules.filter((rule) => rule.role === undefined) }, adapters());
  const otherModel = await lowerPrecedence.resolve({ tier: "complex_worker", role: "reviewer" }, signal);
  assert.equal(otherModel.route.model_id, "gpt-api", "a different model wins over a higher-precedence shared one");

  const sameOnly = createModelRouter({ rules: rules.filter((rule) => rule.role === undefined && rule.source === "user") }, adapters());
  const shared = await sameOnly.resolve({ tier: "complex_worker", role: "reviewer" }, signal);
  assert.equal(shared.route.model_id, "gpt-sub");
  assert.match(shared.reason, /shares the implementer model/);
});

test("AC-6 quota exhaustion never reroutes silently: quota_exhausted plus a human-only provider-change request", async () => {
  const router = createModelRouter({ rules }, adapters());
  const first = await router.resolve({ tier: "complex_worker", role: "implementer" }, signal);
  router.reportFailure(first.route, providerError("quota_exhausted", "usage_limit_reached", { httpStatus: 429, providerCode: "usage_limit_reached" }));

  const blocked = await router.resolve({ tier: "complex_worker", role: "implementer" }, signal).then(
    () => assert.fail("a blocked route must not resolve"),
    (error: unknown) => error,
  );
  assert.ok(blocked instanceof RouteBlockedFailure);
  assert.ok(blocked instanceof ProviderFailure);
  assert.equal(blocked.error.code, "quota_exhausted");
  assert.equal(blocked.error.retryable, false);
  assert.deepEqual(blocked.blocked, first.route);
  assert.equal(blocked.alternatives[0]?.adapter_id, "openai-responses");

  const runId = createId("run");
  const proposal = router.proposeProviderChange(blocked, { runId });
  assert.ok(approvalRequestSchema.safeParse(proposal.request).success);
  assert.equal(proposal.request.subject_kind, "provider-change");
  assert.equal(proposal.to.auth_method, "api-key");

  await assert.rejects(router.resolve({ tier: "complex_worker", role: "implementer" }, signal), RouteBlockedFailure, "still blocked before a decision");

  router.applyProviderChange(userDecision(proposal.request));
  const switched = await router.resolve({ tier: "complex_worker", role: "implementer" }, signal);
  assert.ok(routeDecisionSchema.safeParse(switched).success);
  assert.equal(switched.fallback.used, true);
  assert.deepEqual(switched.fallback.from, first.route);
  assert.equal(switched.fallback.approval_id, proposal.request.approval_id);
  assert.equal(switched.route.adapter_id, "openai-responses");
});

test("AC-6 negative: orchestrator, rejected or mismatched decisions never enable the fallback", async () => {
  const router = createModelRouter({ rules }, adapters());
  const route = (await router.resolve({ tier: "complex_worker", role: "implementer" }, signal)).route;
  router.reportFailure(route, providerError("quota_exhausted", "limit"));
  const failure = (await router.resolve({ tier: "complex_worker", role: "implementer" }, signal).catch((error: unknown) => error)) as RouteBlockedFailure;
  const runId = createId("run");

  const orchestrated = router.proposeProviderChange(failure, { runId });
  assert.throws(() => router.applyProviderChange(userDecision(orchestrated.request, { decided_by: "orchestrator" })));
  await assert.rejects(router.resolve({ tier: "complex_worker", role: "implementer" }, signal), RouteBlockedFailure);

  const rejected = router.proposeProviderChange(failure, { runId });
  assert.throws(() => router.applyProviderChange(userDecision(rejected.request, { outcome: "rejected" })), HarnessError);

  const tampered = router.proposeProviderChange(failure, { runId });
  assert.throws(
    () => router.applyProviderChange(userDecision({ ...tampered.request, subject_digest: `sha256:${"0".repeat(64)}` })),
    HarnessError,
  );
  await assert.rejects(router.resolve({ tier: "complex_worker", role: "implementer" }, signal), RouteBlockedFailure);
});

test("a quota block lifts after its reset time; other errors do not block", async () => {
  let now = new Date("2026-09-22T10:00:00Z");
  const router = createModelRouter({ rules, now: () => now }, adapters());
  const route = (await router.resolve({ tier: "complex_worker", role: undefined }, signal)).route;
  router.reportFailure(route, providerError("rate_limited", "slow", { retryAfterMs: 1000 }));
  assert.equal((await router.resolve({ tier: "complex_worker", role: undefined }, signal)).route.adapter_id, "openai-chatgpt");
  router.reportFailure(route, providerError("quota_exhausted", "limit", { retryAfterMs: 60_000 }));
  await assert.rejects(router.resolve({ tier: "complex_worker", role: undefined }, signal), RouteBlockedFailure);
  now = new Date("2026-09-22T10:02:00Z");
  assert.equal((await router.resolve({ tier: "complex_worker", role: undefined }, signal)).fallback.used, false);
});

test("router rejects unknown adapters, missing tiers and unlisted models", async () => {
  assert.throws(
    () => createModelRouter({ rules: [{ source: "user", tier: "orchestrator", route: { provider_id: "openai", model_id: "m", adapter_id: "nope" } }] }, adapters()),
    HarnessError,
  );
  assert.throws(
    () => createModelRouter({ rules: [{ source: "user", tier: "orchestrator", route: { provider_id: "anthropic", model_id: "m", adapter_id: "openai-chatgpt" } }] }, adapters()),
    HarnessError,
  );
  const router = createModelRouter({ rules: [{ source: "user", tier: "orchestrator", route: { provider_id: "openai", model_id: "gpt-unknown", adapter_id: "openai-chatgpt" } }] }, adapters());
  await assert.rejects(router.resolve({ tier: "fast_worker", role: undefined }, signal), HarnessError);
  await assert.rejects(router.resolve({ tier: "orchestrator", role: undefined }, signal), (error: unknown) => error instanceof ProviderFailure && error.error.code === "model_unavailable");
});
