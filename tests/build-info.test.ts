import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SYNORCH_VERSION } from "../src/domain/product.ts";
import { versionLine } from "../src/infrastructure/build-info.ts";

test("versionLine appends the build commit only when build-info.json carries one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "syn-build-info-"));
  try {
    const file = path.join(dir, "build-info.json");
    assert.equal(versionLine(file), SYNORCH_VERSION);
    await writeFile(file, JSON.stringify({ commit: "abc1234" }));
    assert.equal(versionLine(file), `${SYNORCH_VERSION} (abc1234)`);
    await writeFile(file, JSON.stringify({ commit: null }));
    assert.equal(versionLine(file), SYNORCH_VERSION);
    assert.equal(versionLine(), SYNORCH_VERSION, "sources carry no build-info.json, so the legacy snapshot stays plain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
