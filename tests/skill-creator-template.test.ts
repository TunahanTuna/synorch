import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUIRED_SKILL_SECTIONS } from "../src/domain/canonical-contracts.ts";
import { GENERATED_SKILL_MAX_BYTES } from "../src/domain/generated-skill.ts";
import {
  OBSERVATION_LEDGER_PATH,
  createEmptyLedger,
  observationLedgerSchema,
} from "../src/domain/observation-ledger.ts";
import { BASE_SKILLS } from "../src/domain/skill-packs.ts";
import { parseFrontmatter } from "../src/infrastructure/frontmatter.ts";
import { parseYaml } from "../src/infrastructure/serialization.ts";
import {
  skillCreatorLedgerFiles,
  skillCreatorReferences,
  skillCreatorSkill,
} from "../src/templates/skill-creator-skill.ts";

const SKILL_MAX_BYTES = 6_000;
const SKILL_PATH = ".ai/skills/skill-creator/SKILL.md";

test("skill-creator is the ninth canonical base skill", () => {
  assert.equal(BASE_SKILLS.length, 9);
  assert.equal(BASE_SKILLS.at(-1)?.id, "skill-creator");
  assert.equal(BASE_SKILLS.at(-1)?.relativePath, SKILL_PATH);
  assert.equal(new Set(BASE_SKILLS.map((skill) => skill.id)).size, BASE_SKILLS.length);
});

test("the skill file stays under 6KB and every reference under 15KB", () => {
  assert.ok(
    Buffer.byteLength(skillCreatorSkill, "utf8") <= SKILL_MAX_BYTES,
    `SKILL.md is ${Buffer.byteLength(skillCreatorSkill, "utf8")} bytes`,
  );
  for (const reference of skillCreatorReferences) {
    assert.ok(
      Buffer.byteLength(reference.content, "utf8") <= GENERATED_SKILL_MAX_BYTES,
      `${reference.fileName} is ${Buffer.byteLength(reference.content, "utf8")} bytes`,
    );
  }
});

test("the skill satisfies the Canonical Skill Contract shape", () => {
  const document = parseFrontmatter(skillCreatorSkill);
  assert.equal(document.kind, "parsed");
  const frontmatter = document.data;

  assert.equal(frontmatter["name"], "skill-creator");
  assert.equal(frontmatter["version"], "1.0.0");
  assert.match(String(frontmatter["description"]), /observation/i);
  assert.match(String(frontmatter["not_for"]), /trivial|first session/i);
  assert.equal(frontmatter["priority"], undefined);
  for (const section of REQUIRED_SKILL_SECTIONS) {
    assert.match(document.body, new RegExp(`^## ${section}$`, "m"), section);
  }
  assert.match(document.body, /^1\. /m);
});

test("every declared reference is materialized beside the skill", () => {
  const document = parseFrontmatter(skillCreatorSkill);
  assert.equal(document.kind, "parsed");
  const declared = document.data["references"] as readonly string[];
  const fileNames = new Set(skillCreatorReferences.map((reference) => reference.fileName));

  assert.ok(declared.length > 0);
  assert.equal(declared.length, skillCreatorReferences.length);
  for (const reference of declared) {
    assert.ok(!reference.includes(".."), reference);
    assert.ok(reference.startsWith("references/"), reference);
    assert.ok(fileNames.has(reference.slice("references/".length)), reference);
  }
});

test("the skill encodes the load-bearing rules of the design", () => {
  const content = skillCreatorSkill;

  assert.match(content, /No source, no observation/);
  assert.match(content, /distinct/i);
  assert.match(content, /count. 3|\bthree\b/i);
  assert.match(content, /user correction/i);
  assert.match(content, /permanent/);
  assert.match(content, /12/);
  assert.match(content, /independent reviewer/i);
  assert.match(content, /RETIRED\.md/);
  assert.match(content, /priority: skill/);
  assert.match(content, /never overrides a core protocol/);
  assert.match(content, /\.ai\/tasks\/observations\.yaml/);
});

test("the reference files explain the two counters and the ledger example", () => {
  const ledgerReference =
    skillCreatorReferences.find((reference) => reference.fileName === "observation-ledger.md")
      ?.content ?? "";

  assert.match(ledgerReference, /tasks_seen/);
  assert.match(ledgerReference, /last_seen_task_index/);
  assert.match(ledgerReference, /tasks_seen - last_seen_task_index >= 20/);
  assert.match(ledgerReference, /90 days/);
  assert.match(ledgerReference, /confirmed_by: \[task-141, task-156, task-173\]/);
});

test("the seeded ledger is an empty, schema-valid ledger", () => {
  const seed = parseYaml(contentOf(OBSERVATION_LEDGER_PATH));

  assert.deepEqual(seed, createEmptyLedger());
  assert.equal(observationLedgerSchema.safeParse(seed).success, true);
});

test("the tasks gitignore keeps the ledger and ignores working directories", () => {
  const ignore = contentOf(".ai/tasks/.gitignore");

  assert.match(ignore, /^\*$/m);
  assert.match(ignore, /^!observations\.yaml$/m);
  assert.match(ignore, /^!\.gitkeep$/m);
  assert.match(ignore, /^!\.gitignore$/m);
});

test("every ledger file is canonical and ends with a newline", () => {
  for (const file of skillCreatorLedgerFiles) {
    assert.equal(file.kind, "canonical", file.relativePath);
    assert.ok(file.content.endsWith("\n"), file.relativePath);
  }
  assert.equal(
    new Set(skillCreatorLedgerFiles.map((file) => file.relativePath)).size,
    skillCreatorLedgerFiles.length,
  );
});

function contentOf(relativePath: string): string {
  const file = skillCreatorLedgerFiles.find((entry) => entry.relativePath === relativePath);
  assert.ok(file, relativePath);
  return file.content;
}
