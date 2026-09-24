import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { SessionEvent, TaskContextPacket } from "../src/harness/contracts/index.ts";
import { createDelegationSlot, renderTriagePrompt, validatePlan, type Planner, type TriageInput } from "../src/harness/orchestration/index.ts";
import {
  createTempWorkspace,
  createTestRuntime,
  replayTransitions,
  reviewerClaim,
  testPlan,
  workerClaim,
  type PlanTaskInput,
  type ScriptContext,
} from "../src/harness/orchestration/testing.ts";
import type { PlannerInput } from "../src/harness/orchestration/planner.ts";

/**
 * Replay of live run 01M3ABTS (landing page, parallel HTML and CSS implementers plus an integration
 * review). Live: the HTML task's criterion holding the class contract named style.css, so it moved
 * to the integration review and the implementer lost the contract; its read scope was index.html
 * only, so it could not read style.css (needs_context). Its second attempt wrote index.html but
 * reported partial because its own ad-hoc parse check was refused; the orchestrator failed it and
 * index.html was never integrated.
 * Now: implementers read the whole workspace, packets carry the moved contract and the sibling
 * tasks, and a partial report with a produced change goes to verification and independent review.
 */

const CONTRACT = ".site-header, .site-nav, section.hero (.hero__lead, .hero__actions), .service-card, .site-footer";

const TASKS: readonly PlanTaskInput[] = [
  { key: "html", owned_paths: ["index.html"], read_paths: ["index.html"], criteria: ["index.html has lang tr, a viewport and header/main/footer", `index.html links style.css and uses the class contract ${CONTRACT}`] },
  { key: "css", owned_paths: ["style.css"], read_paths: ["style.css"], criteria: ["style.css styles the shared class contract classes with #10131c, #ff6b54 and #b9a8ff"] },
  { key: "integration-review", role: "reviewer", depends_on: ["html", "css"], criteria: ["index.html classes match style.css selectors"] },
];

function landingPlan(input: PlannerInput): Record<string, unknown> {
  const plan = testPlan(input, TASKS) as { tasks: { key: string; objective: string }[] };
  for (const task of plan.tasks) {
    if (task.key === "html") task.objective = "Do html: follow the approved class/anchor contract and link style.css";
    if (task.key === "css") task.objective = "Do css: style the given shared HTML class contract";
  }
  return plan;
}

function ofType<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

const HTML = '<!doctype html><html lang="tr"><head><link rel="stylesheet" href="style.css"></head><body><header class="site-header"></header></body></html>\n';
const CSS = ".site-header { background: #10131c; }\n";

test("live run 01M3ABTS replay: implementers read the workspace, packets carry the contract, a partial report with a produced change goes to review", async () => {
  const workspace = await createTempWorkspace({ "README.md": "landing\n" }, { git: true });
  try {
    const slot = createDelegationSlot();
    const triaged: TriageInput[] = [];
    const planner: Planner = {
      propose: async (input) => landingPlan(input),
      async triage(input) {
        triaged.push(input);
      },
    };
    const workerPackets = new Map<string, TaskContextPacket>();
    const briefs = new Map<string, string>();
    const reviewPackets = new Map<string, TaskContextPacket>();
    const script = async (context: ScriptContext): Promise<void> => {
      const packet = context.input.packet;
      if (packet === undefined) return;
      const key = TASKS.find((task) => packet.objective.includes(`Do ${task.key}`))?.key ?? "";
      if (context.input.role === "reviewer") {
        if (key !== "integration-review") reviewPackets.set(key, packet);
        const call = await context.toolCall("read_file", { text: "reviewed" });
        await context.report("review_report", reviewerClaim(context, call, "accept"));
        return;
      }
      workerPackets.set(key, packet);
      briefs.set(key, context.input.userMessage ?? "");
      if (key === "css") {
        await context.write("style.css", CSS);
        const call = await context.toolCall("read_file", { text: "style.css written" });
        await context.report("task_report", workerClaim(context, call));
        return;
      }
      await context.write("index.html", HTML);
      const call = await context.toolCall("read_file", { text: "index.html written" });
      // The live report: the file is right, but the worker's own inline parse check was refused.
      await context.report(
        "task_report",
        workerClaim(context, call, {
          status: "partial",
          summary: "index.html written; my own HTML parse check was blocked by the sandbox",
          unresolved_risks: ["python -c parse check refused by policy (inline interpreter code)"],
        }),
      );
    };
    const runtime = createTestRuntime({ workspace, planner, delegation: slot, script });
    const outcome = await runtime.run();
    const events = runtime.runEvents(outcome);
    assert.equal(outcome.status, "succeeded", JSON.stringify(ofType(events, "task/state_changed").map((event) => event.data)));
    assert.deepEqual(replayTransitions(events), []);

    // (1) Implementers read the whole workspace; writes stay on owned paths.
    const html = workerPackets.get("html");
    assert.ok(html !== undefined);
    assert.ok(html.scope.read_paths.includes("**"));
    assert.deepEqual(html.scope.owned_paths, ["index.html"]);
    assert.ok(html.scope.forbidden_paths.includes(".git/**") && html.scope.forbidden_paths.includes(".synorch/**"));

    // (2) The moved contract criterion is still in the HTML packet; the CSS packet sees the HTML task and its contract.
    assert.ok(html.decisions.some((decision) => decision.startsWith("Shared contract") && decision.includes(".site-header")), JSON.stringify(html.decisions));
    assert.ok(html.decisions.some((decision) => decision.startsWith("Other task css") && decision.includes("owns style.css")));
    const css = workerPackets.get("css");
    assert.ok(css?.decisions.some((decision) => decision.startsWith("Other task html") && decision.includes("owns index.html")));
    assert.match(briefs.get("html") ?? "", /The harness runs the verification itself/);

    // (3) No triage: the partial HTML report went to review with its caveats and was integrated.
    assert.equal(triaged.length, 0, "a partial report with a produced change is not triaged");
    const htmlReview = reviewPackets.get("html");
    assert.ok(htmlReview?.decisions.some((decision) => decision.startsWith("Worker caveat: python -c parse check refused")));
    const taskIds = new Map(ofType(events, "task/created").map((event) => [event.data.key, event.data.task_id]));
    const htmlStates = ofType(events, "task/state_changed").filter((event) => event.data.task_id === taskIds.get("html")).map((event) => event.data.to);
    assert.deepEqual(htmlStates, ["ready", "running", "verifying", "reviewing", "completed"]);
    assert.equal(ofType(events, "task/integrated").length, 2);
    assert.equal(await readFile(path.join(workspace.root, "index.html"), "utf8"), HTML);
    assert.equal(await readFile(path.join(workspace.root, "style.css"), "utf8"), CSS);
  } finally {
    await workspace.cleanup();
  }
});

