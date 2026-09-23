import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import {
  createId,
  EVENT_VERSIONS,
  renderToolResultText,
  workspaceDigest,
  type AgentRole,
  type AttemptId,
  type EffectivePolicy,
  type SandboxReport,
  type Tool,
  type ToolCallOutcome,
  type ToolGateway,
} from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { createSandboxRunner, createToolGateway, createToolRegistry } from "../src/harness/tools/index.ts";
import { createAttemptFileLedger } from "../src/harness/tools/file-ledger.ts";
import { applyHunks, parsePatch } from "../src/harness/tools/patch.ts";
import { decodeTextFile, encodeTextFile } from "../src/harness/tools/text-file.ts";
import { createMemoryBlobStore, createMemoryEventStore, type MemoryBlobStore, type MemoryEventStore } from "../src/harness/tools/testing.ts";

/**
 * W1a (ADR-18 D3, ADR-19): short tool refs, the attempt file ledger, model-friendly patches and
 * byte-faithful edits. Patch texts marked "live" are copied verbatim from the two live runs audited
 * in Denetim A (run_01M35SSARRMK87VYMT770BNM3X, run_01M35VYXAC79ST06QZBAFGWT1S).
 */

const engine = createPolicyEngine({ workspaceTrusted: () => true });
const PARTIAL: SandboxReport = {
  backend: "policy-only",
  platform: "win32",
  enforcement: "partial",
  filesystem: "partial",
  network: "unavailable",
  process: "partial",
  notes: [],
};

/** The live runs' `*** Begin Patch` call, byte for byte (attempt 1 and 2 sent the same text). */
const LIVE_PATCH = "*** Begin Patch\n*** Update File: src-add.mjs\n@@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch";
const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A whole-workspace grant is refused by policy, so tests own the files they edit by name. */
const DEFAULT_OWNED = ["src/**", "new/**", "src-add.mjs", "notes.md", "big.txt", "big.ts", "mixed.txt", "mac.txt", "bom.md", "bom.txt", "w.txt", "legacy.txt"];

interface Rig {
  readonly root: string;
  readonly events: MemoryEventStore;
  readonly blobs: MemoryBlobStore;
  readonly gateway: ToolGateway;
  readonly policy: EffectivePolicy;
  call(name: string, args: Record<string, unknown>, attemptId?: AttemptId): Promise<ToolCallOutcome>;
  bytes(relative: string): Promise<Buffer>;
}

interface RigOptions {
  readonly owned?: readonly string[];
  readonly role?: AgentRole;
  readonly verification?: readonly string[];
  readonly extraTools?: readonly Tool[];
  readonly events?: MemoryEventStore;
}

