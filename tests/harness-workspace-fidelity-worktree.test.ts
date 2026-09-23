import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createId, deriveProjectId, HarnessError, workspaceDigest } from "../src/harness/contracts/index.ts";
import { GitCommandError, runGit, type GitRunner } from "../src/harness/orchestration/git.ts";
import { projectWorkspacesDirectory, pruneOrphanedAttempts } from "../src/harness/orchestration/isolation.ts";
import { createFixtureRepo, gitIn, packet, signal, type FixtureRepo } from "./fixtures/git/repo.ts";

/**
 * Denetim B fixtures 5, 8, 9 and 11 (B3, B7, B8, B9): the worktree sees the read inputs the packet
 * cites and the installed dependencies; creation failures fall back to scoped-dir without leaving
 * anything behind; submodule writes are refused, never lost; a retry reuses and resets the worktree
 * and a scoped snapshot does not walk ignored dependency trees.
 */

const denied = (pattern: RegExp) => (error: unknown) => error instanceof HarnessError && error.info.code === "policy_denied" && pattern.test(error.message);

function projectDirectory(repo: FixtureRepo): string {
  return projectWorkspacesDirectory(repo.worktreesRoot, deriveProjectId(repo.root, process.platform));
}

async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [] as string[])).sort();
}

function worktreeCount(repo: FixtureRepo): number {
  return repo.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
}

test("fixture 5 (B3): dirty and untracked read inputs are overlaid, ignored node_modules is linked, and neither is integrated back", async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("lib.mjs", "export const v = 1;\n");
    await repo.write("app.mjs", "import { v } from './lib.mjs';\n");
    await repo.write(".gitignore", "node_modules/\n.env\n");
    repo.commitAll();
    await repo.write("lib.mjs", "export const v = 2; // user WIP\n");
    await repo.write("helper.mjs", "export const h = 1;\n");
    await repo.write("node_modules/dep/index.js", "module.exports = 1;\n");
    await repo.write(".env", "SECRET=1\n");
    const provider = repo.provider();
    const workspace = await provider.create(packet(["app.mjs"], {}, ["lib.mjs", "helper.mjs"]), createId("attempt"), signal(), { overlay: ["lib.mjs", "helper.mjs"] });
    assert.equal(workspace.mode, "worktree");
    assert.equal(await readFile(path.join(workspace.root, "lib.mjs"), "utf8"), "export const v = 2; // user WIP\n", "the dirty read path is what the main tree holds");
    assert.equal(await readFile(path.join(workspace.root, "helper.mjs"), "utf8"), "export const h = 1;\n", "the untracked cited source exists");
    assert.deepEqual([...(workspace.overlaid ?? [])].sort(), ["helper.mjs", "lib.mjs"]);
    assert.deepEqual(workspace.dependencyLinks, ["node_modules"]);
    assert.equal(await readFile(path.join(workspace.root, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n", "dependencies are visible to verification commands");
    assert.equal(existsSync(path.join(workspace.root, ".env")), false, "an ignored non-dependency file is neither overlaid nor linked");
    assert.equal(await workspace.digest?.("lib.mjs"), workspaceDigest(await readFile(path.join(repo.root, "lib.mjs"))), "a packet source digest computed in the worktree matches what the worker reads");
    assert.deepEqual((await workspace.changeSet(signal())).changes, [], "overlays and links are part of the baseline");
    await writeFile(path.join(workspace.root, "app.mjs"), "import { v, h } from './lib.mjs';\n");
    const set = await workspace.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), ["app.mjs"]);
    await provider.integrate(workspace, set.artifactDigest, signal());
    assert.equal(await readFile(path.join(repo.root, "lib.mjs"), "utf8"), "export const v = 2; // user WIP\n");
    await workspace.dispose();
    assert.equal(existsSync(workspace.root), false);
    assert.equal(await readFile(path.join(repo.root, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n", "removing the worktree never empties the linked main-tree directory");

    const plain = await provider.create(packet(["app.mjs"]), createId("attempt"), signal());
    assert.equal(await readFile(path.join(plain.root, "lib.mjs"), "utf8"), "export const v = 1;\n", "without an overlay list the worktree is HEAD");
    assert.equal(plain.overlaid, undefined);
    await plain.dispose();

    const owning = await provider.create(packet(["app.mjs", "node_modules/dep/**"]), createId("attempt"), signal());
    assert.deepEqual(owning.dependencyLinks, [], "a dependency directory an owned path overlaps is never linked");
    await owning.dispose();
    assert.equal(existsSync(path.join(repo.root, "node_modules", "dep", "index.js")), true);
  } finally {
    await repo.cleanup();
  }
});

test("fixture 5 (B3): crash recovery unlinks dependency links before removing a worktree", async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("a.txt", "a\n");
    await repo.write(".gitignore", "node_modules/\n");
    repo.commitAll();
    await repo.write("node_modules/dep/index.js", "x\n");
    const provider = repo.provider();
    const workspace = await provider.create(packet(["a.txt"]), createId("attempt"), signal());
    assert.deepEqual(workspace.dependencyLinks, ["node_modules"]);
    const report = await pruneOrphanedAttempts({
      worktreesRoot: repo.worktreesRoot,
      projectId: deriveProjectId(repo.root, process.platform),
      workspaceRoot: repo.root,
      isLive: () => false,
    });
    assert.deepEqual(report.removedWorktrees, [(workspace as { attemptId: string }).attemptId]);
    assert.equal(existsSync(workspace.root), false);
    assert.equal(await readFile(path.join(repo.root, "node_modules", "dep", "index.js"), "utf8"), "x\n");
  } finally {
    await repo.cleanup();
  }
});

