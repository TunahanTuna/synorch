import { z } from "zod";
import {
  digestOf,
  hasReservedSegment,
  matchesAnyPathPattern as matchesAny,
  normalizedActionSchema,
  toolMetadataSchema,
  type NormalizedAction,
  type Tool,
  type ToolErrorCode,
  type ToolExecutionContext,
  type ToolMetadata,
  type ToolResult,
} from "../../contracts/index.ts";
import { resolveWorkspacePath, ToolScopeViolation } from "../workspace-path.ts";

export type BuiltinMetadataFields = Omit<ToolMetadata, "version" | "source" | "effect_source">;

export function builtinMetadata(fields: BuiltinMetadataFields): ToolMetadata {
  return toolMetadataSchema.parse({ version: "1.0.0", source: "builtin", effect_source: "builtin", ...fields });
}

export interface ToolImplementation<Input> {
  normalize(input: Input, context: ToolExecutionContext): Promise<NormalizedAction>;
  execute(input: Input, context: ToolExecutionContext): Promise<ToolResult>;
}

export function defineTool<Input>(metadata: ToolMetadata, input: z.ZodType<Input>, implementation: ToolImplementation<Input>): Tool<Input> {
  const inputSchema = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    metadata,
    input,
    descriptor: () => ({ name: metadata.name, description: metadata.description, input_schema: inputSchema }),
    normalize: (value, context) => implementation.normalize(value, context),
    execute: (value, context) => implementation.execute(value, context),
  };
}

export interface ActionFields {
  readonly paths?: NormalizedAction["paths"];
  readonly command?: NormalizedAction["command"];
  readonly networkHosts?: readonly string[];
  readonly destructive?: boolean;
  readonly effect?: NormalizedAction["effect"];
}

/** The canonical action; `args_digest` binds approvals to the exact arguments. */
export function actionOf(metadata: ToolMetadata, input: unknown, context: ToolExecutionContext, fields: ActionFields = {}): NormalizedAction {
  return normalizedActionSchema.parse({
    tool_name: metadata.name,
    tool_version: metadata.version,
    effect: fields.effect ?? metadata.effect,
    role: context.role,
    task_id: context.taskId,
    args_digest: digestOf(input),
    paths: fields.paths ?? [],
    command: fields.command,
    network_hosts: fields.networkHosts ?? [],
    destructive: fields.destructive ?? false,
  });
}

export function okResult(text: string, extra: Partial<Omit<ToolResult, "status" | "text" | "error">> = {}): ToolResult {
  return { status: "ok", text, truncated: false, redactions: 0, ...extra };
}

export function errorResult(code: ToolErrorCode, message: string, extra: Partial<Omit<ToolResult, "status" | "error">> = {}): ToolResult {
  return { status: "error", text: "", truncated: false, redactions: 0, ...extra, error: { code, message: message.slice(0, 2000) } };
}

/**
 * Remembers what `normalize` resolved for a call, so `execute` can prove the path it is about to
 * touch is still the one the policy evaluated (TOCTOU). Bounded so denied calls cannot grow it.
 */
export class NormalizedMemo<T> {
  private readonly entries = new Map<string, T>();
  private readonly capacity: number;

  public constructor(capacity = 1024) {
    this.capacity = capacity;
  }

  public remember(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  public take(key: string): T | undefined {
    const value = this.entries.get(key);
    this.entries.delete(key);
    return value;
  }
}

/**
 * Action-time re-resolution of a write target: it must resolve to exactly the canonical path the
 * policy approved, still be inside the write scope and outside forbidden/reserved paths.
 */
export async function recheckWritePath(context: ToolExecutionContext, candidate: string, approved: string | undefined): Promise<string> {
  const resolved = await resolveWorkspacePath(context.workspaceRoot, candidate, "write");
  if (approved === undefined || resolved.relative !== approved) {
    throw new ToolScopeViolation(`${candidate} changed after the policy decision (now ${resolved.relative})`, "write-outside-scope");
  }
  const policy = context.policy;
  if (
    hasReservedSegment(resolved.relative) ||
    matchesAny(resolved.relative, policy.forbidden, { caseInsensitive: true }) ||
    !matchesAny(resolved.relative, policy.write_scope, { caseInsensitive: false })
  ) {
    throw new ToolScopeViolation(`${resolved.relative} is outside the write scope`, "write-outside-scope");
  }
  return resolved.absolute;
}

export function readableByPolicy(relative: string, context: ToolExecutionContext): boolean {
  return (
    !matchesAny(relative, context.policy.forbidden, { caseInsensitive: true }) &&
    matchesAny(relative, context.policy.read_scope, { caseInsensitive: false })
  );
}

export function scopeViolationResult(error: unknown): ToolResult | undefined {
  return error instanceof ToolScopeViolation ? errorResult("path_outside_scope", error.message) : undefined;
}
