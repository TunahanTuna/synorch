import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  createId,
  digestText,
  HarnessError,
  memoryIdSchema,
  memoryNoteFrontmatterSchema,
  memoryProposalSchema,
  projectIdSchema,
  type MemoryNoteFrontmatter,
  type MemoryProposal,
  type MemoryQuery,
} from "../src/harness/contracts/index.ts";
import {
  candidateToProposal,
  createMemoryStore,
  MAX_NOTE_BODY_CHARS,
  MemoryConflictError,
  REDACTED,
  redactSecrets,
  resolveMemoryRoot,
  type NoteInput,
} from "../src/harness/memory/index.ts";

const PROJECT = projectIdSchema.parse("synorch-1a2b3c4d");
const NOW = new Date("2026-09-22T12:00:00Z");
const RUN = createId("run", NOW.getTime());

async function sandbox(): Promise<{ root: string; workspace: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(path.join(tmpdir(), "syn-memory-"));
  const root = path.join(base, "home", ".synorch", "memory", PROJECT);
  const workspace = path.join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, workspace, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function frontmatter(overrides: Partial<Record<keyof MemoryNoteFrontmatter, unknown>>): MemoryNoteFrontmatter {
  return memoryNoteFrontmatterSchema.parse({
    schema_version: 1,
    project_id: PROJECT,
    scope: "project",
    created_at: "2026-09-22",
    confidence: "medium",
    owner: "synorch",
    relations: [],
    ...overrides,
  });
}

function concept(id: string, title: string, body: string, overrides: Partial<Record<keyof MemoryNoteFrontmatter, unknown>> = {}): NoteInput {
  return { frontmatter: frontmatter({ id, kind: "concept", status: "active", ...overrides }), title, body };
}

function query(overrides: Partial<MemoryQuery> = {}): MemoryQuery {
  return { projectId: PROJECT, branch: undefined, text: undefined, kinds: undefined, includeInactive: false, limit: 20, ...overrides };
}

function proposal(overrides: Partial<Record<keyof MemoryProposal, unknown>>): MemoryProposal {
  return memoryProposalSchema.parse({
    schema_version: 1,
    proposal_id: createId("proposal"),
    rationale: "Recorded during the run.",
    evidence: [{ kind: "file", ref: "docs/harness/decisions/ADR-16-memory-location.md", produced_by: "orchestrator" }],
    created_by: { run_id: RUN },
    created_at: NOW.toISOString(),
    state: "pending",
    ...overrides,
  });
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<HarnessError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof HarnessError, `expected HarnessError, got ${String(error)}`);
    assert.equal(error.info.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("ADR-16 resolveMemoryRoot defaults under the injected home and honours memory.root", () => {
  const home = path.resolve("/users/tuna");
  assert.equal(resolveMemoryRoot(undefined, PROJECT, home), path.join(home, ".synorch", "memory", PROJECT));
  assert.equal(resolveMemoryRoot({ root: "" }, PROJECT, home), path.join(home, ".synorch", "memory", PROJECT));
  assert.equal(resolveMemoryRoot({ root: "~/vaults/synorch" }, PROJECT, home), path.join(home, "vaults", "synorch"));
  const absolute = path.resolve("/data/vault");
  assert.equal(resolveMemoryRoot({ root: absolute }, PROJECT, home), absolute);
});

test("AC-1 persist, search and get work on a plain folder with no Obsidian installation or config", async () => {
  const { root, workspace, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root, { workspaceRoot: workspace });
    const written = await store.persist(concept("cpt-memory-architecture", "Hafıza mimarisi", "Notes are plain Markdown; Obsidian is optional."), undefined);
    assert.equal(written.path, "concepts/cpt-memory-architecture.md");
    const raw = await readFile(path.join(root, "concepts", "cpt-memory-architecture.md"), "utf8");
    assert.match(raw, /^---\nschema_version: 1\nid: cpt-memory-architecture\n/);
    assert.match(raw, /\n# Hafıza mimarisi\n/);
    assert.equal(written.digest, digestText(raw));

    const found = await store.search(query({ text: "obsidian optional" }));
    assert.equal(found.length, 1);
    assert.equal(found[0]?.note.frontmatter.id, "cpt-memory-architecture");
    assert.equal(found[0]?.stale, false);
    assert.match(found[0]?.reason ?? "", /matched "obsidian optional" in body/);

    const shown = await store.get(memoryIdSchema.parse("cpt-memory-architecture"));
    assert.equal(shown?.title, "Hafıza mimarisi");
    assert.ok((await readdir(root)).includes("README.md"));
    assert.ok(!(await readdir(root)).includes(".obsidian"), "Synorch never creates Obsidian state");
    const views = await readdir(path.join(root, "views"));
    assert.deepEqual(views.sort(), ["decisions.base", "review-queue.base"]);
    assert.ok(parseYaml(await readFile(path.join(root, "views", "decisions.base"), "utf8")).views.length > 0);
  } finally {
    await cleanup();
  }
});

test("AC-2 an external edit makes the next write conflict and the user's text survives", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const first = await store.persist(concept("cpt-sandbox", "Sandbox", "Initial body."), undefined);
    const file = path.join(root, first.path);
    const edited = `${await readFile(file, "utf8")}\nUser note written in Obsidian.\n`;
    await writeFile(file, edited, "utf8");

    const conflict = await rejectsWith(store.persist(concept("cpt-sandbox", "Sandbox", "Synorch rewrite."), first.digest), "store_write_failed");
    assert.ok(conflict instanceof MemoryConflictError);
    assert.equal(conflict.details.expected, first.digest);
    assert.equal(conflict.details.actual, digestText(edited));
    assert.equal(conflict.info.workspace_effect, "none");
    assert.equal(await readFile(file, "utf8"), edited, "the user's edit is not overwritten");

    const reread = await store.get(memoryIdSchema.parse("cpt-sandbox"));
    assert.match(reread?.body ?? "", /User note written in Obsidian/);
    const updated = await store.persist(concept("cpt-sandbox", "Sandbox", `${reread?.body ?? ""}\nMerged.`), reread?.digest);
    assert.match(await readFile(file, "utf8"), /User note written in Obsidian\.\nMerged\./);
    assert.equal(updated.path, first.path);
  } finally {
    await cleanup();
  }
});

