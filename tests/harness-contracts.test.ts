import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
  approvalDecisionSchema,
  HUMAN_ONLY_APPROVAL_SUBJECTS,
  approvalRequestSchema,
  authStatusSchema,
  DEFAULT_ORCHESTRATION_BUDGETS,
  evidenceRefSchema,
  evidenceResolutionSchema,
  foldPathCase,
  formatEvidenceCorrection,
  harnessEvidenceSchema,
  isCaseInsensitivePlatform,
  modelRequestSchema,
  normalizePathUnicode,
  orchestrationBudgetsSchema,
  parseToolRef,
  promptCacheSchema,
  renderToolResultText,
  REPORT_CORRECTION_ROUNDS,
  sameContent,
  TOOL_EVIDENCE_RESOLUTION_ORDER,
  workspaceDigest,
  canonicalJson,
  completionPacketSchema,
  createId,
  credentialSecretSchema,
  deltaTaskPacketSchema,
  deriveProjectId,
  digestOf,
  digestText,
  effectivePolicySchema,
  encodeUlid,
  EVENT_VERSIONS,
  execConfinementFor,
  EXIT_CODES,
  exitCodeFor,
  findStaleSources,
  HARNESS_ERROR_CODES,
  harnessErrorSchema,
  isTerminalState,
  isWholeWorkspacePattern,
  jsonlFrameSchema,
  CONTEXT_BLOCK_SOURCES,
  EVENT_FIELD_VERSIONS,
  hasReservedSegment,
  isAncestorOfAnyPattern,
  matchesAnyPathPattern,
  matchesPathPattern,
  memoryConfigSchema,
  memoryNoteFrontmatterSchema,
  memoryProposalSchema,
  modelStreamEventSchema,
  normalizedActionSchema,
  parseSessionEvent,
  pathPatternsOverlap,
  planProposalSchema,
  planSchema,
  REPORT_TOOL_NAMES,
  reviewReportInputSchema,
  taskReportInputSchema,
  taskTriageInputSchema,
  policyDecisionSchema,
  providerCapabilitiesSchema,
  providerErrorSchema,
  reviewPacketSchema,
  routeDecisionSchema,
  runIdSchema,
  sandboxReportSchema,
  segmentHeaderSchema,
  selectColor,
  selectRendererKind,
  SESSION_EVENT_TYPES,
  sessionLeaseSchema,
  sessionManifestSchema,
  sha256,
  splitJsonlLines,
  taskContextPacketSchema,
  taskIdSchema,
  toolMetadataSchema,
  toolResultSchema,
  TRANSITIONS,
  validateFrameSequence,
  validateTransition,
  type Digest,
  type JsonlFrame,
  type MachineName,
  type TaskContextPacket,
} from "../src/harness/contracts/index.ts";
import { CliError } from "../src/domain/errors.ts";

const CONTRACTS_DIR = new URL("../docs/harness/contracts/", import.meta.url);

const EXAMPLE_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  plan: planSchema,
  "task-packet": taskContextPacketSchema,
  "delta-packet": deltaTaskPacketSchema,
  "completion-packet": completionPacketSchema,
  "review-packet": reviewPacketSchema,
  "provider-capabilities": providerCapabilitiesSchema,
  "model-stream-event": modelStreamEventSchema,
  "provider-error": providerErrorSchema,
  "route-decision": routeDecisionSchema,
  "auth-status": authStatusSchema,
  "credential-secret": credentialSecretSchema,
  "tool-metadata": toolMetadataSchema,
  "tool-result": toolResultSchema,
  "sandbox-report": sandboxReportSchema,
  "effective-policy": effectivePolicySchema,
  "normalized-action": normalizedActionSchema,
  "policy-decision": policyDecisionSchema,
  "approval-request": approvalRequestSchema,
  "approval-decision": approvalDecisionSchema,
  "jsonl-frame": jsonlFrameSchema,
  "harness-error": harnessErrorSchema,
  "memory-note": memoryNoteFrontmatterSchema,
  "memory-proposal": memoryProposalSchema,
  "memory-config": memoryConfigSchema,
  "task-report": taskReportInputSchema,
  "review-report": reviewReportInputSchema,
  "plan-proposal": planProposalSchema,
  "task-triage": taskTriageInputSchema,
  "session-manifest": sessionManifestSchema,
  "segment-header": segmentHeaderSchema,
  "session-lease": sessionLeaseSchema,
  "evidence-resolution": evidenceResolutionSchema,
  "harness-evidence": harnessEvidenceSchema,
  "orchestration-budgets": orchestrationBudgetsSchema,
  "prompt-cache": promptCacheSchema,
};

const SPECIAL_EXAMPLES = new Set(["session-event", "transition"]);

interface DocExample {
  readonly file: string;
  readonly name: string;
  readonly expectation: "valid" | "invalid" | "unsupported";
  readonly items: readonly unknown[];
}

