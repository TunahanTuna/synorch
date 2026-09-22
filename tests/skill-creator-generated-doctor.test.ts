import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { diagnoseGeneratedSkills } from "../src/application/generated-skill-doctor.ts";
import { createEmptyLedger } from "../src/domain/observation-ledger.ts";
import { NodeFileSystem } from "../src/infrastructure/file-system.ts";
import { stringifyYaml } from "../src/infrastructure/serialization.ts";

const temporaryDirectories: string[] = [];
const SOURCE_PATH = "src/app.ts";
const SOURCE_CONTENT = "export const app = true;\n";
const SOURCE_DIGEST = digestOf(SOURCE_CONTENT);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const resolved = path.resolve(directory);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "cleanup must stay in OS temp");
      await rm(resolved, { recursive: true, force: true });
    }),
  );
});

test("a contract-complete generated skill produces no diagnostics", async () => {
  const directory = await createFixture({});

  assert.deepEqual(await diagnose(directory), []);
});

test("an empty project namespace and an absent ledger produce no diagnostics", async () => {
  const directory = await createTempDirectory();

  assert.deepEqual(await diagnose(directory), []);
});

test("an unparseable ledger is reported as generated.ledger-invalid", async () => {
  const directory = await createFixture({ ledger: "schema_version: 1\n  observations: [" });

  assert.ok((await codes(directory)).includes("generated.ledger-invalid"));
});

test("a schema-invalid ledger is reported as generated.ledger-invalid", async () => {
  const directory = await createFixture({ ledger: stringifyYaml({ schema_version: 2 }) });

  assert.ok((await codes(directory)).includes("generated.ledger-invalid"));
});

test("a missing ledger beside an existing project skill is reported", async () => {
  const directory = await createFixture({ ledger: null });

  assert.ok((await codes(directory)).includes("generated.ledger-invalid"));
});

test("a skill without frontmatter is reported as generated.frontmatter-missing", async () => {
  const directory = await createFixture({ skill: "# No frontmatter here\n" });

  assert.deepEqual(await codes(directory), ["generated.frontmatter-missing"]);
});

test("unparseable frontmatter is reported as generated.frontmatter-invalid", async () => {
  const directory = await createFixture({ skill: "---\nname: [unterminated\n---\n\nBody\n" });

  assert.ok((await codes(directory)).includes("generated.frontmatter-invalid"));
});

test("a constitutional priority is reported as generated.priority-ceiling", async () => {
  const directory = await createFixture({ frontmatter: { priority: "constitutional" } });

  assert.ok((await codes(directory)).includes("generated.priority-ceiling"));
});

test("empty evidence is reported as generated.missing-evidence", async () => {
  const directory = await createFixture({ frontmatter: { evidence: [] } });

  assert.ok((await codes(directory)).includes("generated.missing-evidence"));
});

test("evidence without a digest is reported as generated.missing-evidence", async () => {
  const directory = await createFixture({
    frontmatter: { evidence: [{ claim: "A claim", source: SOURCE_PATH }] },
  });

  assert.ok((await codes(directory)).includes("generated.missing-evidence"));
});

test("two confirmations without the user-correction fast path break the contract", async () => {
  const directory = await createFixture({
    frontmatter: { confirmations: 2, confirmed_by: ["task-1", "task-2"] },
  });

  assert.ok((await codes(directory)).includes("generated.contract-invalid"));
});

test("the user-correction fast path allows a single confirmation", async () => {
  const directory = await createFixture({
    frontmatter: {
      promotion: "user-correction",
      confirmations: 1,
      confirmed_by: ["task-1"],
    },
  });

  assert.deepEqual(await codes(directory), []);
});

test("an evidence source outside the root is reported as generated.unsafe-source", async () => {
  const directory = await createFixture({
    frontmatter: { evidence: [{ claim: "A claim", source: "../outside.ts", digest: SOURCE_DIGEST }] },
  });

  assert.ok((await codes(directory)).includes("generated.unsafe-source"));
});

test("a missing evidence source is reported as generated.missing-source", async () => {
  const directory = await createFixture({
    frontmatter: {
      evidence: [{ claim: "A claim", source: "src/absent.ts", digest: SOURCE_DIGEST }],
    },
  });

  assert.ok((await codes(directory)).includes("generated.missing-source"));
});

test("a changed source is a generated.stale-evidence warning, not an error", async () => {
  const directory = await createFixture({});
  await writeFile(path.join(directory, SOURCE_PATH), "export const app = false;\n", "utf8");

  const diagnostics = await diagnose(directory);

  assert.deepEqual(
    diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.code]),
    [["warning", "generated.stale-evidence"]],
  );
});

test("a confirming task id absent from the ledger is reported", async () => {
  const directory = await createFixture({
    frontmatter: { confirmed_by: ["task-1", "task-2", "task-9"] },
  });

  assert.ok((await codes(directory)).includes("generated.unknown-confirmation"));
});

test("a skill over 15KB is reported as generated.size-exceeded", async () => {
  const directory = await createFixture({ padding: "x".repeat(16_000) });

  assert.ok((await codes(directory)).includes("generated.size-exceeded"));
});

test("more than twelve active skills exceed the budget", async () => {
  const directory = await createFixture({});
  for (let index = 0; index < 12; index += 1) {
    await writeSkill(directory, `extra-${index}`, skillFile({}));
  }

  const budget = (await diagnose(directory)).filter(
    (diagnostic) => diagnostic.code === "generated.budget-exceeded",
  );

  assert.equal(budget.length, 1);
  assert.equal(budget[0]?.severity, "error");
});

