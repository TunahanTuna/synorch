import path from "node:path";
import {
  manifestSchema,
  modelProfileSchema,
  projectRecordSchema,
  skillRegistrySchema,
  workspaceSchema,
  type ProjectRecord,
  type SkillRegistry,
  type WorkspaceConfig,
} from "../domain/config.ts";
import { BASE_SKILLS } from "../domain/skill-packs.ts";
import type { FileSystem } from "../infrastructure/file-system.ts";
import { parseYaml } from "../infrastructure/serialization.ts";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

const REQUIRED_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".ai/constitution.md",
  ".ai/protocols/registry.yaml",
  ".ai/schemas/context-packet.schema.json",
  ".ai/schemas/completion-packet.schema.json",
] as const;

export class DoctorService {
  private readonly fileSystem: FileSystem;

  public constructor(fileSystem: FileSystem) {
    this.fileSystem = fileSystem;
  }

  public async diagnose(targetDirectory: string): Promise<readonly Diagnostic[]> {
    const root = path.resolve(targetDirectory);
    const diagnostics: Diagnostic[] = [];

    for (const requiredPath of REQUIRED_PATHS) {
      if (!(await this.fileSystem.exists(path.join(root, requiredPath)))) {
        diagnostics.push({
          severity: "error",
          code: "missing-required-file",
          message: `Required structure file is missing: ${requiredPath}`,
          path: requiredPath,
        });
      }
    }

    const manifest = await this.validateYamlFile(
      root,
      ".ai/manifest.yaml",
      manifestSchema,
      diagnostics,
    );
    const workspace = await this.validateYamlFile(
      root,
      ".ai/workspace.yaml",
      workspaceSchema,
      diagnostics,
    );

    const openAi = await this.validateYamlFile(
      root,
      ".ai/model-profiles/openai.yaml",
      modelProfileSchema,
      diagnostics,
    );
    const claude = await this.validateYamlFile(
      root,
      ".ai/model-profiles/claude.yaml",
      modelProfileSchema,
      diagnostics,
    );

    if (manifest?.routing.require_session_confirmation !== true) {
      diagnostics.push({
        severity: "error",
        code: "session-confirmation-disabled",
        message: "Session model-profile confirmation must remain enabled.",
        path: ".ai/manifest.yaml",
      });
    }
    if (manifest?.routing.silent_fallback !== false) {
      diagnostics.push({
        severity: "error",
        code: "silent-fallback-enabled",
        message: "Silent model fallback is forbidden.",
        path: ".ai/manifest.yaml",
      });
    }
    if (openAi && openAi.provider !== "openai") {
      diagnostics.push({
        severity: "error",
        code: "provider-profile-mismatch",
        message: "OpenAI profile declares a different provider.",
        path: ".ai/model-profiles/openai.yaml",
      });
    }
    if (claude && claude.provider !== "claude") {
      diagnostics.push({
        severity: "error",
        code: "provider-profile-mismatch",
        message: "Claude profile declares a different provider.",
        path: ".ai/model-profiles/claude.yaml",
      });
    }

    if (workspace !== undefined) {
      await this.validateWorkspaceChain(root, workspace, diagnostics);
    }

    if (diagnostics.length === 0) {
      diagnostics.push({
        severity: "info",
        code: "healthy",
        message: "The AI orchestration structure is internally consistent.",
      });
    }

    return diagnostics;
  }

