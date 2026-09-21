import assert from "node:assert/strict";
import { test } from "node:test";
import { BUNDLED_SKILLS, SKILL_SOURCES } from "../src/domain/skill-sources.ts";
import { loadBundledSkillPool } from "../src/infrastructure/bundled-skill-library.ts";
import { parseYaml } from "../src/infrastructure/serialization.ts";

test("bundles the complete Ingenium skill pool with provenance", async () => {
  const pool = await loadBundledSkillPool();
  const catalog = parseYaml(pool.catalogContent) as {
    readonly skills: ReadonlyArray<Record<string, unknown>>;
    readonly sources: ReadonlyArray<Record<string, unknown>>;
  };

  assert.equal(BUNDLED_SKILLS.length, 32);
  assert.equal(catalog.skills.length, 32);
  assert.equal(catalog.sources.length, 4);
  assert.ok(
    pool.files.some(
      (file) =>
        file.relativePath === ".ai/skills/library/ingenium/node-backend/reference.md",
    ),
  );
  assert.ok(
    pool.files.some(
      (file) =>
        file.relativePath ===
        ".ai/skills/library/ingenium/session-recap/scripts/extract_session.py",
    ),
  );
  assert.ok(
    catalog.skills.every(
      (skill) =>
        typeof skill["description"] === "string" &&
        String(skill["description"]).length > 20,
    ),
  );
  assert.ok(
    catalog.skills.every(
      (skill) => skill["availability"] === "available" && skill["loaded_by_default"] === false,
    ),
  );
  assert.ok(!catalog.skills.some((skill) => skill["id"] === "task-conductor"));
});

test("pins researched external sources without auto-trusting their content", () => {
  const references = SKILL_SOURCES.filter((source) => source.trust === "reference-only");

  assert.deepEqual(
    references.map((source) => source.id),
    ["anthropic-skills", "superpowers", "microsoft-skills"],
  );
  assert.ok(references.every((source) => /^[a-f0-9]{40}$/.test(source.revision)));
  assert.ok(references.every((source) => source.repository?.startsWith("https://github.com/")));
});

