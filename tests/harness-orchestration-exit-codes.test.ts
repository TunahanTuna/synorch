import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createId,
  EVENT_VERSIONS,
  EXIT_CODES,
  ProviderFailure,
  type SessionEvent,
  type SessionEventDraft,
  type TurnOutcome,
} from "../src/harness/contracts/index.ts";
import { classifyAttemptFailure, failedRunExitCode } from "../src/harness/orchestration/index.ts";
import { createScriptedPlanner, createTempWorkspace, createTestRuntime, testPlan, type ScriptContext } from "../src/harness/orchestration/testing.ts";

/**
 * Exit codes of failed runs (cli-and-jsonl.md §5): a provider or tool failure is exit 4, a
 * verification failure exit 5. The cause is read from the attempt's own log, never guessed.
 */

function draft(context: ScriptContext, type: SessionEventDraft["type"], data: unknown): SessionEventDraft {
  return {
    type,
    data,
    event_version: EVENT_VERSIONS[type],
    actor: { kind: "system" },
    run_id: context.input.runId,
    ...(context.input.taskId === undefined ? {} : { task_id: context.input.taskId }),
    ...(context.input.attemptId === undefined ? {} : { attempt_id: context.input.attemptId }),
  } as SessionEventDraft;
}

function outcome(value: TurnOutcome["outcome"]): TurnOutcome {
  return { turnId: createId("turn"), outcome: value, steps: 1 };
}

test("failedRunExitCode: verification wins, then the first recorded cause, else verification", () => {
  assert.equal(failedRunExitCode(["provider_failed"]), EXIT_CODES.provider);
  assert.equal(failedRunExitCode(["tool_failed", undefined]), EXIT_CODES.provider);
  assert.equal(failedRunExitCode(["provider_failed", "review_blocked"]), EXIT_CODES.verification);
  assert.equal(failedRunExitCode([undefined]), EXIT_CODES.verification);
  assert.equal(failedRunExitCode(["sandbox_insufficient"]), EXIT_CODES.policy);
});

test("classifyAttemptFailure reads the provider or tool cause from the attempt log", () => {
  const base = { schema_version: 1, session_id: createId("session"), timestamp: new Date().toISOString(), actor: { kind: "system" } } as const;
  const failed = { ...base, seq: 1, type: "model/response_failed", event_version: 1, data: { request_id: createId("request"), error: { code: "provider_internal", message: "503", retryable: true } } } as unknown as SessionEvent;
  const cancelled = { ...base, seq: 1, type: "model/response_failed", event_version: 1, data: { request_id: createId("request"), error: { code: "cancelled", message: "stop", retryable: false } } } as unknown as SessionEvent;
  const started = { ...base, seq: 2, type: "tool/execution_started", event_version: 1, data: { tool_call_id: createId("toolCall"), sandbox_enforcement: "partial" } } as unknown as SessionEvent;
  assert.equal(classifyAttemptFailure(outcome("failed"), undefined, [failed]), "provider_failed");
  assert.equal(classifyAttemptFailure(outcome("failed"), undefined, [cancelled]), undefined);
  assert.equal(classifyAttemptFailure(undefined, new Error("gateway broke"), [failed, started]), "tool_failed");
  assert.equal(classifyAttemptFailure(outcome("completed"), undefined, [failed]), undefined, "a completed turn has no failure cause");
  assert.equal(classifyAttemptFailure(undefined, new ProviderFailure({ code: "unauthenticated", message: "login", retryable: false }), []), "provider_failed");
});

test("a provider failure in every attempt ends the run with exit 4", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const runtime = createTestRuntime({
      workspace,
      planner: createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial" }])),
      limits: { maxRetries: 1 },
      script: async (context) => {
        await context.events.append(draft(context, "model/response_failed", { request_id: createId("request"), error: { code: "provider_internal", message: "upstream 503", retryable: true } }));
        return "failed";
      },
    });
    const result = await runtime.run();
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, EXIT_CODES.provider);
  } finally {
    await workspace.cleanup();
  }
});

test("a tool whose execution breaks the turn ends the run with exit 4", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const runtime = createTestRuntime({
      workspace,
      planner: createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial" }])),
      limits: { maxRetries: 0 },
      script: async (context) => {
        const toolCallId = createId("toolCall");
        await context.events.append(draft(context, "tool/call_proposed", { tool_call_id: toolCallId, provider_call_id: "p-1", tool_name: "exec", args_digest: `sha256:${"0".repeat(64)}` }));
        await context.events.append(draft(context, "tool/execution_started", { tool_call_id: toolCallId, sandbox_enforcement: "partial" }));
        throw new Error("the tool runner crashed");
      },
    });
    const result = await runtime.run();
    assert.equal(result.exitCode, EXIT_CODES.provider);
  } finally {
    await workspace.cleanup();
  }
});

test("a worker that reports failure is a verification failure (exit 5), not a provider failure", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const runtime = createTestRuntime({
      workspace,
      planner: createScriptedPlanner((input) => testPlan(input, [{ key: "doc", owned_paths: ["docs/**"], risk: "trivial" }])),
      limits: { maxRetries: 0 },
      script: async (context) => {
        await context.reply({ status: "failed", summary: "cannot" });
      },
    });
    assert.equal((await runtime.run()).exitCode, EXIT_CODES.verification);
  } finally {
    await workspace.cleanup();
  }
});

test("a planning turn that fails at the provider exits 4; an unanswerable ask_user exits 3", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const failing = createTestRuntime({
      workspace,
      planner: {
        async propose(input) {
          await input.events.append({
            type: "model/response_failed",
            event_version: EVENT_VERSIONS["model/response_failed"],
            actor: { kind: "system" },
            run_id: input.runId,
            data: { request_id: createId("request"), error: { code: "provider_internal", message: "503", retryable: true } },
          } as SessionEventDraft);
          return undefined;
        },
      },
      script: async () => undefined,
    });
    const provider = await failing.run();
    assert.equal(provider.exitCode, EXIT_CODES.provider);
    assert.match(provider.summary, /the orchestrator's model request failed/);

    const asking = createTestRuntime({
      workspace,
      planner: {
        async propose(input) {
          const toolCallId = createId("toolCall");
          const append = (type: SessionEventDraft["type"], data: unknown) =>
            input.events.append({ type, data, event_version: EVENT_VERSIONS[type], actor: { kind: "system" }, run_id: input.runId } as SessionEventDraft);
          await append("tool/call_proposed", { tool_call_id: toolCallId, provider_call_id: "p-ask", tool_name: "ask_user", args_digest: `sha256:${"1".repeat(64)}` });
          await append("tool/result_recorded", {
            tool_call_id: toolCallId,
            state: "failed",
            result: { status: "error", text: "", truncated: false, redactions: 0, error: { code: "approval_unavailable", message: "headless" } },
            duration_ms: 1,
          });
          return undefined;
        },
      },
      script: async () => undefined,
    });
    const asked = await asking.run();
    assert.equal(asked.exitCode, EXIT_CODES.approval);
    assert.match(asked.summary, /ask_user/);
  } finally {
    await workspace.cleanup();
  }
});
