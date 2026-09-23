import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createId, digestText, workspaceDigest } from "../src/harness/contracts/index.ts";
import { findScopeViolations, matchesAny, normalizeWorkspacePath, sameWorkspacePath } from "../src/harness/orchestration/paths.ts";
import { createWorkspaceDigestReader, resolveOnDiskPath } from "../src/harness/orchestration/workspace-digest.ts";
import { createFixtureRepo, packet, signal } from "./fixtures/git/repo.ts";

/**
 * Denetim B fixture 10 (B11) and B10: paths are compared in NFC with the one case policy
 * (`foldPathCase` on win32 and darwin, no Turkish tailoring), an NFD-created file is found and
 * integrated under its NFC name, and workspace digests are byte-exact.
 */

const NFC = "src/çalışan.ts";
const NFD = NFC.normalize("NFD");

test("B11: normalizeWorkspacePath returns NFC, and owned NFC patterns match NFD candidates on every platform", () => {
  assert.notEqual(NFC, NFD);
  assert.equal(normalizeWorkspacePath(NFD), NFC);
  for (const platform of ["win32", "darwin", "linux"] as const) {
    assert.equal(matchesAny(NFD, [NFC], platform), true, platform);
    assert.equal(matchesAny(NFD, ["src/ç*.ts"], platform), true, platform);
    assert.deepEqual(findScopeViolations([NFD], { owned: [NFC], forbidden: [] }, platform), [], platform);
  }
});

test("B11: win32 and darwin share one case-insensitive policy (foldPathCase); linux stays case-sensitive", () => {
  for (const platform of ["win32", "darwin"] as const) {
    assert.equal(matchesAny("Readme.md", ["readme.md"], platform), true, `${platform}: owned readme.md covers tracked Readme.md`);
    assert.deepEqual(findScopeViolations(["Readme.md"], { owned: ["readme.md"], forbidden: [] }, platform), [], platform);
    assert.equal(matchesAny("src/ŞEHIR/x.ts", ["src/şehir"], platform), true, `${platform}: ı/I and i/I fold together`);
    assert.equal(matchesAny("SRC/ŞEHİR/x.ts", ["src/şehir"], platform), false, `${platform}: İ folds only to itself, as on NTFS`);
    assert.equal(sameWorkspacePath("SRC/Şehir.ts", "src/şehir.ts", platform), true);
    assert.equal(sameWorkspacePath("src/ŞEHİR.ts", "src/şehir.ts", platform), false);
  }
  assert.equal(matchesAny("Readme.md", ["readme.md"], "linux"), false);
  assert.deepEqual(findScopeViolations(["Readme.md"], { owned: ["readme.md"], forbidden: [] }, "linux"), [{ path: "Readme.md", reason: "outside-owned" }]);
});

test("fixture 10 (B11): a file created with an NFD name inside an NFC owned path is changed, integrated under the NFC name, and never outside-owned", async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("src/a.txt", "a\n");
    repo.commitAll();
    const provider = repo.provider();
    const workspace = await provider.create(packet([NFC]), createId("attempt"), signal());
    await writeFile(path.join(workspace.root, ...NFD.split("/")), "nfd\n");
    const set = await workspace.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), [NFC], "the change is reported under its NFC workspace path");
    assert.equal(set.changes[0]?.after, workspaceDigest(Buffer.from("nfd\n")));
    assert.equal(await workspace.digest?.(NFC), workspaceDigest(Buffer.from("nfd\n")), "the NFC name resolves the NFD-created file");
    await provider.integrate(workspace, set.artifactDigest, signal());
    const mainNames = await readdir(path.join(repo.root, "src"));
    assert.deepEqual(mainNames.filter((name) => name.normalize("NFC") === "çalışan.ts").length, 1, "one file, written under the NFC name");
    assert.equal(await readFile(path.join(repo.root, "src", "çalışan.ts"), "utf8"), "nfd\n");
    await workspace.dispose();
  } finally {
    await repo.cleanup();
  }
});

