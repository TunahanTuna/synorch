import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import { buildMemoryGraph, buildProposal } from "../src/harness/memory/index.ts";
import type { IndexedNote } from "../src/harness/memory/memory-index.ts";
import { renderMemoryGraph, viewContext } from "../src/harness/tui/views/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { call, capture, createSandbox, eventsOf, overridesFor, readSession, ScriptedInput, text } from "./fixtures/cli/runtime/support.ts";

/**
 * K2 trust and transparency: the agent proposes a decision, the user accepts it at the decision
 * desk, the ledger shows it, the next request recalls it (and /context says why), /why and
 * /evidence explain from the log, and the memory graph draws the vault.
 */

test("decision desk: propose -> nudge -> accept -> ledger -> recalled with a reason; /why, /evidence, /memory graph", async () => {
  const sandbox = await createSandbox({ "README.md": "# demo\n" });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), "routes:\n  - { tier: session, provider: scripted, model: chat, adapter: chat-script }\n");
    const model = createScriptedAdapter(
      [
        call("memory_propose", () => ({
          kind: "note",
          rationale: "The user decided the package manager for this repository.",
          content: { kind: "decision", title: "Use pnpm workspaces", body: "All packages live in one pnpm workspace." },
        })),
        text("Noted: I proposed it for your memory."),
        text("We decided to use pnpm workspaces."),
      ],
      { adapterId: "chat-script" },
    );
    const input = ["we will use pnpm workspaces", "/memory review", "1", "/memory", "what did we decide?", "/context", "/why", "/why model", "/evidence", "/memory graph", "/exit", ""].join("\n");
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, true), stdinIsTTY: true });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [model] }));
    const stdout = io.stdout();
    assert.equal(code, 0, io.stderr());

    assert.match(stdout, /\* 1 memory proposal - \/memory review/, "the nudge after the turn");
    assert.match(stdout, /Memory proposal 1\/1 - decision/, "the desk card");
    assert.match(stdout, /Use pnpm workspaces/);
    assert.match(stdout, /Remembered dec-use-pnpm-workspaces-/, "accepted and written");
    assert.match(stdout, /Memory ledger - 1 decision/, "the ledger");

    const memoryRoot = (await readdir(path.join(sandbox.home, "memory")))[0] ?? "";
    const decisions = await readdir(path.join(sandbox.home, "memory", memoryRoot, "decisions"));
    assert.equal(decisions.length, 1);
    const note = await readFile(path.join(sandbox.home, "memory", memoryRoot, "decisions", decisions[0] ?? ""), "utf8");
    assert.match(note, /status: accepted/);
    assert.match(note, /reviewed_at: /);

    const last = model.requests.at(-1);
    const recalled = last?.system.find((block) => block.source === "memory");
    assert.ok(recalled !== undefined, "the accepted decision is recalled into the next request");
    assert.match(recalled.text, /Why recalled: /);

    assert.match(stdout, /Why this context\? - scripted\/chat/, "/context card");
    assert.match(stdout, /Memory recalled/);
    assert.match(stdout, /Synorch harness rules \(session\)/);
    assert.match(stdout, /Why was this allowed\? memory_propose/, "/why explains the last decision");
    assert.match(stdout, /Mode +/);
    assert.match(stdout, /Why this model\? scripted\/chat/, "/why model");
    assert.match(stdout, /Evidence - this conversation/, "/evidence when no turn changed or checked anything");
    assert.match(stdout, /Memory graph - 1 note/, "/memory graph");

    const sessionId = /--resume (ses_\S+)\)/.exec(io.stderr())?.[1] ?? "";
    const log = await readSession(sandbox.home, sessionId);
    assert.equal(eventsOf(log, "memory/proposal_decided")[0]?.data.state, "accepted", "the decision is audited in the conversation log");
    assert.equal(eventsOf(log, "memory/persisted").length, 1);
  } finally {
    await sandbox.cleanup();
  }
});

