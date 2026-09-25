#!/usr/bin/env node
// Writes dist/build-info.json so an installed `syn --version` can show the commit it was built from.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
} catch {
  commit = null;
}
const target = fileURLToPath(new URL("../dist/build-info.json", import.meta.url));
writeFileSync(target, `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`);
