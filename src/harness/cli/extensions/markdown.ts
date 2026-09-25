import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * K7: SKILL.md and markdown slash commands in Claude Code's format (the de-facto standard): YAML
 * frontmatter (`name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `allowed-tools`,
 * `disable-model-invocation`, `user-invocable`; unknown keys ignored) and a markdown body with
 * `$ARGUMENTS`, `$0`/`$1`…, named `$arg` and `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` /
 * `${CLAUDE_PROJECT_DIR}` placeholders. Dynamic `!`command`` blocks are left as text (never run).
 */

export const MAX_MARKDOWN_BYTES = 256 * 1024;

export interface MarkdownDocument {
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/** Lenient `key: value` lines, for frontmatter YAML rejects (unquoted colons in a description are common). */
function looseFrontmatter(lines: readonly string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of lines) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined) data[match[1]] = (match[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return data;
}

export function parseMarkdown(text: string): MarkdownDocument {
  const lines = text.replace(/^﻿/, "").replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: lines.join("\n").trim() };
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) return { data: {}, body: lines.join("\n").trim() };
  const head = lines.slice(1, closing);
  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(head.join("\n")) as unknown;
    data = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    data = looseFrontmatter(head);
  }
  return { data, body: lines.slice(closing + 1).join("\n").trim() };
}

export async function readMarkdownFile(file: string): Promise<MarkdownDocument | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > MAX_MARKDOWN_BYTES) return undefined;
  const text = await readFile(file, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseMarkdown(text);
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

function list(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  if (typeof value === "string") return value.split(/[\s,]+/).filter((item) => item !== "");
  return [];
}

function flag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** The fields Synorch uses from a skill or command frontmatter. */
export interface MarkdownMeta {
  readonly name: string | undefined;
  readonly description: string;
  readonly whenToUse: string | undefined;
  readonly argumentHint: string | undefined;
  readonly argumentNames: readonly string[];
  readonly allowedTools: readonly string[];
  /** `disable-model-invocation: true`: only the user invokes it (never in the model's catalog). */
  readonly modelInvocable: boolean;
  /** `user-invocable: false`: hidden from the slash palette. */
  readonly userInvocable: boolean;
}

function firstLine(body: string): string {
  return (
    body
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line !== "") ?? ""
  ).slice(0, 200);
}

export function metaOf(document: MarkdownDocument): MarkdownMeta {
  const data = document.data;
  const hint = data["argument-hint"] ?? data.argument_hint ?? data.argumentHint;
  return {
    name: text(data.name),
    description: text(data.description) ?? firstLine(document.body),
    whenToUse: text(data.when_to_use ?? data["when-to-use"]),
    argumentHint: Array.isArray(hint) ? `[${hint.join("] [")}]` : text(hint),
    argumentNames: list(data.arguments),
    allowedTools: list(data["allowed-tools"] ?? data.allowed_tools),
    modelInvocable: flag(data["disable-model-invocation"]) !== true,
    userInvocable: flag(data["user-invocable"]) !== false,
  };
}

/** Splits an argument string like a shell (double and single quotes group words). */
export function splitArguments(input: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  return parts;
}

export interface ExpansionContext {
  readonly skillDir?: string | undefined;
  readonly pluginRoot?: string | undefined;
  readonly projectDir?: string | undefined;
  readonly argumentNames?: readonly string[];
}

/**
 * Claude Code's argument substitution: `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n`, named `$name` (from
 * `arguments`), the directory variables. Arguments the body never references are appended as
 * `ARGUMENTS: …`, as Claude does, so they are never lost.
 */
export function expandBody(body: string, args: string, context: ExpansionContext = {}): string {
  const positional = splitArguments(args);
  let referenced = false;
  let out = body.replace(/\$\{(CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}/g, (match, name: string) => {
    const value = name === "CLAUDE_SKILL_DIR" ? context.skillDir : name === "CLAUDE_PLUGIN_ROOT" ? context.pluginRoot : context.projectDir;
    return value === undefined ? match : value.replaceAll("\\", "/");
  });
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => {
    referenced = true;
    return positional[Number(index)] ?? "";
  });
  out = out.replace(/\$ARGUMENTS\b/g, () => {
    referenced = true;
    return args;
  });
  out = out.replace(/\$(\d+)\b/g, (_match, index: string) => {
    referenced = true;
    return positional[Number(index)] ?? "";
  });
  const names = context.argumentNames ?? [];
  if (names.length > 0) {
    const pattern = new RegExp(`\\$(${names.map((name) => name.replace(/[^A-Za-z0-9_-]/g, "")).filter((name) => name !== "").join("|")})\\b`, "g");
    out = out.replace(pattern, (_match, name: string) => {
      referenced = true;
      return positional[names.indexOf(name)] ?? "";
    });
  }
  if (!referenced && args.trim() !== "") out = `${out}\n\nARGUMENTS: ${args.trim()}`;
  return out;
}

/** A skill directory's name, kebab-case as Claude requires (lower case, digits, `-`, `_`). */
export function isSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name);
}

export function commandNameOf(file: string): string {
  return path.basename(file).replace(/\.md$/i, "");
}