async function loadDocExamples(): Promise<DocExample[]> {
  const files = (await readdir(CONTRACTS_DIR)).filter((file) => file.endsWith(".md")).sort();
  const examples: DocExample[] = [];
  const fence = /^```yaml example=([a-z-]+)(?: (invalid|unsupported))?\r?\n([\s\S]*?)^```/gm;
  for (const file of files) {
    const text = await readFile(new URL(file, CONTRACTS_DIR), "utf8");
    for (const match of text.matchAll(fence)) {
      const [, name = "", flag, body = ""] = match;
      const parsed: unknown = parseYaml(body);
      examples.push({
        file,
        name,
        expectation: flag === "invalid" ? "invalid" : flag === "unsupported" ? "unsupported" : "valid",
        items: Array.isArray(parsed) ? parsed : [parsed],
      });
    }
  }
  return examples;
}

function describe(example: DocExample, index: number): string {
  return `${example.file} example=${example.name} ${example.expectation} #${index}`;
}

test("contract docs carry parseable examples and every name maps to a schema", async () => {
  const examples = await loadDocExamples();
  assert.ok(examples.length >= 30, `expected many examples, found ${examples.length}`);
  for (const example of examples) {
    assert.ok(
      example.name in EXAMPLE_SCHEMAS || SPECIAL_EXAMPLES.has(example.name),
      `unknown example name ${example.name} in ${example.file}`,
    );
  }
  const files = new Set(examples.map((example) => example.file));
  for (const file of [
    "identity-and-state.md",
    "events-and-storage.md",
    "model-adapter.md",
    "tools.md",
    "policy-and-approval.md",
    "task-packets.md",
    "cli-and-jsonl.md",
    "memory.md",
  ]) {
    assert.ok(files.has(file), `${file} has no example block`);
  }
});

test("every valid contract example parses and every invalid one is rejected", async () => {
  for (const example of await loadDocExamples()) {
    example.items.forEach((item, index) => {
      const label = describe(example, index);
      if (example.name === "transition") {
        const { machine, from, to } = item as { machine: MachineName; from: string; to: string };
        const result = validateTransition(machine, from, to);
        assert.equal(result.ok, example.expectation === "valid", `${label}: ${JSON.stringify(result)}`);
        return;
      }
      if (example.name === "session-event") {
        const result = parseSessionEvent(item);
        const expected = example.expectation === "valid" ? "ok" : example.expectation;
        assert.equal(result.status, expected, `${label}: ${JSON.stringify(result)}`);
        return;
      }
      const schema = EXAMPLE_SCHEMAS[example.name];
      assert.ok(schema !== undefined, label);
      const result = schema.safeParse(item);
      if (example.expectation === "valid") {
        assert.equal(result.success, true, `${label}: ${result.success ? "" : JSON.stringify(result.error.issues)}`);
      } else {
        assert.equal(result.success, false, `${label} should be rejected`);
      }
    });
  }
});

test("ids are prefixed ULIDs and a mismatched prefix is rejected", () => {
  const random = new Uint8Array(10).fill(255);
  assert.equal(encodeUlid(0, new Uint8Array(10)), "0".repeat(26));
  assert.equal(encodeUlid(2 ** 48 - 1, random), "7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  const runId = createId("run", 1_758_535_200_000, new Uint8Array(10));
  assert.match(runId, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(runIdSchema.safeParse(runId).success, true);
  assert.equal(taskIdSchema.safeParse(runId).success, false);
  assert.equal(runIdSchema.safeParse("run_01K5T3Q8Z4X9V2M6N7P0R1S2TI").success, false);
  assert.throws(() => encodeUlid(-1, new Uint8Array(10)));
  assert.throws(() => encodeUlid(0, new Uint8Array(9)));
});

test("project ids are stable, case-insensitive on Windows and slugged", () => {
  const upper = deriveProjectId("C:\\Work\\My Repo", "win32");
  const lower = deriveProjectId("c:\\work\\my repo", "win32");
  assert.equal(upper, lower);
  assert.match(upper, /^my-repo-[0-9a-f]{8}$/);
  assert.notEqual(deriveProjectId("/srv/Repo", "linux"), deriveProjectId("/srv/repo", "linux"));
  assert.match(deriveProjectId("/", "linux"), /^workspace-[0-9a-f]{8}$/);
});

test("canonical JSON is key-order independent and rejects lossy values", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: "x" }] }), '{"a":[2,{"c":"x"}],"b":1}');
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: "1" }));
  assert.throws(() => canonicalJson({ a: Number.NaN }));
  assert.throws(() => canonicalJson({ a: 1n }));
  assert.equal(digestText("a\r\nb\n"), digestText("a\nb\n"));
  assert.match(sha256("x"), /^sha256:[0-9a-f]{64}$/);
});

