import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentManifestSchema,
  skillContractSchema,
  REQUIRED_AGENT_SECTIONS,
  REQUIRED_SKILL_SECTIONS,
} from "../src/domain/canonical-contracts.ts";
import {
  normalizeSectionName,
  parseFrontmatter,
  splitMarkdownSections,
} from "../src/infrastructure/frontmatter.ts";

test("frontmatter parsing separates the YAML mapping from the body", () => {
  const result = parseFrontmatter("---\nname: planning\nversion: 1.0.0\n---\n\n# Planning\n\nBody.\n");

  assert.equal(result.kind, "parsed");
  if (result.kind !== "parsed") return;
  assert.equal(result.data["name"], "planning");
  assert.match(result.body, /^\n# Planning/);
});

test("frontmatter parsing reports a missing block instead of guessing", () => {
  assert.equal(parseFrontmatter("# Planning\n").kind, "missing");
  assert.equal(parseFrontmatter("").kind, "missing");
});

test("frontmatter parsing reports unclosed, unparseable and non-mapping blocks", () => {
  assert.equal(parseFrontmatter("---\nname: planning\n").kind, "malformed");
  assert.equal(parseFrontmatter("---\nname: [unclosed\n---\n").kind, "malformed");
  assert.equal(parseFrontmatter("---\n- one\n- two\n---\n").kind, "malformed");
});

test("frontmatter parsing tolerates Windows line endings", () => {
  const result = parseFrontmatter("---\r\nname: planning\r\n---\r\n\r\n## Procedure\r\n");

  assert.equal(result.kind, "parsed");
  if (result.kind !== "parsed") return;
  assert.equal(result.data["name"], "planning");
  assert.ok(splitMarkdownSections(result.body).has("procedure"));
});

test("section splitting keys by normalized heading and ignores fenced headings", () => {
  const sections = splitMarkdownSections(
    ["## Procedure", "1. First", "", "```", "## Tools", "```", "", "## Tools", "- Read"].join("\n"),
  );

  assert.deepEqual([...sections.keys()], ["procedure", "tools"]);
  assert.equal(sections.get("tools"), "- Read");
  assert.match(sections.get("procedure") ?? "", /^1\. First/);
  assert.equal(normalizeSectionName("  Stop and escalate: "), "stop and escalate");
});

test("skill contract requires kebab-case name, semver version and defaults priority", () => {
  const parsed = skillContractSchema.safeParse({
    name: "code-review",
    description: "Use for independent review.",
    version: "1.0.0",
  });

  assert.ok(parsed.success);
  assert.equal(parsed.data.priority, "skill");
  assert.equal(skillContractSchema.safeParse({ name: "Code Review", description: "d", version: "1.0.0" }).success, false);
  assert.equal(skillContractSchema.safeParse({ name: "code-review", description: "d", version: "1.0" }).success, false);
  assert.equal(skillContractSchema.safeParse({ name: "code-review", version: "1.0.0" }).success, false);
});

test("skill contract stays extendable for generated-skill metadata", () => {
  const extended = skillContractSchema.extend({ origin: skillContractSchema.shape.name });

  const parsed = extended.safeParse({
    name: "generated-skill",
    description: "Use for generated work.",
    version: "1.0.0",
    origin: "skill-creator",
  });

  assert.ok(parsed.success);
  assert.equal(parsed.data.origin, "skill-creator");
});

test("agent manifest requires authority, tier, skills and a report contract", () => {
  const valid = {
    name: "implementer",
    role: "product-change",
    writes_product_files: true,
    model_tier: "any",
    allowed_skills: ["implementation"],
    reports: "completion-packet",
  };

  assert.ok(agentManifestSchema.safeParse(valid).success);
  assert.equal(agentManifestSchema.safeParse({ ...valid, model_tier: "genius" }).success, false);
  assert.equal(agentManifestSchema.safeParse({ ...valid, reports: "chat" }).success, false);
  assert.equal(agentManifestSchema.safeParse({ ...valid, allowed_skills: [] }).success, false);
  assert.equal(
    agentManifestSchema.safeParse({ ...valid, writes_product_files: "true" }).success,
    false,
  );
});

test("required section lists stay distinct and normalized", () => {
  for (const sections of [REQUIRED_SKILL_SECTIONS, REQUIRED_AGENT_SECTIONS]) {
    const normalized = sections.map(normalizeSectionName);
    assert.equal(new Set(normalized).size, normalized.length);
  }
  assert.ok(REQUIRED_SKILL_SECTIONS.includes("Output contract"));
  assert.ok(REQUIRED_AGENT_SECTIONS.includes("Completion conditions"));
});
