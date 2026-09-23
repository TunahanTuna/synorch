import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { closestMatch, editDistance } from "../src/domain/suggest.ts";
import { unknownConversationCommand } from "../src/harness/cli/slash-commands.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function syn(...args: string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const child = spawnSync(process.execPath, [CLI, ...args], { cwd: os.tmpdir(), encoding: "utf8" });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr.replaceAll("\r\n", "\n") };
}

test("closestMatch picks plausible typos and rejects unrelated words", () => {
  assert.equal(editDistance("usgae", "usage"), 1);
  assert.equal(closestMatch("dockter", ["inspect", "init", "sync", "doctor", "agent"]), "doctor");
  assert.equal(closestMatch("usgae", ["usage", "undo", "cost"]), "usage");
  assert.equal(closestMatch("bogus", ["inspect", "init", "sync", "doctor", "agent", "run", "runs", "show"]), undefined);
});

test("an unknown command suggests the closest command, keeps valid flags and prints no stack", () => {
  const typo = syn("dockter", "--runtime");
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, "");
  assert.equal(typo.stderr, "Unknown command: dockter\nDid you mean: syn doctor --runtime?\nRun syn --help for all commands.\n");

  const invalidFlag = syn("dockter", "--bogus");
  assert.match(invalidFlag.stderr, /^Did you mean: syn doctor\?$/m);

  const option = syn("inspect", "--jsn");
  assert.equal(option.status, 2);
  assert.equal(option.stderr, "Unknown option --jsn for syn inspect\nDid you mean --json?\nUsage: syn inspect [--target <path>] [--scope workspace|repository]\n");
  assert.doesNotMatch(option.stderr, /TypeError|at /);
});

test("an unknown slash command suggests the closest conversation command", () => {
  assert.equal(unknownConversationCommand("/usgae", "·"), "Unknown command /usgae · did you mean /usage?");
  assert.equal(unknownConversationCommand("/zzzzzz", "·"), "Unknown command /zzzzzz · /help lists the commands");
});
