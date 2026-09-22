import assert from "node:assert/strict";
import { test } from "node:test";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { providerError } from "../src/harness/providers/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import {
  call,
  capture,
  createSandbox,
  eventsOf,
  overridesFor,
  parseFrames,
  planArguments,
  readSession,
  text,
  writeConfig,
} from "./fixtures/cli/runtime/support.ts";

/**
 * Verification level 3, "provider timeout / rate limit": the attempt fails visibly, the route and
 * usage stay visible, a retry is a new attempt on the same route, and nothing falls back silently to
 * the other configured route. An exhausted quota blocks the route; the retry then asks for a human
 * provider-change decision, which a headless run cannot give, so the task stops instead.
 */

test("rate limit and exhausted quota: failed attempts on the same route, no silent fallback", async () => {
  const sandbox = await createSandbox({ "README.md": "# r\n", "src/a.txt": "a\n" });
  try {
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "alt-script", model: "alt-model" },
      { tier: "fast_worker", adapter: "alt-script", model: "alt-model" },
    ]);
    const orchestrator = createScriptedAdapter(
      [call("plan_propose", () => planArguments("Edit a", [{ key: "edit-a", risk: "trivial", owned: ["src/a.txt"], read: ["src/a.txt"] }])), text("planned")],
      { adapterId: "plan-script" },
    );
    const primary = createScriptedAdapter(
      [
        [{ type: "error", error: providerError("rate_limited", "429 too many requests", { httpStatus: 429, retryAfterMs: 2000 }) }],
        [{ type: "error", error: providerError("quota_exhausted", "usage limit reached", { httpStatus: 429, retryAfterMs: 3_600_000 }) }],
        text("must never be requested: the route is blocked"),
      ],
      { adapterId: "primary-script" },
    );
    const alternative = createScriptedAdapter([text("must never be requested: no silent fallback")], { adapterId: "alt-script" });

    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Edit a", "--mode", "jsonl", "--profile", "complex_worker=scripted/primary-model@primary-script"], run.io, overridesFor(sandbox, { adapters: [orchestrator, primary, alternative], limits: { maxRetries: 2 } }));
    const { frames, problems } = parseFrames(run.stdout());
    assert.deepEqual(problems, []);
    assert.equal(code, 4, `a provider failure exits 4 (cli-and-jsonl.md §5)\n${run.stderr()}`);
    const last = frames.at(-1);
    assert.ok(last?.type === "error", "a provider failure ends with an error frame");
    assert.equal(last.data.code, "provider_failed");
    assert.match(last.data.message, /edit-a \(implementer\): blocked/);

    assert.equal(alternative.requests.length, 0, "the other configured route never received a request");
    assert.equal(primary.requests.length, 2, "after the quota was exhausted the blocked route got no further request");

    const hello = frames[0];
    assert.ok(hello?.type === "hello");
    const runLog = await readSession(sandbox.home, hello.data.session_id);
    const workerRoutes = eventsOf(runLog, "route/decided").map((event) => event.data.decision).filter((decision) => decision.tier === "complex_worker");
    assert.ok(workerRoutes.length >= 2);
    assert.ok(workerRoutes.every((decision) => decision.route.model_id === "primary-model" && decision.source === "session" && !decision.fallback.used), "the decided route is visible and never a fallback");

    const attempts = eventsOf(runLog, "attempt/started");
    assert.equal(attempts.length, 2, "each retry is a new attempt");
    assert.deepEqual(eventsOf(runLog, "attempt/state_changed").map((event) => event.data.to), ["failed", "failed"]);
    const failures: string[] = [];
    for (const attempt of attempts) {
      const log = await readSession(sandbox.home, attempt.data.session_id ?? "");
      failures.push(...eventsOf(log, "model/response_failed").map((event) => event.data.error.code));
      assert.equal(eventsOf(log, "turn/ended")[0]?.data.outcome, "failed");
    }
    assert.deepEqual(failures, ["rate_limited", "quota_exhausted"]);

    const change = eventsOf(runLog, "approval/requested").find((event) => event.data.request.subject_kind === "provider-change");
    assert.ok(change !== undefined, "a blocked route asks for a provider change instead of switching");
    const decided = eventsOf(runLog, "approval/decided").find((event) => event.data.decision.approval_id === change.data.request.approval_id);
    assert.equal(decided?.data.decision.outcome, "unavailable", "a headless run cannot approve a provider change");
    const blocked = eventsOf(runLog, "task/state_changed").at(-1);
    assert.equal(blocked?.data.to, "blocked");
    assert.match(blocked?.data.reason ?? "", /quota/);
  } finally {
    await sandbox.cleanup();
  }
});
