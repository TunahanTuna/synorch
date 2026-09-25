import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setUserSetting } from "../src/harness/cli/config-command.ts";
import { loadRuntimeConfig } from "../src/harness/cli/config.ts";
import type { ModelAdapter, SessionHeaderView } from "../src/harness/contracts/index.ts";
import { buildClaudeArgs } from "../src/harness/providers/claude-code/adapter.ts";
import { clampEffort, collectStream, createAnthropicMessagesAdapter, createOpenAIChatGPTAdapter, fetchCodexModels, resolveEffort } from "../src/harness/providers/index.ts";
import { fakeFetch, jsonResponse, sseResponse, staticCredential, testRequest, testRoute } from "../src/harness/providers/testing.ts";
import { PiTuiRenderer, statusLineParts } from "../src/harness/tui/pi-tui-renderer.ts";
import { createStyler } from "../src/harness/tui/style.ts";
import { VirtualTerminal } from "./fixtures/ux/capture.ts";

/** K6 reasoning effort (clamping and provider mapping) and the K3 live status line. */

test("effort is clamped to the nearest level the model takes, and the clamp is reported", () => {
  assert.equal(clampEffort("ultra", ["low", "medium", "high", "xhigh", "max"]), "max");
  assert.equal(clampEffort("xhigh", ["low", "medium", "high"]), "high");
  assert.equal(clampEffort("medium", ["low", "high"]), "low", "ties go to the lower level");

  const luna = resolveEffort("ultra", { provider: "openai", model: "gpt-6-luna", adapterId: "openai-chatgpt" });
  assert.equal(luna.effective, "max");
  assert.match(luna.notice ?? "", /gpt-6-luna does not support effort ultra; using max/);
  const sol = resolveEffort("ultra", { provider: "openai", model: "gpt-6-sol", adapterId: "openai-chatgpt" });
  assert.deepEqual([sol.effective, sol.notice], ["ultra", undefined]);
  const haiku = resolveEffort("xhigh", { provider: "anthropic", model: "haiku-4.5", adapterId: "anthropic-messages" });
  assert.equal(haiku.effective, "high");
  const opus = resolveEffort("xhigh", { provider: "anthropic", model: "opus-5.5", adapterId: "claude-code" });
  assert.deepEqual([opus.effective, opus.notice], ["xhigh", undefined]);
  // Unknown models get the level unchanged (the provider decides); scripted routes take none.
  assert.equal(resolveEffort("high", { provider: "openai", model: "gpt-next", adapterId: "openai-responses" }).effective, "high");
  assert.equal(resolveEffort("high", { provider: "scripted", model: "s", adapterId: "scripted" }).effective, undefined);
});

async function firstBody(adapter: ModelAdapter, route: ReturnType<typeof testRoute>, fetch: ReturnType<typeof fakeFetch>, overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
  const credential = staticCredential(adapter.providerId, "sk-test-secret-value", adapter.providerId === "anthropic" ? "x-api-key" : "authorization");
  await collectStream(adapter.stream(testRequest(route, overrides), credential, new AbortController().signal));
  return JSON.parse(fetch.requests[0]?.body ?? "{}") as Record<string, unknown>;
}

test("provider mapping: reasoning.effort, output_config.effort, thinking budgets and claude --effort", async () => {
  const empty = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[]}}\n\n";
  const openai = fakeFetch(() => sseResponse(empty));
  const chatgpt = testRoute({ provider_id: "openai", model_id: "gpt-6-sol", adapter_id: "openai-chatgpt", auth_method: "oauth-subscription" });
  const openaiBody = await firstBody(createOpenAIChatGPTAdapter({ fetch: openai.fetch }), chatgpt, openai, { reasoning_effort: "xhigh" });
  assert.deepEqual(openaiBody.reasoning, { effort: "xhigh", summary: "auto" });

  const anthropic = fakeFetch(() => sseResponse(""));
  const opus = testRoute({ provider_id: "anthropic", model_id: "opus-5.5", adapter_id: "anthropic-messages" });
  const opusBody = await firstBody(createAnthropicMessagesAdapter({ fetch: anthropic.fetch }), opus, anthropic, { reasoning_effort: "ultra" });
  assert.deepEqual(opusBody.thinking, { type: "adaptive" });
  assert.deepEqual(opusBody.output_config, { effort: "max" });

  const budget = fakeFetch(() => sseResponse(""));
  const haiku = testRoute({ provider_id: "anthropic", model_id: "haiku-4.5", adapter_id: "anthropic-messages" });
  const haikuBody = await firstBody(createAnthropicMessagesAdapter({ fetch: budget.fetch }), haiku, budget, { reasoning_effort: "high", max_output_tokens: 32000 });
  assert.deepEqual(haikuBody.thinking, { type: "enabled", budget_tokens: 16384 });
  assert.equal(haikuBody.output_config, undefined);

  const args = buildClaudeArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.txt", modelId: "opus-5.5", maxTurns: 4, sessionId: "id", resume: false, effort: "xhigh" });
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.ok(!buildClaudeArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.txt", modelId: "opus-5.5", maxTurns: 4, sessionId: "id", resume: false }).includes("--effort"));
});

