import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  ProjectDiscoveryService,
  resolveWithinRoot,
} from "../src/application/project-discovery.ts";
import { StructureService } from "../src/application/structure-service.ts";
import { CliError } from "../src/domain/errors.ts";
import {
  OBSERVATION_LEDGER_PATH,
  createEmptyLedger,
} from "../src/domain/observation-ledger.ts";
import { NodeFileSystem } from "../src/infrastructure/file-system.ts";
import { parseYaml, stringifyYaml } from "../src/infrastructure/serialization.ts";

const temporaryDirectories: string[] = [];
const PROJECT_SKILL_PATH = ".ai/skills/project/api-test-execution/SKILL.md";
const PROJECT_SKILL_CONTENT = "---\nname: api-test-execution\n---\n\nHand-authored, never synced.\n";

/** A ledger only the user and the orchestrator could have produced: `init` must never touch it. */
const POPULATED_LEDGER = [
  "schema_version: 1",
  "tasks_seen: 174",
  "observations:",
  "  - id: api-test-execution",
  "    claim: API tests must run from the module root.",
  "    kind: command-behavior",
  "    sources:",
  "      - path: package.json",
  "        digest: sha256:9f2c1d3b4a5e6f708192a3b4c5d6e7f8",
  "    confirmed_by: [task-141, task-156, task-173]",
  "    count: 3",
  "    origin: worker-discovery",
  "    first_seen_at: 2026-09-14",
  "    last_seen_at: 2026-09-22",
  "    last_seen_task_index: 173",
  "    status: declined",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const resolved = path.resolve(directory);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "cleanup must stay in OS temp");
      await rm(resolved, { recursive: true, force: true });
    }),
  );
});

test("sync leaves a generated project skill untouched, byte for byte, even with --force", async () => {
  const directory = await createInitializedProject();
  await writeProjectSkill(directory, PROJECT_SKILL_CONTENT);
  const before = await readFile(path.join(directory, PROJECT_SKILL_PATH));

  const result = await new ProjectDiscoveryService(new NodeFileSystem()).sync(directory, {
    force: true,
  });

  const after = await readFile(path.join(directory, PROJECT_SKILL_PATH));
  assert.equal(before.equals(after), true);
  assert.equal(
    result.writtenFiles.some((file) => file.startsWith(".ai/skills/project/")),
    false,
  );
});

test("sync succeeds when there is no observation ledger", async () => {
  const directory = await createInitializedProject();
  // A structure generated before the ledger existed, or one whose ledger a user removed.
  await rm(path.join(directory, OBSERVATION_LEDGER_PATH));

  const result = await new ProjectDiscoveryService(new NodeFileSystem()).sync(directory);

  assert.equal(result.prunedObservations, 0);
  assert.equal(
    result.writtenFiles.includes(OBSERVATION_LEDGER_PATH),
    false,
  );
  assert.equal(await exists(path.join(directory, OBSERVATION_LEDGER_PATH)), false);
});

test("sync prunes expired observations and reports how many it removed", async () => {
  const directory = await createInitializedProject();
  await writeLedger(directory, {
    schema_version: 1,
    tasks_seen: 40,
    observations: [
      observation({ id: "expired-by-tasks", last_seen_task_index: 10 }),
      observation({ id: "expired-by-age", last_seen_at: "2020-01-01", last_seen_task_index: 40 }),
      observation({ id: "still-collecting", last_seen_task_index: 40 }),
      observation({ id: "declined-forever", last_seen_task_index: 0, status: "declined" }),
    ],
  });

  const result = await new ProjectDiscoveryService(new NodeFileSystem()).sync(directory);

  assert.equal(result.prunedObservations, 2);
  assert.ok(result.writtenFiles.includes(OBSERVATION_LEDGER_PATH));
  const ledger = parseYaml(
    await readFile(path.join(directory, OBSERVATION_LEDGER_PATH), "utf8"),
  ) as { readonly tasks_seen: number; readonly observations: ReadonlyArray<{ id: string }> };
  assert.deepEqual(
    ledger.observations.map((entry) => entry.id),
    ["declined-forever", "still-collecting"],
  );
  assert.equal(ledger.tasks_seen, 40);
});

test("sync leaves a ledger with nothing to prune exactly as it found it", async () => {
  const directory = await createInitializedProject();
  const content = "# hand formatted\nschema_version: 1\ntasks_seen: 2\nobservations: []\n";
  await mkdir(path.join(directory, ".ai", "tasks"), { recursive: true });
  await writeFile(path.join(directory, OBSERVATION_LEDGER_PATH), content, "utf8");

  const result = await new ProjectDiscoveryService(new NodeFileSystem()).sync(directory);

  assert.equal(result.prunedObservations, 0);
  assert.equal(await readFile(path.join(directory, OBSERVATION_LEDGER_PATH), "utf8"), content);
});

test("sync refuses to continue with an invalid observation ledger", async () => {
  const directory = await createInitializedProject();
  await mkdir(path.join(directory, ".ai", "tasks"), { recursive: true });
  await writeFile(
    path.join(directory, OBSERVATION_LEDGER_PATH),
    stringifyYaml({ schema_version: 1, observations: "not-a-list" }),
    "utf8",
  );

  await assert.rejects(
    () => new ProjectDiscoveryService(new NodeFileSystem()).sync(directory),
    /Invalid observation ledger/,
  );
});

