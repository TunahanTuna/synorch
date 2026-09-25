import type { ToolHooks } from "../../tools/index.ts";
import { CLAUDE_TOOL_NAMES, claudeToolInput, claudeToolName, type HookEngine, type HookOutcome } from "./hooks.ts";

/**
 * K7: PreToolUse / PostToolUse hooks on the tool gateway. Hooks see Claude Code's tool names and
 * `tool_input` shape (exec → Bash with `command`, read_file → Read with `file_path`, …); matchers
 * are tested against the Claude name(s) and Synorch's own name, so both spellings work.
 */
export interface GatewayHookOptions {
  readonly workspaceRoot: string;
  readonly permissionMode: () => string | undefined;
  /** User notes (systemMessage, hook errors). */
  readonly notify?: (message: string) => void;
}

const RESPONSE_LIMIT = 16 * 1024;

function notifyAll(outcome: HookOutcome, notify: ((message: string) => void) | undefined): void {
  for (const message of outcome.messages) notify?.(message);
}

export function gatewayHooks(engine: HookEngine, options: GatewayHookOptions): ToolHooks {
  return {
    async pre(call, signal) {
      const claudeNative = call.scope.backend === "claude-native";
      if (!engine.has("PreToolUse", { claudeNative })) return undefined;
      const names = [...(CLAUDE_TOOL_NAMES[call.toolName] ?? []), call.toolName];
      const outcome = await engine.run(
        "PreToolUse",
        { tool_name: claudeToolName(call.toolName), tool_input: claudeToolInput(call.toolName, call.arguments, options.workspaceRoot), tool_use_id: call.toolCallId },
        names,
        { sessionId: call.sessionId, cwd: options.workspaceRoot, permissionMode: options.permissionMode(), claudeNative, signal },
      );
      notifyAll(outcome, options.notify);
      if (outcome.blocked) return { deny: outcome.reason ?? "denied by a PreToolUse hook" };
      if (outcome.ask) return { ask: "a PreToolUse hook asks for your approval" };
      return undefined;
    },
    async post(call, signal) {
      const claudeNative = call.scope.backend === "claude-native";
      if (!engine.has("PostToolUse", { claudeNative })) return undefined;
      const names = [...(CLAUDE_TOOL_NAMES[call.toolName] ?? []), call.toolName];
      const outcome = await engine.run(
        "PostToolUse",
        {
          tool_name: claudeToolName(call.toolName),
          tool_input: claudeToolInput(call.toolName, call.arguments, options.workspaceRoot),
          tool_use_id: call.toolCallId,
          tool_response: {
            success: call.result.status === "ok",
            output: call.result.text.slice(0, RESPONSE_LIMIT),
            ...(call.result.exit_code === undefined ? {} : { exit_code: call.result.exit_code }),
            ...(call.result.changed_paths === undefined ? {} : { changed_paths: call.result.changed_paths }),
            ...(call.result.error === undefined ? {} : { error: call.result.error.message }),
          },
        },
        names,
        { sessionId: call.sessionId, cwd: options.workspaceRoot, permissionMode: options.permissionMode(), claudeNative, signal },
      );
      notifyAll(outcome, options.notify);
      return outcome.context.length === 0 ? undefined : { context: outcome.context.join("\n") };
    },
  };
}

/**
 * Synorch's own hooks (user and Synorch plugins) on Claude Code's native built-in tools, from the
 * native permission check: Claude-sourced hooks are skipped (Claude runs them itself). Returns a
 * denial reason, or undefined to continue with the normal permission check.
 */
export async function nativeToolPreHook(
  engine: HookEngine,
  input: { readonly toolName: string; readonly toolInput: Readonly<Record<string, unknown>>; readonly sessionId: string; readonly workspaceRoot: string; readonly permissionMode: string | undefined; readonly notify?: (message: string) => void },
  signal: AbortSignal,
): Promise<string | undefined> {
  const context = { claudeNative: true, origins: ["user", "synorch"] as const };
  if (!engine.has("PreToolUse", context)) return undefined;
  const outcome = await engine.run("PreToolUse", { tool_name: input.toolName, tool_input: input.toolInput }, [input.toolName], {
    sessionId: input.sessionId,
    cwd: input.workspaceRoot,
    permissionMode: input.permissionMode,
    ...context,
    signal,
  });
  notifyAll(outcome, input.notify);
  return outcome.blocked ? (outcome.reason ?? "denied by a PreToolUse hook") : undefined;
}
