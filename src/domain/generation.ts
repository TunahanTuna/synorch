export type PlannedFileKind =
  | "entrypoint"
  | "canonical"
  | "protocol"
  | "agent"
  | "skill"
  | "reference"
  | "schema"
  | "provider";

/**
 * How `init` may write a file that already exists.
 *
 * `overwrite` is the canonical default: the file is generated content, so `--force` refreshes it.
 * `create-only` marks a seed for state the user and the agents own afterwards — the observation
 * ledger is the only one today. It is written when absent and never again, with or without
 * `--force`, because design D12/§9 forbid destroying user-approved state silently.
 */
export type FileWritePolicy = "overwrite" | "create-only";

export interface FileDefinition {
  readonly relativePath: string;
  readonly content: string;
  readonly kind: PlannedFileKind;
  readonly writePolicy?: FileWritePolicy;
}

export type PlannedFileStatus =
  | "create"
  | "unchanged"
  | "conflict"
  | "update"
  /** The file exists and is create-only, so `init` leaves it exactly as it found it. */
  | "preserved";

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
  readonly preserved: readonly string[];
}