test("fixture 8 (B7): a tracked path that is long only inside the worktree still checks out (core.longpaths)", async () => {
  const repo = await createFixtureRepo({}, { baseName: "syn-wf-long-" });
  try {
    const relative = `src/${"modulo-deep-directory-name/".repeat(5)}file-with-a-reasonably-long-name.ts`;
    const mainLength = path.join(repo.root, relative).length;
    assert.ok(mainLength < 250, `the main path stays short (${mainLength})`);
    await repo.write(relative, "x\n");
    await repo.write("a.txt", "a\n");
    repo.commitAll();
    const provider = repo.provider({ worktreesRoot: path.join(repo.base, "w".repeat(80)) });
    const workspace = await provider.create(packet(["a.txt"]), createId("attempt"), signal());
    assert.ok(path.join(workspace.root, relative).length > 260, "the worktree path exceeds MAX_PATH");
    assert.equal(workspace.mode, "worktree");
    assert.equal(await readFile(path.join(workspace.root, ...relative.split("/")), "utf8"), "x\n");
    await workspace.dispose();
    assert.equal(existsSync(workspace.root), false);
  } finally {
    await repo.cleanup();
  }
});

function failingGit(fail: (args: readonly string[], cwd: string) => Error | undefined): GitRunner {
  return (args, cwd, abort, options) => {
    const error = fail(args, cwd);
    return error === undefined ? runGit(args, cwd, abort, options) : Promise.reject(error);
  };
}

test("fixture 8 (B7): a worktree creation failure falls back to scoped-dir with a typed reason and leaves no worktree or owner file", async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("a.txt", "a\n");
    repo.commitAll();
    const tooLong = failingGit((args) =>
      args[0] === "worktree" && args[1] === "add" ? new GitCommandError(args, 128, "fatal: could not create leading directories of 'x': Filename too long") : undefined,
    );
    const provider = repo.provider({ git: tooLong });
    const workspace = await provider.create(packet(["a.txt"]), createId("attempt"), signal());
    assert.equal(workspace.mode, "scoped-dir");
    assert.equal(workspace.root, repo.root);
    assert.equal(workspace.fallback?.from, "worktree");
    assert.equal(workspace.fallback?.reason, "path-too-long");
    assert.match(workspace.fallback?.detail ?? "", /Filename too long/);
    assert.deepEqual((await entries(projectDirectory(repo))).filter((name) => !name.endsWith(".scoped")), [], "no orphan owner file or worktree directory");
    await workspace.dispose();

    await assert.rejects(
      provider.create(packet(["a.txt"], { risk: "high-risk" }), createId("attempt"), signal()),
      (error: unknown) => error instanceof HarnessError && error.info.code === "sandbox_insufficient" && /path-too-long/.test(error.message),
    );
    assert.deepEqual(await entries(projectDirectory(repo)), []);
    assert.equal(worktreeCount(repo), 1);
  } finally {
    await repo.cleanup();
  }
});

