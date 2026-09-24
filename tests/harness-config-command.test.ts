import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseHarnessArgs, UsageError } from "../src/harness/cli/args.ts";
import { configCommand, type ConfigCommandIO, type ConfigInvocation } from "../src/harness/cli/config-command.ts";
import { loadRuntimeConfig } from "../src/harness/cli/config.ts";

/** K1.5-3: `syn config` writes only the user layer, validates every value and shows where effective values come from. */

async function sandbox(): Promise<{ root: string; home: string; repo: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-config-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  return { root, home, repo, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function harness(home: string, repo: string, root: string, runEditor?: ConfigCommandIO["runEditor"]) {
  let out = "";
  let err = "";
  const io: ConfigCommandIO = {
    home,
    cwd: repo,
    env: {},
    platform: process.platform,
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    discovery: { ceiling: root },
    ...(runEditor === undefined ? {} : { runEditor }),
  };
  const run = async (subcommand: ConfigInvocation["subcommand"], args: string[] = [], json = false) => {
    out = "";
    err = "";
    const code = await configCommand({ subcommand, args, json, target: undefined }, io);
    return { code, out, err };
  };
  return run;
}

test("set / get / unset write typed, validated values to the user configuration only", async () => {
  const box = await sandbox();
  try {
    const run = harness(box.home, box.repo, box.root);
    assert.equal((await run("set", ["routes.orchestrator", "openai/gpt-6-sol"])).code, 0);
    assert.equal((await run("set", ["routes.complex_worker", "anthropic/opus-5.5@claude-code"])).code, 0);
    assert.equal((await run("set", ["ui.permission_mode", "auto"])).code, 0);
    assert.equal((await run("set", ["budget.max_wall_time_seconds", "1800"])).code, 0);
    assert.equal((await run("set", ["ui.mouse", "true"])).code, 0);

    const config = await loadRuntimeConfig(box.home, box.repo, [], { ceiling: box.root });
    assert.equal(config.permissionMode, "auto");
    assert.equal(config.mouse, true);
    assert.equal(config.budget.maxWallTimeSeconds, 1800);
    assert.deepEqual(
      config.router.rules.map((rule) => `${rule.tier}=${rule.route.provider_id}/${rule.route.model_id}@${rule.route.adapter_id}`),
      ["orchestrator=openai/gpt-6-sol@openai-chatgpt", "complex_worker=anthropic/opus-5.5@claude-code"],
    );

    assert.equal((await run("get", ["ui.permission_mode"])).out, "auto\n");
    assert.equal((await run("set", ["routes.orchestrator", "openai/gpt-6-luna"])).out, "routes.orchestrator = openai/gpt-6-luna (was openai/gpt-6-sol)\n");
    assert.equal((await run("unset", ["ui.mouse"])).code, 0);
    const text = await readFile(path.join(box.home, "config.yaml"), "utf8");
    assert.doesNotMatch(text, /mouse/);
    assert.match(text, /tier: orchestrator, provider: openai, model: gpt-6-luna/);
    const missing = await run("get", ["routes.session"]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /not set/);
    assert.equal(await readFile(path.join(box.repo, ".synorch", "config.yaml"), "utf8").catch(() => "absent"), "absent", "nothing is written to the repository");
  } finally {
    await box.cleanup();
  }
});

test("friendly errors: unknown keys and values suggest the closest match; nothing is written", async () => {
  const box = await sandbox();
  try {
    const run = harness(box.home, box.repo, box.root);
    const badValue = await run("set", ["ui.permission_mode", "auot"]);
    assert.equal(badValue.code, 2);
    assert.match(badValue.err, /Expected ask, auto, full, plan\. Did you mean auto\?/);
    const badKey = await run("set", ["ui.mose", "true"]);
    assert.match(badKey.err, /Unknown configuration key "ui\.mose"\. Did you mean ui\.mouse\?/);
    assert.match((await run("set", ["budget.max_wall_time_seconds", "-5"])).err, /positive whole number/);
    assert.match((await run("set", ["routes.orchestrator", "openia/gpt-6-sol"])).err, /Did you mean openai\?/);
    assert.match((await run("set", ["routes.orchestrator", "gpt-6-sol"])).err, /Expected <provider>\/<model>/);
    assert.equal(await readFile(path.join(box.home, "config.yaml"), "utf8").catch(() => "absent"), "absent");
    assert.throws(() => parseHarnessArgs(["config", "lst"]), (error: unknown) => error instanceof UsageError && /Did you mean: syn config list\?/.test(error.message));
    assert.equal(parseHarnessArgs(["config"]).kind, "config");
  } finally {
    await box.cleanup();
  }
});

test("list shows effective values with their source; a repository layer only narrows", async () => {
  const box = await sandbox();
  try {
    const run = harness(box.home, box.repo, box.root);
    await run("set", ["budget.max_wall_time_seconds", "1800"]);
    await mkdir(path.join(box.repo, ".synorch"), { recursive: true });
    await writeFile(path.join(box.repo, ".synorch", "config.yaml"), "budget: { max_wall_time_seconds: 600 }\nui: { permission_mode: full }\n", "utf8");
    const listed = await run("list", [], true);
    assert.equal(listed.code, 0, listed.err);
    const report = JSON.parse(listed.out) as { settings: { key: string; value: unknown; source: string }[]; warnings: { key: string }[] };
    const byKey = new Map(report.settings.map((setting) => [setting.key, setting]));
    assert.deepEqual(byKey.get("budget.max_wall_time_seconds"), { key: "budget.max_wall_time_seconds", value: 600, source: "project", scope: "narrow" });
    assert.deepEqual(byKey.get("ui.permission_mode"), { key: "ui.permission_mode", value: "auto", source: "default", scope: "user" }, "a repository cannot choose the permission mode");
    assert.deepEqual(report.warnings.map((warning) => warning.key), ["ui"]);
    const human = await run("list");
    assert.match(human.out, /budget\.max_wall_time_seconds\s+600\s+project \(narrowed\)/);
  } finally {
    await box.cleanup();
  }
});

test("edit saves only a draft that validates; an invalid draft leaves the configuration untouched", async () => {
  const box = await sandbox();
  try {
    let content = "ui: { permission_mode: sometimes }\n";
    const run = harness(box.home, box.repo, box.root, async (file) => {
      await writeFile(file, content, "utf8");
      return 0;
    });
    await run("set", ["ui.permission_mode", "ask"]);
    const invalid = await run("edit");
    assert.equal(invalid.code, 2);
    assert.match(invalid.err, /Nothing was saved/);
    assert.match(await readFile(path.join(box.home, "config.yaml"), "utf8"), /permission_mode: ask/);
    content = "ui: { permission_mode: full }\n";
    const valid = await run("edit");
    assert.equal(valid.code, 0, valid.err);
    assert.match(invalid.err + valid.err, /Continuing your unsaved edit/);
    assert.equal(await readFile(path.join(box.home, "config.yaml"), "utf8"), content);
  } finally {
    await box.cleanup();
  }
});
