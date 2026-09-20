import path from "node:path";
import type { ProjectRecord, StructureScope, WorkspaceConfig } from "../domain/config.ts";
import { workspaceSchema } from "../domain/config.ts";
import { CliError } from "../domain/errors.ts";
import type { FileSystem } from "../infrastructure/file-system.ts";
import { parseYaml, stringifyYaml } from "../infrastructure/serialization.ts";

const MANIFESTS = ["package.json", "pyproject.toml", "pom.xml", "Cargo.toml", "go.mod"] as const;
const IGNORED_DIRECTORIES = new Set([".ai", ".git", "node_modules", "dist", "coverage"]);

export interface SyncResult {
  readonly projects: readonly ProjectRecord[];
  readonly writtenFiles: readonly string[];
}

export class ProjectDiscoveryService {
  private readonly fileSystem: FileSystem;

  public constructor(fileSystem: FileSystem) {
    this.fileSystem = fileSystem;
  }

  public async sync(targetDirectory: string): Promise<SyncResult> {
    const root = path.resolve(targetDirectory);
    const workspacePath = path.join(root, ".ai", "workspace.yaml");
    if (!(await this.fileSystem.exists(workspacePath))) {
      throw new CliError("Structure is not initialized. Run `ai-structure init` first.", 2);
    }

    const currentWorkspace = workspaceSchema.parse(
      parseYaml(await this.fileSystem.readText(workspacePath)),
    );
    const candidates = await this.findCandidates(root, currentWorkspace.scope);
    const projects: ProjectRecord[] = [];
    const writtenFiles: string[] = [];

    for (const candidate of candidates) {
      const record = await this.inspectProject(root, candidate);
      projects.push(record);
      const recordPath = `.ai/projects/${record.id}.yaml`;
      await this.fileSystem.writeText(path.join(root, recordPath), stringifyYaml(record));
      writtenFiles.push(recordPath);
    }

    const workspace: WorkspaceConfig = {
      schema_version: 1,
      scope: currentWorkspace.scope,
      projects: projects.map((project) => ({
        id: project.id,
        path: project.path,
        record: `.ai/projects/${project.id}.yaml`,
      })),
    };
    await this.fileSystem.writeText(workspacePath, stringifyYaml(workspace));
    writtenFiles.push(".ai/workspace.yaml");

    return { projects, writtenFiles };
  }

  private async findCandidates(
    root: string,
    scope: StructureScope,
  ): Promise<readonly string[]> {
    if (scope === "repository") {
      return [root];
    }

    const candidates: string[] = [];
    for (const entry of await this.fileSystem.list(root)) {
      if (!entry.isDirectory || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const candidate = path.join(root, entry.name);
      if (await this.isProject(candidate)) {
        candidates.push(candidate);
      }
    }
    return candidates.sort((left, right) => left.localeCompare(right));
  }

  private async isProject(directory: string): Promise<boolean> {
    if (await this.fileSystem.exists(path.join(directory, ".git"))) {
      return true;
    }
    for (const manifest of MANIFESTS) {
      if (await this.fileSystem.exists(path.join(directory, manifest))) {
        return true;
      }
    }
    return false;
  }

  private async inspectProject(root: string, directory: string): Promise<ProjectRecord> {
    const relativePath = normalizeRelativePath(path.relative(root, directory) || ".");
    const id = createProjectId(relativePath === "." ? path.basename(root) : relativePath);
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const commands: ProjectRecord["commands"] = {};
    let packageManager: string | null = null;

    const packagePath = path.join(directory, "package.json");
    if (await this.fileSystem.exists(packagePath)) {
      languages.add("javascript");
      const packageJson = parsePackageJson(await this.fileSystem.readText(packagePath), packagePath);
      if (packageJsonHasTypeScript(packageJson)) {
        languages.add("typescript");
      }
      packageManager = detectPackageManager(packageJson);
      for (const framework of detectFrameworks(packageJson)) {
        frameworks.add(framework);
      }
      for (const [name, value] of Object.entries(readScripts(packageJson))) {
        commands[name] = {
          value: packageManager === null ? value : `${packageManager} ${name}`,
          source: normalizeRelativePath(path.relative(root, packagePath)),
          confidence: "verified",
        };
      }
    }

    if (await this.fileSystem.exists(path.join(directory, "pyproject.toml"))) languages.add("python");
    if (await this.fileSystem.exists(path.join(directory, "pom.xml"))) languages.add("java");
    if (await this.fileSystem.exists(path.join(directory, "Cargo.toml"))) languages.add("rust");
    if (await this.fileSystem.exists(path.join(directory, "go.mod"))) languages.add("go");

    return {
      id,
      path: relativePath,
      detected_at: new Date().toISOString(),
      repository: { git: await this.fileSystem.exists(path.join(directory, ".git")) },
      stack: {
        languages: [...languages].sort(),
        frameworks: [...frameworks].sort(),
        package_manager: packageManager,
      },
      commands,
    };
  }
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

function detectPackageManager(packageJson: Record<string, unknown>): string | null {
  const packageManager = packageJson["packageManager"];
  if (typeof packageManager === "string") {
    return packageManager.split("@")[0] ?? null;
  }
  return null;
}

function detectFrameworks(packageJson: Record<string, unknown>): readonly string[] {
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
    .map(([, framework]) => framework);
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