test("/evidence of a direct edit: changed file with its diff stat, tests marked not run, not independently reviewed", async () => {
  const broken = "export function add(a, b) {\n  return a - b;\n}\n";
  const patch = "*** Begin Patch\n*** Update File: src-add.mjs\n@@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch";
  const sandbox = await createSandbox({ "src-add.mjs": broken });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), "routes:\n  - { tier: session, provider: scripted, model: chat, adapter: chat-script }\n");
    const model = createScriptedAdapter([call("read_file", () => ({ path: "src-add.mjs" })), call("apply_patch", () => ({ patch })), text("Fixed.")], { adapterId: "chat-script" });
    const input = ["fix add", "/evidence", "/why 2", "/exit", ""].join("\n");
    const io = capture({ cwd: sandbox.workspace, stdin: new ScriptedInput(input, true), stdinIsTTY: true });
    const code = await runHarnessCommand(["agent", "--plain"], io.io, overridesFor(sandbox, { adapters: [model] }));
    const stdout = io.stdout();
    assert.equal(code, 0, io.stderr());
    assert.match(stdout, /Evidence - turn "fix add"/);
    assert.match(stdout, /not independently reviewed/);
    assert.match(stdout, /tests +not run/);
    assert.match(stdout, /changed src-add\.mjs/);
    assert.match(stdout, /Diff +1 file \+1 -1/);
    assert.match(stdout, /Why was this allowed\? read_file src-add\.mjs/, "/why 2 explains the second most recent decision");
  } finally {
    await sandbox.cleanup();
  }
});

test("buildProposal fills a decision note from { kind, title, body } for a conversation turn", () => {
  const built = buildProposal(
    { kind: "note", rationale: "user said so", content: { kind: "preference", title: "Reply in Turkish", body: "The owner prefers Turkish replies." } },
    { projectId: "demo-0123abcd", branch: "main", runId: undefined, taskId: undefined, role: "session", toolCallId: "tc_1", now: new Date("2026-09-24T10:00:00Z") },
  );
  assert.ok(built.ok, built.ok ? "" : built.message);
  assert.equal(built.proposal.note?.kind, "preference");
  assert.equal(built.proposal.note?.owner, "human");
  assert.equal(built.proposal.created_by.role, "session");
  assert.match(built.proposal.note?.id ?? "", /^prf-reply-in-turkish-[0-9a-f]{4}$/);
});

function indexed(id: string, kind: IndexedNote["kind"], status: string, relations: IndexedNote["relations"] = []): IndexedNote {
  return { path: `${kind}s/${id}.md`, size: 1, mtimeMs: 1, digest: "d", id, kind, status, scope: "project", project_id: "p", title: id, tags: [], relations, links: [], mentions: [], title_terms: [], terms: {} };
}

test("memory graph: relations become edges, contradictions are flagged, --around keeps the neighbourhood", () => {
  const notes = [
    indexed("dec-a-0001", "decision", "accepted", [{ type: "supports", target: "asm-b-0002" }]),
    indexed("asm-b-0002", "assumption", "open"),
    indexed("dec-c-0003", "decision", "accepted", [{ type: "contradicts", target: "dec-a-0001" }]),
    indexed("cpt-d-0004", "concept", "active"),
  ];
  const view = buildMemoryGraph(notes, { projectId: "p", branch: undefined });
  assert.equal(view.nodes.length, 4);
  assert.equal(view.edges.length, 2);
  assert.ok(view.nodes.find((node) => node.id === "dec-c-0003")?.contradicted);
  const around = buildMemoryGraph(notes, { projectId: "p", branch: undefined, around: "asm-b-0002", depth: 1 });
  assert.deepEqual(around.nodes.map((node) => node.id).sort(), ["asm-b-0002", "dec-a-0001"]);
  const lines = renderMemoryGraph(view, viewContext({ glyphs: "ascii", color: false, width: 80 }));
  assert.match(lines.join("\n"), /Memory graph - 4 notes - 2 links/);
  assert.match(lines.join("\n"), /dec-c-0003 contradicts dec-a-0001/);
  assert.ok(lines.every((line) => line.length <= 80), "fits 80 columns");
});
