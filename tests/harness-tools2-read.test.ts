import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createId, type AgentRole, type SandboxReport } from "../src/harness/contracts/index.ts";
import { classifyCommand, createHeadlessApprovalBroker, createPolicyEngine } from "../src/harness/policy/index.ts";
import { createToolRegistry } from "../src/harness/tools/index.ts";
import { expandBraces } from "../src/harness/tools/builtin/glob.ts";
import { parsePages } from "../src/harness/tools/builtin/read-media.ts";
import { createGatewayHarness, type GatewayHarness } from "../src/harness/tools/testing.ts";

const engine = createPolicyEngine();
const PARTIAL: SandboxReport = { backend: "policy-only", platform: "win32", enforcement: "partial", filesystem: "partial", network: "unavailable", process: "partial", notes: [] };
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "syn-k42-read-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(path.join(root, "src", "auth"), { recursive: true });
  await mkdir(path.join(root, "src", "billing"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "auth", "session.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "auth", "view.tsx"), "export const b = 2;\n");
  await writeFile(path.join(root, "src", "billing", "invoice.ts"), "export const secret = 3;\n");
  await writeFile(path.join(root, "index.ts"), "export {};\n");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  return root;
}

function harnessFor(root: string, role: AgentRole = "implementer"): GatewayHarness {
  return createGatewayHarness({
    engine,
    policy: engine.compute({
      mode: "autonomous",
      role,
      runId: createId("run"),
      taskId: createId("task"),
      workspaceRoot: root,
      taskScope: { owned: ["src/auth/**"], read: [], forbidden: ["src/billing/**"] },
      userConfig: undefined,
      workspaceConfig: undefined,
      sandbox: PARTIAL,
      grants: [],
    }),
    approvals: createHeadlessApprovalBroker(),
    sandboxReport: PARTIAL,
    registry: createToolRegistry({ classifyCommand }),
  });
}

/** A one-page PDF with the given text (a valid xref, Helvetica). */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("glob walks a non-git folder: bare patterns match at any depth, braces expand, forbidden paths never show", async (t) => {
  const root = await workspace(t);
  const harness = harnessFor(root);
  const ts = await harness.call("glob", { pattern: "*.ts" });
  assert.equal(ts.state, "succeeded", ts.result.error?.message);
  assert.match(ts.result.text, /src\/auth\/session\.ts/);
  assert.match(ts.result.text, /^index\.ts$/m);
  assert.doesNotMatch(ts.result.text, /invoice/);
  const both = await harness.call("glob", { pattern: "src/**/*.{ts,tsx}" });
  assert.match(both.result.text, /view\.tsx/);
  assert.match(both.result.text, /session\.ts/);
  const none = await harness.call("glob", { pattern: "**/*.py" });
  assert.match(none.result.text, /no files match/);
  assert.deepEqual(expandBraces("a/{b,c{d,e}}.ts"), ["a/b.ts", "a/cd.ts", "a/ce.ts"]);
});

test("glob in a git repository honours .gitignore and includes untracked files", async (t) => {
  const root = await workspace(t);
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available");
    return;
  }
  await writeFile(path.join(root, ".gitignore"), "dist/\n");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "bundle.ts"), "built\n");
  const outcome = await harnessFor(root).call("glob", { pattern: "**/*.ts" });
  assert.match(outcome.result.text, /git ls-files/);
  assert.match(outcome.result.text, /session\.ts/);
  assert.doesNotMatch(outcome.result.text, /bundle\.ts/);
});

test("todo echoes the checklist and refuses too many items in progress", async (t) => {
  const root = await workspace(t);
  const harness = harnessFor(root, "explorer");
  const outcome = await harness.call("todo", {
    items: [
      { text: "read the auth module", status: "done" },
      { text: "write the fix", status: "in_progress" },
      { text: "run the tests" },
    ],
  });
  assert.equal(outcome.state, "succeeded", outcome.result.error?.message);
  assert.equal(outcome.result.text, "checklist 1/3 done · now: write the fix\n[x] read the auth module\n[>] write the fix\n[ ] run the tests");
  const busy = await harness.call("todo", { items: [1, 2, 3, 4].map((n) => ({ text: `step ${n}`, status: "in_progress" })) });
  assert.equal(busy.result.error?.code, "invalid_arguments");
});

test("read_file returns an image as an image blob and a PDF as text by page", async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, "docs", "shot.png"), PNG_1PX);
  await writeFile(path.join(root, "docs", "fake.png"), "not a png");
  await writeFile(path.join(root, "docs", "spec.pdf"), tinyPdf("Hello Synorch PDF"));
  const harness = harnessFor(root, "reviewer");

  const image = await harness.call("read_file", { path: "docs/shot.png" });
  assert.equal(image.state, "succeeded", image.result.error?.message);
  assert.equal(image.result.blob?.media_type, "image/png");
  assert.equal(image.result.blob?.size_bytes, PNG_1PX.length);
  assert.match(image.result.text, /image image\/png/);
  const fake = await harness.call("read_file", { path: "docs/fake.png" });
  assert.equal(fake.result.error?.code, "invalid_arguments");

  const pdf = await harness.call("read_file", { path: "docs/spec.pdf" });
  assert.equal(pdf.state, "succeeded", pdf.result.error?.message);
  assert.match(pdf.result.text, /PDF · 1 page · page 1/);
  assert.match(pdf.result.text, /--- page 1 ---\nHello Synorch PDF/);
  const past = await harness.call("read_file", { path: "docs/spec.pdf", pages: "4-5" });
  assert.equal(past.result.error?.code, "invalid_arguments");

  assert.deepEqual(parsePages("1,3-4", 10), [1, 3, 4]);
  assert.deepEqual(parsePages("8-", 10), [8, 9, 10]);
  assert.equal(typeof parsePages("x", 10), "string");
});
