import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { canonicalJson, createId, deriveProjectId, HarnessError, sha256, taskContextPacketSchema, type TaskContextPacket } from "../src/harness/contracts/index.ts";
import * as orchestration from "../src/harness/orchestration/index.ts";
import { createIsolationProvider, runGit } from "../src/harness/orchestration/index.ts";
import { createTempWorkspace, type TempWorkspace } from "../src/harness/orchestration/testing.ts";

/**
 * SEC-H4, SEC-M1 and SEC-M3 regressions for worker isolation: integrate, seed and revert never
 * write through a link; changed ⊆ owned sees ignored files, other tasks' paths and out-of-owned
 * changes; a crash leaves no orphaned worktree or unreverted scoped-dir write behind.
 */

function packet(owned: string[], overrides: Partial<TaskContextPacket> = {}): TaskContextPacket {
  return taskContextPacketSchema.parse({
    schema_version: 2,
    kind: "full",
    task_id: createId("task"),
    run_id: createId("run"),
    plan_id: createId("plan"),
    plan_version: 1,
    plan_digest: sha256("plan"),
    role: "implementer",
    model_tier: "complex_worker",
    risk: "standard",
    write_mode: "owned-paths",
    isolation: "worktree",
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
const denied = (error: unknown) => error instanceof HarnessError && error.info.code === "policy_denied";

async function outsideDir(workspace: TempWorkspace): Promise<string> {
  const outside = path.join(path.dirname(workspace.root), "outside");
  await mkdir(outside, { recursive: true });
  return outside;
}

async function link(target: string, at: string): Promise<void> {
  await symlink(target, at, process.platform === "win32" ? "junction" : "dir");
}

function providerFor(workspace: TempWorkspace) {
  return createIsolationProvider({
    workspaceRoot: workspace.root,
    projectId: deriveProjectId(workspace.root, process.platform),
    home: workspace.home,
    worktreesRoot: path.join(workspace.home, "worktrees"),
  });
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function markOwnerDead(file: string): Promise<void> {
  const owner = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...owner, pid: deadPid() }));
}

test("SEC-H4 integrate refuses to write through a gitignored junction a worker un-ignored (integrate repro)", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n", ".gitignore": "src/gen\n.env\n" }, { git: true });
  try {
    const outside = await outsideDir(workspace);
    await link(outside, path.join(workspace.root, "src", "gen"));
    const provider = providerFor(workspace);
    const isolated = await provider.create(packet([".gitignore", "src/**"]), createId("attempt"), signal());
    assert.equal(isolated.mode, "worktree");
    await writeFile(path.join(isolated.root, ".gitignore"), ".env\n");
    await mkdir(path.join(isolated.root, "src", "gen"), { recursive: true });
    await writeFile(path.join(isolated.root, "src", "gen", "payload.txt"), "escaped\n");
    const set = await isolated.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), [".gitignore", "src/gen/payload.txt"]);
    await assert.rejects(provider.integrate(isolated, set.artifactDigest, signal()), denied);
    assert.equal(existsSync(path.join(outside, "payload.txt")), false, "nothing lands outside the workspace");
    assert.equal(await readFile(path.join(workspace.root, ".gitignore"), "utf8"), "src/gen\n.env\n", "no partial integration");
    const resolve = (orchestration as Record<string, unknown>).resolveLinkSafeTarget as ((root: string, relative: string, platform: NodeJS.Platform) => Promise<string>) | undefined;
    assert.ok(resolve !== undefined, "integrate resolves targets link-safely");
    await assert.rejects(resolve(workspace.root, "src/gen/payload.txt", process.platform), /symbolic link or junction/, "a write target through the junction is refused on its own");
    assert.equal(await resolve(workspace.root, "src/new/file.ts", process.platform), path.join(workspace.root, "src", "new", "file.ts"));
    await isolated.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-H4 integrate refuses a .gitignore change that exposes an ignored escaping link, even without writing through it", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n", ".gitignore": "vendor-link\n" }, { git: true });
  try {
    const outside = await outsideDir(workspace);
    await link(outside, path.join(workspace.root, "vendor-link"));
    const provider = providerFor(workspace);
    const isolated = await provider.create(packet([".gitignore", "vendor-link/**", "src/**"]), createId("attempt"), signal());
    await writeFile(path.join(isolated.root, ".gitignore"), "# nothing ignored\n");
    const set = await isolated.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), [".gitignore"]);
    await assert.rejects(provider.integrate(isolated, set.artifactDigest, signal()), /expose ignored links \(vendor-link/);
    assert.equal(await readFile(path.join(workspace.root, ".gitignore"), "utf8"), "vendor-link\n");
    await isolated.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-H4 seed refuses an artifact path that traverses a junction", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const outside = await outsideDir(workspace);
    await link(outside, path.join(workspace.root, "docs", "gen"));
    const provider = providerFor(workspace);
    const scoped = await provider.create(packet(["docs/**"], { isolation: "scoped-dir" }), createId("attempt"), signal());
    const artifact = Buffer.from(
      canonicalJson({
        format: "synorch.artifact/v1",
        mode: "scoped-dir",
        base_commit: null,
        changes: [{ path: "docs/gen/seeded.md", before: null, after: sha256("x\n"), content: Buffer.from("x\n").toString("base64") }],
      }),
    );
    await assert.rejects(provider.seed(scoped, artifact, signal()), denied);
    assert.equal(existsSync(path.join(outside, "seeded.md")), false);
    await scoped.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-H4 revert never restores through a junction planted during the attempt", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n" }, { git: false });
  try {
    const outside = await outsideDir(workspace);
    const provider = providerFor(workspace);
    const scoped = await provider.create(packet(["docs/**"], { isolation: "scoped-dir" }), createId("attempt"), signal());
    await writeFile(path.join(workspace.root, "docs", "a.md"), "edited\n");
    await rename(path.join(workspace.root, "docs"), path.join(workspace.root, "moved"));
    await link(outside, path.join(workspace.root, "docs"));
    await scoped.revert(signal());
    assert.equal(existsSync(path.join(outside, "a.md")), false, "revert must not write through the junction");
    await scoped.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-M1 scoped-dir sees a gitignored write outside the owned paths and integrate refuses it", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n", ".gitignore": ".env\n" }, { git: true });
  try {
    await writeFile(path.join(workspace.root, "src", "a.ts"), "user edit\n");
    const provider = providerFor(workspace);
    const scoped = await provider.create(packet(["src/**"]), createId("attempt"), signal());
    assert.equal(scoped.mode, "scoped-dir");
    await writeFile(path.join(workspace.root, ".env"), "INJECTED=1\n");
    const set = await scoped.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), [".env"]);
    await assert.rejects(provider.integrate(scoped, set.artifactDigest, signal()), /\.env \(outside-owned\)/);
    await scoped.revert(signal());
    assert.equal(existsSync(path.join(workspace.root, ".env")), false, "revert removes the ignored file the attempt created");
    assert.equal(await readFile(path.join(workspace.root, "src", "a.ts"), "utf8"), "user edit\n");
    await scoped.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-M1 a write into another scoped-dir task's paths is not hidden: scoped-dir tasks never run concurrently", async () => {
  const workspace = await createTempWorkspace({ "src/a/a.ts": "a\n", "src/b/b.ts": "b\n" }, { git: false });
  try {
    const provider = providerFor(workspace);
    const first = await provider.create(packet(["src/a/**"], { isolation: "scoped-dir" }), createId("attempt"), signal());
    let secondReady = false;
    const second = provider.create(packet(["src/b/**"], { isolation: "scoped-dir" }), createId("attempt"), signal()).then((workspace) => {
      secondReady = true;
      return workspace;
    });
    await writeFile(path.join(workspace.root, "src", "b", "x.ts"), "sneaky\n");
    const set = await first.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), ["src/b/x.ts"], "the write into src/b is attributed to the only running attempt");
    await assert.rejects(provider.integrate(first, set.artifactDigest, signal()), /outside-owned/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondReady, false, "the second scoped-dir task waits while the first is active");
    await first.revert(signal());
    await first.dispose();
    const next = await second;
    assert.equal(next.mode, "scoped-dir");
    assert.equal(existsSync(path.join(workspace.root, "src", "b", "x.ts")), false);
    await next.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-M1 non-git revert restores changes outside the owned paths", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n", "other/x.md": "x\n" }, { git: false });
  try {
    const provider = providerFor(workspace);
    const scoped = await provider.create(packet(["docs/**"], { isolation: "scoped-dir" }), createId("attempt"), signal());
    await writeFile(path.join(workspace.root, "other", "x.md"), "outside\n");
    await writeFile(path.join(workspace.root, "docs", "a.md"), "edited\n");
    const restored = await scoped.revert(signal());
    assert.deepEqual([...restored].sort(), ["docs/a.md", "other/x.md"]);
    assert.equal(await readFile(path.join(workspace.root, "other", "x.md"), "utf8"), "x\n");
    assert.equal(await readFile(path.join(workspace.root, "docs", "a.md"), "utf8"), "a\n");
    await scoped.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-M3 recovery prunes a crashed attempt's worktree and keeps a live one", async () => {
  const workspace = await createTempWorkspace({ "src/a.ts": "a\n" }, { git: true });
  try {
    const provider = providerFor(workspace);
    const crashedId = createId("attempt");
    const crashed = await provider.create(packet(["src/**"]), crashedId, signal());
    const live = await provider.create(packet(["src/**"]), createId("attempt"), signal());
    await writeFile(path.join(crashed.root, "src", "a.ts"), "partial\n");
    await markOwnerDead(`${provider.worktreePath(crashedId)}.owner.json`);
    const prune = (orchestration as Record<string, unknown>).pruneOrphanedAttempts as
      | ((options: Record<string, unknown>) => Promise<{ removedWorktrees: string[]; live: string[] }>)
      | undefined;
    assert.ok(prune !== undefined, "pruneOrphanedAttempts exists");
    const report = await prune({ worktreesRoot: path.join(workspace.home, "worktrees"), projectId: deriveProjectId(workspace.root, process.platform), workspaceRoot: workspace.root });
    assert.deepEqual(report.removedWorktrees, [crashedId]);
    assert.ok(report.live.includes(live.attemptId));
    assert.equal(existsSync(crashed.root), false);
    assert.equal(existsSync(live.root), true);
    const list = (await runGit(["worktree", "list", "--porcelain"], workspace.root)).stdout.toString("utf8");
    assert.ok(!list.includes(crashedId));
    assert.equal(await readFile(path.join(workspace.root, "src", "a.ts"), "utf8"), "a\n");
    await live.dispose();
  } finally {
    await workspace.cleanup();
  }
});

