import type { CommandPaletteEntry } from "../../contracts/index.ts";
import { commandLabel, filterCommands } from "./commands.ts";
import type { WorkspaceFileIndex } from "./file-index.ts";

/**
 * The editor's completion source: `/` at the start of the message opens the command palette and
 * `@` at a word boundary opens fuzzy workspace path completion. The shapes match pi-tui's
 * `AutocompleteProvider` structurally, so this module does not import pi-tui (ADR-04).
 */

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export interface CompletionSuggestions {
  items: CompletionItem[];
  prefix: string;
}

export interface CompletionEdit {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

const MENTION = /(?:^|[\s(,])@("[^"]*|[^\s"]*)$/;
const SLASH = /^\/(\S*)$/;

export function mentionPrefix(before: string): string | undefined {
  const match = MENTION.exec(before);
  return match === null ? undefined : `@${match[1] ?? ""}`;
}

/** `@src/app.ts`, or `@"docs/my notes.md"` when the path has spaces. */
export function formatMention(relative: string): string {
  return /\s/.test(relative) ? `@"${relative}"` : `@${relative}`;
}

export class InputCompletionProvider {
  public readonly triggerCharacters = ["@"];
  private commands: readonly CommandPaletteEntry[];
  private files: WorkspaceFileIndex | undefined;
  private readonly maxItems: number;

  public constructor(commands: readonly CommandPaletteEntry[], files: WorkspaceFileIndex | undefined, maxItems = 50) {
    this.commands = commands;
    this.files = files;
    this.maxItems = maxItems;
  }

  public setCommands(commands: readonly CommandPaletteEntry[]): void {
    this.commands = commands;
  }

  public setFiles(files: WorkspaceFileIndex | undefined): void {
    this.files = files;
  }

  public command(name: string): CommandPaletteEntry | undefined {
    const wanted = name.replace(/^\//, "").toLowerCase();
    return this.commands.find((entry) => entry.name === wanted || (entry.aliases ?? []).includes(wanted));
  }

  public async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<CompletionSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (cursorLine === 0) {
      const slash = SLASH.exec(before);
      if (slash !== null) {
        const items = filterCommands(this.commands, slash[1] ?? "").map((entry) => ({
          value: `/${entry.name}`,
          label: commandLabel(entry),
          description: entry.description,
        }));
        return items.length === 0 ? null : { items, prefix: before };
      }
    }
    const prefix = mentionPrefix(before);
    if (prefix === undefined || this.files === undefined) return null;
    const query = prefix.slice(1).replace(/^"/, "");
    let found;
    try {
      found = await this.files.search(query, this.maxItems);
    } catch {
      return null;
    }
    if (options.signal.aborted || found.length === 0) return null;
    return {
      prefix,
      items: found.map((entry) => ({ value: entry.path, label: entry.path, ...(entry.kind === "directory" ? { description: "dir" } : {}) })),
    };
  }

  public applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: CompletionItem, prefix: string): CompletionEdit {
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol);
    const after = line.slice(cursorCol);
    const start = before.endsWith(prefix) ? before.length - prefix.length : before.length;
    let inserted: string;
    if (prefix.startsWith("/") && cursorLine === 0 && start === 0) {
      const entry = this.command(item.value);
      inserted = entry?.argsHint === undefined ? item.value : `${item.value} `;
    } else {
      const directory = item.value.endsWith("/");
      inserted = formatMention(item.value) + (directory || after.startsWith(" ") ? "" : " ");
    }
    const next = [...lines];
    next[cursorLine] = before.slice(0, start) + inserted + after;
    return { lines: next, cursorLine, cursorCol: start + inserted.length };
  }

  public shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return mentionPrefix((lines[cursorLine] ?? "").slice(0, cursorCol)) !== undefined;
  }
}