test("transition tables are closed and terminal states have no exits", () => {
  for (const [machine, table] of Object.entries(TRANSITIONS) as [MachineName, Record<string, readonly string[]>][]) {
    for (const [from, targets] of Object.entries(table)) {
      for (const to of targets) {
        assert.ok(to in table, `${machine}: ${from} -> ${to} targets an unknown state`);
        assert.notEqual(to, from, `${machine}: self transition ${from}`);
      }
    }
  }
  assert.equal(isTerminalState("task", "completed"), true);
  assert.equal(isTerminalState("task", "failed"), false);
  assert.equal(validateTransition("task", "completed", "ready").ok, false);
  assert.deepEqual(validateTransition("attempt", "bogus", "running"), {
    ok: false,
    reason: "unknown-state",
    message: "attempt: unknown state in bogus -> running",
  });
});

test("path overlap errs towards overlapping and whole-workspace patterns are detected", () => {
  assert.equal(pathPatternsOverlap("src/**", "src/auth/a.ts"), true);
  assert.equal(pathPatternsOverlap("src/Auth/**", "src/auth/x.ts"), true);
  assert.equal(pathPatternsOverlap("src/a.ts", "src/b.ts"), false);
  assert.equal(pathPatternsOverlap("src/**", "tests/**"), false);
  assert.equal(pathPatternsOverlap("src/*.ts", "src/deep/x.md"), true);
  for (const pattern of [".", "**", "*", "**/*.ts", "./"]) {
    assert.equal(isWholeWorkspacePattern(pattern), true, pattern);
  }
  assert.equal(isWholeWorkspacePattern("src/**"), false);
});

test("the shared glob matcher: ** spans segments, literals cover subtrees, grants vs denials choose case", () => {
  const exact = { caseInsensitive: false };
  const folded = { caseInsensitive: true };
  assert.equal(matchesPathPattern("src/auth/a.ts", "src/**", exact), true);
  assert.equal(matchesPathPattern("src", "src/**", exact), true);
  assert.equal(matchesPathPattern("src/auth/deep/a.ts", "src/*/a.ts", exact), false);
  assert.equal(matchesPathPattern("src/auth/a.ts", "src/auth", exact), true);
  assert.equal(matchesPathPattern("src/authx/a.ts", "src/auth", exact), false);
  assert.equal(matchesPathPattern("src/a.test.ts", "src/*.{ts,md}", exact), true);
  assert.equal(matchesPathPattern("SRC/auth/a.ts", "src/**", exact), false);
  assert.equal(matchesPathPattern("SRC/auth/a.ts", "src/**", folded), true);
  assert.equal(matchesAnyPathPattern("docs/x.md", ["src/**", "docs/*.md"], exact), true);
  assert.equal(isAncestorOfAnyPattern("src", ["src/auth/**"], exact), true);
  assert.equal(isAncestorOfAnyPattern("tests", ["src/auth/**"], exact), false);
  assert.equal(hasReservedSegment("src/.GIT/config"), true);
  assert.equal(hasReservedSegment("src/gitignore"), false);
});

test("event payload versions: new fields bump the version, older versions still parse, a v1 event cannot carry a v2 field", () => {
  assert.equal(EVENT_VERSIONS["session/resumed"], 2);
  assert.equal(EVENT_VERSIONS["attempt/started"], 3, "v3 added isolation reuse/fallback/overlay/dependency links/submodules (ADR-19)");
  assert.equal(EVENT_VERSIONS["tool/policy_decided"], 3);
  assert.equal(EVENT_VERSIONS["task/integrated"], 1);
  assert.equal(EVENT_VERSIONS["session/closed"], 1);
  for (const [type, fields] of Object.entries(EVENT_FIELD_VERSIONS)) {
    assert.equal(EVENT_VERSIONS[type as keyof typeof EVENT_VERSIONS], Math.max(...Object.values(fields)), type);
  }
  const resumed = (version: number, data: Record<string, unknown>) => ({
    schema_version: 1,
    event_id: createId("event"),
    session_id: createId("session"),
    seq: 9,
    event_version: version,
    timestamp: "2026-09-22T10:00:00Z",
    actor: { kind: "system" },
    type: "session/resumed",
    data: { previous_last_seq: 8, recovered: [], ...data },
  });
  assert.equal(parseSessionEvent(resumed(1, {})).status, "ok");
  assert.equal(parseSessionEvent(resumed(2, { torn_tail: { segment: 1, bytes: 40 } })).status, "ok");
  const early = parseSessionEvent(resumed(1, { torn_tail: { segment: 1, bytes: 40 } }));
  assert.equal(early.status, "invalid");
  assert.match(JSON.stringify(early), /torn_tail requires event_version >= 2/);
  assert.equal(parseSessionEvent(resumed(3, {})).status, "unsupported");
  assert.deepEqual([...CONTEXT_BLOCK_SOURCES].slice(-2), ["history", "tool-result"]);
});