test("fixture 8 (B7): a failure after `worktree add` removes the half-made worktree and its owner file", async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("a.txt", "a\n");
    repo.commitAll();
    let armed = true;
    const failsOnce = failingGit((args) => {
      if (armed && args[0] === "ls-files" && args.includes("--ignored")) {
        armed = false;
        return new GitCommandError(args, 1, "fatal: simulated failure while populating the worktree");
      }
      return undefined;
    });
    const provider = repo.provider({ git: failsOnce });
    const workspace = await provider.create(packet(["a.txt"]), createId("attempt"), signal());
    assert.equal(workspace.mode, "scoped-dir");
    assert.equal(workspace.fallback?.reason, "worktree-create-failed");
    assert.equal(worktreeCount(repo), 1, "git no longer lists the half-made worktree");
    assert.deepEqual((await entries(projectDirectory(repo))).filter((name) => !name.endsWith(".scoped")), []);
    await workspace.dispose();
  } finally {
    await repo.cleanup();
  }
});

test("fixture 8 (B7): git that cannot be started falls back with reason git-unavailable", async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("a.txt", "a\n");
    repo.commitAll();
    const missing = failingGit((args) => new GitCommandError(args, undefined, "spawn git ENOENT", "ENOENT"));
    const workspace = await repo.provider({ git: missing }).create(packet(["a.txt"]), createId("attempt"), signal());
    assert.equal(workspace.mode, "scoped-dir");
    assert.equal(workspace.fallback?.reason, "git-unavailable");
    await workspace.dispose();
  } finally {
    await repo.cleanup();
  }
});

async function submoduleRepo(): Promise<{ readonly repo: FixtureRepo; readonly sub: FixtureRepo }> {
  const sub = await createFixtureRepo();
  await sub.write("s.txt", "s\n");
  sub.commitAll();
  const repo = await createFixtureRepo({ "protocol.file.allow": "always" });
  await repo.write("a.txt", "a\n");
  repo.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.root.replaceAll("\\", "/"), "vendor/lib");
  repo.commitAll();
  return { repo, sub };
}

test("fixture 9 (B8): an owned path inside a submodule is refused at create", async () => {
  const { repo, sub } = await submoduleRepo();
  try {
    const provider = repo.provider();
    await assert.rejects(provider.create(packet(["vendor/lib/s.txt", "a.txt"]), createId("attempt"), signal()), denied(/inside the submodule vendor\/lib/));
    await assert.rejects(provider.create(packet(["vendor/lib"], { isolation: "scoped-dir" }), createId("attempt"), signal()), denied(/submodule/));
    assert.deepEqual(await entries(projectDirectory(repo)), [], "nothing is created for a refused attempt");
  } finally {
    await repo.cleanup();
    await sub.cleanup();
  }
});

test("fixture 9 (B8): a write inside a submodule under an owned glob is reported and refused, never silently dropped", async () => {
  const { repo, sub } = await submoduleRepo();
  try {
    const provider = repo.provider();
    const workspace = await provider.create(packet(["vendor/**", "a.txt"]), createId("attempt"), signal());
    assert.equal(workspace.mode, "worktree");
    assert.deepEqual(workspace.submodules, ["vendor/lib"]);
    await mkdir(path.join(workspace.root, "vendor", "lib"), { recursive: true });
    await writeFile(path.join(workspace.root, "vendor", "lib", "s.txt"), "new\n");
    await writeFile(path.join(workspace.root, "a.txt"), "A\n");
    const set = await workspace.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), ["a.txt", "vendor/lib/s.txt"]);
    assert.deepEqual(set.unsafe, ["vendor/lib/s.txt"]);
    await assert.rejects(provider.integrate(workspace, set.artifactDigest, signal()), denied(/vendor\/lib\/s\.txt: it is inside the submodule vendor\/lib/));
    assert.equal(await readFile(path.join(repo.root, "a.txt"), "utf8"), "a\n", "nothing is integrated");
    await workspace.dispose();
  } finally {
    await repo.cleanup();
    await sub.cleanup();
  }
});

