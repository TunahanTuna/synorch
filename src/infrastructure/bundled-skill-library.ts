import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_SKILLS, SKILL_SOURCES } from "../domain/skill-sources.ts";
import { parseYaml, stringifyYaml } from "./serialization.ts";

export interface BundledSkillFile {
  readonly content: string;
  readonly relativePath: string;
}

export interface BundledSkillPool {
  readonly catalogContent: string;
  readonly files: readonly BundledSkillFile[];
}

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skill-sources",
);

export async function loadBundledSkillPool(): Promise<BundledSkillPool> {
  const files: BundledSkillFile[] = [];
  const catalogSkills: Array<Record<string, unknown>> = [];

  for (const skill of BUNDLED_SKILLS) {
    const sourceDirectory = safeBundledPath(skill.sourceId, "skills", skill.id);
    const skillFiles = await readSkillDirectory(sourceDirectory);
    const entrypoint = skillFiles.find((file) => file.relativePath === "SKILL.md");
    if (entrypoint === undefined) {
      throw new Error(`Bundled skill '${skill.sourceId}/${skill.id}' has no SKILL.md.`);
    }
    const description = readSkillDescription(entrypoint.content, skill.id);
    const targetRoot = `.ai/skills/library/${skill.sourceId}/${skill.id}`;
    for (const file of skillFiles) {
      files.push({
        content: file.content,
        relativePath: `${targetRoot}/${file.relativePath}`,
      });
    }
    catalogSkills.push({
      id: skill.id,
      source_id: skill.sourceId,
      activation: skill.activation,
      availability: "available",
      loaded_by_default: false,
      relative_path: `${targetRoot}/SKILL.md`,
      description,
    });
  }

  return {
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    catalogContent: stringifyYaml({
      schema_version: 1,
      sources: SKILL_SOURCES.map((source) => ({
        id: source.id,
        name: source.name,
        repository: source.repository,
        revision: source.revision,
        license: source.license,
        trust: source.trust,
        notes: source.notes,
      })),
      skills: catalogSkills.sort((left, right) =>
        String(left["id"]).localeCompare(String(right["id"])),
      ),
    }),
  };
}

async function readSkillDirectory(directory: string): Promise<BundledSkillFile[]> {
  const queue: Array<{ readonly absolute: string; readonly relative: string }> = [
    { absolute: directory, relative: "" },
  ];
  const files: BundledSkillFile[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Bundled skill contains a symbolic link: ${entry.name}`);
      }
      const absolute = path.join(current.absolute, entry.name);
      const relative = normalizePath(path.join(current.relative, entry.name));
      if (entry.isDirectory()) {
        queue.push({ absolute, relative });
      } else if (entry.isFile()) {
        files.push({ relativePath: relative, content: await readFile(absolute, "utf8") });
      }
    }
  }
  return files;
}

function readSkillDescription(content: string, skillId: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (match?.[1] === undefined) {
    throw new Error(`Bundled skill '${skillId}' has invalid frontmatter.`);
  }
  const parsed = parseYaml(match[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Bundled skill '${skillId}' frontmatter must be an object.`);
  }
  const description = (parsed as Record<string, unknown>)["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error(`Bundled skill '${skillId}' has no description.`);
  }
  return description.trim();
}

function safeBundledPath(...segments: readonly string[]): string {
  for (const segment of segments) {
    if (!/^[a-z0-9.-]+$/.test(segment)) {
      throw new Error(`Unsafe bundled skill path segment: ${segment}`);
    }
  }
  const resolved = path.resolve(SOURCE_ROOT, ...segments);
  const boundary = path.relative(SOURCE_ROOT, resolved);
  if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    throw new Error(`Bundled skill path escapes source root: ${resolved}`);
  }
  return resolved;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