test("exec confinement: policy/snapshot v2 carries exec_confinement and verification_commands; a v1 snapshot stays readable", () => {
  assert.equal(EVENT_VERSIONS["policy/snapshot"], 3, "v3 added workspace_trusted (SEC-N1)");
  assert.equal(execConfinementFor("full", "autonomous"), "full-sandbox");
  assert.equal(execConfinementFor("partial", "autonomous"), "allowlist");
  assert.equal(execConfinementFor("unavailable", "ask"), "ask");
  const base = {
    schema_version: 1,
    policy_version: 1,
    mode: "autonomous",
    role: "implementer",
    run_id: createId("run"),
    workspace_root: "/w",
    write_scope: ["src/**"],
    read_scope: ["**"],
    forbidden: [],
    effects: { read: "allow", "workspace-write": "allow", exec: "allow", "external-write": "deny", control: "deny" },
    external_write_allowlist: [],
    network: { mode: "deny", hosts: [] },
    sandbox: { backend: "policy-only", enforcement: "partial" },
    require_full_sandbox: false,
    layers: [{ layer: "role", source: "implementer", digest: digestText("implementer") }],
  };
  assert.equal(effectivePolicySchema.safeParse(base).success, true, "v1 policies without the fields still parse");
  assert.equal(effectivePolicySchema.safeParse({ ...base, exec_confinement: "allowlist", verification_commands: ["pnpm test"] }).success, true);
  assert.equal(effectivePolicySchema.safeParse({ ...base, exec_confinement: "full-sandbox" }).success, false, "a partial sandbox cannot claim full confinement");
  assert.equal(effectivePolicySchema.safeParse({ ...base, exec_confinement: "ask" }).success, false, "ask confinement only in ask mode");
  const snapshot = (version: number, policy: Record<string, unknown>) => ({
    schema_version: 1,
    event_id: createId("event"),
    session_id: createId("session"),
    seq: 1,
    event_version: version,
    timestamp: "2026-09-22T10:00:00Z",
    actor: { kind: "policy" },
    type: "policy/snapshot",
    data: { policy, digest: digestText("policy") },
  });
  assert.equal(parseSessionEvent(snapshot(1, base)).status, "ok");
  assert.equal(parseSessionEvent(snapshot(2, { ...base, exec_confinement: "allowlist", verification_commands: [] })).status, "ok");
  assert.equal(parseSessionEvent(snapshot(1, { ...base, exec_confinement: "allowlist" })).status, "invalid");
  assert.equal(parseSessionEvent(snapshot(3, { ...base, exec_confinement: "allowlist", verification_commands: [], workspace_trusted: true })).status, "ok");
  assert.equal(parseSessionEvent(snapshot(2, { ...base, exec_confinement: "allowlist", workspace_trusted: false })).status, "invalid", "workspace_trusted needs v3");
});

test("SEC-N1 trust events: granted, revoked and used carry the canonical root and a repository identity; workspace trust is human-only", () => {
  const envelope = (type: string, data: Record<string, unknown>, actor: Record<string, unknown> = { kind: "user" }) => ({
    schema_version: 1,
    event_id: createId("event"),
    session_id: createId("session"),
    seq: 1,
    event_version: 1,
    timestamp: "2026-09-23T10:00:00Z",
    actor,
    type,
    data,
  });
  const identity = `git:${"a".repeat(64)}`;
  assert.equal(parseSessionEvent(envelope("trust/granted", { workspace_root: "/home/dev/app", repo_identity: identity, source: "prompt" })).status, "ok");
  assert.equal(parseSessionEvent(envelope("trust/granted", { workspace_root: "/home/dev/app", repo_identity: identity, source: "command" })).status, "ok");
  assert.equal(parseSessionEvent(envelope("trust/revoked", { workspace_root: "/home/dev/app", repo_identity: identity })).status, "ok");
  assert.equal(parseSessionEvent(envelope("trust/used", { workspace_root: "/home/dev/app", repo_identity: identity, source: "flag", sandbox_enforcement: "partial" }, { kind: "system" })).status, "ok");
  assert.equal(parseSessionEvent(envelope("trust/granted", { workspace_root: "/home/dev/app", repo_identity: identity, source: "repository" })).status, "invalid", "only a prompt or the command grants");
  assert.equal(parseSessionEvent(envelope("trust/granted", { workspace_root: "/home/dev/app", repo_identity: "sha:x", source: "command" })).status, "invalid");
  assert.equal(parseSessionEvent(envelope("trust/used", { workspace_root: "/home/dev/app", repo_identity: identity, source: "prompt", sandbox_enforcement: "partial" })).status, "invalid");
  assert.ok((HUMAN_ONLY_APPROVAL_SUBJECTS as readonly string[]).includes("workspace-trust"));
  const decision = {
    approval_id: createId("approval"),
    subject_kind: "workspace-trust",
    subject_digest: digestText("trust"),
    outcome: "allowed-once",
    decided_by: "orchestrator",
    mode: "autonomous",
    decided_at: "2026-09-23T10:00:00Z",
  };
  assert.equal(approvalDecisionSchema.safeParse(decision).success, false, "the orchestrator can never trust a workspace");
  assert.equal(approvalDecisionSchema.safeParse({ ...decision, decided_by: "user" }).success, true);
});

