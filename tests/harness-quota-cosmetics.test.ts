import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createId, type SessionEvent } from "../src/harness/contracts/index.ts";
import { UsageLedger } from "../src/harness/cli/usage-stats.ts";
import { claudeRateLimitQuota } from "../src/harness/providers/claude-code/adapter.ts";
import { ConversationPresenter, footerText, GLYPH_SETS, runPrompts } from "../src/harness/tui/conversation-view.ts";
import { displayWidth, truncate, wrap } from "../src/harness/tui/views/kit.ts";

const base = { session_id: createId("session"), seq: 1, event_version: 1, timestamp: "2026-09-25T10:00:00Z" };
const ev = (value: Record<string, unknown>): SessionEvent => ({ ...base, ...value }) as unknown as SessionEvent;

function usage(requestId: string, provider: string, role: string, windows: { name: string; used_percent: number; resets_at?: string }[]): SessionEvent {
  return ev({ type: "provider/usage", actor: { kind: "agent", role }, data: { request_id: requestId, provider_id: provider, usage: { input_tokens: 10, output_tokens: 5, source: "provider-reported" }, quota: { source: "api", windows } } });
}

test("quota per provider: ledger footer names the most-used provider, /usage lists each with worker requests", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "syn-quota-"));
  try {
    const ledger = new UsageLedger(home, () => new Date("2026-09-25T10:00:00Z"));
    const chat = createId("request");
    const worker = createId("request");
    ledger.observe(ev({ type: "model/request_prepared", actor: { kind: "agent", role: "session" }, data: { request_id: chat, route: { provider_id: "openai", model_id: "gpt-6", auth_method: "oauth-subscription" } } }));
    ledger.observe(usage(chat, "openai", "session", [{ name: "5h", used_percent: 30 }, { name: "weekly", used_percent: 12 }]));
    ledger.observe(ev({ type: "model/request_prepared", actor: { kind: "agent", role: "implementer" }, data: { request_id: worker, route: { provider_id: "anthropic", model_id: "opus-5.5", auth_method: "cli-bridge" } } }));
    ledger.observe(usage(worker, "anthropic", "implementer", [{ name: "5h", used_percent: 72, resets_at: "2026-09-25T11:20:00Z" }]));
    const footer = ledger.footer();
    assert.equal(footer.quotaPercent, 72);
    assert.equal(footer.quotaProvider, "anthropic");
    const view = await ledger.view(undefined, new Map([["openai", "ChatGPT Plus"]]), (provider) => (provider === "anthropic" ? "claude" : "chatgpt"));
    assert.deepEqual(
      view.quotas?.map((quota) => [quota.provider, quota.window, quota.usedPercent, quota.resetsAt, quota.plan, quota.requests]),
      [
        ["claude", "5h", 72, "in 1h 20m", undefined, { total: 1, workers: 1 }],
        ["chatgpt", "5h", 30, undefined, "ChatGPT Plus", { total: 1, workers: 0 }],
        ["chatgpt", "weekly", 12, undefined, undefined, undefined],
      ],
    );
    assert.match((await ledger.report()).join("\n"), /Quota anthropic: 72% of the 5h window \(resets in 1h 20m\) used · 1 request this session \(1 by workers\)/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("footer shows the max-used provider's quota, worker usage included", () => {
  const presenter = new ConversationPresenter({ glyphs: GLYPH_SETS.rich, echoesUser: false });
  presenter.apply({ kind: "session-event", event: usage(createId("request"), "openai", "session", [{ name: "5h", used_percent: 40 }]) });
  presenter.apply({ kind: "session-event", event: usage(createId("request"), "anthropic", "implementer", [{ name: "5h", used_percent: 72 }]) });
  const footer = presenter.footer();
  assert.equal(footer.quotaPercent, 72);
  assert.equal(footer.quotaProvider, "claude");
  assert.match(footerText(footer, { folder: "f", branch: undefined, glyphs: GLYPH_SETS.rich }), /quota 72% claude/);
});

test("Claude Code rate_limit_event becomes a quota window; unknown levels yield nothing", () => {
  assert.deepEqual(claudeRateLimitQuota({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.72, resetsAt: 1790000000 }), {
    source: "api",
    windows: [{ name: "5h", used_percent: 72, resets_at: new Date(1790000000 * 1000).toISOString() }],
  });
  assert.equal(claudeRateLimitQuota({ status: "rejected", rateLimitType: "seven_day" })?.windows[0]?.used_percent, 100);
  assert.equal(claudeRateLimitQuota({ status: "allowed", rateLimitType: "five_hour" }), undefined);
});

test("a syn run session hides the planner prompts and exposes the goal", () => {
  const runId = createId("run");
  const events = [
    ev({ type: "run/created", run_id: runId, actor: { kind: "system" }, data: { goal: "convert the tests" } }),
    ev({ type: "message/recorded", actor: { kind: "user" }, data: { role: "user", message: { role: "user", content: [{ type: "text", text: "You are the planner…" }] } } }),
    ev({ type: "run/state_changed", run_id: runId, actor: { kind: "system" }, data: { from: "running", to: "completed", reason: "done" } }),
    ev({ type: "message/recorded", actor: { kind: "user" }, data: { role: "user", message: { role: "user", content: [{ type: "text", text: "thanks" }] } } }),
  ];
  const run = runPrompts(events);
  assert.equal(run.goal, "convert the tests");
  assert.equal(run.hidden.size, 1);
  assert.ok(run.hidden.has(events[1] as SessionEvent));
});

test("view widths are grapheme-aware: ZWJ families, flags and skin tones are one 2-cell unit", () => {
  assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2);
  assert.equal(displayWidth("🇹🇷"), 2);
  assert.equal(displayWidth("👍🏽 ok"), 5);
  assert.equal(truncate("ab👨‍👩‍👧‍👦cd🇹🇷ef", 6), "ab👨‍👩‍👧‍👦c…");
  assert.deepEqual(wrap("fix 👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦 done", 4), ["fix", "👨‍👩‍👧‍👦👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦", "done"]);
});
