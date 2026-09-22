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
  "build.gradle.kts",
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
    const absolutePaths = new Map<string, string>();
    for (const definition of definitions) {
      absolutePaths.set(
        definition.relativePath,
        await resolveSafeInitPath(this.fileSystem, resolvedTarget, definition.relativePath),
      );
    }

    for (const definition of definitions) {
      const absolutePath = absolutePaths.get(definition.relativePath);
      if (absolutePath === undefined) throw new Error("Missing preflighted initialization path.");
      if (!(await this.fileSystem.exists(absolutePath))) {
        files.push({ ...definition, status: "create" });
        continue;
      }

      if (definition.writePolicy === "create-only") {
        files.push({ ...definition, status: "preserved" });
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

    const absolutePaths = new Map<string, string>();
    for (const file of plan.files) {
      absolutePaths.set(
        file.relativePath,
        await resolveSafeInitPath(this.fileSystem, plan.targetDirectory, file.relativePath),
      );
    }

    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const preserved: string[] = [];

    for (const file of plan.files) {
      if (file.status === "unchanged") {
        unchanged.push(file.relativePath);
        continue;
      }
      if (file.status === "preserved") {
        preserved.push(file.relativePath);
        continue;
      }

      const absolutePath = absolutePaths.get(file.relativePath);
      if (absolutePath === undefined) throw new Error("Missing preflighted initialization path.");
      await assertSafeInitPath(
        this.fileSystem,
        plan.targetDirectory,
        absolutePath,
        file.relativePath,
      );
      await this.fileSystem.writeText(absolutePath, file.content);

      if (file.status === "create") {
        created.push(file.relativePath);
      } else {
        updated.push(file.relativePath);
      }
    }

    return { created, updated, unchanged, preserved };
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

async function resolveSafeInitPath(
  fileSystem: FileSystem,
  root: string,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new CliError(`Initialization path must be relative: ${relativePath}`, 2);
  }
  const absolutePath = path.resolve(root, relativePath);
  const boundary = path.relative(root, absolutePath);
  if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    throw new CliError(`Initialization path escapes the target directory: ${relativePath}`, 2);
  }
  await assertSafeInitPath(fileSystem, root, absolutePath, relativePath);
  return absolutePath;
}

async function assertSafeInitPath(
  fileSystem: FileSystem,
  root: string,
  absolutePath: string,
  displayPath: string,
): Promise<void> {
  try {
    await fileSystem.assertPathWithinRoot(root, absolutePath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Unsafe initialization path '${displayPath}': ${detail}`, 2);
  }
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}