test("report tool inputs: defaults for optional lists, strict keys, and a plan proposal lacks identity fields", () => {
  assert.deepEqual(Object.values(REPORT_TOOL_NAMES).sort(), ["plan_propose", "review_report", "task_report"]);
  const report = taskReportInputSchema.parse({ status: "needs_context", summary: "the packet cites a changed file" });
  assert.deepEqual(report.acceptance_evidence, []);
  assert.equal(taskReportInputSchema.safeParse({ status: "completed", summary: "x", changed_paths: ["src/a.ts"] }).success, false, "a worker cannot claim changed paths");
  assert.equal(reviewReportInputSchema.safeParse({ criteria: [], decision: "accept" }).success, false);
  assert.equal(planProposalSchema.safeParse({ plan_id: "plan_x" }).success, false);
});

test("the dispatch freshness gate reports changed and missing sources", async () => {
  const examples = await loadDocExamples();
  const packetExample = examples.find((example) => example.name === "task-packet" && example.expectation === "valid");
  assert.ok(packetExample !== undefined);
  const packet: TaskContextPacket = taskContextPacketSchema.parse(packetExample.items[0]);
  const [first, second] = packet.context.sources;
  assert.ok(first !== undefined && second !== undefined);
  const fresh = new Map<string, Digest | undefined>([
    [first.path, first.digest],
    [second.path, second.digest],
  ]);
  assert.deepEqual(findStaleSources(packet, fresh), []);
  const changed = sha256("changed");
  const stale = findStaleSources(packet, new Map([[first.path, changed]]));
  assert.deepEqual(stale, [
    { path: first.path, expected: first.digest, actual: changed },
    { path: second.path, expected: second.digest, actual: undefined },
  ]);
});

test("every event type has a version and unknown types are unsupported, not invalid", () => {
  assert.equal(SESSION_EVENT_TYPES.length, Object.keys(EVENT_VERSIONS).length);
  assert.ok(SESSION_EVENT_TYPES.includes("tool/result_recorded"));
  assert.equal(new Set(SESSION_EVENT_TYPES).size, SESSION_EVENT_TYPES.length);
  assert.equal(parseSessionEvent({ type: "future/thing", event_version: 1 }).status, "unsupported");
  assert.equal(parseSessionEvent({ type: "session/closed", event_version: 1 }).status, "invalid");
  assert.equal(parseSessionEvent("not an object").status, "invalid");
});

test("exit codes are total, keep the legacy 0-2 meanings and match CliError usage", () => {
  for (const code of HARNESS_ERROR_CODES) {
    assert.ok(Object.values(EXIT_CODES).includes(exitCodeFor(code)), code);
  }
  assert.equal(EXIT_CODES.success, 0);
  assert.equal(EXIT_CODES.internal, new CliError("x").exitCode);
  assert.equal(exitCodeFor("usage_invalid"), 2);
  assert.equal(exitCodeFor("approval_unavailable"), 3);
  assert.equal(exitCodeFor("cancelled"), 130);
});

test("renderer selection follows jsonl > plain > tui and color precedence", () => {
  const base = { jsonl: false, plain: false, env: {}, stdinIsTTY: true, stdoutIsTTY: true };
  assert.equal(selectRendererKind(base), "tui");
  assert.equal(selectRendererKind({ ...base, jsonl: true, plain: true }), "jsonl");
  assert.equal(selectRendererKind({ ...base, stdoutIsTTY: false }), "plain");
  assert.equal(selectRendererKind({ ...base, stdinIsTTY: false }), "plain");
  assert.equal(selectRendererKind({ ...base, env: { TERM: "dumb" } }), "plain");
  assert.equal(selectRendererKind({ ...base, env: { SYN_PLAIN: "1" } }), "plain");
  assert.equal(selectRendererKind({ ...base, env: { SYN_PLAIN: "0" } }), "tui");
  assert.equal(selectRendererKind({ ...base, env: { CI: "true" } }), "tui");

  const color = { flag: "auto" as const, config: undefined, env: {}, streamHasColors: true };
  assert.equal(selectColor(color), true);
  assert.equal(selectColor({ ...color, env: { NO_COLOR: "1" } }), false);
  assert.equal(selectColor({ ...color, env: { NO_COLOR: "" } }), true);
  assert.equal(selectColor({ ...color, env: { NO_COLOR: "1" }, config: true }), true);
  assert.equal(selectColor({ ...color, flag: "never", config: true }), false);
  assert.equal(selectColor({ ...color, streamHasColors: false, env: { FORCE_COLOR: "1" } }), true);
});

