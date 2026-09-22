import type { AgentRole } from "../contracts/index.ts";

/**
 * Skill catalog (progressive disclosure). Every step sees the one-line catalog; the full SKILL.md
 * body is loaded only for a skill whose name or trigger phrase appears in the task text. A catalog
 * may scope both to the requesting role (e.g. an agent manifest's allowed and forbidden skills).
 */

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
}

export interface SkillCatalog {
  list(role?: AgentRole): readonly SkillEntry[] | Promise<readonly SkillEntry[]>;
  /** The full SKILL.md text, or undefined when the skill cannot be loaded (or is not for `role`). */
  load(name: string, role?: AgentRole): Promise<string | undefined>;
}

export function renderCatalog(entries: readonly SkillEntry[]): string {
  return [
    "Available skills (catalog only; a skill's full instructions are provided when it is triggered):",
    ...entries.map((entry) => `- ${entry.name}: ${entry.description}`),
  ].join("\n");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = phrase.trim().toLowerCase();
  return needle.length > 0 && haystack.includes(needle);
}

export function triggeredSkills(entries: readonly SkillEntry[], text: string): readonly SkillEntry[] {
  const haystack = text.toLowerCase();
  return entries.filter((entry) => containsPhrase(haystack, entry.name) || entry.triggers.some((trigger) => containsPhrase(haystack, trigger)));
}
