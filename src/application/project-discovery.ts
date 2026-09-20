import path from "node:path";
import type {
  ProjectEvidence,
  ProjectModule,
  ProjectRecord,
  SkillRegistry,
  StructureScope,
  WorkspaceConfig,
} from "../domain/config.ts";
import { workspaceSchema } from "../domain/config.ts";
import { CliError } from "../domain/errors.ts";
import type { FileSystem } from "../infrastructure/file-system.ts";
import { loadBundledSkillPool } from "../infrastructure/bundled-skill-library.ts";
import { parseYaml, stringifyYaml } from "../infrastructure/serialization.ts";
import { resolveSkillPacks } from "./skill-resolver.ts";

const DISCOVERY_FILES = [
  "Cargo.toml",
  "build.gradle",
  "build.gradle.kts",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pom.xml",
  "pyproject.toml",
  "tsconfig.json",
  "yarn.lock",
] as const;
const DISCOVERY_FILE_NAMES: ReadonlySet<string> = new Set(DISCOVERY_FILES);
const LOCKFILE_PACKAGE_MANAGERS: Readonly<Record<string, string>> = {
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
};
const IGNORED_DIRECTORIES = new Set([
  ".ai",
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const SOURCE_TREE_DIRECTORIES = new Set([
  "generated",
  "generated-sources",
  "generated-test-sources",
  "src",
  "test",
  "tests",
]);
const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERED_DIRECTORIES = 2_000;
const MAX_SOURCE_TREE_DIRECTORIES = 2_000;

export interface SyncResult {
  readonly projects: readonly ProjectRecord[];
  readonly writtenFiles: readonly string[];
}

export interface SyncOptions {
  readonly force?: boolean;
}

interface ProjectIdentity {
  readonly id: string;
  readonly path: string;
}

interface PreparedProject {
  readonly record: ProjectRecord;
  readonly registry: SkillRegistry;
}

export class ProjectDiscoveryService {
  private readonly fileSystem: FileSystem;

  public constructor(fileSystem: FileSystem) {
    this.fileSystem = fileSystem;
  }

  public async sync(targetDirectory: string, options: SyncOptions = {}): Promise<SyncResult> {
    const root = path.resolve(targetDirectory);
    const workspacePath = path.join(root, ".ai", "workspace.yaml");
    await assertSafeGeneratedPath(this.fileSystem, root, workspacePath, ".ai/workspace.yaml");
    if (!(await this.fileSystem.exists(workspacePath))) {
      throw new CliError("Structure is not initialized. Run `syn init` first.", 2);
    }

    const currentWorkspace = workspaceSchema.parse(
      parseYaml(await this.fileSystem.readText(workspacePath)),
    );
    const candidates = await this.findCandidates(root, currentWorkspace.scope);
    const inspectedProjects: Array<Omit<ProjectRecord, "skill_registry">> = [];

    for (const candidate of candidates) {
      const identity = projectIdentity(root, candidate);
      const detectedAt = await this.readPreviousDetectedAt(root, currentWorkspace, identity);
      inspectedProjects.push(await this.inspectProject(root, candidate, detectedAt));
    }
    assertUniqueProjectIdentifiers(inspectedProjects);

    const preparedProjects: PreparedProject[] = [];
    const desiredSkills = new Map<string, string>();
    const bundledPool = await loadBundledSkillPool();
    desiredSkills.set(".ai/skills/catalog.yaml", bundledPool.catalogContent);
    for (const file of bundledPool.files) {
      desiredSkills.set(file.relativePath, file.content);
    }
    for (const inspected of inspectedProjects) {
      const skillRegistryPath = `.ai/projects/${inspected.id}.skills.yaml`;
      const record: ProjectRecord = { ...inspected, skill_registry: skillRegistryPath };
      const skillResolution = resolveSkillPacks(record.modules);
      for (const skill of skillResolution.technologySkills) {
        if (skill.content === null) {
          if (skill.sourceId !== null && desiredSkills.has(skill.relativePath)) continue;
          throw new Error(`Technology skill ${skill.id} has no materializable content.`);
        }
        const existing = desiredSkills.get(skill.relativePath);
        if (
          existing !== undefined &&
          normalizeLineEndings(existing) !== normalizeLineEndings(skill.content)
        ) {
          throw new CliError(`Technology skill output collision at ${skill.relativePath}.`, 2);
        }
        desiredSkills.set(skill.relativePath, skill.content);
      }

      preparedProjects.push({
        record,
        registry: {
          schema_version: 1,
          project_id: record.id,
          base_skills: skillResolution.baseSkills.map((skill) => ({
            id: skill.id,
            relative_path: skill.relativePath,
          })),
          technology_skills: skillResolution.technologySkills.map((skill) => ({
            id: skill.id,
            pack_id: requiredPackId(skill.id, skill.packId),
            source_id: skill.sourceId,
            relative_path: skill.relativePath,
            reasons: [...skill.reasons],
          })),
          selected_packs: skillResolution.selectedPacks.map((pack) => ({
            id: pack.id,
            skill_ids: [...pack.skillIds],
            matched_evidence: pack.matchedEvidence.map((evidence) => ({
              module_id: evidence.moduleId,
              module_path: evidence.modulePath,
              fact: evidence.fact,
            })),
          })),
        },
      });
    }

    const skillWrites: Array<{
      readonly absolutePath: string;
      readonly content: string;
      readonly relativePath: string;
    }> = [];
    for (const [relativePath, content] of [...desiredSkills.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const absolutePath = await resolveSafeGeneratedPath(this.fileSystem, root, relativePath);
      if (await this.fileSystem.exists(absolutePath)) {
        const current = await this.fileSystem.readText(absolutePath);
        if (normalizeLineEndings(current) === normalizeLineEndings(content)) continue;
        if (options.force !== true) {
          throw new CliError(
            `Sync stopped because generated skill file differs: ${relativePath}\nRe-run with --force only after reviewing this file.`,
            2,
          );
        }
      }
      skillWrites.push({ absolutePath, content, relativePath });
    }

    for (const prepared of preparedProjects) {
      await resolveSafeGeneratedPath(
        this.fileSystem,
        root,
        `.ai/projects/${prepared.record.id}.yaml`,
      );
      await resolveSafeGeneratedPath(this.fileSystem, root, prepared.record.skill_registry);
    }
    await resolveSafeGeneratedPath(this.fileSystem, root, ".ai/workspace.yaml");

    const writtenFiles: string[] = [];
    const writtenFileSet = new Set<string>();
    for (const skill of skillWrites) {
      await assertSafeGeneratedPath(
        this.fileSystem,
        root,
        skill.absolutePath,
        skill.relativePath,
      );
      await this.fileSystem.writeText(skill.absolutePath, skill.content);
      addWrittenFile(writtenFiles, writtenFileSet, skill.relativePath);
    }
    for (const prepared of preparedProjects) {
      const recordPath = `.ai/projects/${prepared.record.id}.yaml`;
      await writeIfChanged(
        this.fileSystem,
        root,
        resolveWithinRoot(root, recordPath),
        stringifyYaml(prepared.record),
        recordPath,
        writtenFiles,
        writtenFileSet,
      );
    }

    const projects = preparedProjects.map((item) => item.record);
    const workspace: WorkspaceConfig = {
      schema_version: 1,
      scope: currentWorkspace.scope,
      projects: projects.map((project) => ({
        id: project.id,
        path: project.path,
        record: `.ai/projects/${project.id}.yaml`,
      })),
    };
    await writeIfChanged(
      this.fileSystem,
      root,
      workspacePath,
      stringifyYaml(workspace),
      ".ai/workspace.yaml",
      writtenFiles,
      writtenFileSet,
    );
    for (const prepared of preparedProjects) {
      await writeIfChanged(
        this.fileSystem,
        root,
        resolveWithinRoot(root, prepared.record.skill_registry),
        stringifyYaml(prepared.registry),
        prepared.record.skill_registry,
        writtenFiles,
        writtenFileSet,
      );
    }
    return { projects, writtenFiles };
  }

  private async readPreviousDetectedAt(
    root: string,
    workspace: WorkspaceConfig,
    identity: ProjectIdentity,
  ): Promise<string | undefined> {
    const entry = workspace.projects.find(
      (project) => project.id === identity.id && project.path === identity.path,
    );
    if (entry === undefined) return undefined;
    const recordPath = await resolveSafeGeneratedPath(this.fileSystem, root, entry.record);
    if (!(await this.fileSystem.exists(recordPath))) return undefined;
    let parsed: unknown;
    try {
      parsed = parseYaml(await this.fileSystem.readText(recordPath));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(`Invalid existing project record at ${entry.record}: ${detail}`, 2);
    }
    const record = asRecord(parsed);
    if (record["id"] !== identity.id || record["path"] !== identity.path) {
      throw new CliError(`Existing project record identity mismatch at ${entry.record}.`, 2);
    }
    const detectedAt = record["detected_at"];
    return typeof detectedAt === "string" && !Number.isNaN(Date.parse(detectedAt))
      ? detectedAt
      : undefined;
  }

  private async findCandidates(
    root: string,
    scope: StructureScope,
  ): Promise<readonly string[]> {
    if (scope === "repository") {
      return [root];
    }

    const candidates: string[] = [];
    const entries = [...(await this.fileSystem.list(root))].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const candidate = path.join(root, entry.name);
      if (await this.isProject(candidate)) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  private async isProject(directory: string): Promise<boolean> {
    if (await this.fileSystem.exists(path.join(directory, ".git"))) {
      return true;
    }
    return (await this.findDiscoveryFileNames(directory)).length > 0;
  }

  private async inspectProject(
    root: string,
    directory: string,
    detectedAt?: string,
  ): Promise<Omit<ProjectRecord, "skill_registry">> {
    const { id, path: relativePath } = projectIdentity(root, directory);
    const modules = await this.discoverModules(root, directory);
    assertUniqueModuleIdentifiers(id, modules);

    return {
      id,
      path: relativePath,
      detected_at: detectedAt ?? new Date().toISOString(),
      repository: { git: await this.fileSystem.exists(path.join(directory, ".git")) },
      stack: aggregateStack(modules),
      commands: aggregateCommands(modules),
      manifests: sortedUnique(modules.flatMap((module) => module.manifests)),
      evidence: sortEvidence(modules.flatMap((module) => module.evidence)),
      modules,
    };
  }

  private async discoverModules(root: string, projectDirectory: string): Promise<ProjectModule[]> {
    const directories: Array<{ readonly directory: string; readonly depth: number }> = [
      { directory: projectDirectory, depth: 0 },
    ];
    const modules: ProjectModule[] = [];
    let enqueuedDirectories = 1;

    while (directories.length > 0) {
      const current = directories.shift();
      if (current === undefined) break;
      const discoveryFiles = await this.findDiscoveryFileNames(current.directory);
      if (discoveryFiles.length > 0) {
        modules.push(await this.inspectModule(root, current.directory, discoveryFiles));
      }

      const entries = [...(await this.fileSystem.list(current.directory))].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      const childDirectories: typeof entries = [];
      for (const entry of entries) {
        if (!entry.isDirectory || IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (SOURCE_TREE_DIRECTORIES.has(entry.name)) {
          const sourceTreePath = path.join(current.directory, entry.name);
          if ((await this.findDiscoveryFileNames(sourceTreePath)).length === 0) {
            modules.push(...(await this.discoverModulesInSourceTree(root, sourceTreePath)));
            continue;
          }
        }
        childDirectories.push(entry);
      }
      if (current.depth >= MAX_DISCOVERY_DEPTH) {
        if (childDirectories.length > 0) {
          const relative = normalizeRelativePath(path.relative(root, current.directory) || ".");
          throw new CliError(
            `Project discovery exceeded maximum depth ${MAX_DISCOVERY_DEPTH} at ${relative}.`,
            2,
          );
        }
        continue;
      }
      for (const entry of childDirectories) {
        if (enqueuedDirectories >= MAX_DISCOVERED_DIRECTORIES) {
          throw new CliError(
            `Project discovery exceeded the ${MAX_DISCOVERED_DIRECTORIES}-directory safety limit.`,
            2,
          );
        }
        directories.push({
          directory: path.join(current.directory, entry.name),
          depth: current.depth + 1,
        });
        enqueuedDirectories += 1;
      }
    }

    return modules.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async discoverModulesInSourceTree(
    root: string,
    sourceTree: string,
  ): Promise<ProjectModule[]> {
    const directories = [sourceTree];
    const modules: ProjectModule[] = [];
    let inspectedDirectories = 0;
    while (directories.length > 0) {
      if (inspectedDirectories >= MAX_SOURCE_TREE_DIRECTORIES) {
        const relative = normalizeRelativePath(path.relative(root, sourceTree));
        throw new CliError(
          `Source-tree module scan exceeded ${MAX_SOURCE_TREE_DIRECTORIES} directories at ${relative}.`,
          2,
        );
      }
      const directory = directories.shift();
      if (directory === undefined) break;
      inspectedDirectories += 1;
      const entries = [...(await this.fileSystem.list(directory))].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      const discoveryFiles = entries
        .filter((entry) => !entry.isDirectory && DISCOVERY_FILE_NAMES.has(entry.name))
        .map((entry) => entry.name);
      if (discoveryFiles.length > 0) {
        modules.push(await this.inspectModule(root, directory, discoveryFiles));
      }
      for (const entry of entries) {
        if (entry.isDirectory && !IGNORED_DIRECTORIES.has(entry.name)) {
          directories.push(path.join(directory, entry.name));
        }
      }
    }
    return modules;
  }

  private async findDiscoveryFileNames(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const fileName of DISCOVERY_FILES) {
      if (await this.fileSystem.exists(path.join(directory, fileName))) files.push(fileName);
    }
    return files;
  }

  private async inspectModule(
    root: string,
    directory: string,
    discoveryFiles: readonly string[],
  ): Promise<ProjectModule> {
    const relativePath = normalizeRelativePath(path.relative(root, directory) || ".");
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const buildTools = new Set<string>();
    const commands: ProjectModule["commands"] = {};
    const evidence: ProjectEvidence[] = [];
    let packageJson: Record<string, unknown> | undefined;
    let packageSource: string | undefined;

    for (const fileName of discoveryFiles) {
      const filePath = path.join(directory, fileName);
      const source = normalizeRelativePath(path.relative(root, filePath));
      addEvidence(evidence, "manifest", fileName, source);

      if (fileName === "package.json") {
        languages.add("javascript");
        addEvidence(evidence, "language", "javascript", source);
        packageJson = parsePackageJson(await this.fileSystem.readText(filePath), filePath);
        packageSource = source;
        for (const dependency of Object.keys(allDependencies(packageJson)).sort((left, right) =>
          left.localeCompare(right),
        )) {
          addEvidence(evidence, "dependency", dependency, source);
        }
        if (packageJsonHasTypeScript(packageJson)) {
          languages.add("typescript");
          addEvidence(evidence, "language", "typescript", source);
        }
        for (const framework of detectJavaScriptFrameworks(packageJson)) {
          frameworks.add(framework);
          addEvidence(evidence, "framework", framework, source);
        }
      }

      if (fileName === "tsconfig.json") {
        languages.add("typescript");
        addEvidence(evidence, "language", "typescript", source);
      }

      if (fileName === "pom.xml") {
        languages.add("java");
        buildTools.add("maven");
        addEvidence(evidence, "language", "java", source);
        addEvidence(evidence, "build_tool", "maven", source);
        detectMavenFacts(await this.fileSystem.readText(filePath), frameworks, evidence, source);
        const executable = (await this.fileSystem.exists(path.join(directory, "mvnw")))
          ? "./mvnw"
          : "mvn";
        commands["test"] = verifiedCommand(`${executable} test`, source, relativePath);
        commands["build"] = verifiedCommand(`${executable} verify`, source, relativePath);
      }

      if (fileName === "build.gradle" || fileName === "build.gradle.kts") {
        buildTools.add("gradle");
        addEvidence(evidence, "build_tool", "gradle", source);
        const content = await this.fileSystem.readText(filePath);
        if (detectGradleFacts(content, frameworks, evidence, source)) {
          languages.add("java");
          addEvidence(evidence, "language", "java", source);
        }
        const executable = (await this.fileSystem.exists(path.join(directory, "gradlew")))
          ? "./gradlew"
          : "gradle";
        commands["test"] = verifiedCommand(`${executable} test`, source, relativePath);
        commands["build"] = verifiedCommand(`${executable} build`, source, relativePath);
      }

      if (fileName === "pyproject.toml") {
        languages.add("python");
        addEvidence(evidence, "language", "python", source);
      }
      if (fileName === "Cargo.toml") {
        languages.add("rust");
        buildTools.add("cargo");
        addEvidence(evidence, "language", "rust", source);
        addEvidence(evidence, "build_tool", "cargo", source);
        commands["test"] = verifiedCommand("cargo test", source, relativePath);
        commands["build"] = verifiedCommand("cargo build", source, relativePath);
      }
      if (fileName === "go.mod") {
        languages.add("go");
        addEvidence(evidence, "language", "go", source);
        commands["test"] = verifiedCommand("go test ./...", source, relativePath);
        commands["build"] = verifiedCommand("go build ./...", source, relativePath);
      }
    }

    const packageManager = detectPackageManager(packageJson, discoveryFiles);
    if (packageManager !== null) {
      const managerSource = normalizeRelativePath(
        path.relative(root, path.join(directory, packageManager.sourceFile)),
      );
      addEvidence(evidence, "package_manager", packageManager.value, managerSource);
      if (packageJson !== undefined && packageSource !== undefined) {
        for (const [name] of Object.entries(readScripts(packageJson)).sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          commands[name] = verifiedCommand(
            packageScriptCommand(packageManager.value, name),
            packageSource,
            relativePath,
          );
        }
      }
    }

    return {
      id: createProjectId(relativePath === "." ? path.basename(root) : relativePath),
      path: relativePath,
      manifests: discoveryFiles
        .map((fileName) => normalizeRelativePath(path.relative(root, path.join(directory, fileName))))
        .sort((left, right) => left.localeCompare(right)),
      stack: {
        languages: [...languages].sort((left, right) => left.localeCompare(right)),
        frameworks: [...frameworks].sort((left, right) => left.localeCompare(right)),
        package_manager: packageManager?.value ?? null,
        build_tool: buildTools.size === 1 ? [...buildTools][0] ?? null : null,
      },
      commands: sortCommands(commands),
      evidence: sortEvidence(evidence),
    };
  }
}

function addWrittenFile(paths: string[], seen: Set<string>, relativePath: string): void {
  if (seen.has(relativePath)) return;
  seen.add(relativePath);
  paths.push(relativePath);
}

function requiredPackId(skillId: string, packId: string | null): string {
  if (packId === null) {
    throw new Error("Technology skill " + skillId + " is missing its pack id.");
  }
  return packId;
}

function parsePackageJson(content: string, packagePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid package.json at ${packagePath}: ${detail}`, 2);
  }
}

function packageJsonHasTypeScript(packageJson: Record<string, unknown>): boolean {
  const dependencies = allDependencies(packageJson);
  return "typescript" in dependencies || "tsx" in dependencies || "ts-node" in dependencies;
}

interface DetectedPackageManager {
  readonly value: string;
  readonly sourceFile: string;
}

function detectPackageManager(
  packageJson: Record<string, unknown> | undefined,
  discoveryFiles: readonly string[],
): DetectedPackageManager | null {
  const declared = packageJson?.["packageManager"];
  if (typeof declared === "string") {
    const value = declared.split("@")[0]?.trim();
    if (value !== undefined && value.length > 0) return { value, sourceFile: "package.json" };
  }
  const lockfiles = discoveryFiles
    .map((sourceFile) => ({ sourceFile, value: LOCKFILE_PACKAGE_MANAGERS[sourceFile] }))
    .filter((item): item is DetectedPackageManager => item.value !== undefined);
  const managers = sortedUnique(lockfiles.map((item) => item.value));
  if (managers.length !== 1) return null;
  const value = managers[0];
  const match = lockfiles.find((item) => item.value === value);
  return value === undefined || match === undefined ? null : { value, sourceFile: match.sourceFile };
}

function packageScriptCommand(packageManager: string, scriptName: string): string {
  return packageManager === "npm"
    ? `npm run ${scriptName}`
    : `${packageManager} ${scriptName}`;
}

function detectJavaScriptFrameworks(packageJson: Record<string, unknown>): readonly string[] {
  const dependencies = allDependencies(packageJson);
  const knownFrameworks: Readonly<Record<string, string>> = {
    next: "nextjs",
    react: "react",
    vue: "vue",
    nuxt: "nuxt",
    "@angular/core": "angular",
    express: "express",
    fastify: "fastify",
    "@nestjs/core": "nestjs",
  };
  return Object.entries(knownFrameworks)
    .filter(([dependency]) => dependency in dependencies)
    .map(([, framework]) => framework)
    .sort((left, right) => left.localeCompare(right));
}

function detectMavenFacts(
  content: string,
  frameworks: Set<string>,
  evidence: ProjectEvidence[],
  source: string,
): void {
  const xml = content.replace(/<!--[\s\S]*?-->/g, "");
  const activeXml = removeXmlElementBlocks(
    removeXmlElementBlocks(xml, "dependencyManagement"),
    "pluginManagement",
  );
  const dependencies = extractXmlCoordinates(activeXml, "dependency");
  const plugins = extractXmlCoordinates(activeXml, "plugin");
  const parents = extractXmlCoordinates(xml, "parent");
  for (const coordinate of dependencies) {
    addEvidence(evidence, "dependency", coordinate, source);
  }
  const normalizedDependencies = new Set(dependencies.map((value) => value.toLowerCase()));
  const springBoot =
    [...normalizedDependencies].some((coordinate) => {
      const [group, artifact] = coordinate.split(":");
      return group === "org.springframework.boot" && artifact?.startsWith("spring-boot") === true;
    }) ||
    plugins.some(
      (coordinate) =>
        coordinate.toLowerCase() === "org.springframework.boot:spring-boot-maven-plugin",
    ) ||
    parents.some(
      (coordinate) =>
        coordinate.toLowerCase() === "org.springframework.boot:spring-boot-starter-parent",
    );
  if (springBoot) {
    frameworks.add("spring-boot");
    addEvidence(evidence, "framework", "spring-boot", source);
  }
  if ([...normalizedDependencies].some(isJpaCoordinate)) {
    frameworks.add("jpa");
    addEvidence(evidence, "framework", "jpa", source);
  }
}

function removeXmlElementBlocks(content: string, element: string): string {
  return content.replace(
    new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}>`, "gi"),
    "",
  );
}

function extractXmlCoordinates(content: string, element: string): string[] {
  const coordinates: string[] = [];
  const blocks = new RegExp(`<${element}\\b[^>]*>([\\s\\S]*?)<\\/${element}>`, "gi");
  for (const match of content.matchAll(blocks)) {
    const block = match[1];
    if (block === undefined) continue;
    const group = readXmlElement(block, "groupId");
    const artifact = readXmlElement(block, "artifactId");
    if (group !== null && artifact !== null) coordinates.push(`${group}:${artifact}`);
  }
  return sortedUnique(coordinates);
}

function readXmlElement(content: string, element: string): string | null {
  const match = new RegExp(
    `<${element}\\b[^>]*>\\s*([^<]+?)\\s*<\\/${element}>`,
    "i",
  ).exec(content);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function detectGradleFacts(
  content: string,
  frameworks: Set<string>,
  evidence: ProjectEvidence[],
  source: string,
): boolean {
  const gradle = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  const pluginIds = new Set<string>();
  for (const match of gradle.matchAll(/\bid\s*(?:\(\s*)?["']([^"']+)["']\s*\)?/g)) {
    if (match[1] !== undefined) pluginIds.add(match[1].trim().toLowerCase());
  }
  for (const match of gradle.matchAll(/\bapply\s+plugin\s*:\s*["']([^"']+)["']/g)) {
    if (match[1] !== undefined) pluginIds.add(match[1].trim().toLowerCase());
  }
  if (/(?:^|[\r\n])\s*java\s*(?:[\r\n}]|$)/m.test(gradle)) pluginIds.add("java");

  const dependencies: string[] = [];
  const dependencyPattern =
    /\b(?:api|implementation|compileOnly|runtimeOnly|testImplementation|annotationProcessor)\s*(?:\(\s*)?["']([^"'\r\n]+)["']/g;
  for (const match of gradle.matchAll(dependencyPattern)) {
    const raw = match[1];
    if (raw === undefined || raw.includes("$")) continue;
    const [group, artifact] = raw.split(":");
    if (
      group !== undefined &&
      artifact !== undefined &&
      group.length > 0 &&
      artifact.length > 0
    ) {
      dependencies.push(`${group}:${artifact}`);
    }
  }
  for (const coordinate of sortedUnique(dependencies)) {
    addEvidence(evidence, "dependency", coordinate, source);
  }
  const normalizedDependencies = new Set(dependencies.map((value) => value.toLowerCase()));
  const springBoot =
    pluginIds.has("org.springframework.boot") ||
    [...normalizedDependencies].some((coordinate) => {
      const [group, artifact] = coordinate.split(":");
      return group === "org.springframework.boot" && artifact?.startsWith("spring-boot") === true;
    });
  if (springBoot) {
    frameworks.add("spring-boot");
    addEvidence(evidence, "framework", "spring-boot", source);
  }
  if ([...normalizedDependencies].some(isJpaCoordinate)) {
    frameworks.add("jpa");
    addEvidence(evidence, "framework", "jpa", source);
  }
  return pluginIds.has("java") || pluginIds.has("java-library") || springBoot;
}

function isJpaCoordinate(coordinate: string): boolean {
  return new Set([
    "jakarta.persistence:jakarta.persistence-api",
    "javax.persistence:javax.persistence-api",
    "org.hibernate:hibernate-core",
    "org.hibernate.orm:hibernate-core",
    "org.springframework.boot:spring-boot-starter-data-jpa",
  ]).has(coordinate);
}

function allDependencies(packageJson: Record<string, unknown>): Record<string, unknown> {
  return {
    ...asRecord(packageJson["dependencies"]),
    ...asRecord(packageJson["devDependencies"]),
  };
}

function readScripts(packageJson: Record<string, unknown>): Record<string, string> {
  const scripts = asRecord(packageJson["scripts"]);
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function aggregateStack(modules: readonly ProjectModule[]): ProjectRecord["stack"] {
  const languages = sortedUnique(modules.flatMap((module) => module.stack.languages));
  const frameworks = sortedUnique(modules.flatMap((module) => module.stack.frameworks));
  const packageManagers = sortedUnique(
    modules.flatMap((module) =>
      module.stack.package_manager === null ? [] : [module.stack.package_manager],
    ),
  );
  const buildTools = sortedUnique(
    modules.flatMap((module) => (module.stack.build_tool === null ? [] : [module.stack.build_tool])),
  );
  return {
    languages,
    frameworks,
    package_manager: packageManagers.length === 1 ? packageManagers[0] ?? null : null,
    build_tool: buildTools.length === 1 ? buildTools[0] ?? null : null,
  };
}

function aggregateCommands(modules: readonly ProjectModule[]): ProjectRecord["commands"] {
  const occurrences = new Map<
    string,
    Array<{ module: ProjectModule; value: ProjectModule["commands"][string] }>
  >();
  for (const module of modules) {
    for (const [name, value] of Object.entries(module.commands)) {
      const current = occurrences.get(name) ?? [];
      current.push({ module, value });
      occurrences.set(name, current);
    }
  }

  const commands: ProjectRecord["commands"] = {};
  for (const [name, values] of [...occurrences.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (values.length === 1) {
      const only = values[0];
      if (only !== undefined) commands[name] = only.value;
      continue;
    }
    for (const { module, value } of values.sort((left, right) =>
      left.module.path.localeCompare(right.module.path),
    )) {
      commands[`${module.path}:${name}`] = value;
    }
  }
  return sortCommands(commands);
}

function verifiedCommand(
  value: string,
  source: string,
  cwd: string,
): ProjectModule["commands"][string] {
  return { value, cwd, source, confidence: "verified" };
}

function sortCommands<T extends ProjectModule["commands"]>(commands: T): T {
  return Object.fromEntries(
    Object.entries(commands).sort(([left], [right]) => left.localeCompare(right)),
  ) as T;
}

function addEvidence(
  evidence: ProjectEvidence[],
  kind: ProjectEvidence["kind"],
  value: string,
  source: string,
): void {
  evidence.push({ kind, value, source, confidence: "verified" });
}

function sortEvidence(evidence: readonly ProjectEvidence[]): ProjectEvidence[] {
  const unique = new Map<string, ProjectEvidence>();
  for (const item of evidence) {
    unique.set(`${item.source}\u0000${item.kind}\u0000${item.value}`, item);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.kind.localeCompare(right.kind) ||
      left.value.localeCompare(right.value),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function projectIdentity(root: string, directory: string): ProjectIdentity {
  const relativePath = normalizeRelativePath(path.relative(root, directory) || ".");
  return {
    id: createProjectId(relativePath === "." ? path.basename(root) : relativePath),
    path: relativePath,
  };
}

function assertUniqueProjectIdentifiers(
  projects: ReadonlyArray<{ readonly id: string; readonly path: string }>,
): void {
  const pathsById = new Map<string, string>();
  for (const project of projects) {
    const previousPath = pathsById.get(project.id);
    if (previousPath !== undefined && previousPath !== project.path) {
      throw new CliError(
        `Project id collision: '${project.id}' maps to both '${previousPath}' and '${project.path}'.`,
        2,
      );
    }
    pathsById.set(project.id, project.path);
  }
}

function assertUniqueModuleIdentifiers(
  projectId: string,
  modules: readonly ProjectModule[],
): void {
  const pathsById = new Map<string, string>();
  for (const module of modules) {
    const previousPath = pathsById.get(module.id);
    if (previousPath !== undefined && previousPath !== module.path) {
      throw new CliError(
        `Module id collision in project '${projectId}': '${module.id}' maps to both '${previousPath}' and '${module.path}'.`,
        2,
      );
    }
    pathsById.set(module.id, module.path);
  }
}

function resolveWithinRoot(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new CliError(`Generated path must be relative: ${relativePath}`, 2);
  }
  const resolved = path.resolve(root, relativePath);
  const boundary = path.relative(root, resolved);
  if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    throw new CliError(`Generated path escapes the target directory: ${relativePath}`, 2);
  }
  return resolved;
}

async function resolveSafeGeneratedPath(
  fileSystem: FileSystem,
  root: string,
  relativePath: string,
): Promise<string> {
  const absolutePath = resolveWithinRoot(root, relativePath);
  await assertSafeGeneratedPath(fileSystem, root, absolutePath, relativePath);
  return absolutePath;
}

async function assertSafeGeneratedPath(
  fileSystem: FileSystem,
  root: string,
  absolutePath: string,
  displayPath: string,
): Promise<void> {
  try {
    await fileSystem.assertPathWithinRoot(root, absolutePath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Unsafe generated path '${displayPath}': ${detail}`, 2);
  }
}

async function writeIfChanged(
  fileSystem: FileSystem,
  root: string,
  absolutePath: string,
  content: string,
  relativePath: string,
  writtenFiles: string[],
  writtenFileSet: Set<string>,
): Promise<void> {
  await assertSafeGeneratedPath(fileSystem, root, absolutePath, relativePath);
  if (await fileSystem.exists(absolutePath)) {
    const current = await fileSystem.readText(absolutePath);
    if (normalizeLineEndings(current) === normalizeLineEndings(content)) return;
  }
  await assertSafeGeneratedPath(fileSystem, root, absolutePath, relativePath);
  await fileSystem.writeText(absolutePath, content);
  addWrittenFile(writtenFiles, writtenFileSet, relativePath);
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function createProjectId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "project";
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}
