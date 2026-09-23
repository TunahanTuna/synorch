import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  agentManifestSchema,
  CANONICAL_SIZE_CEILINGS,
  skillContractSchema,
  TECHNOLOGY_SKILL_TOKEN,
  type AgentModelTier,
  type AgentReportContract,
} from "../../domain/canonical-contracts.ts";
import { GENERATED_SKILL_DIRECTORY, generatedSkillFrontmatterSchema } from "../../domain/generated-skill.ts";
import { isSafeRelativePath, normalizeRelativePath } from "../../domain/relative-path.ts";
import { BASE_SKILLS } from "../../domain/skill-packs.ts";
import { formatZodIssues } from "../../domain/zod-issues.ts";
import { createStructureFiles } from "../../templates/structure-templates.ts";
import { AGENT_ROLES, CONTROL_PLANE_WRITE_PREFIX, digestText, type AgentRole, type Digest } from "../contracts/index.ts";
import type { ProjectInstructions, SkillCatalog, SkillEntry } from "../context/index.ts";

/**
 * The target repository's canonical Synorch structure (`.ai/`) as runtime input. The constitution
 * and the mandatory core protocols become `project`-trust instruction blocks in registry priority
 * order, agent manifests become role definitions, skills become a catalog (name and description;
 * the body is loaded only when a skill is triggered) and model profiles become router tier hints.
 *
 * Everything is parsed with the generator's own schemas (`src/domain/canonical-contracts.ts`). The
 * text is repository content: it can describe and restrict, never grant. A manifest that asks for
 * more than the harness allows is reported and ignored. Without a `.ai/` directory the built-in
 * defaults `syn init` would write (`src/templates`) are used, and the session says so.
 */

export type CanonicalOrigin = "repository" | "builtin";

export interface RoleDefinition {
  readonly role: AgentRole;
  /** `.ai/agents/<role>/AGENT.md`, or `builtin:` + that path. */
  readonly source: string;
  readonly origin: CanonicalOrigin;
  readonly digest: Digest;
  readonly modelTier: AgentModelTier;
  readonly writesProductFiles: boolean;
  readonly controlPlaneWriteScope: string | undefined;
  readonly allowedSkills: readonly string[];
  readonly forbiddenSkills: readonly string[];
  readonly reports: AgentReportContract;
}

export interface CanonicalSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly kind: "base" | "technology" | "generated";
}

export type ProfileTier = "orchestrator" | "complex_worker" | "fast_worker";

export interface ModelProfileHint {
  readonly profile: string;
  readonly provider: string;
  readonly tier: ProfileTier;
  readonly model: string;
  readonly source: string;
}

export interface CanonicalStructure {
  readonly origin: CanonicalOrigin;
  readonly instructions: ProjectInstructions;
  readonly roles: ReadonlyMap<AgentRole, RoleDefinition>;
  readonly skills: SkillCatalog;
  readonly skillEntries: readonly CanonicalSkill[];
  readonly profiles: readonly ModelProfileHint[];
  readonly protocolIds: readonly string[];
  readonly diagnostics: readonly string[];
}

interface CanonicalReader {
  readonly origin: CanonicalOrigin;
  read(relative: string): Promise<string | undefined>;
  /** Names of the sub-directories of `relative`. */
  directories(relative: string): Promise<readonly string[]>;
}

const MAX_CANONICAL_FILE_BYTES = 64 * 1024;
const PROFILE_TIERS: readonly ProfileTier[] = ["orchestrator", "complex_worker", "fast_worker"];
const PROFILE_PROVIDER_IDS: Readonly<Record<string, string>> = { claude: "anthropic" };
const BASE_SKILL_IDS: ReadonlySet<string> = new Set(BASE_SKILLS.map((skill) => skill.id));
const PRIORITY_RANK: Readonly<Record<string, number>> = { constitutional: 0, core: 1 };
const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set(["explorer", "reviewer"]);

