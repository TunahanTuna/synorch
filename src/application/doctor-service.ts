import path from "node:path";
import { manifestSchema, modelProfileSchema, workspaceSchema } from "../domain/config.ts";
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
    await this.validateYamlFile(root, ".ai/workspace.yaml", workspaceSchema, diagnostics);

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

    if (diagnostics.length === 0) {
      diagnostics.push({
        severity: "info",
        code: "healthy",
        message: "The AI orchestration structure is internally consistent.",
      });
    }

    return diagnostics;
  }

  private async validateYamlFile<T>(
    root: string,
    relativePath: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
    diagnostics: Diagnostic[],
  ): Promise<T | undefined> {
    const absolutePath = path.join(root, relativePath);
    if (!(await this.fileSystem.exists(absolutePath))) {
      diagnostics.push({
        severity: "error",
        code: "missing-config",
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
        code: "invalid-config",
        message: result.error.message,
        path: relativePath,
      });
      return undefined;
    } catch (error: unknown) {
      diagnostics.push({
        severity: "error",
        code: "invalid-yaml",
        message: error instanceof Error ? error.message : String(error),
        path: relativePath,
      });
      return undefined;
    }
  }
}