test("AC-2 negative: creating a note over an existing file without its digest conflicts", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    await store.persist(concept("cpt-twice", "Twice", "one"), undefined);
    await rejectsWith(store.persist(concept("cpt-twice", "Twice", "two"), undefined), "store_write_failed");
    const deleted = await store.get(memoryIdSchema.parse("cpt-twice"));
    await rm(path.join(root, deleted?.path ?? ""));
    await rejectsWith(store.persist(concept("cpt-twice", "Twice", "three"), deleted?.digest), "store_write_failed");
  } finally {
    await cleanup();
  }
});

test("AC-2 a note moved by the user is still found and updated by id", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const first = await store.persist(concept("cpt-moved", "Moved", "body"), undefined);
    await mkdir(path.join(root, "concepts", "archive"), { recursive: true });
    const moved = path.join(root, "concepts", "archive", "renamed.md");
    await writeFile(moved, await readFile(path.join(root, first.path), "utf8"), "utf8");
    await rm(path.join(root, first.path));
    const note = await store.get(memoryIdSchema.parse("cpt-moved"));
    assert.equal(note?.path, "concepts/archive/renamed.md");
    await store.persist(concept("cpt-moved", "Moved", "updated"), note?.digest);
    assert.match(await readFile(moved, "utf8"), /updated/);
  } finally {
    await cleanup();
  }
});