test("init --force leaves a populated observation ledger byte-identical", async () => {
  const directory = await createInitializedProject();
  await writeFile(path.join(directory, OBSERVATION_LEDGER_PATH), POPULATED_LEDGER, "utf8");
  const before = await readFile(path.join(directory, OBSERVATION_LEDGER_PATH));

  const structure = new StructureService(new NodeFileSystem());
  const result = await structure.initialize(
    await structure.createPlan(directory, "repository", true),
  );

  const after = await readFile(path.join(directory, OBSERVATION_LEDGER_PATH));
  assert.equal(before.equals(after), true, "the ledger must survive --force untouched");
  assert.ok(result.preserved.includes(OBSERVATION_LEDGER_PATH));
  assert.equal(result.updated.includes(OBSERVATION_LEDGER_PATH), false);
  assert.equal(result.unchanged.includes(OBSERVATION_LEDGER_PATH), false);
  assert.equal(result.created.includes(OBSERVATION_LEDGER_PATH), false);
});

test("inspect reports a populated ledger as preserved rather than a conflict", async () => {
  const directory = await createInitializedProject();
  await writeFile(path.join(directory, OBSERVATION_LEDGER_PATH), POPULATED_LEDGER, "utf8");

  const structure = new StructureService(new NodeFileSystem());
  const plan = await structure.createPlan(directory, "repository");

  const ledgerFile = plan.files.find((file) => file.relativePath === OBSERVATION_LEDGER_PATH);
  assert.ok(ledgerFile);
  assert.equal(ledgerFile.status, "preserved");
  assert.deepEqual(
    plan.files.filter((file) => file.status === "conflict").map((file) => file.relativePath),
    [],
  );

  // An init without --force must therefore succeed, and still not touch the ledger.
  const before = await readFile(path.join(directory, OBSERVATION_LEDGER_PATH));
  await structure.initialize(plan);
  assert.equal(before.equals(await readFile(path.join(directory, OBSERVATION_LEDGER_PATH))), true);
});

test("init --force still refreshes the canonical task gitignore beside the ledger", async () => {
  const directory = await createInitializedProject();
  const ignorePath = path.join(directory, ".ai", "tasks", ".gitignore");
  await writeFile(ignorePath, "# hand edited\n", "utf8");

  const structure = new StructureService(new NodeFileSystem());
  const result = await structure.initialize(
    await structure.createPlan(directory, "repository", true),
  );

  assert.ok(result.updated.includes(".ai/tasks/.gitignore"));
  assert.match(await readFile(ignorePath, "utf8"), /^!observations\.yaml$/m);
});

test("a ledger absent at init time is seeded once", async () => {
  const directory = await createInitializedProject();
  await rm(path.join(directory, OBSERVATION_LEDGER_PATH));

  const structure = new StructureService(new NodeFileSystem());
  const result = await structure.initialize(await structure.createPlan(directory, "repository"));

  assert.ok(result.created.includes(OBSERVATION_LEDGER_PATH));
  assert.equal(
    await readFile(path.join(directory, OBSERVATION_LEDGER_PATH), "utf8"),
    stringifyYaml(createEmptyLedger()),
  );
});

function observation(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "api-test-execution",
    claim: "API tests must run from the module root.",
    kind: "command-behavior",
    sources: [{ path: "package.json", digest: "sha256:9f2c1d3b4a5e6f708192a3b4c5d6e7f8" }],
    confirmed_by: ["task-1"],
    count: 1,
    origin: "worker-discovery",
    first_seen_at: "2026-09-14",
    last_seen_at: "2026-09-22",
    last_seen_task_index: 0,
    status: "collecting",
    ...overrides,
  };
}

async function writeLedger(directory: string, ledger: unknown): Promise<void> {
  await mkdir(path.join(directory, ".ai", "tasks"), { recursive: true });
  await writeFile(path.join(directory, OBSERVATION_LEDGER_PATH), stringifyYaml(ledger), "utf8");
}

async function writeProjectSkill(directory: string, content: string): Promise<void> {
  const absolutePath = path.join(directory, PROJECT_SKILL_PATH);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function createInitializedProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-skill-creator-"));
  temporaryDirectories.push(directory);
  const structure = new StructureService(new NodeFileSystem());
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.19.0", scripts: { test: "node --test" } }),
    "utf8",
  );
  return directory;
}

async function exists(targetPath: string): Promise<boolean> {
  return new NodeFileSystem().exists(targetPath);
}

test("resolveWithinRoot refuses the generated skill namespace outright", () => {
  const root = path.resolve(os.tmpdir(), "synorch-guard");

  for (const relativePath of [
    ".ai/skills/project/x/SKILL.md",
    ".ai/skills/project",
    String.raw`.ai\skills\project\x\SKILL.md`,
    ".ai/skills/Project/x/SKILL.md",
    "./.ai/skills/project/x/SKILL.md",
  ]) {
    assert.throws(
      () => resolveWithinRoot(root, relativePath),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 2 &&
        /never write inside the generated skill namespace/.test(error.message),
      relativePath,
    );
  }

  assert.equal(
    resolveWithinRoot(root, ".ai/skills/task-conductor/SKILL.md"),
    path.join(root, ".ai", "skills", "task-conductor", "SKILL.md"),
  );
});
