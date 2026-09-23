import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createId, HarnessError, workspaceDigest } from "../src/harness/contracts/index.ts";
import { contentIdentity, createWorkspaceDigestReader } from "../src/harness/orchestration/workspace-digest.ts";
import { createFixtureRepo, crlf, lfsAvailable, packet, signal, type FixtureRepo } from "./fixtures/git/repo.ts";

/**
 * Denetim B fixtures 1–4 (B1, K1/B2): integrate detects conflicts by ContentIdentity and writes the
 * main tree's representation, so EOL conversion, `.gitattributes eol`, clean/smudge filters and
 * Git LFS never report a conflict for a file the user did not touch, and the main tree keeps its
 * line endings. The attempt's own digests are the raw bytes of the worktree (workspace-raw-v1).
 */

const LF = "export function add(a, b) {\n  return a + b;\n}\n";
const EDITED_LF = "export function add(a, b) {\n  return a + b + 0;\n}\n";

async function bytes(file: string): Promise<Buffer> {
  return readFile(file);
}

async function editIntegrate(repo: FixtureRepo, relative: string, content: string | Buffer): Promise<{ worktreeBefore: Buffer }> {
  const provider = repo.provider();
  const workspace = await provider.create(packet([relative]), createId("attempt"), signal());
  assert.equal(workspace.mode, "worktree");
  const file = path.join(workspace.root, ...relative.split("/"));
  const worktreeBefore = await bytes(file);
  const set0 = await workspace.changeSet(signal());
  assert.deepEqual(set0.changes, [], "a fresh checkout has no changes");
  await writeFile(file, content);
  const set = await workspace.changeSet(signal());
  assert.deepEqual(set.changes.map((change) => change.path), [relative]);
  assert.equal(set.changes[0]?.before, workspaceDigest(worktreeBefore), "before is the worktree's own checkout bytes (workspace-raw-v1)");
  await provider.integrate(workspace, set.artifactDigest, signal());
  await workspace.dispose();
  return { worktreeBefore };
}

function numstat(repo: FixtureRepo): string {
  return repo.git("diff", "--numstat").trim();
}

test("fixture 1 (B1): autocrlf=true, LF blob, CRLF main checkout — integrate succeeds and the main file stays CRLF", async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "true" });
  try {
    await repo.write("src/add.mjs", LF);
    repo.commitAll();
    await rm(path.join(repo.root, "src", "add.mjs"));
    repo.git("checkout", "--", "src/add.mjs");
    assert.equal((await readFile(path.join(repo.root, "src", "add.mjs"), "latin1")).includes("\r\n"), true, "the main tree is a normal Windows checkout");
    await editIntegrate(repo, "src/add.mjs", crlf(EDITED_LF));
    assert.equal(await readFile(path.join(repo.root, "src", "add.mjs"), "latin1"), crlf(EDITED_LF));
    assert.equal(numstat(repo), "1\t1\tsrc/add.mjs", "only the edited line differs");
  } finally {
    await repo.cleanup();
  }
});

test("fixture 1b (B1): a worker writing LF into a CRLF checkout still integrates as CRLF (the main tree's representation)", async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "true" });
  try {
    await repo.write("src/add.mjs", crlf(LF));
    repo.commitAll();
    await editIntegrate(repo, "src/add.mjs", EDITED_LF);
    assert.equal(await readFile(path.join(repo.root, "src", "add.mjs"), "latin1"), crlf(EDITED_LF));
    assert.equal(numstat(repo), "1\t1\tsrc/add.mjs");
  } finally {
    await repo.cleanup();
  }
});

test("fixture 2 (K1, B2): autocrlf=true, LF blob, LF main tree — the attempt digest is the worktree's bytes and integrate keeps the main file LF", async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "true" });
  try {
    await repo.write("src-add.mjs", LF);
    repo.commitAll();
    const mainRaw = workspaceDigest(await bytes(path.join(repo.root, "src-add.mjs")));
    const provider = repo.provider();
    const workspace = await provider.create(packet(["src-add.mjs"]), createId("attempt"), signal());
    const worktreeBytes = await bytes(path.join(workspace.root, "src-add.mjs"));
    assert.equal(worktreeBytes.includes(13), true, "git wrote the worktree checkout with CRLF");
    assert.ok(workspace.digest !== undefined, "IsolatedWorkspace.digest exists in worktree mode");
    const digest = await workspace.digest("src-add.mjs");
    assert.equal(digest, workspaceDigest(worktreeBytes), "the packet digest is computed in the attempt workspace");
    assert.notEqual(digest, mainRaw, "and differs from the main tree's bytes, so the main-tree digest can never be used as a precondition");
    assert.equal(await createWorkspaceDigestReader(workspace.root)("src-add.mjs"), digest);
    await writeFile(path.join(workspace.root, "src-add.mjs"), crlf(EDITED_LF));
    const set = await workspace.changeSet(signal());
    await provider.integrate(workspace, set.artifactDigest, signal());
    assert.equal(await readFile(path.join(repo.root, "src-add.mjs"), "latin1"), EDITED_LF, "the main file keeps its LF line endings");
    assert.equal(numstat(repo), "1\t1\tsrc-add.mjs");
    await workspace.dispose();
  } finally {
    await repo.cleanup();
  }
});

test("fixture 3 (B1): autocrlf=input with a CRLF working file — no conflict, and the main file keeps CRLF", async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "input" });
  try {
    await repo.write("in.txt", crlf("a\nb\nc\n"));
    repo.commitAll();
    assert.equal(repo.git("status", "--porcelain"), "", "git sees the CRLF working file as clean");
    await editIntegrate(repo, "in.txt", "a\nB\nc\n");
    assert.equal(await readFile(path.join(repo.root, "in.txt"), "latin1"), crlf("a\nB\nc\n"));
    assert.equal(numstat(repo), "1\t1\tin.txt");
  } finally {
    await repo.cleanup();
  }
});