test("AC-3 decision and preference notes cannot be persisted directly", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const decision: NoteInput = {
      frontmatter: frontmatter({ id: "dec-0042", kind: "decision", status: "proposed" }),
      title: "Memory lives under ~/.synorch",
      body: "",
    };
    const preference: NoteInput = {
      frontmatter: frontmatter({ id: "prf-terse-output", kind: "preference", status: "active", owner: "human", scope: "user" }),
      title: "Terse output",
      body: "",
    };
    await rejectsWith(store.persist(decision, undefined), "policy_denied");
    await rejectsWith(store.persist(preference, undefined), "policy_denied");
    assert.equal(await store.get(memoryIdSchema.parse("dec-0042")), undefined);
    assert.deepEqual(await readdir(path.dirname(root)).catch(() => []), []);
  } finally {
    await cleanup();
  }
});

test("AC-3 accepting a queued decision writes it with reviewed_at; the queue records who decided", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const queued = proposal({
      kind: "note",
      note: frontmatter({ id: "dec-0042", kind: "decision", status: "proposed", confidence: "high" }),
      body: "# Memory lives under ~/.synorch\n\n## Karar\nKişisel hafıza kullanıcı alanında tutulur.",
    });
    await store.propose(queued);
    assert.equal((await store.pending()).length, 1);
    assert.equal(await store.get(memoryIdSchema.parse("dec-0042")), undefined, "a proposal is not yet memory");

    const outcome = await store.decideWithAudit(queued.proposal_id, { by: "user", at: "2026-09-23T08:00:00Z", reason: "matches ADR-16" }, "accepted");
    const note = await store.get(memoryIdSchema.parse("dec-0042"));
    assert.equal(note?.frontmatter.status, "accepted");
    assert.equal(note?.frontmatter.reviewed_at, "2026-09-23");
    assert.equal(note?.frontmatter.source_run, RUN);
    assert.equal(note?.title, "Memory lives under ~/.synorch");
    assert.equal(note?.path, "decisions/dec-0042.md");
    assert.deepEqual(outcome.decided, { proposal_id: queued.proposal_id, state: "accepted", decided_by: "user", reason: "matches ADR-16" });
    assert.equal(outcome.persisted?.memory_id, "dec-0042");
    assert.equal(outcome.runId, undefined);
    assert.equal((await store.pending()).length, 0);
    const recorded = parseYaml(await readFile(path.join(root, "queue", `${queued.proposal_id}.yaml`), "utf8"));
    assert.equal(recorded.state, "accepted");
    assert.equal(recorded.decision.by, "user");
    await rejectsWith(store.decide(queued.proposal_id, { by: "user", at: "2026-09-23T08:00:00Z", reason: "again" }, "rejected"), "usage_invalid");
  } finally {
    await cleanup();
  }
});

test("AC-3 an orchestrator decision must carry run_id and is recorded with it", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    await store.persist(concept("cpt-memory-architecture", "Memory architecture", "Plain files."), undefined);
    await store.persist({ frontmatter: frontmatter({ id: "asm-memory-in-repo", kind: "assumption", status: "open" }), title: "Memory in repo", body: "" }, undefined);
    const change = proposal({ kind: "status-change", target: "asm-memory-in-repo", new_status: "invalidated" });
    await store.propose(change);

    await rejectsWith(store.decide(change.proposal_id, { by: "orchestrator", at: "2026-09-22T12:01:00Z", reason: "autonomous" }, "accepted"), "usage_invalid");
    const untouched = await store.get(memoryIdSchema.parse("asm-memory-in-repo"));
    assert.equal(untouched?.frontmatter.status, "open", "a rejected decision attempt changes nothing");

    const outcome = await store.decideWithAudit(
      change.proposal_id,
      { by: "orchestrator", at: "2026-09-22T12:01:00Z", reason: "autonomous mode; evidence is an accepted ADR", run_id: RUN },
      "accepted",
    );
    assert.equal(outcome.runId, RUN);
    assert.equal(outcome.decided.decided_by, "orchestrator");
    const recorded = parseYaml(await readFile(path.join(root, "queue", `${change.proposal_id}.yaml`), "utf8"));
    assert.equal(recorded.decision.run_id, RUN);
    const changed = await store.get(memoryIdSchema.parse("asm-memory-in-repo"));
    assert.equal(changed?.frontmatter.status, "invalidated");
    assert.equal(changed?.frontmatter.reviewed_at, "2026-09-22");
  } finally {
    await cleanup();
  }
});

