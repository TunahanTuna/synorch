import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * AC-1 (I5): `syn inspect/init/sync/doctor` keep their stdout, stderr and exit codes byte for byte.
 * The fixtures capture legacy CLI output, including the current generated model profiles.
 * Only the temporary target directory (`<TARGET>`, its name `<TARGET_NAME>`) is masked and path separators are unified so
 * one fixture serves every OS; everything else is compared raw.
 * Set `SYN_UPDATE_LEGACY_SNAPSHOT=1` to re-capture after an intentional legacy output change.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/cli/legacy-snapshot.json", import.meta.url));
const UPDATE = process.env.SYN_UPDATE_LEGACY_SNAPSHOT === "1";

interface Step {
  readonly name: string;
  readonly args: readonly string[];
  readonly firstStderrLineOnly?: boolean;
}

interface Scenario {
  readonly name: string;
  readonly setup?: (target: string) => Promise<void>;
  readonly steps: readonly Step[];
}

interface Captured {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "top-level",
    steps: [
      { name: "help", args: ["--help"] },
      { name: "help-short", args: ["-h"] },
      { name: "no-arguments", args: [] },
      { name: "version", args: ["--version"] },
      { name: "unknown-command", args: ["bogus"] },
      { name: "unknown-option", args: ["inspect", "--bogus"], firstStderrLineOnly: true },
      { name: "extra-positionals", args: ["inspect", "extra", "more"] },
    ],
  },
  {
    name: "workspace-lifecycle",
    steps: [
      { name: "doctor-uninitialized", args: ["doctor", "--target", "<TARGET>"] },
      { name: "doctor-uninitialized-json", args: ["doctor", "--target", "<TARGET>", "--json"] },
      { name: "sync-uninitialized", args: ["sync", "--target", "<TARGET>"] },
      { name: "inspect-invalid-scope", args: ["inspect", "--target", "<TARGET>", "--scope", "nope"] },
      { name: "inspect", args: ["inspect", "--target", "<TARGET>"] },
      { name: "inspect-json", args: ["inspect", "--target", "<TARGET>", "--json"] },
      { name: "init", args: ["init", "--target", "<TARGET>"] },
      { name: "init-again", args: ["init", "--target", "<TARGET>"] },
      { name: "inspect-after-init", args: ["inspect", "--target", "<TARGET>"] },
      { name: "sync-scope-rejected", args: ["sync", "--target", "<TARGET>", "--scope", "workspace"] },
      { name: "sync", args: ["sync", "--target", "<TARGET>"] },
      { name: "sync-json", args: ["sync", "--target", "<TARGET>", "--json"] },
      { name: "doctor", args: ["doctor", "--target", "<TARGET>"] },
      { name: "doctor-json", args: ["doctor", "--target", "<TARGET>", "--json"] },
      { name: "doctor-force-rejected", args: ["doctor", "--target", "<TARGET>", "--force"] },
      { name: "doctor-scope-rejected", args: ["doctor", "--target", "<TARGET>", "--scope", "workspace"] },
    ],
  },
  {
    name: "repository-with-project",
    setup: async (target) => {
      await mkdir(path.join(target, "packages", "api"), { recursive: true });
      await writeFile(path.join(target, "packages", "api", "package.json"), '{ "name": "api" }\n');
    },
    steps: [
      { name: "inspect-repository", args: ["inspect", "--target", "<TARGET>", "--scope", "repository"] },
      { name: "init-repository-json", args: ["init", "--target", "<TARGET>", "--scope", "repository", "--json"] },
      { name: "sync", args: ["sync", "--target", "<TARGET>"] },
      { name: "doctor", args: ["doctor", "--target", "<TARGET>"] },
    ],
  },
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const resolved = path.resolve(directory);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "test cleanup must stay inside OS temp");
      await rm(resolved, { recursive: true, force: true });
    }),
  );
});

function normalize(text: string, target: string): string {
  const escaped = JSON.stringify(target).slice(1, -1);
  const name = new RegExp(path.basename(target), "gi");
  return text
    .replaceAll(escaped, "<TARGET>")
    .replaceAll(target, "<TARGET>")
    .replace(name, "<TARGET_NAME>")
    .replaceAll("\\", "/");
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["NO_COLOR", "FORCE_COLOR", "SYN_PLAIN", "NODE_OPTIONS"]) delete env[name];
  return env;
}

async function runScenario(scenario: Scenario): Promise<Record<string, Captured>> {
  const target = await mkdtemp(path.join(os.tmpdir(), "synorch-legacy-"));
  temporaryDirectories.push(target);
  await scenario.setup?.(target);
  const results: Record<string, Captured> = {};
  for (const step of scenario.steps) {
    const args = step.args.map((argument) => (argument === "<TARGET>" ? target : argument));
    const child = spawnSync(process.execPath, [CLI, ...args], { cwd: target, env: environment(), encoding: "utf8" });
    const stderr = normalize(child.stderr, target);
    results[step.name] = {
      args: step.args,
      exitCode: child.status,
      stdout: normalize(child.stdout, target),
      stderr: step.firstStderrLineOnly === true ? `${stderr.split("\n")[0] ?? ""}\n` : stderr,
    };
  }
  return results;
}

test("legacy commands keep byte-identical stdout, stderr and exit codes (AC-1)", async () => {
  const actual: Record<string, Record<string, Captured>> = {};
  for (const scenario of SCENARIOS) actual[scenario.name] = await runScenario(scenario);

  if (UPDATE) {
    await mkdir(path.dirname(FIXTURE), { recursive: true });
    await writeFile(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }

  const expected = JSON.parse(await readFile(FIXTURE, "utf8")) as Record<string, Record<string, Captured>>;
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const [scenario, steps] of Object.entries(expected)) {
    for (const [step, captured] of Object.entries(steps)) {
      const observed = actual[scenario]?.[step];
      assert.ok(observed !== undefined, `${scenario}/${step} was not run`);
      assert.equal(observed.exitCode, captured.exitCode, `${scenario}/${step} exit code`);
      assert.equal(observed.stdout, captured.stdout, `${scenario}/${step} stdout`);
      assert.equal(observed.stderr, captured.stderr, `${scenario}/${step} stderr`);
    }
  }
});