test("triage of a needs_context report with a produced change: fail is answered with the review offer, review sends it on", async () => {
  const workspace = await createTempWorkspace({ "README.md": "landing\n" }, { git: true });
  try {
    const slot = createDelegationSlot();
    const answers: string[] = [];
    const prompts: string[] = [];
    const planner: Planner = {
      propose: async (input) => testPlan(input, [{ key: "html", owned_paths: ["index.html"], criteria: ["index.html exists"] }]),
      async triage(input) {
        prompts.push(renderTriagePrompt(input));
        const port = slot.current();
        assert.ok(port?.triage !== undefined);
        const caller = { runId: input.runId, role: "orchestrator" as const, toolCallId: "call_triage" };
        for (const decision of [
          { task: "html", decision: "fail" as const },
          { task: "html", decision: "review" as const, guidance: "the file looks complete" },
        ]) {
          const result = port.triage(decision, caller);
          answers.push(result.ok ? `ok: ${result.text}` : `${result.code}: ${result.message}`);
        }
      },
    };
    const script = async (context: ScriptContext): Promise<void> => {
      if (context.input.role === "reviewer") {
        const call = await context.toolCall("read_file", { text: "reviewed" });
        await context.report("review_report", reviewerClaim(context, call, "accept"));
        return;
      }
      await context.write("index.html", HTML);
      const call = await context.toolCall("read_file", { text: "written" });
      await context.report("task_report", workerClaim(context, call, { status: "needs_context", summary: "the class contract was not provided" }));
    };
    const runtime = createTestRuntime({ workspace, planner, delegation: slot, script });
    const outcome = await runtime.run();
    assert.equal(outcome.status, "succeeded", outcome.summary);
    assert.match(prompts[0] ?? "", /- review: the worker produced index\.html/);
    assert.match(answers[0] ?? "", /^invalid_arguments: html produced index\.html in its owned paths\. Prefer decision review/);
    assert.match(answers[1] ?? "", /^ok: decision for html recorded: review/);
    assert.equal(await readFile(path.join(workspace.root, "index.html"), "utf8"), HTML);
  } finally {
    await workspace.cleanup();
  }
});

test("plan validation: an undefined shared contract is rejected; a sibling's file without a dependency warns", () => {
  const input = { runId: "run_01K5T3Q8Z4X9V2M6N7P0R1S2T3", planId: "plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5", version: 1, goal: "landing", createdAt: "2026-09-24T10:00:00Z" } as const;
  const expected = { runId: input.runId as never, planId: input.planId as never, version: 1 };
  const undefinedContract = testPlan(input as never, [
    { key: "html", owned_paths: ["index.html"], criteria: ["index.html follows the approved class contract"] },
    { key: "css", owned_paths: ["style.css"], criteria: ["style.css is responsive"] },
  ]);
  const rejected = validatePlan(undefinedContract, expected);
  assert.ok(!rejected.ok && rejected.issues.some((issue) => /html AC-1 references "approved class contract", which the plan never defines/.test(issue)), JSON.stringify(rejected));

  const defined = validatePlan(landingPlan(input as never), expected);
  assert.ok(defined.ok, JSON.stringify(defined));
  assert.ok(defined.warnings?.some((warning) => /^html names style\.css \(owned by css\) but runs in parallel with it/.test(warning)), JSON.stringify(defined.warnings));
});