test("AC-3 rejecting a false contradiction leaves both notes unchanged", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const left = await store.persist(concept("cpt-alpha", "Alpha", "a"), undefined);
    const right = await store.persist(concept("cpt-beta", "Beta", "b"), undefined);
    const contradiction = proposal({ kind: "contradiction", target: "cpt-alpha", relation: { type: "contradicts", target: "cpt-beta" } });
    await store.propose(contradiction);
    const outcome = await store.decideWithAudit(contradiction.proposal_id, { by: "user", at: "2026-09-22T12:05:00Z", reason: "not a conflict" }, "rejected");
    assert.equal(outcome.persisted, undefined);
    assert.equal((await store.get(memoryIdSchema.parse("cpt-alpha")))?.digest, left.digest);
    assert.equal((await store.get(memoryIdSchema.parse("cpt-beta")))?.digest, right.digest);

    const relation = proposal({ kind: "relation", target: "cpt-alpha", relation: { type: "supports", target: "cpt-beta" } });
    await store.propose(relation);
    await store.decide(relation.proposal_id, { by: "user", at: "2026-09-22T12:06:00Z", reason: "yes" }, "deferred");
    assert.equal((await store.pending())[0]?.state, "deferred");
    await store.decide(relation.proposal_id, { by: "user", at: "2026-09-22T12:07:00Z", reason: "yes" }, "accepted");
    assert.deepEqual((await store.get(memoryIdSchema.parse("cpt-alpha")))?.frontmatter.relations, [{ type: "supports", target: "cpt-beta" }]);
  } finally {
    await cleanup();
  }
});

test("AC-4 the index is rebuilt from notes after deletion and broken links are reported", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    await store.persist(concept("cpt-target", "Target", "The target note."), undefined);
    await store.persist(
      concept("cpt-linker", "Linker", "See [target](cpt-target.md), [gone](../questions/que-missing.md) and [site](https://obsidian.md).", {
        relations: [{ type: "depends_on", target: "cpt-nowhere" }],
      }),
      undefined,
    );
    assert.equal((await store.search(query({ text: "target" }))).length, 2);
    await rm(path.join(root, ".index"), { recursive: true, force: true });

    const result = await store.reindex();
    assert.deepEqual(result, { notes: 2, broken_links: 2 });
    const index = await store.rebuildIndex();
    assert.deepEqual(
      index.broken_links.map((link) => [link.kind, link.target]).sort(),
      [
        ["link", "questions/que-missing.md"],
        ["relation", "cpt-nowhere"],
      ],
    );
    assert.ok((await stat(path.join(root, ".index", "index.json"))).isFile());

    await rm(path.join(root, ".index"), { recursive: true, force: true });
    const found = await store.search(query({ text: "target note" }));
    assert.equal(found[0]?.note.frontmatter.id, "cpt-target", "search rebuilds a missing index on demand");
  } finally {
    await cleanup();
  }
});

test("AC-4 a stale index is refreshed when a user edits a note outside Synorch", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const note = await store.persist(concept("cpt-editable", "Editable", "original words"), undefined);
    assert.equal((await store.search(query({ text: "zeppelin" }))).length, 0);
    await writeFile(path.join(root, note.path), (await readFile(path.join(root, note.path), "utf8")).replace("original words", "zeppelin words, longer"), "utf8");
    assert.equal((await store.search(query({ text: "zeppelin" }))).length, 1);
  } finally {
    await cleanup();
  }
});