test("the Codex models listing carries each model's reasoning levels", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse(200, { models: [{ slug: "gpt-6-luna", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }, { slug: "plain" }] }),
  );
  const listed = await fetchCodexModels(fetch.fetch, new Headers(), new AbortController().signal);
  assert.deepEqual(listed, [{ id: "gpt-6-luna", efforts: ["low", "max"], defaultEffort: "medium" }, { id: "plain" }]);
});

test("syn config set effort.<slot> writes a validated level to the user configuration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synorch-effort-"));
  try {
    const change = await setUserSetting(home, "effort.complex_worker", "XHIGH");
    assert.equal(change.value, "xhigh");
    const config = await loadRuntimeConfig(home, home, [], { ceiling: home });
    assert.deepEqual(config.effort, { complex_worker: "xhigh" });
    await assert.rejects(setUserSetting(home, "effort.session", "extreme"), /Expected low, medium, high, xhigh, max, ultra/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const HEADER: SessionHeaderView = { workspaceRoot: "/work/demo", gitBranch: "main", policyMode: "autonomous", routes: [], sandboxEnforcement: "full", notices: [], version: "0.4.0-beta.1", model: "gpt-6-sol", permissionMode: "auto" };

test("the status line follows /model and /effort at once", async () => {
  const terminal = new VirtualTerminal(100, 24);
  const tui = new PiTuiRenderer({ color: false, policyMode: "autonomous", environment: { platform: "linux", env: {} }, terminal, schedule: () => {}, drainInputMs: 0, view: "conversation", now: () => 1_000 });
  await tui.start(HEADER);
  const footer = async (): Promise<string> => {
    tui.flush();
    const lines = (await terminal.viewport()).split("\n").filter((line) => line.includes("auto mode"));
    return lines.at(-1) ?? "";
  };
  assert.match(await footer(), /gpt-6-sol/);
  tui.controls.setSessionStatus?.({ model: "gpt-6-luna", effort: "high" });
  const changed = await footer();
  assert.match(changed, /gpt-6-luna \S high/);
  assert.doesNotMatch(changed, /gpt-6-sol/);
  tui.controls.setSessionStatus?.({ model: "gpt-6-luna", effort: undefined });
  assert.doesNotMatch(await footer(), /high/);
  await tui.stop("completed");
});

test("status line fields: threshold colours, no ANSI without colour", () => {
  const painted = (percent: number) => statusLineParts({ model: "m", effort: "high", contextPercent: percent, quotaPercent: percent, costUsd: undefined }, { folder: "f", branch: "b", mode: undefined, approvalWaiting: false, style: createStyler(true) });
  const ctx = (percent: number) => painted(percent).find((part) => part.text.includes("ctx"))?.text ?? "";
  assert.match(ctx(30), /\u001b\[32m/);
  assert.match(ctx(70), /\u001b\[33m/);
  assert.match(ctx(90), /\u001b\[31m/);
  assert.match(painted(90).find((part) => part.text.includes("quota"))?.text ?? "", /\u001b\[31m/);
  const plain = statusLineParts({ model: "m", effort: "high", contextPercent: 90, quotaPercent: 10, costUsd: undefined }, { folder: "f", branch: "b", mode: "auto mode", approvalWaiting: false, style: createStyler(false) });
  assert.ok(plain.every((part) => !part.text.includes("\u001b")));
  assert.deepEqual(plain.map((part) => part.text), ["f", "b", "m", "high", "auto mode", "ctx 90%", "quota 10%"]);
  // Narrow screens drop branch, folder, quota, effort, then the model; mode and ctx never.
  const order = [...plain].filter((part) => part.drop > 0).sort((left, right) => left.drop - right.drop).map((part) => part.text);
  assert.deepEqual(order, ["b", "f", "quota 10%", "high", "m"]);
});