test("fixture 10 (B11): owned readme.md vs tracked Readme.md is accepted by isolation on a case-insensitive platform", { skip: process.platform === "win32" || process.platform === "darwin" ? false : "needs a case-insensitive file system" }, async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("Readme.md", "1\n");
    repo.commitAll();
    const provider = repo.provider();
    const workspace = await provider.create(packet(["readme.md"]), createId("attempt"), signal());
    await writeFile(path.join(workspace.root, "readme.md"), "2\n");
    const set = await workspace.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), ["Readme.md"]);
    await provider.integrate(workspace, set.artifactDigest, signal());
    assert.equal(await readFile(path.join(repo.root, "Readme.md"), "utf8"), "2\n");
    await workspace.dispose();
  } finally {
    await repo.cleanup();
  }
});

test("B10: the workspace digest is byte-exact where digestText collides (cp1254, invalid UTF-8, CRLF, lone CR)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syn-wf-digest-"));
  try {
    const reader = createWorkspaceDigestReader(root);
    const pairs: readonly (readonly [Buffer, Buffer])[] = [
      [Buffer.from([0x73, 0xfe, 0x0a]), Buffer.from([0x73, 0xf0, 0x0a])],
      [Buffer.from([0x61, 0xff, 0x0a]), Buffer.from([0x61, 0xfe, 0x0a])],
      [Buffer.from("a\r\nb\r\n"), Buffer.from("a\nb\n")],
      [Buffer.from("a\rb"), Buffer.from("a\nb")],
    ];
    for (const [index, [left, right]] of pairs.entries()) {
      assert.equal(digestText(left.toString("utf8")), digestText(right.toString("utf8")), `pair ${index} collides under digestText`);
      await writeFile(path.join(root, `l${index}.txt`), left);
      await writeFile(path.join(root, `r${index}.txt`), right);
      const [l, r] = [await reader(`l${index}.txt`), await reader(`r${index}.txt`)];
      assert.equal(l, workspaceDigest(left));
      assert.notEqual(l, r, `pair ${index} differs under workspaceDigest`);
    }
    assert.equal(await reader("missing.txt"), undefined);
    await mkdir(path.join(root, "dir"));
    assert.equal(await reader("dir"), undefined, "a directory has no digest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("B10: a scoped-dir attempt detects a one-byte cp1254 edit (ş -> ğ)", async () => {
  const repo = await createFixtureRepo();
  try {
    await repo.write("w1254.txt", Buffer.from([0x73, 0xfe, 0x0a]));
    repo.commitAll();
    const provider = repo.provider();
    const scoped = await provider.create(packet(["w1254.txt"], { isolation: "scoped-dir" }), createId("attempt"), signal());
    await writeFile(path.join(repo.root, "w1254.txt"), Buffer.from([0x73, 0xf0, 0x0a]));
    const set = await scoped.changeSet(signal());
    assert.deepEqual(set.changes.map((change) => change.path), ["w1254.txt"]);
    await scoped.revert(signal());
    assert.deepEqual(await readFile(path.join(repo.root, "w1254.txt")), Buffer.from([0x73, 0xfe, 0x0a]));
    await scoped.dispose();
  } finally {
    await repo.cleanup();
  }
});

test("resolveOnDiskPath finds an NFD-named entry for an NFC path and refuses traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syn-wf-resolve-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, ...NFD.split("/")), "x");
    const resolved = await resolveOnDiskPath(root, NFC);
    assert.ok(resolved !== undefined && resolved.normalize("NFC") === NFC);
    assert.equal(existsSync(path.join(root, ...(resolved ?? "").split("/"))), true);
    assert.equal(await resolveOnDiskPath(root, "../outside.txt"), undefined);
    assert.equal(await resolveOnDiskPath(root, "src/missing.ts"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
