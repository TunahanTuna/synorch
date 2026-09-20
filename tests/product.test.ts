import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SYNORCH_GENERATOR_NAME, SYNORCH_VERSION } from "../src/domain/product.ts";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly repository?: { readonly url?: unknown };
  readonly bin?: Record<string, unknown>;
}

async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
}

test("package identity and executable aliases stay canonical", async () => {
  const manifest = await readPackageManifest();

  assert.equal(manifest.name, SYNORCH_GENERATOR_NAME);
  assert.equal(manifest.version, SYNORCH_VERSION);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository?.url, "git+https://github.com/TunahanTuna/synorch.git");
  assert.deepEqual(manifest.bin, {
    syn: "dist/cli.js",
    synorch: "dist/cli.js",
  });
});
