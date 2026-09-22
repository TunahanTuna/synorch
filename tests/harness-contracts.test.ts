import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
  approvalDecisionSchema,
  approvalRequestSchema,
  authStatusSchema,
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
  "session-manifest": sessionManifestSchema,
  "segment-header": segmentHeaderSchema,
  "session-lease": sessionLeaseSchema,
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
  assert.equal(EVENT_VERSIONS["attempt/started"], 2);
  assert.equal(EVENT_VERSIONS["tool/policy_decided"], 2);
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
