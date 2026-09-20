export type PlannedFileKind =
  | "entrypoint"
  | "canonical"
  | "protocol"
  | "agent"
  | "skill"
  | "schema"
  | "provider";

export interface FileDefinition {
  readonly relativePath: string;
  readonly content: string;
  readonly kind: PlannedFileKind;
}

export type PlannedFileStatus = "create" | "unchanged" | "conflict" | "update";

export interface PlannedFile extends FileDefinition {
  readonly status: PlannedFileStatus;
}

export interface GenerationPlan {
  readonly targetDirectory: string;
  readonly scope: "workspace" | "repository";
  readonly files: readonly PlannedFile[];
}

export interface InitResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
}
