import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  authStatusSchema,
  createId,
  deriveProjectId,
  memoryNoteFrontmatterSchema,
  memoryProposalSchema,
} from "../src/harness/contracts/index.ts";
import { MEMORY_AUDIT_TITLE, runHarnessCommand } from "../src/harness/cli/index.ts";
import { createMemoryStore } from "../src/harness/memory/index.ts";
import { createSessionStore } from "../src/harness/store/index.ts";
import { capture, createSandbox, eventsOf, overridesFor, readSession, ScriptedInput } from "./fixtures/cli/runtime/support.ts";

/**
 * `syn login/logout/auth status` (I2 authCommand) and `syn memory ...` (I6 memoryCommand) wired by
 * the composition root: the interactive renderer supplies `AuthInteraction` (including the one-time
 * `claude-bridge-experimental` notice), headless login exits 7, and memory decisions are appended
 * to the project's audit session.
 */

const INSTALLED = { claudeProbe: async () => ({ installed: true, version: "9.9.9" }) };

test("auth status lists identities without secrets and ignores the CLI's common flags", async () => {
  const sandbox = await createSandbox({ "README.md": "# auth\n" });
  try {
    const status = capture({ cwd: sandbox.workspace, env: { ANTHROPIC_API_KEY: "sk-ant-test-secret-value-000000" } });
    const code = await runHarnessCommand(["auth", "status", "--json", "--plain", "--target", "."], status.io, overridesFor(sandbox, { authOptions: INSTALLED }));
    assert.equal(code, 0, status.stderr());
    const statuses = (JSON.parse(status.stdout()) as unknown[]).map((entry) => authStatusSchema.parse(entry));
    assert.deepEqual(
      statuses.map((entry) => `${entry.provider_id}/${entry.method}:${entry.state}`),
      ["openai/oauth-subscription:disconnected", "openai/api-key:disconnected", "anthropic/api-key:connected", "anthropic/cli-bridge:login_required"],
    );
    assert.doesNotMatch(status.stdout(), /sk-ant-test-secret/);
  } finally {
    await sandbox.cleanup();
  }
});

test("login shows the claude-bridge-experimental notice once and headless login exits 7", async () => {
  const sandbox = await createSandbox({ "README.md": "# auth\n" });
  try {
    const overrides = overridesFor(sandbox, { authOptions: INSTALLED });
    const first = capture({ cwd: sandbox.workspace, stdinIsTTY: true, stdin: new ScriptedInput("y\n", true) });
    assert.equal(await runHarnessCommand(["login", "anthropic", "--method", "cli-bridge"], first.io, overrides), 0, first.stderr());
    const shown = first.stdout() + first.stderr();
    assert.match(shown, /notice: .*experimental/i);
    assert.match(shown, /Continue\? \[y\/N\]/);
    assert.match(first.stdout(), /Signed in: anthropic\/cli-bridge/);

    const second = capture({ cwd: sandbox.workspace, stdinIsTTY: true, stdin: new ScriptedInput("", true) });
    assert.equal(await runHarnessCommand(["login", "anthropic", "--method", "cli-bridge"], second.io, overrides), 0, second.stderr());
    assert.doesNotMatch(second.stdout() + second.stderr(), /Continue\? \[y\/N\]/, "the notice needs acknowledgement only once");

    const status = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["auth", "status", "--json"], status.io, overrides), 0);
    const bridge = (JSON.parse(status.stdout()) as { method: string; state: string }[]).find((entry) => entry.method === "cli-bridge");
    assert.equal(bridge?.state, "unknown", "opted in; Claude's own sign-in is checked on first use");

    const headless = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["login", "openai"], headless.io, overrides), 7);
    assert.match(headless.stderr(), /needs an interactive terminal/);

    const logout = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["logout", "anthropic", "--profile", "default"], logout.io, overrides), 0, logout.stderr());
    assert.match(logout.stdout(), /Signed out: anthropic\/cli-bridge/);
  } finally {
    await sandbox.cleanup();
  }
});

test("syn memory accept applies the decision and appends its audit events", async () => {
  const sandbox = await createSandbox({ "README.md": "# memory\n" });
  try {
    const projectId = deriveProjectId(sandbox.workspace, process.platform);
    const store = createMemoryStore(path.join(sandbox.home, "memory", projectId), { workspaceRoot: sandbox.workspace });
    const proposal = memoryProposalSchema.parse({
      schema_version: 1,
      proposal_id: createId("proposal"),
      kind: "note",
      note: memoryNoteFrontmatterSchema.parse({
        schema_version: 1,
        id: "dec-0001",
        kind: "decision",
        status: "proposed",
        project_id: projectId,
        scope: "project",
        created_at: "2026-09-23",
        confidence: "medium",
        owner: "synorch",
        relations: [],
      }),
      body: "# Runs are resumable",
      rationale: "Recovery closes open items without re-running tools.",
      evidence: [{ kind: "file", ref: "README.md", produced_by: "orchestrator" }],
      created_by: { run_id: createId("run") },
      created_at: new Date().toISOString(),
      state: "pending",
    });
    await store.propose(proposal);

    const review = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["memory", "review"], review.io, overridesFor(sandbox)), 0, review.stderr());
    assert.match(review.stdout(), new RegExp(proposal.proposal_id));

    const accept = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["memory", "accept", proposal.proposal_id, "--reason", "agreed"], accept.io, overridesFor(sandbox)), 0, accept.stderr());
    assert.match(accept.stdout(), /accepted prop_\w+; wrote dec-0001/);

    const audit = (await createSessionStore(sandbox.home).list(projectId)).find((summary) => summary.manifest.title === MEMORY_AUDIT_TITLE);
    assert.ok(audit !== undefined, "an audit session exists for the project");
    const events = await readSession(sandbox.home, audit.manifest.session_id);
    const decided = eventsOf(events, "memory/proposal_decided");
    assert.deepEqual(decided.map((event) => [event.data.proposal_id, event.data.state, event.data.decided_by, event.actor.kind]), [[proposal.proposal_id, "accepted", "user", "user"]]);
    assert.equal(eventsOf(events, "memory/persisted")[0]?.data.memory_id, "dec-0001");
  } finally {
    await sandbox.cleanup();
  }
});