test("AC-5 secrets are redacted before a note or proposal reaches disk", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const secrets = [
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "ghp_0123456789abcdefghijABCDEFGHIJklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "hunter2-very-secret",
    ];
    const note = await store.persist(
      concept("cpt-auth-setup", "Auth setup", `Use key ${secrets[0]} and token ${secrets[1]}.\naws ${secrets[2]}\npassword=${secrets[3]}`),
      undefined,
    );
    const raw = await readFile(path.join(root, note.path), "utf8");
    for (const secret of secrets) assert.ok(!raw.includes(secret), `leaked ${secret.slice(0, 6)}`);
    assert.ok(raw.includes(REDACTED));
    assert.equal(note.digest, digestText(raw));

    const queued = proposal({
      kind: "note",
      note: frontmatter({ id: "dec-auth", kind: "decision", status: "proposed" }),
      body: `# Auth\n\nAuthorization: Bearer ${secrets[1]}`,
      rationale: `seen api_key: ${secrets[3]}`,
    });
    await store.propose(queued);
    const file = await readFile(path.join(root, "queue", `${queued.proposal_id}.yaml`), "utf8");
    for (const secret of secrets) assert.ok(!file.includes(secret));
    assert.deepEqual(redactSecrets("nothing to hide here").rules, []);
  } finally {
    await cleanup();
  }
});

test("AC-5 raw tool output is refused, not stored", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const ansi = "\u001b[31mFAIL\u001b[0m src/auth.test.ts\nexport OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    await rejectsWith(store.persist(concept("cpt-tool-dump", "Tool dump", ansi), undefined), "usage_invalid");
    await rejectsWith(store.persist(concept("cpt-huge-dump", "Huge", "x".repeat(MAX_NOTE_BODY_CHARS + 1)), undefined), "usage_invalid");
    assert.equal(await store.get(memoryIdSchema.parse("cpt-tool-dump")), undefined);
    assert.equal(await store.get(memoryIdSchema.parse("cpt-huge-dump")), undefined);
    const concepts = await readdir(path.join(root, "concepts")).catch(() => [] as string[]);
    assert.deepEqual(concepts, []);
  } finally {
    await cleanup();
  }
});

test("AC-6 a note scoped to another branch is not returned as current knowledge", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    await store.persist(concept("cpt-harness-layout", "Harness layout", "runtime modules live under src/harness", { scope: "branch", branch: "harness" }), undefined);
    await store.persist(concept("cpt-general-layout", "General layout", "runtime modules are documented"), undefined);

    const onMain = await store.search(query({ branch: "main", text: "runtime modules" }));
    assert.deepEqual(onMain.map((result) => result.note.frontmatter.id), ["cpt-general-layout"]);
    const detached = await store.search(query({ branch: undefined, text: "runtime modules" }));
    assert.deepEqual(detached.map((result) => result.note.frontmatter.id), ["cpt-general-layout"]);

    const history = await store.search(query({ branch: "main", text: "runtime modules", includeInactive: true }));
    const offBranch = history.find((result) => result.note.frontmatter.id === "cpt-harness-layout");
    assert.equal(offBranch?.stale, true);
    assert.match(offBranch?.reason ?? "", /scoped to branch harness, not main; not current here/);
    assert.equal(history.at(-1)?.note.frontmatter.id, "cpt-harness-layout", "off-branch notes rank after current ones");

    const onHarness = await store.search(query({ branch: "harness", text: "runtime modules" }));
    assert.equal(onHarness.find((result) => result.note.frontmatter.id === "cpt-harness-layout")?.stale, false);
  } finally {
    await cleanup();
  }
});

test("stale detection: a changed or missing source_digest source marks the note stale", async () => {
  const { root, workspace, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root, { workspaceRoot: workspace });
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    const source = path.join(workspace, "docs", "adr.md");
    await writeFile(source, "memory lives in the user home\r\n", "utf8");
    await store.persist(
      {
        frontmatter: frontmatter({
          id: "evd-adr-16",
          kind: "evidence",
          status: "current",
          source_ref: "docs/adr.md",
          source_digest: digestText("memory lives in the user home\n"),
        }),
        title: "ADR-16 evidence",
        body: "The ADR says memory lives in the user home.",
      },
      undefined,
    );
    const fresh = await store.search(query({ text: "adr" }));
    assert.equal(fresh[0]?.stale, false);
    await writeFile(source, "memory lives in the repository\n", "utf8");
    const changed = await store.search(query({ text: "adr" }));
    assert.equal(changed[0]?.stale, true);
    assert.match(changed[0]?.reason ?? "", /source docs\/adr\.md changed/);
    assert.deepEqual((await store.status()).stale, ["evd-adr-16"]);
    await rm(source);
    assert.match((await store.search(query({ text: "adr" })))[0]?.reason ?? "", /is missing/);
  } finally {
    await cleanup();
  }
});

