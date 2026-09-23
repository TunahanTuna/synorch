import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createId, deriveProjectId, HarnessError, sha256, taskContextPacketSchema, type TaskContextPacket } from "../src/harness/contracts/index.ts";
import { createIsolationProvider, decodeArtifact, runGit } from "../src/harness/orchestration/index.ts";
import { workspaceDirectoryName } from "../src/harness/orchestration/isolation.ts";
import { createMemoryBlobStore, createTempWorkspace } from "../src/harness/orchestration/testing.ts";

function packet(owned: string[], overrides: Partial<TaskContextPacket> = {}): TaskContextPacket {
  return taskContextPacketSchema.parse({
    schema_version: 2,
    kind: "full",
    task_id: createId("task"),
    run_id: createId("run"),
    plan_id: createId("plan"),
    plan_version: 1,
    plan_digest: sha256("plan"),
    role: owned.length > 0 ? "implementer" : "explorer",
    model_tier: "complex_worker",
    risk: "standard",
    write_mode: owned.length > 0 ? "owned-paths" : "read-only",
    isolation: owned.length > 0 ? "worktree" : "shared-read-only",
    objective: "o",
    why: { user_goal: "g" },
    scope: { owned_paths: owned, read_paths: [], forbidden_paths: [] },
    known_facts: [],
    decisions: [],
    relevant_symbols: [],
    acceptance_criteria: [{ id: "AC-1", statement: "s" }],
    verification: { commands: [] },
    non_goals: [],
    open_questions: [],
    stop_conditions: [],
    limits: { max_steps: 5, max_wall_time_seconds: 60 },
    context: { created_at: "2026-09-22T10:00:00Z", sources: [] },
    expected_report: ["summary"],
    ...overrides,
  });
}

const signal = () => new AbortController().signal;

test("worktree isolation: the attempt writes under <home>/.synorch/worktrees/<project-hash>/<attempt-hash> and the main workspace is untouched until integrate", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n", "README.md": "r\n" }, { git: true });
  try {
    const projectId = deriveProjectId(workspace.root, process.platform);
    const blobs = createMemoryBlobStore();
    const provider = createIsolationProvider({ workspaceRoot: workspace.root, projectId, home: workspace.home, blobs });
    const attemptId = createId("attempt");
    const isolated = await provider.create(packet(["src/**"]), attemptId, signal());
    assert.equal(isolated.mode, "worktree");
    assert.equal(isolated.root, path.join(workspace.home, ".synorch", "worktrees", workspaceDirectoryName(projectId), workspaceDirectoryName(attemptId)));
    assert.equal(workspaceDirectoryName(attemptId).length, 12, "hashed names keep worktree paths short (B7)");
    assert.ok(isolated.baseCommit !== undefined && /^[0-9a-f]{40}$/.test(isolated.baseCommit));
    await writeFile(path.join(isolated.root, "src", "a.ts"), "changed\n");
    await writeFile(path.join(isolated.root, "src", "new.ts"), "new\n");
    assert.equal(await readFile(path.join(workspace.root, "src", "a.ts"), "utf8"), "a\n");
    const snapshot = await isolated.snapshot(signal());
    assert.deepEqual(snapshot.changedPaths, ["src/a.ts", "src/new.ts"]);
    assert.ok(await blobs.has(snapshot.artifactDigest), "the pinned artifact is stored as a blob");
    const document = decodeArtifact(await blobs.get(snapshot.artifactDigest));
    assert.equal(document.changes.find((change) => change.path === "src/new.ts")?.before, null);

    await assert.rejects(provider.integrate(isolated, sha256("wrong"), signal()), (error: unknown) => error instanceof HarnessError && error.info.code === "verification_failed");
    assert.equal(await readFile(path.join(workspace.root, "src", "a.ts"), "utf8"), "a\n");
    await provider.integrate(isolated, snapshot.artifactDigest, signal());
    assert.equal(await readFile(path.join(workspace.root, "src", "a.ts"), "utf8"), "changed\n");
    assert.equal(await readFile(path.join(workspace.root, "src", "new.ts"), "utf8"), "new\n");
    await isolated.dispose();
    await assert.rejects(stat(isolated.root));
    const worktrees = (await runGit(["worktree", "list", "--porcelain"], workspace.root)).stdout.toString("utf8");
    assert.ok(!worktrees.includes(attemptId));
  } finally {
    await workspace.cleanup();
  }
});