  private async validateWorkspaceChain(
    root: string,
    workspace: WorkspaceConfig,
    diagnostics: Diagnostic[],
  ): Promise<void> {
    reportDuplicates(
      workspace.projects.map((project) => project.id),
      "project id",
      "duplicate-project-id",
      diagnostics,
    );
    reportDuplicates(
      workspace.projects.map((project) => normalizeForComparison(project.path)),
      "project path",
      "duplicate-project-path",
      diagnostics,
    );
    reportDuplicates(
      workspace.projects.map((project) => normalizeForComparison(project.record)),
      "project record",
      "duplicate-project-record",
      diagnostics,
    );

    for (const project of workspace.projects) {
      const projectPath = resolveSafeRelativePath(root, project.path);
      if (projectPath === undefined) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-project-path",
          message: `Workspace project path must stay within the target root: ${project.path}`,
          path: ".ai/workspace.yaml",
        });
        continue;
      }
      if (!(await this.isExistingDirectory(projectPath.absolute))) {
        diagnostics.push({
          severity: "error",
          code: "missing-project-directory",
          message: `Workspace project path is not an existing directory: ${project.path}`,
          path: ".ai/workspace.yaml",
        });
        continue;
      }
      if (!(await this.isCanonicalPathWithin(root, projectPath.absolute))) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-project-path",
          message: `Workspace project path escapes the target root: ${project.path}`,
          path: ".ai/workspace.yaml",
        });
        continue;
      }

      const recordPath = resolveSafeRelativePath(root, project.record);
      if (recordPath === undefined) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-project-record-path",
          message: `Workspace project record path must stay within the target root: ${project.record}`,
          path: ".ai/workspace.yaml",
        });
        continue;
      }
      const expectedRecordPath = `.ai/projects/${project.id}.yaml`;
      if (project.record !== expectedRecordPath) {
        diagnostics.push({
          severity: "error",
          code: "noncanonical-project-record-path",
          message:
            `Workspace project record must be exactly '${expectedRecordPath}', received ` +
            `'${project.record}'.`,
          path: ".ai/workspace.yaml",
        });
        continue;
      }
      if (
        !(await this.isExistingRegularFile(recordPath.absolute)) ||
        !(await this.isCanonicalPathWithin(root, recordPath.absolute))
      ) {
        diagnostics.push({
          severity: "error",
          code: "missing-project-record",
          message: `Project record is missing, unsafe, or not a regular file: ${project.record}`,
          path: recordPath.relative,
        });
        continue;
      }

      const record = await this.validateYamlFile(
        root,
        recordPath.relative,
        projectRecordSchema,
        diagnostics,
        {
          missing: "missing-project-record",
          invalid: "invalid-project-record",
          malformed: "malformed-project-record",
        },
      );
      if (record === undefined) continue;

      if (record.id !== project.id) {
        diagnostics.push({
          severity: "error",
          code: "project-record-id-mismatch",
          message: `Project record id '${record.id}' does not match workspace id '${project.id}'.`,
          path: recordPath.relative,
        });
      }
      if (normalizeForComparison(record.path) !== projectPath.comparison) {
        diagnostics.push({
          severity: "error",
          code: "project-record-path-mismatch",
          message: `Project record path '${record.path}' does not match workspace path '${project.path}'.`,
          path: recordPath.relative,
        });
      }

      await this.validateProjectRecordPaths(
        root,
        projectPath.absolute,
        record,
        recordPath.relative,
        diagnostics,
      );
      await this.validateSkillRegistry(root, record, recordPath.relative, diagnostics);
    }
  }

  private async validateProjectRecordPaths(
    root: string,
    projectRoot: string,
    record: ProjectRecord,
    recordPath: string,
    diagnostics: Diagnostic[],
  ): Promise<void> {
    const modulePaths = new Set<string>();
    for (const module of record.modules) {
      const modulePath = resolveSafeRelativePath(root, module.path);
      if (
        modulePath === undefined ||
        !isPathWithin(projectRoot, modulePath.absolute) ||
        !(await this.isCanonicalPathWithin(projectRoot, modulePath.absolute))
      ) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-module-path",
          message: `Module path must stay within its project root: ${module.path}`,
          path: recordPath,
        });
        continue;
      }
      modulePaths.add(modulePath.comparison);
      if (!(await this.isExistingDirectory(modulePath.absolute))) {
        diagnostics.push({
          severity: "error",
          code: "missing-module-directory",
          message: `Module path is not an existing directory: ${module.path}`,
          path: recordPath,
        });
      }

      for (const manifestPath of module.manifests) {
        await this.validateProjectArtifactPath(
          root,
          projectRoot,
          manifestPath,
          recordPath,
          diagnostics,
        );
      }
      for (const evidence of module.evidence) {
        await this.validateProjectArtifactPath(
          root,
          projectRoot,
          evidence.source,
          recordPath,
          diagnostics,
        );
      }
      for (const command of Object.values(module.commands)) {
        await this.validateCommandPaths(
          root,
          projectRoot,
          command.cwd,
          command.source,
          modulePath.comparison,
          recordPath,
          diagnostics,
        );
      }
    }

    for (const manifestPath of record.manifests) {
      await this.validateProjectArtifactPath(
        root,
        projectRoot,
        manifestPath,
        recordPath,
        diagnostics,
      );
    }
    for (const evidence of record.evidence) {
      await this.validateProjectArtifactPath(
        root,
        projectRoot,
        evidence.source,
        recordPath,
        diagnostics,
      );
    }
    for (const command of Object.values(record.commands)) {
      await this.validateCommandPaths(
        root,
        projectRoot,
        command.cwd,
        command.source,
        modulePaths,
        recordPath,
        diagnostics,
      );
    }
  }

  private async validateProjectArtifactPath(
    root: string,
    projectRoot: string,
    candidate: string,
    recordPath: string,
    diagnostics: Diagnostic[],
  ): Promise<void> {
    const artifactPath = resolveSafeRelativePath(root, candidate);
    if (
      artifactPath === undefined ||
      !isPathWithin(projectRoot, artifactPath.absolute) ||
      !(await this.isCanonicalPathWithin(projectRoot, artifactPath.absolute))
    ) {
      diagnostics.push({
        severity: "error",
        code: "unsafe-project-artifact-path",
        message: `Manifest or source path must stay within its project root: ${candidate}`,
        path: recordPath,
      });
      return;
    }
    if (!(await this.isExistingRegularFile(artifactPath.absolute))) {
      diagnostics.push({
        severity: "error",
        code: "missing-project-artifact",
        message: `Manifest or source path is not an existing regular file: ${candidate}`,
        path: recordPath,
      });
    }
  }

  private async validateCommandPaths(
    root: string,
    projectRoot: string,
    cwd: string,
    source: string,
    expectedModulePath: string | ReadonlySet<string>,
    recordPath: string,
    diagnostics: Diagnostic[],
  ): Promise<void> {
    const cwdPath = resolveSafeRelativePath(root, cwd);
    if (
      cwdPath === undefined ||
      !isPathWithin(projectRoot, cwdPath.absolute) ||
      !(await this.isCanonicalPathWithin(projectRoot, cwdPath.absolute))
    ) {
      diagnostics.push({
        severity: "error",
        code: "unsafe-command-cwd",
        message: `Command cwd must stay within its project root: ${cwd}`,
        path: recordPath,
      });
    } else {
      if (!(await this.isExistingDirectory(cwdPath.absolute))) {
        diagnostics.push({
          severity: "error",
          code: "missing-command-cwd",
          message: `Command cwd is not an existing directory: ${cwd}`,
          path: recordPath,
        });
      }
      const matchesModule =
        typeof expectedModulePath === "string"
          ? cwdPath.comparison === expectedModulePath
          : expectedModulePath.has(cwdPath.comparison);
      if (!matchesModule) {
        diagnostics.push({
          severity: "error",
          code: "command-cwd-module-mismatch",
          message: `Command cwd does not match a discovered module path: ${cwd}`,
          path: recordPath,
        });
      }
    }

    await this.validateProjectArtifactPath(
      root,
      projectRoot,
      source,
      recordPath,
      diagnostics,
    );
  }

  private async validateSkillRegistry(
    root: string,
    record: ProjectRecord,
    recordPath: string,
    diagnostics: Diagnostic[],
  ): Promise<void> {
    const registryPath = resolveSafeRelativePath(root, record.skill_registry, ".ai/projects/");
    if (registryPath === undefined) {
      diagnostics.push({
        severity: "error",
        code: "unsafe-skill-registry-path",
        message:
          "Project skill_registry must be a safe relative path under .ai/projects/: " +
          record.skill_registry,
        path: recordPath,
      });
      return;
    }
    if (
      !(await this.isExistingRegularFile(registryPath.absolute)) ||
      !(await this.isCanonicalPathWithin(root, registryPath.absolute))
    ) {
      diagnostics.push({
        severity: "error",
        code: "missing-skill-registry",
        message:
          "Project skill_registry is missing, unsafe, or not a regular file: " +
          record.skill_registry,
        path: registryPath.relative,
      });
      return;
    }

    const registry = await this.validateYamlFile(
      root,
      registryPath.relative,
      skillRegistrySchema,
      diagnostics,
      {
        missing: "missing-skill-registry",
        invalid: "invalid-skill-registry",
        malformed: "malformed-skill-registry",
      },
    );
    if (registry === undefined) return;

    if (registry.project_id !== record.id) {
      diagnostics.push({
        severity: "error",
        code: "skill-registry-project-mismatch",
        message:
          `Skill registry project_id '${registry.project_id}' does not match record id ` +
          `'${record.id}'.`,
        path: registryPath.relative,
      });
    }

    await this.validateRegisteredSkills(root, registry, registryPath.relative, diagnostics);
  }

  private async validateRegisteredSkills(
    root: string,
    registry: SkillRegistry,
    registryPath: string,
    diagnostics: Diagnostic[],
  ): Promise<void> {
    const expectedBaseSkills = new Map(
      BASE_SKILLS.map((skill) => [skill.id, skill.relativePath] as const),
    );
    reportDuplicates(
      registry.base_skills.map((skill) => skill.id),
      "base skill id",
      "duplicate-base-skill-id",
      diagnostics,
      registryPath,
    );
    const registeredBaseSkillIds = new Set(registry.base_skills.map((skill) => skill.id));
    for (const expectedSkill of BASE_SKILLS) {
      if (!registeredBaseSkillIds.has(expectedSkill.id)) {
        diagnostics.push({
          severity: "error",
          code: "missing-base-skill-entry",
          message: `Skill registry is missing canonical base skill '${expectedSkill.id}'.`,
          path: registryPath,
        });
      }
    }
    for (const registeredSkill of registry.base_skills) {
      if (!expectedBaseSkills.has(registeredSkill.id)) {
        diagnostics.push({
          severity: "error",
          code: "unexpected-base-skill-entry",
          message: `Skill registry contains unexpected base skill '${registeredSkill.id}'.`,
          path: registryPath,
        });
      }
    }

    reportDuplicates(
      [
        ...registry.base_skills.map((skill) => normalizeForComparison(skill.relative_path)),
        ...registry.technology_skills.map((skill) =>
          normalizeForComparison(skill.relative_path),
        ),
      ],
      "registry skill path",
      "duplicate-registry-skill-path",
      diagnostics,
      registryPath,
    );

    for (const skill of registry.base_skills) {
      const expectedPath = expectedBaseSkills.get(skill.id);
      if (expectedPath === undefined) continue;
      const skillPath = resolveSafeRelativePath(root, skill.relative_path, ".ai/skills/");
      if (
        skill.relative_path !== expectedPath ||
        skillPath === undefined ||
        normalizeForComparison(skill.relative_path).startsWith(".ai/skills/technology/")
      ) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-base-skill-path",
          message:
            `Base skill '${skill.id}' must use canonical path '${expectedPath}', received ` +
            `'${skill.relative_path}'.`,
          path: registryPath,
        });
        continue;
      }
      if (
        !(await this.isExistingRegularFile(skillPath.absolute)) ||
        !(await this.isCanonicalPathWithin(root, skillPath.absolute))
      ) {
        diagnostics.push({
          severity: "error",
          code: "missing-base-skill",
          message: `Registered base skill is missing or not a regular file: ${skillPath.relative}`,
          path: skillPath.relative,
        });
      }
    }

    for (const skill of registry.technology_skills) {
      const skillPath = resolveSafeRelativePath(
        root,
        skill.relative_path,
        ".ai/skills/technology/",
      );
      if (skillPath === undefined) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-technology-skill-path",
          message:
            "Technology skill path must stay under .ai/skills/technology/: " +
            skill.relative_path,
          path: registryPath,
        });
        continue;
      }
      if (
        !(await this.fileSystem.exists(skillPath.absolute)) ||
        (await this.fileSystem.isDirectory(skillPath.absolute)) ||
        !(await this.isCanonicalPathWithin(root, skillPath.absolute))
      ) {
        diagnostics.push({
          severity: "error",
          code: "missing-technology-skill",
          message: `Registered technology skill is missing: ${skillPath.relative}`,
          path: skillPath.relative,
        });
      }
    }
  }

  private async isExistingDirectory(targetPath: string): Promise<boolean> {
    return (
      (await this.fileSystem.exists(targetPath)) &&
      (await this.fileSystem.isDirectory(targetPath))
    );
  }

  private async isExistingRegularFile(targetPath: string): Promise<boolean> {
    return (
      (await this.fileSystem.exists(targetPath)) &&
      !(await this.fileSystem.isDirectory(targetPath))
    );
  }

  private async isCanonicalPathWithin(root: string, targetPath: string): Promise<boolean> {
    try {
      await this.fileSystem.assertPathWithinRoot(root, targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async validateYamlFile<T>(
    root: string,
    relativePath: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
    diagnostics: Diagnostic[],
    codes: {
      readonly missing: string;
      readonly invalid: string;
      readonly malformed: string;
    } = {
      missing: "missing-config",
      invalid: "invalid-config",
      malformed: "invalid-yaml",
    },
  ): Promise<T | undefined> {
    const absolutePath = path.join(root, relativePath);
    if (!(await this.fileSystem.exists(absolutePath))) {
      diagnostics.push({
        severity: "error",
        code: codes.missing,
        message: `Configuration file is missing: ${relativePath}`,
        path: relativePath,
      });
      return undefined;
    }

    try {
      const result = schema.safeParse(parseYaml(await this.fileSystem.readText(absolutePath)));
      if (result.success) {
        return result.data;
      }
      diagnostics.push({
        severity: "error",
        code: codes.invalid,
        message: result.error.message,
        path: relativePath,
      });
      return undefined;
    } catch (error: unknown) {
      diagnostics.push({
        severity: "error",
        code: codes.malformed,
        message: error instanceof Error ? error.message : String(error),
        path: relativePath,
      });
      return undefined;
    }
  }
}

interface SafeRelativePath {
  readonly relative: string;
  readonly absolute: string;
  readonly comparison: string;
}

function resolveSafeRelativePath(
  root: string,
  candidate: string,
  requiredPrefix?: string,
): SafeRelativePath | undefined {
  if (candidate.includes("\0") || path.win32.parse(candidate).root !== "") return undefined;

  const normalized = normalizeRelativePath(candidate);
  if (path.posix.isAbsolute(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;

  const absolute = path.resolve(root, ...segments);
  const relativeToRoot = path.relative(root, absolute);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(".." + path.sep) ||
    path.isAbsolute(relativeToRoot)
  ) {
    return undefined;
  }

  const comparison = normalizeForComparison(normalized);
  if (
    requiredPrefix !== undefined &&
    !isStrictDescendant(comparison, normalizeForComparison(requiredPrefix))
  ) {
    return undefined;
  }
  return { relative: normalized, absolute, comparison };
}

function isStrictDescendant(candidate: string, directory: string): boolean {
  return candidate.startsWith(directory + "/");
}

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  );
}

function normalizeRelativePath(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/$/, "");
  return normalized || ".";
}

function normalizeForComparison(value: string): string {
  return normalizeRelativePath(value).toLowerCase();
}

function reportDuplicates(
  values: readonly string[],
  label: string,
  code: string,
  diagnostics: Diagnostic[],
  diagnosticPath = ".ai/workspace.yaml",
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key) && !reported.has(key)) {
      diagnostics.push({
        severity: "error",
        code,
        message: `Duplicate ${label}: ${value}`,
        path: diagnosticPath,
      });
      reported.add(key);
    }
    seen.add(key);
  }
}
