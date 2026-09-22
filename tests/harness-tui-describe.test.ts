import assert from "node:assert/strict";
import { test } from "node:test";
import { createId, sha256, type SessionEvent } from "../src/harness/contracts/index.ts";
import { describeEvent, levelPrefix } from "../src/harness/tui/describe.ts";

/**
 * Autonomous plan self-approval (ADR-08) is an audited decision, not something the user must act
 * on: renderers show it as an informational line. Human-only subjects and `ask` mode still warn.
 */

function event(type: "approval/requested" | "approval/decided", data: unknown): SessionEvent {
  return {
    schema_version: 1,
    seq: 1,
    session_id: createId("session"),
    timestamp: new Date().toISOString(),
    type,
    event_version: 1,
    actor: { kind: "orchestrator", role: "orchestrator" },
    data,
  } as unknown as SessionEvent;
}

function requested(subject: "plan" | "provider-change") {
  return event("approval/requested", {
    request: { approval_id: createId("approval"), run_id: createId("run"), subject_kind: subject, subject_digest: sha256(subject), summary: "Plan v1: fix it", scope: "plan", requested_at: new Date().toISOString() },
  });
}

function decided(by: "orchestrator" | "user", mode: "autonomous" | "ask") {
  return event("approval/decided", {
    decision: { approval_id: createId("approval"), subject_kind: "plan", subject_digest: sha256("plan"), outcome: "allowed-for-scope", decided_by: by, mode, decided_at: new Date().toISOString() },
  });
}

test("autonomous self-approval renders as an informational audited line, never a warning", () => {
  const request = describeEvent(requested("plan"), { policyMode: "autonomous" });
  assert.equal(request?.level, "info");
  assert.equal(levelPrefix(request?.level ?? "info"), "");
  assert.match(request?.text ?? "", /^Approval \(plan\) decided by the orchestrator under autonomous policy, recorded for audit: Plan v1: fix it$/);
  const decision = describeEvent(decided("orchestrator", "autonomous"), { policyMode: "autonomous" });
  assert.equal(decision?.level, "info");
  assert.equal(decision?.text, "Approval allowed-for-scope by orchestrator (autonomous self-approval, audited)");
});

test("ask mode and human-only subjects still ask for attention", () => {
  assert.equal(describeEvent(requested("plan"), { policyMode: "ask" })?.level, "warning");
  assert.equal(describeEvent(requested("plan"))?.level, "warning", "without a known mode the safe default is a warning");
  const change = describeEvent(requested("provider-change"), { policyMode: "autonomous" });
  assert.equal(change?.level, "warning");
  assert.match(change?.text ?? "", /^Approval needed \(provider-change\)/);
  assert.equal(describeEvent(decided("user", "ask"), { policyMode: "ask" })?.level, "success");
});
