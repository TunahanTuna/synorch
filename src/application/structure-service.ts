import path from "node:path";
import { CliError } from "../domain/errors.ts";
import type {
  GenerationPlan,
  InitResult,
  PlannedFile,
} from "../domain/generation.ts";
import type { StructureScope } from "../domain/config.ts";
import type { FileSystem } from "../infrastructure/file-system.ts";
import { createStructureFiles } from "../templates/structure-templates.ts";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "Cargo.toml",
  "go.mod",
] as const;

export class StructureService {
  private readonly fileSystem: FileSystem;

  public constructor(fileSystem: FileSystem) {
    this.fileSystem = fileSystem;
  }

  public async createPlan(
    targetDirectory: string,
    requestedScope?: StructureScope,
    allowUpdates = false,
  ): Promise<GenerationPlan> {
    const resolvedTarget = path.resolve(targetDirectory);
    if (!(await this.fileSystem.isDirectory(resolvedTarget))) {
      throw new CliError(`Target is not an existing directory: ${resolvedTarget}`);
    }

    const scope = requestedScope ?? (await this.detectScope(resolvedTarget));
    const definitions = createStructureFiles(scope);
    const files: PlannedFile[] = [];

    for (const definition of definitions) {
      const absolutePath = path.join(resolvedTarget, definition.relativePath);
      if (!(await this.fileSystem.exists(absolutePath))) {
        files.push({ ...definition, status: "create" });
        continue;
      }

      const currentContent = await this.fileSystem.readText(absolutePath);
      files.push({
        ...definition,
        status:
          normalizeLineEndings(currentContent) === normalizeLineEndings(definition.content)
            ? "unchanged"
            : allowUpdates
              ? "update"
              : "conflict",
      });
    }

    return { targetDirectory: resolvedTarget, scope, files };
  }

  public async initialize(plan: GenerationPlan): Promise<InitResult> {
    const conflicts = plan.files.filter((file) => file.status === "conflict");
    if (conflicts.length > 0) {
      const paths = conflicts.map((file) => `- ${file.relativePath}`).join("\n");
      throw new CliError(
        `Initialization stopped because existing files differ:\n${paths}\nRun inspect first and use --force only after reviewing these paths.`,
        2,
      );
    }

    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];

    for (const file of plan.files) {
      if (file.status === "unchanged") {
        unchanged.push(file.relativePath);
        continue;
      }

      await this.fileSystem.writeText(
        path.join(plan.targetDirectory, file.relativePath),
        file.content,
      );

      if (file.status === "create") {
        created.push(file.relativePath);
      } else {
        updated.push(file.relativePath);
      }
    }

    return { created, updated, unchanged };
  }

  private async detectScope(targetDirectory: string): Promise<StructureScope> {
    for (const marker of PROJECT_MARKERS) {
      if (await this.fileSystem.exists(path.join(targetDirectory, marker))) {
        return "repository";
      }
    }
    return "workspace";
  }
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}