async function mediumRepo(files: number): Promise<FixtureRepo> {
  const repo = await createFixtureRepo();
  for (let index = 0; index < files; index += 1) {
    await repo.write(`src/m${index % 50}/f${index}.ts`, `export const v${index} = ${index};\n`);
  }
  await repo.write(".gitignore", "node_modules/\n.venv/\n");
  repo.commitAll();
  for (let index = 0; index < 200; index += 1) await repo.write(`node_modules/p${index % 20}/i${index}.js`, "module.exports = 1;\n");
  for (let index = 0; index < 200; index += 1) await repo.write(`.venv/p${index % 20}/i${index}.py`, "x = 1\n");
  return repo;
}

test("fixture 11 (B9): a retry reuses and resets the task's worktree instead of creating a new one", async () => {
  const repo = await mediumRepo(600);
  try {
    const provider = repo.provider();
    const task = packet(["src/m1/**"]);
    let started = Date.now();
    const first = await provider.create(task, createId("attempt"), signal());
    const freshMs = Date.now() - started;
    await writeFile(path.join(first.root, "src", "m1", "f1.ts"), "changed\n");
    await writeFile(path.join(first.root, "src", "m1", "untracked.ts"), "new\n");
    await writeFile(path.join(first.root, "src", "m2", "f2.ts"), "outside\n");
    assert.equal((await first.changeSet(signal())).changes.length, 3);

    started = Date.now();
    const second = await provider.create(task, createId("attempt"), signal(), { reuse: first });
    const reuseMs = Date.now() - started;
    assert.equal(second.reused, true);
    assert.equal(second.root, first.root, "the same worktree directory");
    assert.equal(worktreeCount(repo), 2, "no second worktree was added");
    assert.deepEqual((await second.changeSet(signal())).changes, [], "tracked edits and untracked files are reset");
    assert.equal(await readFile(path.join(second.root, "src", "m1", "f1.ts"), "utf8"), "export const v1 = 1;\n");
    assert.equal(existsSync(path.join(second.root, "src", "m1", "untracked.ts")), false);
    assert.deepEqual([...(second.dependencyLinks ?? [])].sort(), [".venv", "node_modules"]);
    assert.equal(existsSync(path.join(second.root, "node_modules", "p1", "i1.js")), true, "dependency links are restored after the reset");
    assert.equal(existsSync(path.join(repo.root, "node_modules", "p1", "i1.js")), true, "the reset never empties the linked directory");
    await first.dispose();
    assert.equal(existsSync(second.root), true, "disposing the superseded attempt keeps the reused worktree");
    await writeFile(path.join(second.root, "src", "m1", "f1.ts"), "retry\n");
    const set = await second.changeSet(signal());
    await provider.integrate(second, set.artifactDigest, signal());
    assert.equal(await readFile(path.join(repo.root, "src", "m1", "f1.ts"), "utf8"), "retry\n");
    await second.dispose();
    assert.equal(existsSync(second.root), false);
    assert.equal(worktreeCount(repo), 1);
    assert.equal(existsSync(path.join(repo.root, ".venv", "p1", "i1.py")), true);
    assert.ok(reuseMs < 15_000, `reuse took ${reuseMs} ms (fresh create ${freshMs} ms)`);
    process.stdout.write(`# B9 perf (600 tracked files): fresh worktree ${freshMs} ms, reuse ${reuseMs} ms\n`);
  } finally {
    await repo.cleanup();
  }
});

