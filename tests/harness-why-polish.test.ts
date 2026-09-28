import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWhy, type WhyFacts } from "../src/harness/cli/transparency.ts";
import type { SessionEvent } from "../src/harness/contracts/events.ts";

const facts: WhyFacts = { mode: "ask", trust: "trusted", sandbox: "partial", grants: [], planOn: false, noPermissionMode: false };
const route = { provider_id: "p", model_id: "m", adapter_id: "a" };

test("/why: empty states explain themselves; /why model shows effort, fallback and how to change", () => {
  assert.match(String(buildWhy([], "", facts)), /No tool decision recorded yet/);
  assert.match(String(buildWhy([], "model", facts)), /chosen when the first request is sent/);
  const events = [
    { type: "route/decided", data: { decision: { tier: "chat", source: "user", reason: "default", route, fallback: { used: false } } } },
    { type: "model/request_prepared", data: { reasoning_effort: "high" } },
  ] as unknown as SessionEvent[];
  const view = buildWhy(events, "model", facts);
  assert.ok(typeof view !== "string");
  assert.ok(view.facts?.some((fact) => fact.label === "Effort" && fact.text.startsWith("high")));
  assert.ok(view.facts?.some((fact) => fact.label === "Fallback" && fact.text.startsWith("no")));
  assert.ok(view.howToChange.some((change) => change.command === "/effort"));
});
