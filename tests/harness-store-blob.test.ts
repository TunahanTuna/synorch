import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { sha256, StoreFailure, type Digest } from "../src/harness/contracts/index.ts";
import { createBlobStore } from "../src/harness/store/index.ts";

const homes: string[] = [];

after(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

async function newHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "synorch-blobs-"));
  homes.push(home);
  return home;
}

function blobFile(home: string, digest: Digest): string {
  const hex = digest.slice("sha256:".length);
  return path.join(home, "blobs", "sha256", hex.slice(0, 2), hex.slice(2));
}

async function rejectsWith(promise: Promise<unknown>, code: StoreFailure["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof StoreFailure && error.code === code);
}

test("put stores content-addressed bytes under sha256/<2>/<62> and get returns them verified", async () => {
  const home = await newHome();
  const blobs = createBlobStore(home);
  const bytes = new TextEncoder().encode("large tool output\n".repeat(2000));
  const ref = await blobs.put(bytes, "text/plain");
  assert.deepEqual(ref, { digest: sha256(bytes), size_bytes: bytes.byteLength, media_type: "text/plain" });
  assert.deepEqual(new Uint8Array(await readFile(blobFile(home, ref.digest))), bytes);
  assert.deepEqual(await blobs.get(ref.digest), bytes);
  assert.equal(await blobs.has(ref.digest), true);
  assert.deepEqual(await blobs.put(bytes, "text/plain"), ref, "a second put of the same bytes is a no-op");
});

test("AC-8 a blob whose bytes no longer match its digest returns no data", async () => {
  const home = await newHome();
  const blobs = createBlobStore(home);
  const ref = await blobs.put(new TextEncoder().encode("original"), "text/plain");
  await writeFile(blobFile(home, ref.digest), "tampered");
  await rejectsWith(blobs.get(ref.digest), "blob_digest_mismatch");
});

test("AC-8 a truncated blob is a digest mismatch as well", async () => {
  const home = await newHome();
  const blobs = createBlobStore(home);
  const ref = await blobs.put(new TextEncoder().encode("0123456789"), "application/octet-stream");
  await writeFile(blobFile(home, ref.digest), "01234");
  await rejectsWith(blobs.get(ref.digest), "blob_digest_mismatch");
});

test("put rewrites a damaged copy instead of trusting it", async () => {
  const home = await newHome();
  const blobs = createBlobStore(home);
  const bytes = new TextEncoder().encode("repair me");
  const ref = await blobs.put(bytes, "text/plain");
  await writeFile(blobFile(home, ref.digest), "damaged");
  await blobs.put(bytes, "text/plain");
  assert.deepEqual(await blobs.get(ref.digest), bytes);
});

test("a missing blob or a malformed digest is blob_missing and has() is false", async () => {
  const blobs = createBlobStore(await newHome());
  const absent = sha256("never stored");
  await rejectsWith(blobs.get(absent), "blob_missing");
  assert.equal(await blobs.has(absent), false);
  await rejectsWith(blobs.get("sha256:abc" as Digest), "blob_missing");
  await rejectsWith(blobs.get("sha256:../../../../etc/passwd" as Digest), "blob_missing");
  assert.equal(await blobs.has("sha256:abc" as Digest), false);
});

test("an empty blob round-trips and an invalid media type is rejected", async () => {
  const blobs = createBlobStore(await newHome());
  const empty = await blobs.put(new Uint8Array(), "application/octet-stream");
  assert.equal(empty.size_bytes, 0);
  assert.deepEqual(await blobs.get(empty.digest), new Uint8Array());
  await rejectsWith(blobs.put(new Uint8Array([1]), ""), "write_failed");
});

test("concurrent puts of the same content converge on one verified file", async () => {
  const blobs = createBlobStore(await newHome());
  const bytes = new TextEncoder().encode("contended".repeat(10_000));
  const refs = await Promise.all(Array.from({ length: 8 }, () => blobs.put(bytes, "text/plain")));
  assert.equal(new Set(refs.map((ref) => ref.digest)).size, 1);
  assert.deepEqual(await blobs.get(refs[0]?.digest ?? sha256("")), bytes);
});
