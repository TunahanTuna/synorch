import type { CommandPaletteEntry } from "../../contracts/index.ts";

/**
 * The `/` palette rows (TUI §8.11). The session replaces the list with `setCommands`; until it does,
 * the palette shows the commands `syn agent` handles today. Renderer-local commands (`/mouse`,
 * `/select`, `/exit`) are always present because the renderer executes them itself.
 */

export const LOCAL_COMMANDS: readonly CommandPaletteEntry[] = [
  { name: "mouse", description: "mouse wheel scrolling and click to expand (turns off native text selection)", argsHint: "[on|off]" },
  { name: "select", description: "copy-friendly select mode: native selection, full transcript (Esc returns)" },
  { name: "exit", description: "leave (resume with syn agent --continue)", aliases: ["quit"] },
];

export const DEFAULT_COMMAND_PALETTE: readonly CommandPaletteEntry[] = [
  { name: "plan", description: "plan a large goal with parallel workers and independent review", argsHint: "<goal>" },
  { name: "undo", description: "revert the last edit Synorch made" },
  { name: "allow", description: "let Synorch run commands starting with a prefix here", argsHint: "[prefix]" },
  { name: "trust", description: "trust this folder so build/test commands may run" },
  { name: "diff", description: "files changed by Synorch in this conversation" },
  { name: "context", description: "what the model saw in its last request" },
  { name: "permissions", description: "what Synorch may do here" },
  { name: "model", description: "which model each role uses" },
  { name: "log", description: "raw event log of this conversation (debug)", argsHint: "[n]" },
  { name: "cancel", description: "stop the current work (the conversation stays resumable)" },
  { name: "help", description: "shortcuts and commands" },
];

/** Session rows first, then the local rows the session did not already define. */
export function mergeCommands(session: readonly CommandPaletteEntry[]): CommandPaletteEntry[] {
  const seen = new Set(session.map((entry) => entry.name));
  return [...session, ...LOCAL_COMMANDS.filter((entry) => !seen.has(entry.name))];
}

/** `<goal>`-style hints mean the command needs an argument: Enter completes instead of submitting. */
export function requiresArgument(entry: CommandPaletteEntry): boolean {
  return entry.argsHint !== undefined && entry.argsHint.trimStart().startsWith("<");
}

export interface RankedCommand {
  readonly entry: CommandPaletteEntry;
  readonly score: number;
}

/**
 * Filters by the typed prefix: exact/prefix matches on the name or an alias first (in list order),
 * then subsequence matches. An empty query returns every row.
 */
export function filterCommands(entries: readonly CommandPaletteEntry[], query: string): CommandPaletteEntry[] {
  const needle = query.toLowerCase();
  if (needle === "") return [...entries];
  const ranked: RankedCommand[] = [];
  entries.forEach((entry, index) => {
    const names = [entry.name, ...(entry.aliases ?? [])].map((name) => name.toLowerCase());
    let score: number | undefined;
    if (names.some((name) => name === needle)) score = 0;
    else if (names.some((name) => name.startsWith(needle))) score = 100;
    else if (names.some((name) => name.includes(needle))) score = 200;
    else if (names.some((name) => isSubsequence(needle, name))) score = 300;
    if (score !== undefined) ranked.push({ entry, score: score + index });
  });
  return ranked.sort((a, b) => a.score - b.score).map((item) => item.entry);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return at === needle.length;
}

export function commandLabel(entry: CommandPaletteEntry): string {
  return `/${entry.name}${entry.argsHint === undefined ? "" : ` ${entry.argsHint}`}`;
}