test("superseded decisions and inactive notes are excluded unless history is requested", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    await store.persist({ frontmatter: frontmatter({ id: "que-old", kind: "question", status: "resolved" }), title: "Old routing question", body: "" }, undefined);
    assert.equal((await store.search(query({ text: "routing" }))).length, 0);
    const history = await store.search(query({ text: "routing", includeInactive: true }));
    assert.equal(history[0]?.stale, true);
    assert.match(history[0]?.reason ?? "", /historical only/);
  } finally {
    await cleanup();
  }
});

test("rule-based candidates: shared source and id mentions become reviewable proposals, never facts", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    for (const id of ["dec-store-sqlite", "dec-store-jsonl"]) {
      const queued = proposal({
        kind: "note",
        note: frontmatter({ id, kind: "decision", status: "proposed", source_ref: "docs/harness/decisions/ADR-03-session-store.md" }),
        body: `# ${id}`,
      });
      await store.propose(queued);
      await store.decide(queued.proposal_id, { by: "user", at: "2026-09-22T12:00:00Z", reason: "ok" }, "accepted");
    }
    await store.persist(concept("cpt-session-log", "Session log", "Implements dec-store-jsonl."), undefined);

    const candidates = await store.candidates();
    const contradiction = candidates.find((candidate) => candidate.kind === "contradiction");
    assert.equal(contradiction?.rule, "same-source");
    assert.deepEqual([contradiction?.source, contradiction?.target].sort(), ["dec-store-jsonl", "dec-store-sqlite"]);
    const mention = candidates.find((candidate) => candidate.rule === "mentions-id");
    assert.deepEqual([mention?.source, mention?.relation.target], ["cpt-session-log", "dec-store-jsonl"]);

    const before = (await store.get(memoryIdSchema.parse("dec-store-jsonl")))?.digest;
    const queued = candidateToProposal(contradiction!, { run_id: RUN }, NOW);
    assert.equal(memoryProposalSchema.safeParse(queued).success, true);
    await store.propose(queued);
    assert.equal((await store.get(memoryIdSchema.parse("dec-store-jsonl")))?.digest, before, "proposing a candidate changes no note");

    const view = await store.related(memoryIdSchema.parse("dec-store-jsonl"));
    assert.ok(view?.candidates.some((candidate) => candidate.rule === "mentions-id"));
  } finally {
    await cleanup();
  }
});

test("invalid proposals and notes are refused with usage errors", async () => {
  const { root, cleanup } = await sandbox();
  try {
    const store = createMemoryStore(root);
    const bad = { ...proposal({ kind: "status-change", target: "asm-x-y-z", new_status: "invalidated" }), evidence: [] } as unknown as MemoryProposal;
    await rejectsWith(store.propose(bad), "usage_invalid");
    const good = proposal({ kind: "status-change", target: "asm-missing", new_status: "invalidated" });
    await store.propose(good);
    await rejectsWith(store.propose(good), "usage_invalid");
    await rejectsWith(store.decide(good.proposal_id, { by: "user", at: "2026-09-22T12:00:00Z", reason: "ok" }, "accepted"), "usage_invalid");
    assert.equal((await store.pending()).length, 1, "a failed apply leaves the proposal pending");
    await rejectsWith(store.persist(concept("cpt-multi", "two\nlines", "b"), undefined), "usage_invalid");
  } finally {
    await cleanup();
  }
});
