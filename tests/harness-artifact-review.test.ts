import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { digestOf, type SessionEvent } from "../src/harness/contracts/index.ts";
import { reviewDiff } from "../src/harness/cli/session-git.ts";
import {
  compileArtifactReviewPacket,
  fixFollowUpMessage,
  isGeneratedPath,
  mapReviewVerdict,
  parseReviewArgument,
  renderArtifactReviewBrief,
  renderReviewCard,
  type ArtifactReviewRequest,
  type PinnedReviewArtifact,
} from "../src/harness/orchestration/index.ts";
import { createScriptedPlanner, createTempWorkspace, createTestRuntime, type ScriptContext } from "../src/harness/orchestration/testing.ts";

const GLYPHS = { ok: "v", warn: "!", fail: "x", bullet: "-", sep: "|" };

test("/review target parsing: workspace, staged, commit, range, run, fix and free focus", () => {
  assert.deepEqual(parseReviewArgument("").target, { kind: "workspace" });
  assert.deepEqual(parseReviewArgument("--staged").target, { kind: "staged" });
  assert.deepEqual(parseReviewArgument("HEAD~3..HEAD").target, { kind: "range", from: "HEAD~3", to: "HEAD", symmetric: false });
  assert.deepEqual(parseReviewArgument("main...HEAD").target, { kind: "range", from: "main", to: "HEAD", symmetric: true });
  assert.deepEqual(parseReviewArgument("1a2b3c4 error paths"), { target: { kind: "commit", rev: "1a2b3c4" }, focus: "error paths", fix: false, json: false });
  assert.deepEqual(parseReviewArgument("HEAD^").target, { kind: "commit", rev: "HEAD^" });
  assert.deepEqual(parseReviewArgument("run-2").target, { kind: "run", ref: "run-2" });
  assert.equal(parseReviewArgument("fix").fix, true);
  const focus = parseReviewArgument("security of the login flow --json");
  assert.deepEqual(focus.target, { kind: "workspace" });
  assert.equal(focus.focus, "security of the login flow");
  assert.equal(focus.json, true);
});

test("verdict mapping is proportional: block/blocker blocks, major or not_met requests changes, minor-only approves", () => {
  const minor = { id: "F-1", severity: "minor" as const, summary: "naming" };
  const major = { id: "F-2", severity: "major" as const, summary: "bug" };
  const blocker = { id: "F-3", severity: "blocker" as const, summary: "data loss" };
  assert.equal(mapReviewVerdict("accept", [], [{ verdict: "met" }]), "approve");
  assert.equal(mapReviewVerdict("revise", [minor], [{ verdict: "met" }, { verdict: "unverifiable" }]), "approve");
  assert.equal(mapReviewVerdict("accept", [major], [{ verdict: "met" }]), "changes_requested");
  assert.equal(mapReviewVerdict("revise", [], [{ verdict: "not_met" }]), "changes_requested");
  assert.equal(mapReviewVerdict("accept", [blocker], [{ verdict: "met" }]), "blocked");
  assert.equal(mapReviewVerdict("block", [], [{ verdict: "met" }]), "blocked");
});

test("generated artifacts are excluded from review", () => {
  for (const file of ["pnpm-lock.yaml", "web/package-lock.json", "dist/index.js", "coverage/lcov.info", "a.min.js", "src/x.generated.ts", "__snapshots__/a.test.ts.snap"]) assert.equal(isGeneratedPath(file), true, file);
  for (const file of ["src/index.ts", "README.md", "tests/build.test.ts", "distribution.md"]) assert.equal(isGeneratedPath(file), false, file);
});

test("the review packet is read-only, pinned to the artifact digest and carries the four criteria", () => {
  const digest = digestOf({ diff: "diff --git a/x b/x" });
  const packet = compileArtifactReviewPacket({
    runId: "run_01K0000000000000000000000A" as never,
    taskId: "task_01K0000000000000000000000A" as never,
    planId: "plan_01K0000000000000000000000A" as never,
    artifactDigest: digest,
    label: "uncommitted changes",
    focus: "error handling",
    tier: "complex_worker",
    createdAt: new Date().toISOString(),
  });
  assert.equal(packet.role, "reviewer");
  assert.equal(packet.write_mode, "read-only");
  assert.equal(packet.isolation, "shared-read-only");
  assert.deepEqual(packet.scope.owned_paths, []);
  assert.equal(packet.context.project_snapshot, digest);
  assert.deepEqual(packet.acceptance_criteria.map((criterion) => criterion.id), ["AC-1", "AC-2", "AC-3", "AC-4"]);
  assert.ok(packet.decisions.some((decision) => decision.includes(digest)));
  assert.ok(packet.decisions.some((decision) => decision.includes("error handling")));
  const brief = renderArtifactReviewBrief({ label: "uncommitted changes", digest, diff: "+x", truncated: false, changedPaths: ["src/a.ts"], excludedPaths: ["pnpm-lock.yaml"], focus: "" });
  assert.match(brief, new RegExp(digest));
  assert.match(brief, /pnpm-lock\.yaml/);
  assert.match(brief, /```diff\n\+x\n```/);
});

