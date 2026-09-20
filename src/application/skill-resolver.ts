import {
  BASE_SKILLS,
  TECHNOLOGY_SKILL_PACKS,
  type ModuleStackFacts,
  type SkillDefinition,
  type StackFact,
} from "../domain/skill-packs.ts";
import { getTechnologySkillTemplate } from "../templates/technology-skill-templates.ts";

export interface MatchedSkillEvidence {
  readonly moduleId: string;
  readonly modulePath: string;
  readonly fact: StackFact;
}

export interface ResolvedSkill extends SkillDefinition {
  readonly packId: string | null;
  readonly content: string | null;
  readonly reasons: readonly string[];
}

export interface SelectedTechnologyPack {
  readonly id: string;
  readonly matchedEvidence: readonly MatchedSkillEvidence[];
  readonly skillIds: readonly string[];
}

export interface SkillResolution {
  readonly baseSkills: readonly ResolvedSkill[];
  readonly technologySkills: readonly ResolvedSkill[];
  readonly allSkills: readonly ResolvedSkill[];
  readonly selectedPacks: readonly SelectedTechnologyPack[];
}

/** Resolve skills solely from explicit module facts; absence of evidence never selects a pack. */
export function resolveSkillPacks(modules: readonly ModuleStackFacts[]): SkillResolution {
  const facts = canonicalFacts(modules);
  const baseSkills = BASE_SKILLS.map<ResolvedSkill>((skill) => ({
    ...skill,
    packId: null,
    content: null,
    reasons: ["Base skill included for every initialized project."],
  }));
  const selectedPacks: SelectedTechnologyPack[] = [];
  const technologySkills: ResolvedSkill[] = [];
  const emittedSkillIds = new Set<string>();

  for (const pack of TECHNOLOGY_SKILL_PACKS) {
    const matchedEvidence = facts.filter((evidence) =>
      pack.anyOf.some(
        (trigger) =>
          trigger.kind === evidence.fact.kind &&
          trigger.values.some((value) => normalize(value) === normalize(evidence.fact.value)),
      ),
    );
    if (matchedEvidence.length === 0) {
      continue;
    }

    const skillIds: string[] = [];
    const reasons = matchedEvidence.map(formatReason);
    for (const skill of pack.skills) {
      if (emittedSkillIds.has(skill.id)) {
        continue;
      }
      emittedSkillIds.add(skill.id);
      skillIds.push(skill.id);
      technologySkills.push({
        ...skill,
        packId: pack.id,
        content: skill.sourceId === null ? getTechnologySkillTemplate(skill.id) : null,
        reasons,
      });
    }
    selectedPacks.push({ id: pack.id, matchedEvidence, skillIds });
  }

  return {
    baseSkills,
    technologySkills,
    allSkills: [...baseSkills, ...technologySkills],
    selectedPacks,
  };
}

function canonicalFacts(modules: readonly ModuleStackFacts[]): readonly MatchedSkillEvidence[] {
  const unique = new Map<string, MatchedSkillEvidence>();
  for (const module of modules) {
    for (const fact of module.evidence) {
      const canonicalFact: StackFact = {
        kind: fact.kind,
        value: normalize(fact.value),
        source: fact.source.trim(),
        confidence: fact.confidence,
      };
      const evidence: MatchedSkillEvidence = {
        moduleId: module.id.trim(),
        modulePath: normalizePath(module.path),
        fact: canonicalFact,
      };
      const key = [
        evidence.moduleId,
        evidence.modulePath,
        canonicalFact.kind,
        normalize(canonicalFact.value),
        canonicalFact.source,
      ].join("\u0000");
      unique.set(key, evidence);
    }
  }
  return [...unique.values()].sort(compareEvidence);
}

function compareEvidence(left: MatchedSkillEvidence, right: MatchedSkillEvidence): number {
  return (
    left.modulePath.localeCompare(right.modulePath) ||
    left.moduleId.localeCompare(right.moduleId) ||
    left.fact.kind.localeCompare(right.fact.kind) ||
    normalize(left.fact.value).localeCompare(normalize(right.fact.value)) ||
    left.fact.source.localeCompare(right.fact.source)
  );
}

function formatReason(evidence: MatchedSkillEvidence): string {
  const location = evidence.modulePath === "." ? evidence.moduleId : evidence.modulePath;
  return `${location}: ${evidence.fact.kind} '${evidence.fact.value}' from ${evidence.fact.source}.`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized || ".";
}
