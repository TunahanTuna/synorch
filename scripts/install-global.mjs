#!/usr/bin/env node
// Builds this checkout, packs it and installs the tarball globally, so `syn` works from any folder
// as a self-contained copy (no link back to the checkout). Extra arguments go to `npm install -g`,
// e.g. `node scripts/install-global.mjs --prefix C:\scratch` for a throwaway install.
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const passthrough = process.argv.slice(2).filter((arg) => arg !== "--").map((arg) => JSON.stringify(arg)).join(" ");
const run = (command) => execSync(command, { cwd: root, stdio: "inherit" });

// On Windows a running `syn` keeps its native .node files open: npm then fails with EPERM/EBUSY
// while replacing them. Retry with backoff, then say what to do instead of a raw npm stack.
const LOCKED = /\b(EPERM|EBUSY|EACCES)\b|operation not permitted|resource busy or locked/i;
const ATTEMPTS = 4;

async function installWithRetry(command) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = spawnSync(command, { cwd: root, shell: true, stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" });
    const stderr = result.stderr ?? "";
    if (result.status === 0) {
      process.stderr.write(stderr);
      return 0;
    }
    const locked = LOCKED.test(stderr);
    if (!locked || attempt === ATTEMPTS) {
      process.stderr.write(stderr);
      if (locked) {
        console.error("\nThe install could not replace files that are in use (EPERM/EBUSY).");
        console.error("Close running syn windows and run again.");
      }
      return result.status ?? 1;
    }
    const wait = 1000 * 2 ** (attempt - 1);
    console.error(`Files are locked (a running syn?); retrying in ${wait / 1000} s (${attempt}/${ATTEMPTS - 1})...`);
    await sleep(wait);
  }
}

run("pnpm build");
let failed = 0;
const out = mkdtempSync(path.join(os.tmpdir(), "synorch-pack-"));
try {
  run(`npm pack --ignore-scripts --pack-destination ${JSON.stringify(out)}`);
  const tarball = readdirSync(out).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error(`npm pack produced no tarball in ${out}`);
  failed = await installWithRetry(`npm install -g ${JSON.stringify(path.join(out, tarball))} ${passthrough}`.trim());
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failed !== 0) process.exit(failed);
console.log("\nInstalled. Open a new terminal and run: syn --version");