test("twelve active skills stay inside the budget", async () => {
  const directory = await createFixture({});
  for (let index = 0; index < 11; index += 1) {
    await writeSkill(directory, `extra-${index}`, skillFile({}));
  }

  assert.deepEqual(await codes(directory), []);
});

test("a retired skill does not consume the active budget", async () => {
  const directory = await createFixture({});
  for (let index = 0; index < 12; index += 1) {
    await writeSkill(directory, `extra-${index}`, skillFile({ status: "retired" }));
  }

  assert.deepEqual(await codes(directory), []);
});

test("a body without an activation section warns as shape.no-trigger", async () => {
  const directory = await createFixture({ body: "## Procedure\n\n1. Run the tests.\n" });

  const diagnostics = await diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "shape.no-trigger"));
  assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === "warning"));
});

test("a cited path with no evidence entry warns as shape.unsourced-claim", async () => {
  const directory = await createFixture({
    body: `## When this applies\n\nWhen changing \`services/api/package.json\`.\n`,
  });

  assert.deepEqual(await codes(directory), ["shape.unsourced-claim"]);
});

test("narrated past events warn as shape.incident-log-shape", async () => {
  const directory = await createFixture({
    body:
      "## When this applies\n\nIn task-141 the suite was red. The container had died and the " +
      "startup probe failed, so we tried a rebuild on 2026-09-14.\n",
  });

  assert.deepEqual(await codes(directory), ["shape.incident-log-shape"]);
});

test("a good body triggers none of the shape heuristics", async () => {
  const directory = await createFixture({});

  assert.deepEqual(await codes(directory), []);
});

interface FixtureOptions {
  readonly frontmatter?: Record<string, unknown>;
  readonly body?: string;
  readonly padding?: string;
  readonly skill?: string;
  readonly ledger?: string | null;
}

async function createFixture(options: FixtureOptions): Promise<string> {
  const directory = await createTempDirectory();
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(path.join(directory, SOURCE_PATH), SOURCE_CONTENT, "utf8");
  if (options.ledger !== null) {
    await mkdir(path.join(directory, ".ai", "tasks"), { recursive: true });
    await writeFile(
      path.join(directory, ".ai", "tasks", "observations.yaml"),
      options.ledger ?? stringifyYaml(ledgerFixture()),
      "utf8",
    );
  }
  await writeSkill(
    directory,
    "api-test-execution",
    options.skill ?? skillFile(options.frontmatter ?? {}, options.body, options.padding),
  );
  return directory;
}

async function writeSkill(
  directory: string,
  skillId: string,
  content: string,
): Promise<void> {
  const skillDirectory = path.join(directory, ".ai", "skills", "project", skillId);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), content, "utf8");
}

function skillFile(
  overrides: Record<string, unknown>,
  body?: string,
  padding?: string,
): string {
  const frontmatter = {
    name: "api-test-execution",
    description: "How to run and debug the API test suite in this repository.",
    version: "1.0.0",
    priority: "skill",
    origin: "generated",
    status: "active",
    generated_at: "2026-09-22",
    verified_at: "2026-09-22",
    confirmations: 3,
    promotion: "threshold",
    confirmed_by: ["task-1", "task-2", "task-3"],
    evidence: [{ claim: "The app entrypoint exports app", source: SOURCE_PATH, digest: SOURCE_DIGEST }],
    supersedes: [],
    ...overrides,
  };
  return `---\n${stringifyYaml(frontmatter)}---\n\n# API Test Execution\n\n${body ?? goodBody()}${padding ?? ""}`;
}

function goodBody(): string {
  return [
    "## When this applies",
    "",
    "When running or debugging the API test suite.",
    "",
    "## When it does not",
    "",
    "For unit tests outside the API module.",
    "",
    "## Required inputs",
    "",
    `- The module entrypoint \`${SOURCE_PATH}\`.`,
    "",
    "## Procedure",
    "",
    "1. Start the suite from the module root.",
    "",
    "## Tools",
    "",
    "The package manager test script.",
    "",
    "## Verification",
    "",
    "The suite reports zero failures.",
    "",
    "## Stop and escalate",
    "",
    "Stop when startup fails twice in a row.",
    "",
    "## Output contract",
    "",
    "A passing suite and the command that produced it.",
    "",
  ].join("\n");
}

function ledgerFixture(): unknown {
  return {
    ...createEmptyLedger(),
    tasks_seen: 3,
    observations: [
      {
        id: "api-test-execution",
        claim: "API tests must run from the module root.",
        kind: "command-behavior",
        sources: [{ path: SOURCE_PATH, digest: SOURCE_DIGEST }],
        confirmed_by: ["task-1", "task-2", "task-3"],
        count: 3,
        origin: "worker-discovery",
        first_seen_at: "2026-09-14",
        last_seen_at: "2026-09-22",
        last_seen_task_index: 3,
        status: "promoted",
      },
    ],
  };
}

function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

async function diagnose(directory: string) {
  return diagnoseGeneratedSkills(new NodeFileSystem(), directory);
}

async function codes(directory: string): Promise<readonly string[]> {
  return (await diagnose(directory)).map((diagnostic) => diagnostic.code);
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-generated-"));
  temporaryDirectories.push(directory);
  return directory;
}