test("reviewDiff pins the uncommitted diff: generated files left out, digest stable until the content changes", async () => {
  const workspace = await createTempWorkspace({ "src/a.mjs": "export const a = 1;\n", "pnpm-lock.yaml": "lock: 1\n" }, { git: true });
  try {
    await writeFile(path.join(workspace.root, "src", "a.mjs"), "export const a = 2;\n");
    await writeFile(path.join(workspace.root, "pnpm-lock.yaml"), "lock: 2\n");
    await writeFile(path.join(workspace.root, "src", "b.mjs"), "export const b = 1;\n");
    const first = await reviewDiff(workspace.root, { kind: "workspace" }, isGeneratedPath);
    assert.ok(typeof first !== "string");
    assert.deepEqual([...first.files].sort(), ["src/a.mjs", "src/b.mjs"]);
    assert.deepEqual(first.excluded, ["pnpm-lock.yaml"]);
    assert.doesNotMatch(first.text, /lock: 2/);
    const again = await reviewDiff(workspace.root, first.resolved, isGeneratedPath);
    assert.ok(typeof again !== "string");
    assert.equal(digestOf({ diff: again.text }), digestOf({ diff: first.text }));
    await writeFile(path.join(workspace.root, "src", "a.mjs"), "export const a = 3;\n");
    const moved = await reviewDiff(workspace.root, first.resolved, isGeneratedPath);
    assert.ok(typeof moved !== "string");
    assert.notEqual(digestOf({ diff: moved.text }), digestOf({ diff: first.text }));
    const commit = await reviewDiff(workspace.root, { kind: "commit", rev: "HEAD" }, isGeneratedPath);
    assert.ok(typeof commit !== "string");
    assert.match(commit.label, /^commit [0-9a-f]+ initial/);
  } finally {
    await workspace.cleanup();
  }
});

async function reviewRun(changeDuringReview: boolean) {
  const workspace = await createTempWorkspace({ "src/a.mjs": "export const a = 1;\n" }, { git: true });
  await writeFile(path.join(workspace.root, "src", "a.mjs"), "export const a = null;\n");
  const briefs: string[] = [];
  const script = async (context: ScriptContext): Promise<void> => {
    if (context.input.role !== "reviewer") return;
    briefs.push(context.input.userMessage ?? "");
    const call = await context.toolCall("read_file", { text: "export const a = null;" });
    if (changeDuringReview) await writeFile(path.join(workspace.root, "src", "a.mjs"), "export const a = 5;\n");
    await context.report("review_report", {
      criteria: (context.input.packet?.acceptance_criteria ?? []).map((criterion) => ({ criterion_id: criterion.id, verdict: criterion.id === "AC-3" ? "unverifiable" : "met", evidence: [{ kind: "tool-call", ref: call, produced_by: "reviewer" }] })),
      findings: [{ id: "F-1", severity: "major", summary: "a is null where callers expect a number", path: "src/a.mjs", line: 1, recommendation: "keep a numeric default" }],
      decision: "revise",
    });
  };
  const runtime = createTestRuntime({ workspace, script, planner: createScriptedPlanner(() => undefined) });
  const diff = await reviewDiff(workspace.root, { kind: "workspace" }, isGeneratedPath);
  assert.ok(typeof diff !== "string");
  const digest = digestOf({ diff: diff.text });
  const artifact: PinnedReviewArtifact = {
    digest,
    brief: renderArtifactReviewBrief({ label: diff.label, digest, diff: diff.text, truncated: false, changedPaths: diff.files, excludedPaths: diff.excluded, focus: "" }),
    repin: async (signal) => {
      const now = await reviewDiff(workspace.root, diff.resolved, isGeneratedPath, signal);
      return typeof now === "string" ? undefined : digestOf({ diff: now.text });
    },
  };
  const route = await runtime.router.resolve({ tier: "complex_worker", role: "reviewer" }, new AbortController().signal);
  const request: ArtifactReviewRequest = {
    workspaceRoot: workspace.root,
    policyMode: "autonomous",
    headless: true,
    target: { kind: "workspace" },
    label: diff.label,
    focus: "",
    tier: "complex_worker",
    route,
    implementer: { provider_id: "openai" as never, model_id: "gpt-worker" as never },
    changedPaths: diff.files,
    excludedPaths: diff.excluded,
    artifact,
  };
  const result = await runtime.coordinator.review(request, new AbortController().signal);
  const events: SessionEvent[] = [];
  const reader = await runtime.sessions.openForRead(result.sessionId as never);
  for await (const item of reader.read()) if (item.status === "ok") events.push(item.event);
  return { workspace, result, events, briefs, digest };
}

test("an artifact review runs as its own run through the worker manager and records a structured verdict", async () => {
  const { workspace, result, events, briefs, digest } = await reviewRun(false);
  try {
    assert.equal(result.status, "reviewed");
    assert.equal(result.verdict, "changes_requested");
    assert.equal(result.artifactDigest, digest);
    assert.equal(result.sameProvider, false);
    assert.equal(result.findings[0]?.path, "src/a.mjs");
    assert.ok(result.evidence.length > 0, "verdicts rest on the reviewer's own tool calls");
    assert.match(briefs[0] ?? "", new RegExp(digest));
    assert.doesNotMatch(briefs[0] ?? "", /conversation history:/i);
    const types = events.map((event) => event.type);
    for (const type of ["run/created", "task/created", "route/decided", "attempt/started", "review/recorded"]) assert.ok(types.includes(type as never), type);
    const recorded = events.find((event) => event.type === "review/recorded");
    assert.equal(recorded?.type === "review/recorded" ? recorded.data.decision : undefined, "revise");
    const card = renderReviewCard(result, GLYPHS).join("\n");
    assert.match(card, /changes requested/);
    assert.match(card, /src\/a\.mjs:1/);
    assert.match(card, /unchanged during review/);
    assert.match(fixFollowUpMessage(result, result.findings), /1\. \[major\] src\/a\.mjs:1: a is null/);
  } finally {
    await workspace.cleanup();
  }
});

test("a change to the pinned files during the review is reported as artifact changed", async () => {
  const { workspace, result } = await reviewRun(true);
  try {
    assert.equal(result.status, "artifact_changed");
    assert.match(renderReviewCard(result, GLYPHS).join("\n"), /artifact changed during review/);
  } finally {
    await workspace.cleanup();
  }
});