test("SEC-M3 recovery reverts a crashed scoped-dir attempt's partial writes from the persisted baseline", async () => {
  const workspace = await createTempWorkspace({ "docs/a.md": "a\n", "other/x.md": "x\n" }, { git: false });
  try {
    const provider = providerFor(workspace);
    const attemptId = createId("attempt");
    await provider.create(packet(["docs/**"], { isolation: "scoped-dir" }), attemptId, signal());
    await writeFile(path.join(workspace.root, "docs", "a.md"), "partial\n");
    await writeFile(path.join(workspace.root, "docs", "new.md"), "new\n");
    await writeFile(path.join(workspace.root, "other", "x.md"), "edited later by the user\n");
    const directory = `${provider.worktreePath(attemptId)}.scoped`;
    assert.ok(existsSync(directory), "the baseline is persisted outside the workspace");
    await markOwnerDead(path.join(directory, "owner.json"));
    const prune = (orchestration as Record<string, unknown>).pruneOrphanedAttempts as
      | ((options: Record<string, unknown>) => Promise<{ revertedScoped: { attemptId: string; restored: string[]; leftInPlace: string[] }[] }>)
      | undefined;
    assert.ok(prune !== undefined, "pruneOrphanedAttempts exists");
    const report = await prune({ worktreesRoot: path.join(workspace.home, "worktrees"), projectId: deriveProjectId(workspace.root, process.platform), workspaceRoot: workspace.root });
    assert.equal(report.revertedScoped.length, 1);
    assert.deepEqual([...(report.revertedScoped[0]?.restored ?? [])].sort(), ["docs/a.md", "docs/new.md"]);
    assert.deepEqual(report.revertedScoped[0]?.leftInPlace, ["other/x.md"]);
    assert.equal(await readFile(path.join(workspace.root, "docs", "a.md"), "utf8"), "a\n");
    assert.equal(existsSync(path.join(workspace.root, "docs", "new.md")), false);
    assert.equal(await readFile(path.join(workspace.root, "other", "x.md"), "utf8"), "edited later by the user\n");
    assert.equal(existsSync(directory), false);
  } finally {
    await workspace.cleanup();
  }
});
