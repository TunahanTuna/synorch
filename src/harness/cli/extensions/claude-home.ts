import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * K7: the one place that decides what Synorch may read under Claude Code's home (`~/.claude`, or
 * `CLAUDE_CONFIG_DIR`). Claude keeps credentials there (`.credentials.json`) next to history,
 * sessions and settings, so the boundary is an allowlist, never a denylist:
 *
 *   skills/**    the user's own skills (SKILL.md folders)
 *   commands/**  the user's own markdown slash commands
 *   plugins/**   installed plugins (`installed_plugins.json`, `cache/`, `marketplaces/`)
 *   settings.json, the `enabledPlugins` key only (parsed, every other key dropped at once)
 *
 * Nothing else under the Claude home is ever opened, and nothing there is ever written: Synorch
 * turns Claude items off in its own configuration only.
 */
export const CLAUDE_HOME_READABLE_DIRECTORIES = ["skills", "commands", "plugins"] as const;
export type ClaudeHomeDirectory = (typeof CLAUDE_HOME_READABLE_DIRECTORIES)[number];

const CLAUDE_SETTINGS_FILE = "settings.json";

/**
 * Claude Code's configuration directory: `CLAUDE_CONFIG_DIR`, else `<HOME or USERPROFILE>/.claude`.
 * Undefined when the environment names no home (a hermetic test environment reads no Claude home).
 */
export function claudeHome(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const override = env.CLAUDE_CONFIG_DIR;
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  const home = env.HOME ?? env.USERPROFILE;
  return home === undefined || home.trim() === "" ? undefined : path.join(home, ".claude");
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** An allowlisted directory of the Claude home (`skills`, `commands` or `plugins`). */
export function claudeDirectory(home: string, directory: ClaudeHomeDirectory): string {
  return path.join(home, directory);
}

/**
 * Whether `target` may be read: anything outside the Claude home, or inside one of its allowlisted
 * directories. A plugin's `installPath` or a local marketplace can live anywhere on disk; inside the
 * Claude home only the allowlisted directories are readable.
 */
export function mayReadPath(home: string, target: string): boolean {
  const base = path.resolve(home);
  const resolved = path.resolve(target);
  if (!inside(base, resolved)) return true;
  return CLAUDE_HOME_READABLE_DIRECTORIES.some((directory) => inside(path.join(base, directory), resolved));
}

/** `mayReadPath` after resolving symlinks: a link inside `skills/` that points at `.credentials.json` is refused. */
export async function mayReadReal(home: string, target: string): Promise<boolean> {
  if (!mayReadPath(home, target)) return false;
  const real = await realpath(target).catch(() => undefined);
  if (real === undefined) return false;
  const realHome = await realpath(home).catch(() => home);
  return mayReadPath(realHome, real) && mayReadPath(home, real);
}

/** `enabledPlugins` of Claude's user settings (`"<name>@<marketplace>": true|false`); every other key is discarded. */
export async function readClaudeEnabledPlugins(home: string): Promise<Readonly<Record<string, boolean>>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(home, CLAUDE_SETTINGS_FILE), "utf8"));
  } catch {
    return {};
  }
  const enabled = (raw as { enabledPlugins?: unknown } | null)?.enabledPlugins;
  raw = undefined;
  if (typeof enabled !== "object" || enabled === null || Array.isArray(enabled)) return {};
  const result: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(enabled as Record<string, unknown>)) if (typeof value === "boolean") result[id] = value;
  return result;
}