test("JSONL framing splits on LF only and sequence invariants are enforced", async () => {
  const { lines, rest } = splitJsonlLines('{"a":"x\u2028y"}\r\n{"b":1}\n{"c"');
  assert.deepEqual(lines, ['{"a":"x\u2028y"}', '{"b":1}']);
  assert.equal(rest, '{"c"');

  const examples = await loadDocExamples();
  const frames = examples.find((example) => example.name === "jsonl-frame" && example.expectation === "valid");
  assert.ok(frames !== undefined);
  const parsed = frames.items.map((item) => jsonlFrameSchema.parse(item));
  const [hello, event, result, error] = parsed as [JsonlFrame, JsonlFrame, JsonlFrame, JsonlFrame];
  assert.deepEqual(validateFrameSequence([hello, event, result]), []);
  assert.ok(validateFrameSequence([hello, event, result, error]).length > 0);
  assert.ok(validateFrameSequence([event, result]).length > 0);
  assert.ok(validateFrameSequence([hello, event]).length > 0);
});

test("privilege escalation through packet mutation is rejected", async () => {
  const examples = await loadDocExamples();
  const packetExample = examples.find((example) => example.name === "task-packet" && example.expectation === "valid");
  assert.ok(packetExample !== undefined);
  const packet = taskContextPacketSchema.parse(packetExample.items[0]);
  const mutate = (change: (copy: Record<string, unknown>) => void): boolean => {
    const copy = structuredClone(packet) as unknown as Record<string, unknown>;
    change(copy);
    return taskContextPacketSchema.safeParse(copy).success;
  };
  assert.equal(mutate(() => undefined), true);
  assert.equal(mutate((copy) => { copy.role = "reviewer"; }), false);
  assert.equal(mutate((copy) => { (copy.scope as { owned_paths: string[] }).owned_paths = ["C:\\Windows\\**"]; }), false);
  assert.equal(mutate((copy) => { (copy.scope as { owned_paths: string[] }).owned_paths = [".synorch/credentials.json"]; }), false);
  assert.equal(mutate((copy) => { (copy.scope as { owned_paths: string[] }).owned_paths = ["src/auth/../../etc/**"]; }), false);
  assert.equal(mutate((copy) => { copy.write_mode = "read-only"; }), false);
  assert.equal(mutate((copy) => { copy.isolation = "shared-read-only"; }), false);
  assert.equal(mutate((copy) => { copy.grants = ["*"]; }), false);
});

const envelopeOf = (type: string, version: number, data: Record<string, unknown>, actor: Record<string, unknown> = { kind: "orchestrator", role: "orchestrator" }) => ({
  schema_version: 1,
  event_id: createId("event"),
  session_id: createId("session"),
  seq: 5,
  event_version: version,
  timestamp: "2026-09-23T12:00:00Z",
  actor,
  type,
  data,
});