for (const eol of ["crlf", "lf"] as const) {
  test(`fixture 3 (B1): autocrlf=false with .gitattributes "* text=auto eol=${eol}" — no conflict, main keeps ${eol.toUpperCase()}`, async () => {
    const repo = await createFixtureRepo({ "core.autocrlf": "false" });
    try {
      await repo.write(".gitattributes", `* text=auto eol=${eol}\n`);
      await repo.write("e.txt", "a\nb\nc\n");
      repo.commitAll();
      await rm(path.join(repo.root, "e.txt"));
      repo.git("checkout", "--", "e.txt");
      const expected = eol === "crlf" ? crlf("a\nB\nc\n") : "a\nB\nc\n";
      await editIntegrate(repo, "e.txt", eol === "crlf" ? "a\nB\nc\n" : crlf("a\nB\nc\n"));
      assert.equal(await readFile(path.join(repo.root, "e.txt"), "latin1"), expected);
      assert.equal(numstat(repo), "1\t1\te.txt");
    } finally {
      await repo.cleanup();
    }
  });
}

test("fixture 4 (B1): a smudge/clean filter — the smudged main file is not a conflict and integrate writes the smudged form", async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "false" });
  try {
    // Portable filter scripts (node, not sed): clean drops the header line, smudge adds it.
    const clean = path.join(repo.base, "clean.mjs").replaceAll("\\", "/");
    const smudge = path.join(repo.base, "smudge.mjs").replaceAll("\\", "/");
    const script = (body: string): string => `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(${body}));\n`;
    await writeFile(clean, script(String.raw`s.replace(/^# smudged\n/, "")`));
    await writeFile(smudge, script(String.raw`"# smudged\n" + s`));
    repo.git("config", "filter.hdr.clean", `node "${clean}"`);
    repo.git("config", "filter.hdr.smudge", `node "${smudge}"`);
    await repo.write(".gitattributes", "*.cfg filter=hdr\n");
    await repo.write("a.cfg", "k=1\n");
    repo.commitAll();
    repo.git("rm", "-q", "--cached", "a.cfg");
    repo.git("checkout", "HEAD", "--", "a.cfg");
    assert.equal(await readFile(path.join(repo.root, "a.cfg"), "utf8"), "# smudged\nk=1\n");
    assert.equal(repo.git("cat-file", "blob", "HEAD:a.cfg"), "k=1\n");
    const identity = await contentIdentity(repo.root, "a.cfg", signal());
    assert.deepEqual(identity, { scheme: "git-blob", oid: repo.git("rev-parse", "HEAD:a.cfg").trim() }, "the clean filter makes the smudged file equal the HEAD blob");
    await editIntegrate(repo, "a.cfg", "# smudged\nk=2\n");
    assert.equal(await readFile(path.join(repo.root, "a.cfg"), "utf8"), "# smudged\nk=2\n");
    assert.equal(repo.git("status", "--porcelain").trim(), "M a.cfg");
  } finally {
    await repo.cleanup();
  }
});

test("fixture 4 (B1): Git LFS — the pointer blob is not compared with the file content; integrate writes real content", { skip: lfsAvailable() ? false : "git-lfs is not installed" }, async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "false" });
  try {
    repo.git("lfs", "install", "--local");
    repo.git("lfs", "track", "*.bin");
    await repo.write("data.bin", Buffer.alloc(1000, 7));
    repo.commitAll();
    assert.match(repo.git("cat-file", "blob", "HEAD:data.bin"), /^version https:\/\/git-lfs/);
    const { worktreeBefore } = await editIntegrate(repo, "data.bin", Buffer.alloc(1000, 8));
    assert.equal(worktreeBefore.length, 1000, "the worktree holds the smudged content, and before is its digest");
    const main = await readFile(path.join(repo.root, "data.bin"));
    assert.deepEqual(main, Buffer.alloc(1000, 8));
    assert.equal(repo.git("status", "--porcelain").trim(), "M data.bin");
  } finally {
    await repo.cleanup();
  }
});

test("B1: a real concurrent user edit is still a conflict, and re-integrating identical content is not", async () => {
  const repo = await createFixtureRepo({ "core.autocrlf": "true" });
  try {
    await repo.write("f.txt", crlf("a\nb\n"));
    repo.commitAll();
    const provider = repo.provider();
    const first = await provider.create(packet(["f.txt"]), createId("attempt"), signal());
    await writeFile(path.join(first.root, "f.txt"), crlf("a\nB\n"));
    const firstSet = await first.changeSet(signal());
    await writeFile(path.join(repo.root, "f.txt"), crlf("user\nb\n"));
    await assert.rejects(provider.integrate(first, firstSet.artifactDigest, signal()), (error: unknown) => error instanceof HarnessError && /integration conflict/.test(error.message));
    assert.equal(await readFile(path.join(repo.root, "f.txt"), "latin1"), crlf("user\nb\n"));
    await writeFile(path.join(repo.root, "f.txt"), "a\nB\n");
    await provider.integrate(first, firstSet.artifactDigest, signal());
    assert.equal(await readFile(path.join(repo.root, "f.txt"), "latin1"), "a\nB\n", "the same content (LF in the main tree) is already applied: no conflict, main EOL kept");
    await first.dispose();
  } finally {
    await repo.cleanup();
  }
});
