import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSkillPacks } from "../src/application/skill-resolver.ts";
import type { ModuleStackFacts, StackFact } from "../src/domain/skill-packs.ts";

test("selects React and TypeScript skills from explicit module evidence", () => {
  const resolution = resolveSkillPacks([
    moduleFacts("web", "frontend", [
      fact("framework", "react", "frontend/package.json#dependencies"),
      fact("language", "typescript", "frontend/tsconfig.json"),
    ]),
  ]);

  assert.deepEqual(skillIds(resolution.technologySkills), [
    "typescript-patterns",
    "react-patterns",
  ]);
  assert.equal(resolution.baseSkills.length, 7);
  assert.ok(resolution.baseSkills.every((skill) => skill.category === "base"));
  assert.match(resolution.technologySkills[0]?.reasons[0] ?? "", /frontend.*tsconfig\.json/);
  assert.match(resolution.technologySkills[1]?.content ?? "", /name: react-patterns/);
  assert.ok(
    resolution.technologySkills.every((skill) =>
      skill.relativePath.startsWith(".ai/skills/technology/"),
    ),
  );
});

test("selects Java, Spring Boot, JPA and Maven skills from verified facts", () => {
  const resolution = resolveSkillPacks([
    moduleFacts("api", "backend", [
      fact("language", "java", "backend/pom.xml"),
      fact("framework", "spring-boot", "backend/pom.xml#parent"),
      fact(
        "dependency",
        "org.springframework.boot:spring-boot-starter-data-jpa",
        "backend/pom.xml#dependencies",
      ),
      fact("manifest", "pom.xml", "backend/pom.xml"),
    ]),
  ]);

  assert.deepEqual(skillIds(resolution.technologySkills), [
    "java-patterns",
    "spring-boot-patterns",
    "jpa-patterns",
    "maven-build",
  ]);
  assert.deepEqual(
    resolution.selectedPacks.map((pack) => pack.id),
    ["java", "spring-boot", "jpa", "maven"],
  );
});

test("does not select technology skills for an unrelated stack", () => {
  const resolution = resolveSkillPacks([
    moduleFacts("service", ".", [
      fact("language", "go", "go.mod"),
      fact("manifest", "go.mod", "go.mod"),
    ]),
  ]);

  assert.deepEqual(resolution.technologySkills, []);
  assert.deepEqual(resolution.selectedPacks, []);
  assert.deepEqual(resolution.allSkills, resolution.baseSkills);
});

test("deduplicates evidence and produces deterministic registry-ordered output", () => {
  const duplicateReact = fact("framework", "React", "frontend/package.json#dependencies");
  const first = resolveSkillPacks([
    moduleFacts("web", "frontend\\", [
      duplicateReact,
      duplicateReact,
      fact("language", "TypeScript", "frontend/tsconfig.json"),
    ]),
    moduleFacts("api", "backend", [
      fact("manifest", "build.gradle.kts", "backend/build.gradle.kts"),
      fact("language", "java", "backend/build.gradle.kts"),
    ]),
  ]);
  const second = resolveSkillPacks([
    moduleFacts("api", "backend", [
      fact("language", "java", "backend/build.gradle.kts"),
      fact("manifest", "build.gradle.kts", "backend/build.gradle.kts"),
    ]),
    moduleFacts("web", "frontend", [
      fact("language", "typescript", "frontend/tsconfig.json"),
      fact("framework", "react", "frontend/package.json#dependencies"),
    ]),
  ]);

  assert.deepEqual(skillIds(first.technologySkills), [
    "typescript-patterns",
    "react-patterns",
    "java-patterns",
    "gradle-build",
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.selectedPacks.find((pack) => pack.id === "react")?.matchedEvidence.length, 1);
  assert.equal(new Set(skillIds(first.allSkills)).size, first.allSkills.length);
});

function moduleFacts(
  id: string,
  path: string,
  evidence: readonly StackFact[],
): ModuleStackFacts {
  return { id, path, evidence };
}

function fact(kind: StackFact["kind"], value: string, source: string): StackFact {
  return { kind, value, source, confidence: "verified" };
}

function skillIds(skills: readonly { readonly id: string }[]): readonly string[] {
  return skills.map((skill) => skill.id);
}