test("ADR-18 short refs: [#n] rendering is the one model-visible tool result form and #n parses back", () => {
  assert.equal(renderToolResultText(3, { text: "ok\n", error: undefined }), "[#3] ok\n");
  assert.equal(renderToolResultText(4, { text: "", error: undefined }), "[#4] ok");
  assert.equal(
    renderToolResultText(5, { text: "", error: { code: "stale_precondition", message: "re-read src/a.ts" } }),
    "[#5] Error [stale_precondition]: re-read src/a.ts",
  );
  assert.equal(renderToolResultText(undefined, { text: "partial", error: { code: "timeout", message: "late" } }), "partial\nError [timeout]: late");
  assert.equal(parseToolRef("#5"), 5);
  assert.equal(parseToolRef("[#12] exec node check.mjs exit 0"), 12);
  assert.equal(parseToolRef("`#7`"), 7);
  assert.equal(parseToolRef("#0"), undefined);
  assert.equal(parseToolRef("#5a"), undefined);
  assert.equal(parseToolRef("functions.exec node check.mjs"), undefined);
  assert.deepEqual([...TOOL_EVIDENCE_RESOLUTION_ORDER], ["tool-call-id", "short-ref", "provider-call-id", "tool-name-args", "path-token"]);
  const text = formatEvidenceCorrection(
    [{ criterionId: "AC-1", ref: "functions.exec node check.mjs", reason: "matches no tool call" }],
    [{ ref: 5, toolName: "exec", summary: "node check.mjs -> exit 0" }],
    REPORT_CORRECTION_ROUNDS,
  );
  assert.match(text, /- AC-1: 'functions\.exec node check\.mjs' matches no tool call/);
  assert.match(text, /#5 exec node check\.mjs -> exit 0/);
  assert.match(text, /1 correction left/);
});

test("ADR-18 harness evidence: harness-* kinds are harness-produced only, and completion harness refs must be recorded", async () => {
  assert.equal(evidenceRefSchema.safeParse({ kind: "harness-verification", ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#12", produced_by: "harness" }).success, true);
  assert.equal(evidenceRefSchema.safeParse({ kind: "harness-verification", ref: "x", produced_by: "worker" }).success, false, "a worker cannot mint harness evidence");
  assert.equal(evidenceRefSchema.safeParse({ kind: "tool-call", ref: "#3", produced_by: "harness" }).success, false, "the harness produces only harness-* kinds");
  const examples = await loadDocExamples();
  const completion = examples.find(
    (example) => example.name === "completion-packet" && example.expectation === "valid" && (example.items[0] as { harness_evidence?: unknown }).harness_evidence !== undefined,
  );
  assert.ok(completion !== undefined, "a completion example with harness evidence exists");
  const withHarness = completionPacketSchema.parse(completion.items[0]);
  assert.ok(withHarness.harness_evidence !== undefined);
  const forged = structuredClone(completion.items[0]) as { acceptance_evidence: { evidence: { ref: string }[] }[] };
  const first = forged.acceptance_evidence.flatMap((entry) => entry.evidence).find((evidence) => evidence.ref.startsWith("ses_"));
  assert.ok(first !== undefined);
  first.ref = "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#999";
  assert.equal(completionPacketSchema.safeParse(forged).success, false, "harness evidence must name a harness_evidence record");
  assert.deepEqual(DEFAULT_ORCHESTRATION_BUDGETS, { triage_retries: 1, evidence_repairs: 2, review_revisions: 2 });
  assert.equal(orchestrationBudgetsSchema.safeParse({ triage_retries: 9 }).success, false);
});

test("ADR-18 events: attempt/verification_ran and attempt/repair_requested are v1; tool/call_proposed v2 carries the short ref", () => {
  const attempt = { attempt_id: "att_01K5T3Q8Z4X9V2M6N7P0R1S2T8", task_id: "task_01K5T3Q8Z4X9V2M6N7P0R1S2T6" };
  const ran = (data: Record<string, unknown>) => envelopeOf("attempt/verification_ran", 1, { ...attempt, ordinal: 1, command: "node check.mjs", duration_ms: 120, output_excerpt: "ok", ...data });
  assert.equal(parseSessionEvent(ran({ argv: ["node", "check.mjs"], status: "passed", termination: "exited", exit_code: 0 })).status, "ok");
  assert.equal(parseSessionEvent(ran({ argv: ["node", "check.mjs"], status: "passed", termination: "exited", exit_code: 1 })).status, "invalid");
  assert.equal(parseSessionEvent(ran({ argv: ["pnpm", "test"], command_class: "build-test", status: "passed", termination: "exited", exit_code: 0 })).status, "ok", "the harness records how it classified the command");
  assert.equal(parseSessionEvent(ran({ argv: ["pnpm", "test"], command_class: "trusted", status: "passed", termination: "exited", exit_code: 0 })).status, "invalid");
  assert.equal(parseSessionEvent(ran({ status: "not-run", exit_code: null, reason: "not expressible as argv" })).status, "ok");
  assert.equal(parseSessionEvent(ran({ status: "not-run", exit_code: null })).status, "invalid", "not-run needs a reason");
  const repair = (round: number) => envelopeOf("attempt/repair_requested", 1, { ...attempt, kind: "evidence-repair", round, budget: 2, problems: ["AC-1 has no resolvable evidence"] });
  assert.equal(parseSessionEvent(repair(1)).status, "ok");
  assert.equal(parseSessionEvent(repair(3)).status, "invalid", "a round beyond the budget is impossible");
  const proposed = (version: number, extra: Record<string, unknown>) =>
    envelopeOf("tool/call_proposed", version, { tool_call_id: "call_01K5T3Q8Z4X9V2M6N7P0R1S2TE", provider_call_id: "fc_1", tool_name: "exec", args_digest: sha256("args"), ...extra }, { kind: "worker", role: "implementer" });
  assert.equal(EVENT_VERSIONS["tool/call_proposed"], 2);
  assert.equal(EVENT_VERSIONS["tool/result_recorded"], 2);
  assert.equal(EVENT_VERSIONS["attempt/verification_ran"], 1);
  assert.equal(parseSessionEvent(proposed(1, {})).status, "ok", "v1 calls without a ref stay readable");
  assert.equal(parseSessionEvent(proposed(2, { ref: 3 })).status, "ok");
  assert.equal(parseSessionEvent(proposed(1, { ref: 3 })).status, "invalid");
  const recorded = (version: number, result: Record<string, unknown>) =>
    envelopeOf("tool/result_recorded", version, { tool_call_id: "call_01K5T3Q8Z4X9V2M6N7P0R1S2TE", state: "succeeded", duration_ms: 3, result: { status: "ok", text: "x", truncated: false, redactions: 0, ...result } });
  assert.equal(parseSessionEvent(recorded(2, { digest: sha256("x") })).status, "ok");
  assert.equal(parseSessionEvent(recorded(1, { digest: sha256("x") })).status, "invalid", "result.digest needs v2");
});

test("ADR-19 workspace digest is raw sha256 of the attempt's bytes; content identity never crosses schemes", () => {
  const lf = new TextEncoder().encode("a\nb\n");
  const crlf = new TextEncoder().encode("a\r\nb\r\n");
  assert.equal(workspaceDigest(lf), sha256(lf));
  assert.notEqual(workspaceDigest(lf), workspaceDigest(crlf), "an EOL flip is a change the precondition must see");
  assert.equal(digestText("a\r\nb\r\n"), digestText("a\nb\n"), "digestText stays the ledger's LF-folded text digest");
  assert.equal(sameContent({ scheme: "git-blob", oid: "e69de29" }, { scheme: "git-blob", oid: "e69de29" }), true);
  assert.equal(sameContent({ scheme: "git-blob", oid: "e69de29" }, { scheme: "workspace", digest: workspaceDigest(lf) }), false);
});

test("ADR-19 attempt/started v3 records reuse, fallback, overlay, dependency links and submodules", () => {
  const started = (version: number, isolation: Record<string, unknown>) =>
    envelopeOf("attempt/started", version, {
      attempt_id: "att_01K5T3Q8Z4X9V2M6N7P0R1S2T8",
      task_id: "task_01K5T3Q8Z4X9V2M6N7P0R1S2T6",
      role: "implementer",
      route: { provider_id: "openai", model_id: "gpt-5.6-luna", adapter_id: "openai-chatgpt", adapter_kind: "model", auth_method: "oauth-subscription", profile: "default" },
      packet_digest: sha256("packet"),
      isolation: { mode: "scoped-dir", ...isolation },
    });
  const v3 = { fallback: { from: "worktree", reason: "path-too-long", detail: "worktree path exceeds 260 characters" }, overlaid: ["src/lib.mjs"], dependency_links: ["node_modules"], reused: true, submodules: ["vendor/lib"] };
  assert.equal(parseSessionEvent(started(3, v3)).status, "ok");
  assert.equal(parseSessionEvent(started(2, v3)).status, "invalid");
  assert.equal(parseSessionEvent(started(2, {})).status, "ok");
  assert.equal(parseSessionEvent(started(3, { fallback: { from: "worktree", reason: "because", detail: "x" } })).status, "invalid");
});

test("ADR-19 path policy: NFC everywhere, one length-preserving case fold without Turkish tailoring", () => {
  const nfd = "src/şehir.ts";
  assert.equal(normalizePathUnicode(nfd), "src/şehir.ts");
  assert.equal(matchesPathPattern(nfd, "src/şehir.ts", { caseInsensitive: false }), true, "an NFD name matches its NFC grant");
  assert.equal(foldPathCase("readme.md"), foldPathCase("Readme.MD"));
  assert.equal(foldPathCase("ı"), "I", "dotless i folds with I");
  assert.equal(foldPathCase("İ"), "İ", "dotted capital I folds only to itself");
  assert.notEqual(foldPathCase("şehir"), foldPathCase("ŞEHİR"), "as on NTFS, these are different names");
  assert.equal(foldPathCase("straße"), "STRAßE", "a multi-code-point upper case is kept, the fold is length-preserving");
  assert.equal(matchesPathPattern("SRC/Auth/a.ts", "src/**/[a-z].ts", { caseInsensitive: true }), true);
  assert.equal(matchesPathPattern(".GIT/config", ".git", { caseInsensitive: true }), true);
  assert.equal(hasReservedSegment("src/.Git/config"), true);
  assert.equal(isCaseInsensitivePlatform("win32"), true);
  assert.equal(isCaseInsensitivePlatform("darwin"), true);
  assert.equal(isCaseInsensitivePlatform("linux"), false);
});

test("ADR-20 prompt cache: an optional request hint with a bounded key", () => {
  assert.equal(promptCacheSchema.safeParse({ key: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4:implementer", stable_system_blocks: 5 }).success, true);
  assert.equal(promptCacheSchema.safeParse({ key: "has space", stable_system_blocks: 1 }).success, false);
  assert.ok("cache" in modelRequestSchema.shape);
  assert.equal(modelRequestSchema.shape.cache.safeParse(undefined).success, true, "requests without a cache hint stay valid");
});