async function rig(t: TestContext, options: RigOptions = {}): Promise<Rig> {
  const root = await mkdtemp(path.join(tmpdir(), "syn-w1a-edit-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return rigAt(root, options);
}

function rigAt(root: string, options: RigOptions = {}): Rig {
  const role = options.role ?? "implementer";
  const policy = engine.compute({
    mode: "autonomous",
    role,
    runId: createId("run"),
    taskId: createId("task"),
    workspaceRoot: root,
    taskScope: { owned: [...(options.owned ?? DEFAULT_OWNED)], read: [], forbidden: [], verification_commands: [...(options.verification ?? [])] },
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: PARTIAL,
    grants: [],
  });
  const registry = createToolRegistry({ classifyCommand });
  for (const tool of options.extraTools ?? []) registry.register(tool);
  const events = options.events ?? createMemoryEventStore();
  const blobs = createMemoryBlobStore();
  const gateway = createToolGateway({ events, blobs, registry, policy: engine, approvals: createHeadlessApprovalBroker(), sandbox: createSandboxRunner(PARTIAL) });
  let counter = 0;
  return {
    root,
    events,
    blobs,
    gateway,
    policy,
    call(name, args, attemptId) {
      counter += 1;
      return gateway.invoke(
        { tool_call_id: createId("toolCall"), provider_call_id: `call_provider_${counter}`, tool_name: name, arguments: args },
        { runId: policy.run_id, taskId: policy.task_id, attemptId, role: policy.role, policy },
        new AbortController().signal,
      );
    },
    bytes: (relative) => readFile(path.join(root, ...relative.split("/"))),
  };
}

async function put(root: string, relative: string, content: string | Uint8Array): Promise<void> {
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function ok(outcome: ToolCallOutcome): ToolCallOutcome {
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.result));
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// [#n] short refs (AC-a1), endsTurn (AC-a2), digest pass-through

test("AC-a1: every call gets an attempt-scoped [#n] ref, recorded in tool/call_proposed v2 and rendered first", async (t) => {
  const r = await rig(t);
  await put(r.root, "a.txt", "a\n");
  const attempt = createId("attempt");
  const first = await r.call("read_file", { path: "a.txt" }, attempt);
  const unknown = await r.call("no_such_tool", {}, attempt);
  const denied = await r.call("read_file", { path: "../outside.txt" }, attempt);
  assert.deepEqual([first.ref, unknown.ref, denied.ref], [1, 2, 3], "denied and unknown calls are numbered too");
  assert.match(renderToolResultText(first.ref, first.result), /^\[#1\] a\.txt · digest sha256:[0-9a-f]{64} · lines 1-1 of 1\na$/);
  assert.match(renderToolResultText(unknown.ref, unknown.result), /^\[#2\] Error \[unknown_tool\]/);

  const other = createId("attempt");
  assert.equal((await r.call("read_file", { path: "a.txt" }, other)).ref, 1, "a different attempt counts from 1");
  assert.equal((await r.call("read_file", { path: "a.txt" })).ref, 1, "a call without an attempt counts per session");
  assert.equal((await r.call("read_file", { path: "a.txt" }, attempt)).ref, 4);

  const proposed = r.events.events.filter((event) => event.type === "tool/call_proposed");
  assert.deepEqual(
    proposed.map((event) => (event.type === "tool/call_proposed" ? [event.attempt_id ?? "-", event.data.ref] : [])),
    [
      [attempt, 1],
      [attempt, 2],
      [attempt, 3],
      [other, 1],
      ["-", 1],
      [attempt, 4],
    ],
  );
  assert.ok(proposed.every((event) => event.event_version === EVENT_VERSIONS["tool/call_proposed"] && event.event_version >= 2));
});

test("AC-a1: after a resume the numbering continues from the recorded events and never reuses a number", async (t) => {
  const r = await rig(t);
  await put(r.root, "a.txt", "a\n");
  const attempt = createId("attempt");
  await r.call("read_file", { path: "a.txt" }, attempt);
  await r.call("read_file", { path: "a.txt" }, attempt);
  const resumed = rigAt(r.root, { events: r.events });
  const [x, y] = await Promise.all([resumed.call("read_file", { path: "a.txt" }, attempt), resumed.call("list_dir", {}, attempt)]);
  assert.deepEqual([x.ref, y.ref].sort(), [3, 4]);
});

test("AC-a2: endsTurn is set only when an ends_turn control tool succeeds with status ok", async (t) => {
  let answer: "ok" | "error" = "error";
  const finish: Tool<{ readonly note: string }> = {
    metadata: {
      name: "finish_up",
      version: "1.0.0",
      description: "test terminal tool",
      source: "builtin",
      effect: "control",
      effect_source: "builtin",
      idempotent: false,
      network: "none",
      output_limit_bytes: 4096,
      timeout_ms: 1000,
      cancellable: true,
      concurrency: "sequential",
      visible_to: ["implementer"],
      ends_turn: true,
    },
    input: z.strictObject({ note: z.string() }),
    descriptor: () => ({ name: "finish_up", description: "test terminal tool", input_schema: {} }),
    normalize: async (_input, context) => ({
      tool_name: "finish_up",
      tool_version: "1.0.0",
      effect: "control",
      role: context.role,
      task_id: context.taskId,
      args_digest: workspaceDigest(new Uint8Array()),
      paths: [],
      network_hosts: [],
      destructive: false,
    }),
    execute: async () =>
      answer === "ok"
        ? { status: "ok", text: "recorded", truncated: false, redactions: 0 }
        : { status: "error", text: "", truncated: false, redactions: 0, error: { code: "invalid_arguments", message: "AC-1: unresolved" } },
  };
  const r = await rig(t, { extraTools: [finish] });
  const rejected = await r.call("finish_up", { note: "x" });
  assert.equal(rejected.endsTurn, undefined);
  const invalid = await r.call("finish_up", { wrong: true });
  assert.equal(invalid.endsTurn, undefined);
  answer = "ok";
  const accepted = await r.call("finish_up", { note: "x" });
  assert.equal(accepted.endsTurn, true);
  await put(r.root, "a.txt", "a\n");
  assert.equal((await r.call("read_file", { path: "a.txt" })).endsTurn, undefined, "ordinary tools never end the turn");
});

// ---------------------------------------------------------------------------------------------
// read_file digest header and the ledger (AC-a3, AC-a4)

test("AC-a3: read_file reports the raw-byte workspace digest in its header and ToolResult.digest, recorded as result v2", async (t) => {
  const r = await rig(t);
  const crlf = "export function add(a, b) {\r\n  return a - b;\r\n}\r\n";
  await put(r.root, "src-add.mjs", crlf);
  const outcome = ok(await r.call("read_file", { path: "src-add.mjs" }));
  const digest = workspaceDigest(Buffer.from(crlf));
  assert.equal(outcome.result.digest, digest);
  assert.equal(outcome.result.text, `src-add.mjs · digest ${digest} · lines 1-3 of 3\nexport function add(a, b) {\n  return a - b;\n}`);
  const recorded = r.events.events.find((event) => event.type === "tool/result_recorded");
  assert.equal(recorded?.type === "tool/result_recorded" ? recorded.data.result.digest : undefined, digest);
  assert.equal(recorded?.event_version, 2);

  await put(r.root, "empty.txt", "");
  assert.match(ok(await r.call("read_file", { path: "empty.txt" })).result.text, /^empty\.txt · digest sha256:[0-9a-f]{64} · empty file$/);
  await put(r.root, "bom.txt", "﻿first\nsecond\n");
  assert.match(ok(await r.call("read_file", { path: "bom.txt" })).result.text, /lines 1-2 of 2\nfirst\nsecond$/, "the BOM is not shown");
  await put(r.root, "mac.txt", "one\rtwo\rthree\r");
  assert.match(ok(await r.call("read_file", { path: "mac.txt", offset: 2, limit: 1 })).result.text, /lines 2-2 of 3\ntwo$/, "CR-only files split into lines");
});

test("AC-a4: writes default expected_digest to the attempt's last read; consecutive edits need no re-read", async (t) => {
  const r = await rig(t);
  await put(r.root, "src-add.mjs", BUGGY);
  const attempt = createId("attempt");

  const blind = await r.call("write_file", { path: "src-add.mjs", content: FIXED }, attempt);
  assert.equal(blind.result.error?.code, "invalid_arguments");
  assert.match(blind.result.error?.message ?? "", /read_file it first/);
  const blindPatch = await r.call("apply_patch", { patch: LIVE_PATCH }, attempt);
  assert.equal(blindPatch.result.error?.code, "invalid_arguments");
  assert.equal((await r.bytes("src-add.mjs")).toString(), BUGGY);

  ok(await r.call("read_file", { path: "src-add.mjs" }, attempt));
  const patched = ok(await r.call("apply_patch", { patch: LIVE_PATCH }, attempt));
  assert.equal((await r.bytes("src-add.mjs")).toString(), FIXED);
  assert.equal(patched.result.digest, workspaceDigest(Buffer.from(FIXED)));
  assert.match(patched.result.text, /updated src-add\.mjs · digest sha256:/);

  const second = "*** Begin Patch\n*** Update File: src-add.mjs\n@@ export function add(a, b) {\n-  return a + b;\n+  return Number(a) + Number(b);\n*** End Patch";
  ok(await r.call("apply_patch", { patch: second }, attempt));
  ok(await r.call("write_file", { path: "src-add.mjs", content: FIXED }, attempt));
  assert.equal((await r.bytes("src-add.mjs")).toString(), FIXED);

  const otherAttempt = createId("attempt");
  const fresh = await r.call("write_file", { path: "src-add.mjs", content: BUGGY }, otherAttempt);
  assert.equal(fresh.result.error?.code, "invalid_arguments", "the ledger is per attempt");
});

test("AC-a4: a file changed behind the model's back is a stale precondition naming the current digest", async (t) => {
  const r = await rig(t);
  await put(r.root, "notes.md", "a\n");
  ok(await r.call("read_file", { path: "notes.md" }));
  await put(r.root, "notes.md", "a\nchanged by the user\n");
  const current = workspaceDigest(Buffer.from("a\nchanged by the user\n"));
  const stale = await r.call("write_file", { path: "notes.md", content: "b\n" });
  assert.equal(stale.result.error?.code, "stale_precondition");
  assert.match(stale.result.error?.message ?? "", new RegExp(`current digest ${current}`));
  assert.match(stale.result.error?.message ?? "", /Re-read the file with read_file and retry/);
  const stalePatch = await r.call("apply_patch", { patch: "*** Begin Patch\n*** Update File: notes.md\n@@\n-a\n+b\n*** End Patch" });
  assert.equal(stalePatch.result.error?.code, "stale_precondition");
  assert.equal((await r.bytes("notes.md")).toString(), "a\nchanged by the user\n");
  ok(await r.call("read_file", { path: "notes.md" }));
  ok(await r.call("write_file", { path: "notes.md", content: "b\n" }));

  const explicit = await r.call("apply_patch", { patch: "--- a/notes.md\n+++ b/notes.md\n@@\n-b\n+c\n", expected: { "notes.md": workspaceDigest(Buffer.from("zzz")) } });
  assert.equal(explicit.result.error?.code, "stale_precondition", "an explicit digest wins over the ledger");
  const shorthand = ok(await r.call("apply_patch", { patch: "--- a/notes.md\n+++ b/notes.md\n@@\n-b\n+c\n", expected_digest: workspaceDigest(Buffer.from("b\n")) }));
  assert.deepEqual(shorthand.result.changed_paths, ["notes.md"]);
});

test("AC-a4: the ledger keys paths by NFC and, on case-insensitive platforms, by foldPathCase", () => {
  const digest = workspaceDigest(Buffer.from("x"));
  const windows = createAttemptFileLedger("win32");
  windows.noteRead("Src/Şehir.ts", digest);
  assert.equal(windows.lastSeen("src/şehir.ts"), digest, "Ş and ş fold together");
  windows.noteRead("x/ŞEHİR.md", digest);
  assert.equal(windows.lastSeen("x/şehir.md"), undefined, "İ folds only to itself (no Turkish tailoring, as on NTFS)");
  windows.noteRead("Src/Readme.md", digest);
  assert.equal(windows.lastSeen("src/README.MD"), digest);
  windows.noteRead("docs/ş.md", digest);
  assert.equal(windows.lastSeen("docs/ş.md"), digest, "NFD and NFC name the same key");
  const linux = createAttemptFileLedger("linux");
  linux.noteRead("Src/Readme.md", digest);
  assert.equal(linux.lastSeen("src/readme.md"), undefined);
  linux.noteWrite("Src/Readme.md", undefined);
  assert.equal(linux.lastSeen("Src/Readme.md"), undefined);
});

// ---------------------------------------------------------------------------------------------
// Patch formats (AC-a5)

test("AC-a5: the live '*** Begin Patch' call applies verbatim to the LF and to the CRLF checkout", async (t) => {
  const r = await rig(t);
  await put(r.root, "src-add.mjs", BUGGY);
  ok(await r.call("read_file", { path: "src-add.mjs" }));
  ok(await r.call("apply_patch", { patch: LIVE_PATCH }));
  assert.equal((await r.bytes("src-add.mjs")).toString(), FIXED);

  // Attempt 1 of run 2 ran in a worktree that git had checked out with CRLF (autocrlf=true).
  const crlf = await rig(t);
  await put(crlf.root, "src-add.mjs", BUGGY.replaceAll("\n", "\r\n"));
  const read = ok(await crlf.call("read_file", { path: "src-add.mjs" }));
  // The live call also carried the digest it had just read; it is accepted as the explicit precondition.
  ok(await crlf.call("apply_patch", { patch: LIVE_PATCH, expected: { "src-add.mjs": read.result.digest } }));
  assert.equal((await crlf.bytes("src-add.mjs")).toString(), FIXED.replaceAll("\n", "\r\n"));
});

test("AC-a5: Add File, Delete File, Move to and several files in one patch", async (t) => {
  const r = await rig(t);
  await put(r.root, "src/old.ts", "export const a = 1;\nexport const b = 2;\n");
  await put(r.root, "src/gone.ts", "bye\n");
  ok(await r.call("read_file", { path: "src/old.ts" }));
  ok(await r.call("read_file", { path: "src/gone.ts" }));
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+export const created = true;",
    "+",
    "+export const more = 1;",
    "*** Delete File: src/gone.ts",
    "*** Update File: src/old.ts",
    "*** Move to: src/renamed.ts",
    "@@",
    " export const a = 1;",
    "-export const b = 2;",
    "+export const b = 3;",
    "*** End Patch",
  ].join("\n");
  const outcome = ok(await r.call("apply_patch", { patch }));
  assert.deepEqual([...(outcome.result.changed_paths ?? [])].sort(), ["src/gone.ts", "src/new.ts", "src/old.ts", "src/renamed.ts"]);
  assert.equal((await r.bytes("src/new.ts")).toString(), "export const created = true;\n\nexport const more = 1;\n");
  assert.equal((await r.bytes("src/renamed.ts")).toString(), "export const a = 1;\nexport const b = 3;\n");
  assert.deepEqual((await readdir(path.join(r.root, "src"))).sort(), ["new.ts", "renamed.ts"]);

  const again = await r.call("apply_patch", { patch: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch" });
  assert.equal(again.result.error?.code, "stale_precondition", "adding over an existing file is refused");
  const missing = await r.call("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/none.ts\n@@\n-a\n+b\n*** End Patch" });
  assert.equal(missing.result.error?.code, "invalid_arguments");
  assert.match(missing.result.error?.message ?? "", /does not exist; create it with '\*\*\* Add File/);
});

test("AC-a5: unified diffs without line counts, with wrong counts or wrong line numbers are located by context", async (t) => {
  const r = await rig(t);
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  await put(r.root, "big.txt", `${lines.join("\n")}\n`);
  ok(await r.call("read_file", { path: "big.txt" }));
  // Bare @@ headers (models often drop the numbers), two hunks.
  const bare = "--- a/big.txt\n+++ b/big.txt\n@@\n line 4\n-line 5\n+line five\n line 6\n@@\n line 30\n-line 31\n+line thirty-one\n";
  ok(await r.call("apply_patch", { patch: bare }));
  // Numbers that point at the wrong place and counts that do not add up.
  const wrong = "--- big.txt\n+++ big.txt\n@@ -1,7 +1,9 @@\n line 20\n-line 21\n+line twenty-one\n line 22\n";
  ok(await r.call("apply_patch", { patch: wrong }));
  // Counts-less numbered form and a fenced block, as chat models emit it.
  const fenced = "```diff\n--- a/big.txt\n+++ b/big.txt\n@@ -40 +40 @@\n-line 40\n+line forty\n```";
  ok(await r.call("apply_patch", { patch: fenced }));
  const result = (await r.bytes("big.txt")).toString().split("\n");
  assert.equal(result[4], "line five");
  assert.equal(result[20], "line twenty-one");
  assert.equal(result[30], "line thirty-one");
  assert.equal(result[39], "line forty");
  assert.equal(result.length, 41);
});

test("AC-a5: a hunk that repeats elsewhere is placed by the '@@ <anchor>' line, the line hint or file order", () => {
  const source = decodeTextFile(Buffer.from("function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n"), "f.ts");
  const anchored = applyHunks(source, parsePatch("*** Begin Patch\n*** Update File: f.ts\n@@ function b() {\n-  return 1;\n+  return 2;\n*** End Patch")[0]?.hunks ?? [], "f.ts");
  assert.equal(encodeTextFile(anchored).toString(), "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n");
  const hinted = applyHunks(source, parsePatch("--- f.ts\n+++ f.ts\n@@ -5 +5 @@\n-  return 1;\n+  return 3;\n")[0]?.hunks ?? [], "f.ts");
  assert.equal(encodeTextFile(hinted).toString(), "function a() {\n  return 1;\n}\nfunction b() {\n  return 3;\n}\n");
  const trailingSpace = applyHunks(source, parsePatch("--- f.ts\n+++ f.ts\n@@\n function a() {  \n-  return 1;\n+  return 4;\n")[0]?.hunks ?? [], "f.ts");
  assert.equal(encodeTextFile(trailingSpace).toString().split("\n")[0], "function a() {", "a tolerant match keeps the file's own context line");
});

test("AC-a6: a missing final newline is kept unless the patch's '\\ No newline at end of file' markers change it", () => {
  const source = decodeTextFile(Buffer.from("a\nb"), "n.txt");
  const apply = (patch: string): string => encodeTextFile(applyHunks(source, parsePatch(patch)[0]?.hunks ?? [], "n.txt")).toString();
  assert.equal(apply("--- n.txt\n+++ n.txt\n@@\n a\n-b\n+c\n"), "a\nc");
  assert.equal(apply("--- n.txt\n+++ n.txt\n@@\n a\n b\n+c\n"), "a\nb\nc");
  assert.equal(apply("--- n.txt\n+++ n.txt\n@@ -2 +2 @@\n-b\n\\ No newline at end of file\n+b\n"), "a\nb\n");
  const terminated = decodeTextFile(Buffer.from("a\nb\n"), "t.txt");
  assert.equal(encodeTextFile(applyHunks(terminated, parsePatch("--- t.txt\n+++ t.txt\n@@ -2 +2 @@\n-b\n+b\n\\ No newline at end of file\n")[0]?.hunks ?? [], "t.txt")).toString(), "a\nb");
});

test("AC-a5: unusable patches are invalid_arguments naming the accepted formats with an example", async (t) => {
  const r = await rig(t);
  await put(r.root, "src-add.mjs", BUGGY);
  ok(await r.call("read_file", { path: "src-add.mjs" }));
  for (const patch of ["not a diff", "@@\n-a\n+b\n", "*** Begin Patch\n*** Frobnicate File: x\n*** End Patch"]) {
    const outcome = await r.call("apply_patch", { patch });
    assert.equal(outcome.result.error?.code, "invalid_arguments", patch);
    const message = outcome.result.error?.message ?? "";
    assert.match(message, /\*\*\* Begin Patch/);
    assert.match(message, /unified diff/);
    assert.match(message, /\*\*\* Update File: src\/app\.ts\n@@\n export function retries\(\) \{\n- {2}return 1;\n\+ {2}return 3;/);
  }
  const mismatch = await r.call("apply_patch", { patch: "*** Begin Patch\n*** Update File: src-add.mjs\n@@\n-  return a * b;\n+  return a + b;\n*** End Patch" });
  assert.equal(mismatch.result.error?.code, "invalid_arguments");
  assert.match(mismatch.result.error?.message ?? "", /context mismatch in hunk 1 of src-add\.mjs.*"  return a \* b;".*Re-read the file/s);
  assert.equal((await r.bytes("src-add.mjs")).toString(), BUGGY);
});

// ---------------------------------------------------------------------------------------------
// Byte fidelity (AC-a6, AC-a7) — Denetim B fixtures 6 and 7

test("AC-a6: a mixed-EOL file keeps every untouched line byte-identical; inserted lines take their neighbour's EOL", async (t) => {
  const r = await rig(t);
  const original = "alpha\r\nbeta\ngamma\r\ndelta\nomega";
  await put(r.root, "mixed.txt", original);
  ok(await r.call("read_file", { path: "mixed.txt" }));
  ok(await r.call("apply_patch", { patch: "*** Begin Patch\n*** Update File: mixed.txt\n@@\n beta\n-gamma\n+GAMMA\n+gamma2\n delta\n*** End Patch" }));
  assert.equal((await r.bytes("mixed.txt")).toString(), "alpha\r\nbeta\nGAMMA\r\ngamma2\r\ndelta\nomega", "no final newline is added either");
});

test("AC-a6: CR-only files are patchable and a BOM survives a line-1 hunk", async (t) => {
  const r = await rig(t);
  await put(r.root, "mac.txt", "one\rtwo\rthree\r");
  ok(await r.call("read_file", { path: "mac.txt" }));
  ok(await r.call("apply_patch", { patch: "--- a/mac.txt\n+++ b/mac.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" }));
  assert.equal((await r.bytes("mac.txt")).toString(), "one\rTWO\rthree\r");

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Başlık\r\nmetin\r\n")]);
  await put(r.root, "bom.md", bom);
  ok(await r.call("read_file", { path: "bom.md" }));
  ok(await r.call("apply_patch", { patch: "*** Begin Patch\n*** Update File: bom.md\n@@\n-# Başlık\n+# Yeni Başlık\n metin\n*** End Patch" }));
  const after = await r.bytes("bom.md");
  assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(after.subarray(3).toString(), "# Yeni Başlık\r\nmetin\r\n");
});

test("AC-a6: write_file keeps the existing file's uniform EOL and BOM; a mixed file takes the content as given", async (t) => {
  const r = await rig(t);
  await put(r.root, "w.txt", "one\r\ntwo\r\nthree\r\n");
  ok(await r.call("read_file", { path: "w.txt" }));
  const written = ok(await r.call("write_file", { path: "w.txt", content: "one\nTWO\nthree\n" }));
  assert.equal((await r.bytes("w.txt")).toString(), "one\r\nTWO\r\nthree\r\n");
  assert.match(written.result.text, /CRLF line endings kept/);
  assert.equal(written.result.digest, workspaceDigest(await r.bytes("w.txt")));

  await put(r.root, "bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\n")]));
  ok(await r.call("read_file", { path: "bom.txt" }));
  ok(await r.call("write_file", { path: "bom.txt", content: "b\n" }));
  assert.deepEqual([...(await r.bytes("bom.txt"))], [0xef, 0xbb, 0xbf, 0x62, 0x0a]);

  await put(r.root, "mixed.txt", "a\r\nb\n");
  ok(await r.call("read_file", { path: "mixed.txt" }));
  ok(await r.call("write_file", { path: "mixed.txt", content: "x\ny\n" }));
  assert.equal((await r.bytes("mixed.txt")).toString(), "x\ny\n");

  ok(await r.call("write_file", { path: "new/lf.txt", content: "fresh\n" }));
  assert.equal((await r.bytes("new/lf.txt")).toString(), "fresh\n", "a new file is written as given");
});

test("AC-a7: a cp1254 file is refused by apply_patch and write_file and its bytes never change", async (t) => {
  const r = await rig(t);
  // "sş\r\nğ\r\n" in Windows-1254: ş = 0xFE, ğ = 0xF0 (Denetim B, s2.mjs E).
  const legacy = Buffer.from([0x73, 0xfe, 0x0d, 0x0a, 0xf0, 0x0d, 0x0a, 0x6b, 0x0d, 0x0a]);
  await put(r.root, "legacy.txt", legacy);
  const read = ok(await r.call("read_file", { path: "legacy.txt" }));
  assert.match(read.result.text, /not valid UTF-8/);
  const patch = await r.call("apply_patch", { patch: "*** Begin Patch\n*** Update File: legacy.txt\n@@\n-k\n+K\n*** End Patch" });
  assert.equal(patch.result.error?.code, "invalid_arguments");
  assert.match(patch.result.error?.message ?? "", /not valid UTF-8/);
  const write = await r.call("write_file", { path: "legacy.txt", content: "sş\nğ\nK\n" });
  assert.equal(write.result.error?.code, "invalid_arguments");
  assert.deepEqual(await r.bytes("legacy.txt"), legacy);
});

test("Denetim B fixtures 6-7: with autocrlf=false, edits of CRLF and mixed files diff as the real lines only", { skip: !gitAvailable && "git is not installed" }, async (t) => {
  const r = await rig(t);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=W1a", "-c", "user.email=w1a@example.invalid", ...args], { cwd: r.root, encoding: "utf8" });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  await put(r.root, "w.txt", "one\r\ntwo\r\nthree\r\n");
  await put(r.root, "mixed.txt", "alpha\r\nbeta\ngamma\r\ndelta\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  ok(await r.call("read_file", { path: "w.txt" }));
  ok(await r.call("write_file", { path: "w.txt", content: "one\nTWO\nthree\n" }));
  ok(await r.call("read_file", { path: "mixed.txt" }));
  ok(await r.call("apply_patch", { patch: "--- a/mixed.txt\n+++ b/mixed.txt\n@@ -2,2 +2,2 @@\n beta\n-gamma\n+GAMMA\n" }));
  assert.deepEqual(git("diff", "--numstat").trim().split(/\r?\n/).sort(), ["1\t1\tmixed.txt", "1\t1\tw.txt"]);
});

// ---------------------------------------------------------------------------------------------
// Bounded output (AC-a8)

test("AC-a8: a large read_file is shown head + tail within the inline cap with an offset/limit note; the rest is in a blob", async (t) => {
  const r = await rig(t);
  const lines = Array.from({ length: 3000 }, (_, index) => `const value${index + 1} = ${index + 1};`);
  await put(r.root, "big.ts", `${lines.join("\n")}\n`);
  const outcome = ok(await r.call("read_file", { path: "big.ts" }));
  assert.ok(Buffer.byteLength(outcome.result.text) <= 16 * 1024);
  assert.equal(outcome.result.truncated, true);
  assert.match(outcome.result.text, /^big\.ts · digest sha256:[0-9a-f]{64} · lines 1-3000 of 3000\nconst value1 = 1;/);
  assert.match(outcome.result.text, /… \[lines \d+-\d+ omitted; truncated; use offset\/limit to read them, e\.g\. offset \d+ limit \d+\] …/);
  assert.match(outcome.result.text, /const value3000 = 3000;$/);
  assert.ok(outcome.result.blob !== undefined);
  assert.equal(r.blobs.text(outcome.result.blob.digest), lines.join("\n"));
  const paged = ok(await r.call("read_file", { path: "big.ts", offset: 1500, limit: 2 }));
  assert.match(paged.result.text, /lines 1500-1501 of 3000\nconst value1500 = 1500;\nconst value1501 = 1501;$/);
});

test("AC-a8: large exec output is bounded head + tail with a hint and the full output in a blob", async (t) => {
  const r0 = await rig(t);
  const script = path.join(r0.root, "noisy.mjs");
  await writeFile(script, "for (let i = 0; i < 4000; i += 1) console.log(`row ${i} ${'x'.repeat(20)}`);\n");
  const r = rigAt(r0.root, { verification: [`node '${script.replaceAll("'", "'\\''")}'`] });
  const outcome = ok(await r.call("exec", { argv: ["node", script] }));
  assert.ok(Buffer.byteLength(outcome.result.text) <= 16 * 1024);
  assert.equal(outcome.result.truncated, true);
  assert.match(outcome.result.text, /bytes omitted; truncated; narrow the command's output/);
  assert.match(outcome.result.text, /row 3999/);
  assert.ok(outcome.result.blob !== undefined);
  assert.match(r.blobs.text(outcome.result.blob.digest), /row 2000 /);
});

// ---------------------------------------------------------------------------------------------
// Unicode and case (AC-a9) — the tool half of Denetim B fixture 10

test("AC-a9: a file created with an NFD name is writable under an NFC owned path", async (t) => {
  const r = await rig(t, { owned: ["docs/şehir/**"] });
  const nfd = "docs/şehir/not.md";
  await put(r.root, nfd, "eski\n");
  ok(await r.call("read_file", { path: nfd }));
  const outcome = ok(await r.call("write_file", { path: nfd, content: "yeni\n" }));
  assert.equal(outcome.result.changed_paths?.[0]?.normalize("NFC"), "docs/şehir/not.md");
  assert.equal((await r.bytes(nfd)).toString(), "yeni\n");
});

test(
  "AC-a9: an owned readme.md and an on-disk Readme.md are the same file for write_file on case-insensitive platforms",
  { skip: !["win32", "darwin"].includes(process.platform) && "needs a case-insensitive volume (win32/darwin)" },
  async (t) => {
    const r = await rig(t, { owned: ["readme.md"] });
    await put(r.root, "Readme.md", "old\n");
    ok(await r.call("read_file", { path: "readme.md" }));
    const outcome = ok(await r.call("write_file", { path: "readme.md", content: "new\n" }));
    assert.deepEqual(outcome.result.changed_paths, ["Readme.md"], "the canonical case comes from the file system");
    assert.equal((await r.bytes("Readme.md")).toString(), "new\n");
  },
);
