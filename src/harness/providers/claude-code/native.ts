import type { PermissionMode, ToolEffect } from "../../contracts/index.ts";

/**
 * Claude Code native mode (owner revision 2026-09-24): Claude runs its full built-in toolset and
 * Synorch keeps the MCP bridge, the permission prompt, isolation, integration, verification,
 * review and audit. These helpers are the only place that knows Claude's built-in tool names.
 */

export const CLAUDE_CODE_MODES = ["native", "restricted"] as const;
export type ClaudeCodeMode = (typeof CLAUDE_CODE_MODES)[number];
export const DEFAULT_CLAUDE_CODE_MODE: ClaudeCodeMode = "native";

/** Claude Code's `--permission-mode` choices this bridge uses (verified against `claude --help`, 2.1.282). */
export type ClaudePermissionMode = "manual" | "auto" | "bypassPermissions" | "plan";

/**
 * Synorch permission mode → Claude `--permission-mode` (ADR-08 owner revision 3): ask→manual
 * (Claude's default mode), auto→auto (Claude's own classifier decides; only its escalations reach
 * Synorch's card), full→bypassPermissions, plan→plan. Headless (no mode) is `manual`, and every
 * prompt then reaches Synorch's headless broker, which refuses it (fail closed).
 */
export function claudePermissionMode(mode: PermissionMode | undefined): ClaudePermissionMode {
  switch (mode) {
    case "auto":
      return "auto";
    case "full":
      return "bypassPermissions";
    case "plan":
      return "plan";
    default:
      return "manual";
  }
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const EXEC_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell", "KillBash"]);

/** The Synorch effect of a Claude built-in tool, for the approval card and audit. */
export function claudeToolEffect(name: string): ToolEffect {
  if (EXEC_TOOLS.has(name)) return "exec";
  if (WRITE_TOOLS.has(name)) return "workspace-write";
  if (name === "WebFetch" || name === "WebSearch") return "network-read";
  return "read";
}

/** Tools whose results carry web content (K4.1 taint: `onWebContentRead`). */
export function isClaudeWebTool(name: string): boolean {
  return name === "WebFetch" || name === "WebSearch";
}

function str(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function lineCount(text: string | undefined): number {
  if (text === undefined || text === "") return 0;
  return text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function hostPath(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return raw;
  }
}

/** A short, display-ready summary of a built-in tool's input (`pnpm test`, `src/x.ts`, `"query"`). */
export function claudeInputSummary(name: string, input: Readonly<Record<string, unknown>>): string {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return oneLine(str(input, "command") ?? "", 500);
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return oneLine(str(input, "file_path") ?? str(input, "path") ?? "", 500);
    case "NotebookEdit":
      return oneLine(str(input, "notebook_path") ?? "", 500);
    case "Grep":
    case "Glob":
      return oneLine(`${str(input, "pattern") ?? ""}${str(input, "path") === undefined ? "" : ` in ${str(input, "path") ?? ""}`}`, 500);
    case "WebSearch":
      return oneLine(`"${str(input, "query") ?? ""}"`, 500);
    case "WebFetch":
      return oneLine(hostPath(str(input, "url") ?? ""), 500);
    case "Task":
    case "Agent":
      return oneLine(str(input, "description") ?? str(input, "prompt") ?? "", 500);
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} todo(s)` : "";
    default: {
      const first = Object.values(input).find((value) => typeof value === "string");
      return typeof first === "string" ? oneLine(first, 500) : "";
    }
  }
}

/** Lines an Edit/Write/MultiEdit input adds and removes (from its own strings; the diff stays authoritative). */
export function claudeLineCounts(name: string, input: Readonly<Record<string, unknown>>): { readonly added: number; readonly removed: number } | undefined {
  if (name === "Edit") return { added: lineCount(str(input, "new_string")), removed: lineCount(str(input, "old_string")) };
  if (name === "Write") return { added: lineCount(str(input, "content")), removed: 0 };
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    let added = 0;
    let removed = 0;
    for (const edit of input.edits) {
      if (typeof edit !== "object" || edit === null) continue;
      const record = edit as Record<string, unknown>;
      added += lineCount(typeof record.new_string === "string" ? record.new_string : undefined);
      removed += lineCount(typeof record.old_string === "string" ? record.old_string : undefined);
    }
    return { added, removed };
  }
  return undefined;
}

/** The text of a `tool_result` block's content (a string, or text parts). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text" ? String((part as Record<string, unknown>).text ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** A one-line result summary: `12 passed` for a test run, else the first meaningful line. */
export function claudeResultSummary(name: string, text: string, isError: boolean): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (name === "Bash" || name === "PowerShell") {
    // `12 passed` (vitest, jest, pytest) or `ℹ pass 12` (node --test).
    const passed = /(?:^|\s)pass\s+(\d+)/im.exec(text)?.[1] ?? /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/i.exec(text)?.[1];
    const failed = /(?:^|\s)fail\s+(\d+)/im.exec(text)?.[1] ?? /(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?\b/i.exec(text)?.[1];
    if (passed !== undefined || failed !== undefined) {
      return [passed === undefined ? undefined : `${passed} passed`, failed === undefined || failed === "0" ? undefined : `${failed} failed`].filter((part) => part !== undefined).join(", ");
    }
    if (lines.length === 0) return isError ? "failed" : "done";
    return oneLine(lines.at(-1) ?? "", 200);
  }
  if (name === "Grep" || name === "Glob") return lines.length === 0 ? "no matches" : `${lines.length} line(s)`;
  if (name === "Read") return isError ? oneLine(lines[0] ?? "failed", 200) : `${lines.length} line(s)`;
  return oneLine(lines[0] ?? (isError ? "failed" : "done"), 200);
}
