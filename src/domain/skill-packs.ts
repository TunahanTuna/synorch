export const STACK_FACT_KINDS = [
  "language",
  "framework",
  "package_manager",
  "build_tool",
  "dependency",
  "manifest",
] as const;

export type StackFactKind = (typeof STACK_FACT_KINDS)[number];

/** A normalized discovery fact with enough provenance to explain a selection. */
export interface StackFact {
  readonly kind: StackFactKind;
  readonly value: string;
  readonly source: string;
  readonly confidence: "verified";
}

/** Minimal, provider-neutral input shared by repository and workspace discovery. */
export interface ModuleStackFacts {
  readonly id: string;
  readonly path: string;
  readonly evidence: readonly StackFact[];
}

export type SkillCategory = "base" | "technology";

export interface SkillDefinition {
  readonly id: string;
  readonly category: SkillCategory;
  readonly relativePath: string;
}

export interface SkillPackTrigger {
  readonly kind: StackFactKind;
  readonly values: readonly string[];
}

export interface TechnologySkillPackDefinition {
  readonly id: string;
  readonly skills: readonly SkillDefinition[];
  /** A pack is selected when at least one explicit trigger matches. */
  readonly anyOf: readonly SkillPackTrigger[];
}

export const BASE_SKILLS: readonly SkillDefinition[] = [
  baseSkill("planning"),
  baseSkill("project-discovery"),
  baseSkill("codebase-exploration"),
  baseSkill("implementation"),
  baseSkill("verification"),
  baseSkill("debugging"),
  baseSkill("code-review"),
];

/**
 * Registry order is public behavior: it provides deterministic output independent
 * of module or fact discovery order.
 */
export const TECHNOLOGY_SKILL_PACKS: readonly TechnologySkillPackDefinition[] = [
  technologyPack("typescript", "typescript-patterns", [
    { kind: "language", values: ["typescript"] },
  ]),
  technologyPack("react", "react-patterns", [
    { kind: "framework", values: ["react"] },
  ]),
  technologyPack("java", "java-patterns", [{ kind: "language", values: ["java"] }]),
  technologyPack("spring-boot", "spring-boot-patterns", [
    { kind: "framework", values: ["spring-boot"] },
    {
      kind: "dependency",
      values: [
        "org.springframework.boot:spring-boot",
        "org.springframework.boot:spring-boot-starter",
      ],
    },
  ]),
  technologyPack("jpa", "jpa-patterns", [
    { kind: "framework", values: ["jpa", "hibernate"] },
    {
      kind: "dependency",
      values: [
        "jakarta.persistence:jakarta.persistence-api",
        "org.hibernate.orm:hibernate-core",
        "org.springframework.boot:spring-boot-starter-data-jpa",
      ],
    },
  ]),
  technologyPack("maven", "maven-build", [
    { kind: "build_tool", values: ["maven"] },
    { kind: "manifest", values: ["pom.xml"] },
  ]),
  technologyPack("gradle", "gradle-build", [
    { kind: "build_tool", values: ["gradle"] },
    {
      kind: "manifest",
      values: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    },
  ]),
];

function baseSkill(id: string): SkillDefinition {
  return { id, category: "base", relativePath: `.ai/skills/${id}/SKILL.md` };
}

function technologyPack(
  id: string,
  skillId: string,
  anyOf: readonly SkillPackTrigger[],
): TechnologySkillPackDefinition {
  return {
    id,
    skills: [
      {
        id: skillId,
        category: "technology",
        relativePath: ".ai/skills/technology/" + skillId + "/SKILL.md",
      },
    ],
    anyOf,
  };
}