test("fixture 11 (B9): a scoped snapshot does not walk ignored dependency trees outside the owned paths", async () => {
  const repo = await mediumRepo(200);
  try {
    await repo.write(".gitignore", "node_modules/\n.venv/\nbuild/\n");
    repo.commitAll("ignore build");
    await repo.write("build/out.js", "old\n");
    const provider = repo.provider();
    const started = Date.now();
    const scoped = await provider.create(packet(["src/m1/**", "build/**"], { isolation: "scoped-dir" }), createId("attempt"), signal());
    const createMs = Date.now() - started;
    assert.equal(scoped.mode, "scoped-dir");
    await writeFile(path.join(repo.root, ".venv", "p1", "i1.py"), "changed = 1\n");
    await writeFile(path.join(repo.root, ".venv", "new.py"), "new\n");
    await writeFile(path.join(repo.root, "build", "out.js"), "new\n");
    await writeFile(path.join(repo.root, "src", "m1", "f1.ts"), "edit\n");
    const set = await scoped.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), ["build/out.js", "src/m1/f1.ts"], "the ignored .venv is skipped; an owned ignored directory is still watched");
    await writeFile(path.join(repo.root, "src", "m2", "f2.ts"), "outside the owned paths\n");
    const restored = await scoped.revert(signal());
    assert.ok(restored.includes("src/m2/f2.ts"), "a clean tracked file outside the owned paths is restored from the base commit (no copy kept)");
    assert.equal(await readFile(path.join(repo.root, "src", "m2", "f2.ts"), "utf8"), "export const v2 = 2;\n");
    assert.equal(await readFile(path.join(repo.root, "src", "m1", "f1.ts"), "utf8"), "export const v1 = 1;\n");
    await scoped.dispose();
    assert.ok(createMs < 15_000, `scoped create took ${createMs} ms`);
  } finally {
    await repo.cleanup();
  }
});

test("fixture 11 (B9, perf guard, SYNORCH_PERF=1): 20k tracked files — worktree reuse and a .venv-skipping snapshot stay bounded", { skip: process.env.SYNORCH_PERF === "1" ? false : "set SYNORCH_PERF=1 to run the 20k-file perf guard" }, async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "true" });
  try {
    for (let index = 0; index < 20_000; index += 1) await repo.write(`src/m${index % 200}/f${index}.ts`, `export const v${index} = ${index};\n`.repeat(20));
    await repo.write(".gitignore", "node_modules/\n.venv/\n");
    repo.commitAll();
    for (let index = 0; index < 30_000; index += 1) await repo.write(`node_modules/p${index % 300}/i${index}.js`, "module.exports=1;\n");
    for (let index = 0; index < 15_000; index += 1) await repo.write(`.venv/p${index % 150}/i${index}.py`, "x=1\n".repeat(50));
    const provider = repo.provider();
    const task = packet(["src/m1"]);
    const time = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
      const started = Date.now();
      const value = await work();
      return [value, Date.now() - started];
    };
    const [first, freshMs] = await time(() => provider.create(task, createId("attempt"), signal()));
    const [second, reuseMs] = await time(() => provider.create(task, createId("attempt"), signal(), { reuse: first }));
    const [, disposeMs] = await time(() => second.dispose());
    const [scoped, scopedMs] = await time(() => provider.create(packet(["src/m1"], { isolation: "scoped-dir" }), createId("attempt"), signal()));
    const [, scopedChangeMs] = await time(() => scoped.changeSet(signal()));
    await scoped.dispose();
    process.stdout.write(`# B9 perf (20k files): fresh ${freshMs} ms, reuse ${reuseMs} ms, dispose ${disposeMs} ms, scoped create ${scopedMs} ms, scoped changeSet ${scopedChangeMs} ms\n`);
    assert.ok(reuseMs < freshMs, "reuse is cheaper than a fresh worktree");
    assert.ok(scopedMs < 20_000 && scopedChangeMs < 15_000);
    assert.equal(gitIn(repo.root, ["worktree", "list"]).toString("utf8").trim().split("\n").length, 1);
  } finally {
    await repo.cleanup();
  }
});