function normalizeLines(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function splitFrontmatter(text: string): { readonly data: unknown; readonly body: string } | { readonly error: string } {
  const lines = normalizeLines(text).split("\n");
  if (lines[0]?.trim() !== "---") return { data: undefined, body: lines.join("\n") };
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) return { error: "frontmatter is never closed with ---" };
  try {
    return { data: parseYaml(lines.slice(1, closing).join("\n")) as unknown, body: lines.slice(closing + 1).join("\n").trim() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function bounded(text: string, ceiling: number, label: string, diagnostics: string[]): string {
  const limit = ceiling * 4;
  if (text.length <= limit) return text;
  diagnostics.push(`${label} is ${text.length} characters (canonical ceiling ${ceiling}); only the first ${limit} are used`);
  return `${text.slice(0, limit)}\n[truncated]`;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function repositoryReader(workspaceRoot: string): CanonicalReader {
  let rootReal: Promise<string> | undefined;
  const resolve = async (relative: string): Promise<string | undefined> => {
    if (!isSafeRelativePath(relative)) return undefined;
    rootReal ??= realpath(workspaceRoot);
    const root = await rootReal;
    const candidate = path.join(workspaceRoot, ...normalizeRelativePath(relative).split("/"));
    const real = await realpath(candidate).catch(() => undefined);
    return real !== undefined && isInside(root, real) ? real : undefined;
  };
  return {
    origin: "repository",
    async read(relative) {
      const file = await resolve(relative);
      if (file === undefined) return undefined;
      const info = await stat(file).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.size > MAX_CANONICAL_FILE_BYTES) return undefined;
      return readFile(file, "utf8").catch(() => undefined);
    },
    async directories(relative) {
      const directory = await resolve(relative);
      if (directory === undefined) return [];
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    },
  };
}

let builtinFiles: ReadonlyMap<string, string> | undefined;

function builtinReader(): CanonicalReader {
  builtinFiles ??= new Map(createStructureFiles("repository").map((file) => [file.relativePath, file.content]));
  const files = builtinFiles;
  return {
    origin: "builtin",
    read: async (relative) => files.get(relative),
    async directories(relative) {
      const prefix = `${relative.replace(/\/$/, "")}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash > 0) names.add(rest.slice(0, slash));
      }
      return [...names].sort();
    },
  };
}

function sourceLabel(reader: CanonicalReader, relative: string): string {
  return reader.origin === "repository" ? relative : `builtin:${relative}`;
}

interface Loaded<T> {
  readonly value: T;
  readonly reader: CanonicalReader;
}

async function firstAvailable<T>(
  readers: readonly CanonicalReader[],
  load: (reader: CanonicalReader) => Promise<T | undefined>,
): Promise<Loaded<T> | undefined> {
  for (const reader of readers) {
    const value = await load(reader);
    if (value !== undefined) return { value, reader };
  }
  return undefined;
}

async function loadConstitution(readers: readonly CanonicalReader[], diagnostics: string[]): Promise<Loaded<string> | undefined> {
  return firstAvailable(readers, async (reader) => {
    const text = await reader.read(".ai/constitution.md");
    if (text === undefined) {
      if (reader.origin === "repository") diagnostics.push(".ai/constitution.md is missing; the built-in constitution is used");
      return undefined;
    }
    return bounded(normalizeLines(text).trim(), CANONICAL_SIZE_CEILINGS.constitution, sourceLabel(reader, ".ai/constitution.md"), diagnostics);
  });
}

interface ProtocolEntry {
  readonly id: string;
  readonly path: string;
  readonly priority: string;
  readonly mandatory: boolean;
}

function parseRegistry(text: string): ProtocolEntry[] | string {
  let data: unknown;
  try {
    data = parseYaml(text) as unknown;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const protocols = (data as { protocols?: unknown } | null)?.protocols;
  if (!Array.isArray(protocols)) return "protocols must be a list";
  const entries: ProtocolEntry[] = [];
  for (const raw of protocols) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.path !== "string") return "every protocol needs an id and a path";
    entries.push({
      id: entry.id,
      path: entry.path,
      priority: typeof entry.priority === "string" ? entry.priority : "project",
      mandatory: entry.mandatory === true,
    });
  }
  return entries;
}

async function loadProtocols(readers: readonly CanonicalReader[], diagnostics: string[]): Promise<Loaded<{ id: string; text: string }[]> | undefined> {
  return firstAvailable(readers, async (reader) => {
    const registry = await reader.read(".ai/protocols/registry.yaml");
    if (registry === undefined) {
      if (reader.origin === "repository") diagnostics.push(".ai/protocols/registry.yaml is missing; the built-in core protocols are used");
      return undefined;
    }
    const entries = parseRegistry(registry);
    if (typeof entries === "string") {
      diagnostics.push(`${sourceLabel(reader, ".ai/protocols/registry.yaml")} is invalid (${entries}); the built-in core protocols are used`);
      return undefined;
    }
    const ordered = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.mandatory)
      .sort((left, right) => (PRIORITY_RANK[left.entry.priority] ?? 2) - (PRIORITY_RANK[right.entry.priority] ?? 2) || left.index - right.index);
    const skipped = entries.length - ordered.length;
    if (skipped > 0) diagnostics.push(`${skipped} non-mandatory protocol(s) are not loaded into every step`);
    const protocols: { id: string; text: string }[] = [];
    for (const { entry } of ordered) {
      const relative = isSafeRelativePath(entry.path) ? normalizeRelativePath(entry.path) : undefined;
      if (relative === undefined || !relative.startsWith(".ai/protocols/")) {
        diagnostics.push(`protocol ${entry.id} points outside .ai/protocols (${entry.path}); ignored`);
        continue;
      }
      const text = await reader.read(relative);
      const parsed = text === undefined ? undefined : splitFrontmatter(text);
      if (parsed === undefined || "error" in parsed) {
        diagnostics.push(`protocol ${entry.id} (${sourceLabel(reader, relative)}) ${parsed === undefined ? "is missing" : `is invalid: ${parsed.error}`}; ignored`);
        continue;
      }
      protocols.push({ id: entry.id, text: bounded(parsed.body, CANONICAL_SIZE_CEILINGS.protocol, sourceLabel(reader, relative), diagnostics) });
    }
    return protocols;
  });
}

interface LoadedRole {
  readonly definition: RoleDefinition;
  readonly body: string;
}

async function loadRole(role: AgentRole, readers: readonly CanonicalReader[], diagnostics: string[]): Promise<LoadedRole | undefined> {
  const relative = `.ai/agents/${role}/AGENT.md`;
  const loaded = await firstAvailable(readers, async (reader) => {
    const text = await reader.read(relative);
    const label = sourceLabel(reader, relative);
    if (text === undefined) {
      if (reader.origin === "repository") diagnostics.push(`${relative} is missing; the built-in ${role} manifest is used`);
      return undefined;
    }
    const parsed = splitFrontmatter(text);
    if ("error" in parsed) {
      diagnostics.push(`${label} has malformed frontmatter (${parsed.error}); the built-in ${role} manifest is used`);
      return undefined;
    }
    const manifest = agentManifestSchema.safeParse(parsed.data);
    if (!manifest.success) {
      diagnostics.push(`${label} is not a valid agent manifest (${formatZodIssues(manifest.error)}); the built-in ${role} manifest is used`.slice(0, 500));
      return undefined;
    }
    if (manifest.data.name !== role) {
      diagnostics.push(`${label} declares name ${manifest.data.name}, not ${role}; the built-in ${role} manifest is used`);
      return undefined;
    }
    return { manifest: manifest.data, body: parsed.body, text, label };
  });
  if (loaded === undefined) return undefined;
  const { manifest, body, text, label } = loaded.value;
  let writes = manifest.writes_product_files;
  if (writes && (READ_ONLY_ROLES.has(role) || role === "orchestrator")) {
    diagnostics.push(`${label} sets writes_product_files: true, but ${role} never writes product files in the harness; ignored (manifests cannot widen policy)`);
    writes = false;
  }
  let scope = manifest.control_plane_write_scope;
  if (scope !== undefined && (role !== "orchestrator" || !normalizeRelativePath(scope).startsWith(CONTROL_PLANE_WRITE_PREFIX))) {
    diagnostics.push(`${label} sets control_plane_write_scope ${scope}, which is not inside ${CONTROL_PLANE_WRITE_PREFIX}** for the orchestrator; ignored`);
    scope = undefined;
  }
  return {
    definition: {
      role,
      source: label,
      origin: loaded.reader.origin,
      digest: digestText(normalizeLines(text)),
      modelTier: manifest.model_tier,
      writesProductFiles: writes,
      controlPlaneWriteScope: scope === undefined ? undefined : normalizeRelativePath(scope),
      allowedSkills: manifest.allowed_skills,
      forbiddenSkills: manifest.forbidden_skills ?? [],
      reports: manifest.reports,
    },
    body: bounded(body, CANONICAL_SIZE_CEILINGS.agentManifest, label, diagnostics),
  };
}

async function loadSkills(readers: readonly CanonicalReader[], diagnostics: string[]): Promise<{ entries: CanonicalSkill[]; reader: CanonicalReader }> {
  for (const reader of readers) {
    const directories = (await reader.directories(".ai/skills")).filter((name) => name !== "project");
    if (directories.length === 0 && reader.origin === "repository") continue;
    const entries: CanonicalSkill[] = [];
    for (const directory of directories) {
      const relative = `.ai/skills/${directory}/SKILL.md`;
      const text = await reader.read(relative);
      if (text === undefined) continue;
      const parsed = splitFrontmatter(text);
      const contract = "error" in parsed ? undefined : skillContractSchema.safeParse(parsed.data);
      if (contract === undefined || !contract.success) {
        diagnostics.push(`${sourceLabel(reader, relative)} is not a valid skill contract; left out of the catalog`);
        continue;
      }
      entries.push({ name: contract.data.name, description: contract.data.description, path: relative, kind: BASE_SKILL_IDS.has(contract.data.name) ? "base" : "technology" });
    }
    for (const directory of await reader.directories(GENERATED_SKILL_DIRECTORY)) {
      const relative = `${GENERATED_SKILL_DIRECTORY}/${directory}/SKILL.md`;
      const text = await reader.read(relative);
      if (text === undefined) continue;
      const parsed = splitFrontmatter(text);
      const frontmatter = "error" in parsed ? undefined : generatedSkillFrontmatterSchema.safeParse(parsed.data);
      if (frontmatter === undefined || !frontmatter.success) {
        diagnostics.push(`${sourceLabel(reader, relative)} is not a valid generated skill; left out of the catalog`);
        continue;
      }
      if (frontmatter.data.status !== "active") continue;
      entries.push({ name: frontmatter.data.name, description: frontmatter.data.description, path: relative, kind: "generated" });
    }
    if (reader.origin === "repository" && entries.length === 0) continue;
    return { entries, reader };
  }
  return { entries: [], reader: readers[readers.length - 1] ?? builtinReader() };
}

async function loadProfiles(readers: readonly CanonicalReader[], diagnostics: string[]): Promise<ModelProfileHint[]> {
  const loaded = await firstAvailable(readers, async (reader) => {
    const text = await reader.read(".ai/manifest.yaml");
    if (text === undefined) return undefined;
    try {
      const manifest = parseYaml(text) as { model_profiles?: Record<string, unknown> } | null;
      return { profiles: manifest?.model_profiles ?? {} };
    } catch (error) {
      diagnostics.push(`${sourceLabel(reader, ".ai/manifest.yaml")} is invalid YAML (${error instanceof Error ? error.message : String(error)}); model profile hints are not available`);
      return { profiles: {} };
    }
  });
  if (loaded === undefined) return [];
  const hints: ModelProfileHint[] = [];
  for (const [profile, location] of Object.entries(loaded.value.profiles)) {
    if (typeof location !== "string" || !isSafeRelativePath(location) || !normalizeRelativePath(location).startsWith(".ai/model-profiles/")) continue;
    const relative = normalizeRelativePath(location);
    const text = await loaded.reader.read(relative);
    if (text === undefined) continue;
    let data: { provider?: unknown; defaults?: Record<string, unknown> } | null;
    try {
      data = parseYaml(text) as typeof data;
    } catch {
      diagnostics.push(`${sourceLabel(loaded.reader, relative)} is invalid YAML; ignored`);
      continue;
    }
    const provider = typeof data?.provider === "string" ? data.provider : profile;
    for (const tier of PROFILE_TIERS) {
      const model = data?.defaults?.[tier];
      if (typeof model === "string" && model.trim() !== "") {
        hints.push({ profile, provider: PROFILE_PROVIDER_IDS[provider] ?? provider, tier, model: model.trim(), source: sourceLabel(loaded.reader, relative) });
      }
    }
  }
  return hints;
}

function roster(roles: ReadonlyMap<AgentRole, RoleDefinition>): string {
  const lines = ["Worker roles defined by the canonical agent manifests (repository text; the harness policy still decides what each role may do):"];
  for (const role of AGENT_ROLES) {
    const definition = roles.get(role);
    if (definition === undefined || role === "orchestrator") continue;
    lines.push(`- ${role}: model tier ${definition.modelTier}, ${definition.writesProductFiles ? "may write its owned paths" : "never writes product files"}, reports ${definition.reports}`);
  }
  return lines.join("\n");
}

function skillVisible(skill: CanonicalSkill, definition: RoleDefinition | undefined): boolean {
  if (definition === undefined) return true;
  if (definition.forbiddenSkills.includes(skill.name)) return false;
  if (definition.allowedSkills.includes(skill.name)) return true;
  return skill.kind !== "base" && definition.allowedSkills.includes(TECHNOLOGY_SKILL_TOKEN);
}

const SKILL_REFERENCE = /\.ai\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/g;

/** Skills a role manifest body points at (`.ai/skills/<name>/SKILL.md`), in order of first mention. */
export function referencedSkills(body: string): readonly string[] {
  return [...new Set([...body.matchAll(SKILL_REFERENCE)].map((match) => match[1] ?? "").filter((name) => name !== ""))];
}

function createCatalog(
  entries: readonly CanonicalSkill[],
  reader: CanonicalReader,
  roles: ReadonlyMap<AgentRole, RoleDefinition>,
  roleTexts: Partial<Record<AgentRole, string>>,
): SkillCatalog {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    primary(role: AgentRole): readonly string[] {
      const definition = roles.get(role);
      return referencedSkills(roleTexts[role] ?? "").filter((name) => {
        const entry = byName.get(name);
        return entry !== undefined && skillVisible(entry, definition);
      });
    },
    list(role?: AgentRole): readonly SkillEntry[] {
      const definition = role === undefined ? undefined : roles.get(role);
      return entries.filter((entry) => skillVisible(entry, definition)).map((entry) => ({ name: entry.name, description: entry.description, triggers: [] }));
    },
    async load(name: string, role?: AgentRole): Promise<string | undefined> {
      const entry = byName.get(name);
      if (entry === undefined || !skillVisible(entry, role === undefined ? undefined : roles.get(role))) return undefined;
      const text = await reader.read(entry.path);
      if (text === undefined) return undefined;
      const parsed = splitFrontmatter(text);
      if ("error" in parsed) return undefined;
      return bounded(`Skill ${entry.name} (${sourceLabel(reader, entry.path)}):\n${parsed.body}`, CANONICAL_SIZE_CEILINGS.skillReference, entry.path, []);
    },
  };
}

const ENTRYPOINT_FILE = "AGENTS.md";

/**
 * The repository's own `AGENTS.md` guidance as a context block, so no worker has to read it with a
 * tool. The unmodified Synorch entrypoint is left out: its substance is the constitution and core
 * protocols (already in context) and its bootstrap steps are the runtime's job.
 */
async function loadEntrypoint(workspaceRoot: string, diagnostics: string[]): Promise<{ path: string; text: string } | undefined> {
  const text = await repositoryReader(workspaceRoot)
    .read(ENTRYPOINT_FILE)
    .catch(() => undefined);
  if (text === undefined) return undefined;
  const normalized = normalizeLines(text).trim();
  const generated = ["AGENTS.md", "CLAUDE.md"].map((file) => builtinFiles?.get(file)).filter((content): content is string => content !== undefined);
  if (normalized === "" || generated.some((content) => normalizeLines(content).trim() === normalized)) return undefined;
  const body = bounded(normalized, CANONICAL_SIZE_CEILINGS.entrypoint, ENTRYPOINT_FILE, diagnostics);
  return {
    path: ENTRYPOINT_FILE,
    text: `Repository entrypoint ${ENTRYPOINT_FILE} (project guidance; host bootstrap steps it lists, such as reading files, confirming a model profile or asking for approval, are performed by the Synorch runtime):\n${body}`,
  };
}

async function hasCanonicalDirectory(workspaceRoot: string): Promise<boolean> {
  const info = await stat(path.join(workspaceRoot, ".ai")).catch(() => undefined);
  return info?.isDirectory() === true;
}

/** Loads the canonical structure of `workspaceRoot`, falling back to the built-in defaults piece by piece. */
export async function loadCanonicalStructure(workspaceRoot: string): Promise<CanonicalStructure> {
  const diagnostics: string[] = [];
  const builtin = builtinReader();
  const present = await hasCanonicalDirectory(workspaceRoot);
  const readers: readonly CanonicalReader[] = present ? [repositoryReader(workspaceRoot), builtin] : [builtin];

  const constitution = await loadConstitution(readers, diagnostics);
  const protocols = await loadProtocols(readers, diagnostics);
  const roles = new Map<AgentRole, RoleDefinition>();
  const roleTexts: Partial<Record<AgentRole, string>> = {};
  for (const role of AGENT_ROLES) {
    const loaded = await loadRole(role, readers, diagnostics);
    if (loaded === undefined) continue;
    roles.set(role, loaded.definition);
    roleTexts[role] = loaded.body;
  }
  if (roleTexts.orchestrator !== undefined) roleTexts.orchestrator = `${roleTexts.orchestrator}\n\n${roster(roles)}`;
  const skills = await loadSkills(readers, diagnostics);
  const profiles = await loadProfiles(readers, diagnostics);
  const entrypoint = await loadEntrypoint(workspaceRoot, diagnostics);

  return {
    origin: present ? "repository" : "builtin",
    instructions: {
      ...(constitution === undefined ? {} : { constitution: constitution.value }),
      protocols: protocols?.value ?? [],
      roles: roleTexts,
      ...(entrypoint === undefined ? {} : { entrypoint }),
    },
    roles,
    skills: createCatalog(skills.entries, skills.reader, roles, roleTexts),
    skillEntries: skills.entries,
    profiles,
    protocolIds: (protocols?.value ?? []).map((protocol) => protocol.id),
    diagnostics,
  };
}

/** One line for the session header and `doctor --runtime`. */
export function describeCanonical(canonical: CanonicalStructure, workspaceRoot: string): string {
  const parts = `constitution ${canonical.instructions.constitution === undefined ? "missing" : "loaded"}, ${canonical.protocolIds.length} core protocol(s), ${canonical.roles.size} role manifest(s), ${canonical.skillEntries.length} skill(s) in the catalog`;
  return canonical.origin === "repository"
    ? `canonical .ai: ${path.join(workspaceRoot, ".ai")} (${parts})`
    : `canonical .ai: none in ${workspaceRoot}; using the built-in Synorch defaults (${parts}); run syn init to customize`;
}

export function describeProfiles(canonical: CanonicalStructure): string | undefined {
  if (canonical.profiles.length === 0) return undefined;
  const byProfile = new Map<string, string[]>();
  for (const hint of canonical.profiles) byProfile.set(hint.profile, [...(byProfile.get(hint.profile) ?? []), `${hint.tier}=${hint.provider}/${hint.model}`]);
  return `model profile hints (not routes): ${[...byProfile.entries()].map(([profile, tiers]) => `${profile} ${tiers.join(" ")}`).join("; ")}`;
}

/** Profile hints for a tier, used to suggest a `--profile` when no route is configured. */
export function profileHintsFor(canonical: CanonicalStructure, tier: ProfileTier): readonly ModelProfileHint[] {
  return canonical.profiles.filter((hint) => hint.tier === tier);
}
