#!/usr/bin/env node
// Builds this checkout, packs it and installs the tarball globally, so `syn` works from any folder
// as a self-contained copy (no link back to the checkout). Extra arguments go to `npm install -g`,
// e.g. `node scripts/install-global.mjs --prefix C:\scratch` for a throwaway install.
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const passthrough = process.argv.slice(2).filter((arg) => arg !== "--").map((arg) => JSON.stringify(arg)).join(" ");
const run = (command) => execSync(command, { cwd: root, stdio: "inherit" });

run("pnpm build");
const out = mkdtempSync(path.join(os.tmpdir(), "synorch-pack-"));
try {
  run(`npm pack --ignore-scripts --pack-destination ${JSON.stringify(out)}`);
  const tarball = readdirSync(out).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error(`npm pack produced no tarball in ${out}`);
  run(`npm install -g ${JSON.stringify(path.join(out, tarball))} ${passthrough}`.trim());
} finally {
  rmSync(out, { recursive: true, force: true });
}
console.log("\nInstalled. Open a new terminal and run: syn --version");