test("integrate refuses an artifact that writes outside the owned paths", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n", "docs/d.md": "d\n" }, { git: true });
  try {
    const provider = createIsolationProvider({ workspaceRoot: workspace.root, projectId: deriveProjectId(workspace.root, process.platform), home: workspace.home });
    const isolated = await provider.create(packet(["src/**"]), createId("attempt"), signal());
    await writeFile(path.join(isolated.root, "docs", "d.md"), "sneaky\n");
    const snapshot = await isolated.snapshot(signal());
    await assert.rejects(provider.integrate(isolated, snapshot.artifactDigest, signal()), (error: unknown) => error instanceof HarnessError && error.info.code === "policy_denied");
    assert.equal(await readFile(path.join(workspace.root, "docs", "d.md"), "utf8"), "d\n");
    await isolated.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("integrate never overwrites the user's untracked file or a concurrent edit; it reports a conflict", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n" }, { git: true });
  try {
    const provider = createIsolationProvider({ workspaceRoot: workspace.root, projectId: deriveProjectId(workspace.root, process.platform), home: workspace.home });
    const isolated = await provider.create(packet(["src/new.ts", "src/a.ts"]), createId("attempt"), signal());
    await writeFile(path.join(isolated.root, "src", "new.ts"), "from worker\n");
    const snapshot = await isolated.snapshot(signal());
    await writeFile(path.join(workspace.root, "src", "new.ts"), "user's untracked work\n");
    await assert.rejects(provider.integrate(isolated, snapshot.artifactDigest, signal()), /integration conflict/);
    assert.equal(await readFile(path.join(workspace.root, "src", "new.ts"), "utf8"), "user's untracked work\n");
    await isolated.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("uncommitted user changes overlapping owned paths fall back to scoped-dir; high-risk refuses instead", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n", "src/b.ts": "b\n" }, { git: true });
  try {
    await writeFile(path.join(workspace.root, "src", "a.ts"), "user edit\n");
    const provider = createIsolationProvider({ workspaceRoot: workspace.root, projectId: deriveProjectId(workspace.root, process.platform), home: workspace.home });
    const scoped = await provider.create(packet(["src/**"]), createId("attempt"), signal());
    assert.equal(scoped.mode, "scoped-dir");
    assert.equal(scoped.root, workspace.root);
    await writeFile(path.join(workspace.root, "src", "b.ts"), "worker edit\n");
    assert.deepEqual((await scoped.snapshot(signal())).changedPaths, ["src/b.ts"], "the user's pre-existing edit is not attributed to the attempt");
    assert.deepEqual(await scoped.revert(signal()), ["src/b.ts"]);
    assert.equal(await readFile(path.join(workspace.root, "src", "b.ts"), "utf8"), "b\n");
    assert.equal(await readFile(path.join(workspace.root, "src", "a.ts"), "utf8"), "user edit\n", "revert keeps the user's own change");
    await scoped.dispose();
    await assert.rejects(
      provider.create(packet(["src/**"], { risk: "high-risk" }), createId("attempt"), signal()),
      (error: unknown) => error instanceof HarnessError && error.info.code === "sandbox_insufficient",
    );
  } finally {
    await workspace.cleanup();
  }
});

test("a non-git workspace uses scoped-dir with a revertable pre-attempt copy", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n", "other/x.md": "x\n" }, { git: false });
  try {
    const provider = createIsolationProvider({ workspaceRoot: workspace.root, projectId: deriveProjectId(workspace.root, process.platform), home: workspace.home });
    const scoped = await provider.create(packet(["docs/**"], { isolation: "scoped-dir" }), createId("attempt"), signal());
    assert.equal(scoped.mode, "scoped-dir");
    await writeFile(path.join(workspace.root, "docs", "a.md"), "edited\n");
    await mkdir(path.join(workspace.root, "docs", "sub"), { recursive: true });
    await writeFile(path.join(workspace.root, "docs", "sub", "n.md"), "new\n");
    await writeFile(path.join(workspace.root, "other", "x.md"), "outside\n");
    const changes = (await scoped.changeSet(signal())).changes;
    assert.deepEqual(changes.map((change) => change.path), ["docs/a.md", "docs/sub/n.md", "other/x.md"]);
    await assert.rejects(provider.integrate(scoped, (await scoped.snapshot(signal())).artifactDigest, signal()), /outside the owned scope/);
    await scoped.revert(signal());
    assert.equal(await readFile(path.join(workspace.root, "docs", "a.md"), "utf8"), "a\n");
    await assert.rejects(stat(path.join(workspace.root, "docs", "sub", "n.md")));
  } finally {
    await workspace.cleanup();
  }
});

test("explorers and reviewers get a shared read-only workspace, optionally rooted at the artifact under review", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n" }, { git: true });
  try {
    const provider = createIsolationProvider({ workspaceRoot: workspace.root, projectId: deriveProjectId(workspace.root, process.platform), home: workspace.home });
    const readOnly = await provider.create(packet([]), createId("attempt"), signal());
    assert.equal(readOnly.mode, "shared-read-only");
    assert.equal(readOnly.root, workspace.root);
    assert.deepEqual((await readOnly.snapshot(signal())).changedPaths, []);
    const elsewhere = await provider.create(packet([]), createId("attempt"), signal(), { readRoot: workspace.home });
    assert.equal(elsewhere.root, workspace.home);
  } finally {
    await workspace.cleanup();
  }
});

test("seed continues a revise attempt from an earlier artifact in a fresh worktree", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n" }, { git: true });
  try {
    const provider = createIsolationProvider({ workspaceRoot: workspace.root, projectId: deriveProjectId(workspace.root, process.platform), home: workspace.home });
    const first = await provider.create(packet(["src/**"]), createId("attempt"), signal());
    await writeFile(path.join(first.root, "src", "a.ts"), "first\n");
    const firstSet = await first.changeSet(signal());
    await first.dispose();
    const second = await provider.create(packet(["src/**"]), createId("attempt"), signal());
    await provider.seed(second, firstSet.artifactBytes, signal());
    assert.equal(await readFile(path.join(second.root, "src", "a.ts"), "utf8"), "first\n");
    assert.deepEqual((await second.snapshot(signal())).changedPaths, ["src/a.ts"]);
    await second.dispose();
  } finally {
    await workspace.cleanup();
  }
});
