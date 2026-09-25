import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { claudeDirectory, mayReadReal, readClaudeEnabledPlugins } from "./claude-home.ts";
import { readAgentFile, type AgentRef } from "./agents.ts";
import { describeHookConfig, hookCount, mergeHookConfigs, parseHookConfig, type HookConfig } from "./hooks.ts";
import { commandNameOf, isSkillName, metaOf, readMarkdownFile, type MarkdownMeta } from "./markdown.ts";

/**
 * K7 plugins in Claude Code's plugin format (code.claude.com/docs/en/plugins-reference, verified
 * 2026-09-25): a directory with an optional `.claude-plugin/plugin.json` (`name` required; `version`,
 * `description`, and component keys `skills` (adds to `skills/`), `commands` (replaces `commands/`;
 * path, array or name map), `agents`, `hooks`, `mcpServers` (merged with `.mcp.json`)). Component
 * paths are relative to the plugin root and never leave it.
 *
 * Synorch installs plugins under `<synorch home>/plugins/installed/<name>/` and records them, with the
 * marketplaces the user added, in `<synorch home>/plugins/plugins.json`. Plugins enabled in Claude Code
 * are read in place from Claude's own records (`~/.claude/plugins/installed_plugins.json` and
 * `enabledPlugins` in `~/.claude/settings.json`); Synorch never writes there.
 */

export interface SkillRef {
  /** The skill's own name (directory name, or frontmatter `name`). */
  readonly name: string;
  readonly file: string;
  readonly dir: string;
  readonly meta: MarkdownMeta;
}

export interface CommandRef {
  readonly name: string;
  /** The markdown file, or undefined for an inline `content` command of a manifest map. */
  readonly file: string | undefined;
  readonly content: string | undefined;
  readonly meta: MarkdownMeta;
}

export interface PluginContents {
  /** Manifest `name` (the namespace of its skills and commands), else the directory name. */
  readonly name: string;
  readonly version: string | undefined;
  readonly description: string;
  readonly root: string;
  readonly skills: readonly SkillRef[];
  readonly commands: readonly CommandRef[];
  /** Agent names. */
  readonly agents: readonly string[];
  /** Agents (`agents/*.md`): orchestration worker personas. */
  readonly agentDefs: readonly AgentRef[];
  /** Hook event names the plugin declares (supported or not). */
  readonly hooks: readonly string[];
  /** The supported command hooks; they run only once the user approved them. */
  readonly hookConfig: HookConfig;
  /** Raw MCP server entries by name (`.mcp.json` and manifest `mcpServers`). */
  readonly mcpServers: Readonly<Record<string, unknown>>;
  readonly problems: readonly string[];
}

/** Decides whether a file may be read (the Claude home allowlist for Claude plugins; always true otherwise). */
export type ReadGuard = (file: string) => Promise<boolean>;

const allowAll: ReadGuard = async () => true;

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isDirectory() === true;
}

async function isFile(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isFile() === true;
}

async function readJson(file: string, guard: ReadGuard): Promise<unknown> {
  if (!(await guard(file))) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
}

async function skillAt(dir: string, guard: ReadGuard): Promise<SkillRef | undefined> {
  const file = path.join(dir, "SKILL.md");
  if (!(await isFile(file)) || !(await guard(file))) return undefined;
  const document = await readMarkdownFile(file);
  if (document === undefined) return undefined;
  const meta = metaOf(document);
  const name = meta.name !== undefined && isSkillName(meta.name) ? meta.name : path.basename(dir);
  if (!isSkillName(name)) return undefined;
  return { name, file, dir, meta };
}

/** Skills of a directory: `<name>/SKILL.md` folders, or one `SKILL.md` directly in it. Plugin folders (`.claude-plugin/`) are skipped. */
export async function scanSkills(dir: string, guard: ReadGuard = allowAll): Promise<SkillRef[]> {
  if (!(await isDirectory(dir))) return [];
  const direct = await skillAt(dir, guard);
  if (direct !== undefined) return [direct];
  const skills: SkillRef[] = [];
  for (const name of await subdirectories(dir)) {
    if (await isDirectory(path.join(dir, name, ".claude-plugin"))) continue;
    const skill = await skillAt(path.join(dir, name), guard);
    if (skill !== undefined) skills.push(skill);
  }
  return skills;
}

async function markdownFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(full, depth + 1)));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(full);
  }
  return files;
}

async function commandAt(file: string, guard: ReadGuard, name = commandNameOf(file)): Promise<CommandRef | undefined> {
  if (!(await guard(file))) return undefined;
  const document = await readMarkdownFile(file);
  if (document === undefined || !isSkillName(name)) return undefined;
  return { name, file, content: undefined, meta: metaOf(document) };
}

/** Markdown slash commands: `.md` files of a directory (sub-folders included), or one `.md` file. */
export async function scanCommands(target: string, guard: ReadGuard = allowAll): Promise<CommandRef[]> {
  const files = (await isFile(target)) ? [target] : (await isDirectory(target)) ? await markdownFiles(target) : [];
  const commands: CommandRef[] = [];
  for (const file of files) {
    const command = await commandAt(file, guard);
    if (command !== undefined) commands.push(command);
  }
  return commands;
}

const manifestSchema = z.looseObject({
  name: z.string().min(1).max(100),
  version: z.string().max(100).optional(),
  description: z.string().max(4000).optional(),
});

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Reads a plugin directory (manifest optional). `fallback` names a manifest-less plugin (marketplace
 * entry, or the directory name). Nothing is executed here (hooks run only after approval, from the hook engine).
 */
export async function readPlugin(root: string, fallback: { readonly name?: string; readonly description?: string; readonly version?: string } = {}, guard: ReadGuard = allowAll): Promise<PluginContents> {
  const problems: string[] = [];
  const manifestFile = path.join(root, ".claude-plugin", "plugin.json");
  const rawManifest = (await isFile(manifestFile)) ? await readJson(manifestFile, guard) : undefined;
  let manifest: z.infer<typeof manifestSchema> | undefined;
  if (rawManifest !== undefined) {
    const parsed = manifestSchema.safeParse(rawManifest);
    if (parsed.success) manifest = parsed.data;
    else problems.push(`${manifestFile}: not a valid plugin manifest (name is required)`);
  } else if (await isFile(manifestFile)) problems.push(`${manifestFile}: not valid JSON`);
  const data = (manifest ?? {}) as Record<string, unknown>;
  const within = (relative: unknown, key: string): string | undefined => {
    if (typeof relative !== "string" || relative.trim() === "") return undefined;
    const resolved = path.resolve(root, relative);
    if (!inside(path.resolve(root), resolved)) {
      problems.push(`${key}: ${relative} escapes the plugin directory; ignored`);
      return undefined;
    }
    return resolved;
  };

  // Skills: `skills/` always, plus the manifest's directories; a root SKILL.md without either is one skill.
  const skillDirs = [path.join(root, "skills"), ...asList(data.skills).map((entry) => within(entry, "skills")).filter((entry): entry is string => entry !== undefined)];
  const skills: SkillRef[] = [];
  const seenSkills = new Set<string>();
  for (const dir of skillDirs) {
    for (const skill of await scanSkills(dir, guard)) {
      if (seenSkills.has(skill.name)) continue;
      seenSkills.add(skill.name);
      skills.push(skill);
    }
  }
  if (skills.length === 0 && data.skills === undefined && !(await isDirectory(path.join(root, "skills")))) {
    const single = await skillAt(root, guard);
    if (single !== undefined) skills.push(single);
  }

  // Commands: the manifest's `commands` replaces the default folder (path, array, or a name → {source|content} map).
  const commands: CommandRef[] = [];
  const declared = data.commands;
  if (declared !== undefined && typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
    for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
      const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      const source = within(entry.source, `commands.${name}`);
      if (source !== undefined) {
        const command = await commandAt(source, guard, name);
        if (command !== undefined) commands.push(typeof entry.description === "string" ? { ...command, meta: { ...command.meta, description: entry.description } } : command);
      } else if (typeof entry.content === "string" && isSkillName(name)) {
        const description = typeof entry.description === "string" ? entry.description : entry.content.split("\n")[0]?.slice(0, 200) ?? "";
        commands.push({ name, file: undefined, content: entry.content, meta: { ...metaOf({ data: {}, body: entry.content }), description, argumentHint: typeof entry.argumentHint === "string" ? entry.argumentHint : undefined } });
      }
    }
  } else {
    const targets = declared === undefined ? [path.join(root, "commands")] : asList(declared).map((entry) => within(entry, "commands")).filter((entry): entry is string => entry !== undefined);
    for (const target of targets) commands.push(...(await scanCommands(target, guard)));
  }

  // Agents (worker personas) and hooks (run only after approval, see hooks.ts).
  const agentFiles = data.agents === undefined ? await markdownFiles(path.join(root, "agents")) : (await Promise.all(asList(data.agents).map((entry) => within(entry, "agents")).filter((entry): entry is string => entry !== undefined).map(async (entry) => ((await isDirectory(entry)) ? markdownFiles(entry) : [entry])))).flat();
  const agentDefs: AgentRef[] = [];
  for (const file of agentFiles) {
    if (!(await guard(file))) continue;
    const agent = await readAgentFile(file);
    if (agent !== undefined && !agentDefs.some((existing) => existing.name === agent.name)) agentDefs.push(agent);
  }
  const agents = agentFiles.map((file) => commandNameOf(file));
  const hooks: string[] = [];
  const hookConfigs: HookConfig[] = [];
  const hooksFile = path.join(root, "hooks", "hooks.json");
  const hookEvents = (value: unknown): string[] => {
    const events = (value as { hooks?: unknown } | undefined)?.hooks ?? value;
    const parsed = parseHookConfig(value);
    hookConfigs.push(parsed.config);
    for (const entry of parsed.unsupported) problems.push(`hooks: ${entry} is not supported by Synorch; it never runs`);
    return typeof events === "object" && events !== null && !Array.isArray(events) ? Object.keys(events as Record<string, unknown>) : [];
  };
  if (await isFile(hooksFile)) hooks.push(...hookEvents(await readJson(hooksFile, guard)));
  for (const entry of asList(data.hooks)) {
    if (typeof entry === "string") {
      const file = within(entry, "hooks");
      if (file !== undefined && path.resolve(file) !== path.resolve(hooksFile)) hooks.push(...hookEvents(await readJson(file, guard)));
    } else hooks.push(...hookEvents(entry));
  }

  // MCP servers: `.mcp.json` first, then the manifest's `mcpServers` (a later name replaces an earlier one).
  const mcpServers: Record<string, unknown> = {};
  const addServers = (value: unknown, label: string): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const map = typeof record.mcpServers === "object" && record.mcpServers !== null ? (record.mcpServers as Record<string, unknown>) : record;
    for (const [name, entry] of Object.entries(map)) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) mcpServers[name] = entry;
      else problems.push(`${label}: server ${name} is not an object; ignored`);
    }
  };
  const mcpFile = path.join(root, ".mcp.json");
  if (await isFile(mcpFile)) addServers(await readJson(mcpFile, guard), mcpFile);
  for (const entry of asList(data.mcpServers)) {
    if (typeof entry === "string") {
      if (/\.(mcpb|dxt)$/i.test(entry) || /^https?:/i.test(entry)) {
        problems.push(`mcpServers: bundle ${entry} is not supported yet; ignored`);
        continue;
      }
      const file = within(entry, "mcpServers");
      if (file !== undefined) addServers(await readJson(file, guard), file);
    } else addServers(entry, "plugin.json mcpServers");
  }

  const name = manifest?.name ?? fallback.name ?? path.basename(root);
  return {
    name,
    version: manifest?.version ?? fallback.version,
    description: manifest?.description ?? fallback.description ?? "",
    root,
    skills,
    commands,
    agents,
    agentDefs,
    hooks: [...new Set(hooks)],
    hookConfig: mergeHookConfigs(hookConfigs),
    mcpServers,
    problems,
  };
}

/** One line per component kind, for previews and `/plugins`. */
export function describeContents(contents: PluginContents): string[] {
  const names = (items: readonly { readonly name: string }[]): string => items.map((item) => item.name).join(", ");
  const lines: string[] = [];
  if (contents.skills.length > 0) lines.push(`skills (${contents.skills.length}): ${names(contents.skills)}`);
  if (contents.commands.length > 0) lines.push(`commands (${contents.commands.length}): ${contents.commands.map((command) => `/${contents.name}:${command.name}`).join(", ")}`);
  const servers = Object.keys(contents.mcpServers);
  if (servers.length > 0) lines.push(`MCP servers (${servers.length}): ${servers.join(", ")}`);
  if (contents.agentDefs.length > 0) lines.push(`agents (${contents.agentDefs.length}, worker personas): ${contents.agentDefs.map((agent) => `${contents.name}:${agent.name}`).join(", ")}`);
  const count = hookCount(contents.hookConfig);
  if (count > 0) {
    lines.push(`hooks (${count}, run only after you approve them):`);
    for (const line of describeHookConfig(contents.hookConfig)) lines.push(`  ${line}`);
  } else if (contents.hooks.length > 0) lines.push(`hooks: ${contents.hooks.join(", ")} (none Synorch supports; never run)`);
  if (lines.length === 0) lines.push("no skills, commands or MCP servers");
  for (const problem of contents.problems) lines.push(`warning: ${problem}`);
  return lines;
}

// ---- Synorch's own plugin store --------------------------------------------------------------------

export const PLUGIN_STORE_FILE = "plugins.json";
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const storeSchema = z.object({
  schema_version: z.literal(1),
  plugins: z.array(
    z.object({
      name: z.string().min(1),
      source: z.string().min(1),
      marketplace: z.string().optional(),
      dir: z.string().min(1),
      version: z.string().optional(),
      installed_at: z.string(),
    }),
  ),
  marketplaces: z.array(z.object({ name: z.string().min(1), source: z.string().min(1), dir: z.string().min(1), added_at: z.string() })),
});
export type PluginStore = z.infer<typeof storeSchema>;
export type InstalledPlugin = PluginStore["plugins"][number];
export type KnownMarketplace = PluginStore["marketplaces"][number];

export function pluginsHome(home: string): string {
  return path.join(home, "plugins");
}

export async function readPluginStore(home: string): Promise<PluginStore> {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(await readFile(path.join(pluginsHome(home), PLUGIN_STORE_FILE), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable: nothing installed.
  }
  return { schema_version: 1, plugins: [], marketplaces: [] };
}

async function writePluginStore(home: string, store: PluginStore): Promise<void> {
  const dir = pluginsHome(home);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, PLUGIN_STORE_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export class PluginError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

/** `git clone --depth 1 [--branch ref] <url> <dest>`; the only process a plugin install starts. */
export type GitClone = (url: string, dest: string, ref: string | undefined) => Promise<void>;

export const defaultGitClone: GitClone = (url, dest, ref) =>
  new Promise((resolve, reject) => {
    const args = ["clone", "--depth", "1", ...(ref === undefined ? [] : ["--branch", ref]), "--", url, dest];
    execFile("git", args, { timeout: 180_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, _stdout, stderr) => {
      if (error === null) resolve();
      else reject(new PluginError(`git clone ${url} failed: ${(stderr || error.message).trim().split("\n").slice(-2).join(" ")}`));
    });
  });

/** A git URL (`https://…`, `git@…`, `ssh://…`, `….git`) or GitHub shorthand (`github:owner/repo`, `owner/repo` when no such path exists). */
export function gitUrlOf(spec: string): string | undefined {
  if (/^(https?:\/\/|ssh:\/\/|git@|git:\/\/|file:\/\/)/i.test(spec) || /\.git$/i.test(spec)) return spec;
  const github = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(spec);
  return github === null ? undefined : `https://github.com/${github[1]}/${github[2]}.git`;
}

export interface StagedPlugin {
  readonly contents: PluginContents;
  readonly source: string;
  readonly marketplace: string | undefined;
  /** Moves the staged copy into the store and records it; returns the record. */
  commit(): Promise<InstalledPlugin>;
  /** Removes the staged copy (always safe to call). */
  discard(): Promise<void>;
}

export interface PluginInstallOptions {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly git?: GitClone;
  /** Also resolve `name@marketplace` against the marketplaces Claude Code knows (read only). */
  readonly claudeHome?: string;
}

const marketplaceSchema = z.looseObject({
  name: z.string().min(1),
  plugins: z.array(z.looseObject({ name: z.string().min(1), source: z.unknown(), description: z.string().optional(), version: z.string().optional() })),
  metadata: z.looseObject({ pluginRoot: z.string().optional() }).optional(),
});

async function readMarketplace(dir: string, guard: ReadGuard = allowAll): Promise<z.infer<typeof marketplaceSchema> | undefined> {
  const parsed = marketplaceSchema.safeParse(await readJson(path.join(dir, ".claude-plugin", "marketplace.json"), guard));
  return parsed.success ? parsed.data : undefined;
}

async function stagingDir(home: string): Promise<string> {
  const dir = path.join(pluginsHome(home), ".staging");
  await mkdir(dir, { recursive: true });
  return mkdtemp(path.join(dir, "p-"));
}

async function copyPlugin(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, filter: (source) => path.basename(source) !== ".git" && path.basename(source) !== "node_modules" });
}

interface ResolvedSource {
  /** The plugin directory inside `temp` (a copy or a clone). */
  readonly dir: string;
  readonly temp: string;
  readonly fallback: { readonly name?: string; readonly description?: string; readonly version?: string };
}

async function fetchEntrySource(home: string, git: GitClone, marketplaceDir: string, market: z.infer<typeof marketplaceSchema>, entry: z.infer<typeof marketplaceSchema>["plugins"][number]): Promise<ResolvedSource> {
  const temp = await stagingDir(home);
  const fallback = { name: entry.name, ...(entry.description === undefined ? {} : { description: entry.description }), ...(entry.version === undefined ? {} : { version: entry.version }) };
  const source = entry.source;
  try {
    if (typeof source === "string") {
      const base = !source.startsWith("./") && market.metadata?.pluginRoot !== undefined ? path.resolve(marketplaceDir, market.metadata.pluginRoot) : marketplaceDir;
      const from = path.resolve(base, source);
      if (!inside(path.resolve(marketplaceDir), from) || source.includes("..")) throw new PluginError(`plugin ${entry.name}: source ${source} leaves the marketplace directory`);
      if (!(await isDirectory(from))) throw new PluginError(`plugin ${entry.name}: source path does not exist: ${from}`);
      const dir = path.join(temp, "plugin");
      await copyPlugin(from, dir);
      return { dir, temp, fallback };
    }
    const object = (typeof source === "object" && source !== null ? source : {}) as Record<string, unknown>;
    const ref = typeof object.ref === "string" ? object.ref : undefined;
    const clone = path.join(temp, "clone");
    if (object.source === "github" && typeof object.repo === "string") {
      await git(`https://github.com/${object.repo}.git`, clone, ref);
      return { dir: clone, temp, fallback };
    }
    if ((object.source === "url" || object.source === "git") && typeof object.url === "string") {
      await git(gitUrlOf(object.url) ?? object.url, clone, ref);
      return { dir: clone, temp, fallback };
    }
    if (object.source === "git-subdir" && typeof object.url === "string" && typeof object.path === "string") {
      await git(gitUrlOf(object.url) ?? object.url, clone, ref);
      const dir = path.resolve(clone, object.path);
      if (!inside(clone, dir) || !(await isDirectory(dir))) throw new PluginError(`plugin ${entry.name}: ${object.path} is not a directory of ${object.url}`);
      return { dir, temp, fallback };
    }
    throw new PluginError(`plugin ${entry.name}: source type ${String(object.source ?? typeof source)} is not supported yet (relative path, github, url and git-subdir are)`);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

/** Claude's known marketplaces (`~/.claude/plugins/known_marketplaces.json`): name → local directory. */
async function claudeMarketplaceDir(claudeHome: string, name: string): Promise<string | undefined> {
  const file = path.join(claudeDirectory(claudeHome, "plugins"), "known_marketplaces.json");
  const guard: ReadGuard = (target) => mayReadReal(claudeHome, target);
  const raw = (await readJson(file, guard)) as Record<string, { installLocation?: unknown }> | undefined;
  const location = raw?.[name]?.installLocation;
  return typeof location === "string" && (await isDirectory(location)) && (await guard(location)) ? location : undefined;
}

/**
 * Fetches a plugin into a staging directory and reads it, without installing it yet:
 * a local path, a git URL / GitHub shorthand, or `name@marketplace` (a marketplace added with
 * `syn plugin marketplace add`, else one Claude Code knows).
 */
export async function stagePlugin(spec: string, options: PluginInstallOptions): Promise<StagedPlugin> {
  const home = options.home;
  const git = options.git ?? defaultGitClone;
  let resolved: ResolvedSource;
  let marketplace: string | undefined;
  const local = path.resolve(options.cwd, spec);
  const at = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(spec);
  if (await isDirectory(local)) {
    const temp = await stagingDir(home);
    const dir = path.join(temp, "plugin");
    await copyPlugin(local, dir);
    resolved = { dir, temp, fallback: { name: path.basename(local) } };
  } else if (at !== null && at[1] !== undefined && at[2] !== undefined) {
    const [pluginName, marketName] = [at[1], at[2]];
    const store = await readPluginStore(home);
    let marketDir = store.marketplaces.find((entry) => entry.name === marketName)?.dir;
    let guard: ReadGuard = allowAll;
    if (marketDir === undefined && options.claudeHome !== undefined) {
      marketDir = await claudeMarketplaceDir(options.claudeHome, marketName);
      const claudeHomeDir = options.claudeHome;
      guard = (target) => mayReadReal(claudeHomeDir, target);
    }
    if (marketDir === undefined) throw new PluginError(`unknown marketplace ${marketName}; add it first: syn plugin marketplace add <git-url|path>`);
    const market = await readMarketplace(marketDir, guard);
    if (market === undefined) throw new PluginError(`${marketDir} has no valid .claude-plugin/marketplace.json`);
    const entry = market.plugins.find((candidate) => candidate.name === pluginName);
    if (entry === undefined) throw new PluginError(`plugin ${pluginName} not found in marketplace ${marketName} (it lists: ${market.plugins.map((candidate) => candidate.name).join(", ") || "nothing"})`);
    resolved = await fetchEntrySource(home, git, marketDir, market, entry);
    marketplace = marketName;
  } else {
    const url = gitUrlOf(spec);
    if (url === undefined) throw new PluginError(`${spec} is neither a directory, a git URL nor name@marketplace`);
    const temp = await stagingDir(home);
    const dir = path.join(temp, "clone");
    try {
      await git(url, dir, undefined);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
    resolved = { dir, temp, fallback: { name: path.basename(url).replace(/\.git$/i, "") } };
  }
  const discard = async (): Promise<void> => {
    await rm(resolved.temp, { recursive: true, force: true }).catch(() => undefined);
  };
  let contents: PluginContents;
  try {
    contents = await readPlugin(resolved.dir, resolved.fallback);
    if (!PLUGIN_NAME.test(contents.name)) throw new PluginError(`plugin name ${contents.name} is not valid (letters, digits, . _ -)`);
  } catch (error) {
    await discard();
    throw error;
  }
  const source = at !== null ? spec : (await isDirectory(local)) ? local : spec;
  return {
    contents,
    source,
    marketplace,
    discard,
    async commit() {
      const target = path.join(pluginsHome(home), "installed", contents.name);
      await rm(target, { recursive: true, force: true });
      await mkdir(path.dirname(target), { recursive: true });
      await cp(resolved.dir, target, { recursive: true, filter: (item) => path.basename(item) !== ".git" });
      await discard();
      const store = await readPluginStore(home);
      const record: InstalledPlugin = {
        name: contents.name,
        source,
        ...(marketplace === undefined ? {} : { marketplace }),
        dir: target,
        ...(contents.version === undefined ? {} : { version: contents.version }),
        installed_at: new Date().toISOString(),
      };
      await writePluginStore(home, { ...store, plugins: [...store.plugins.filter((entry) => entry.name !== contents.name), record] });
      return record;
    },
  };
}

export async function removePlugin(home: string, name: string): Promise<InstalledPlugin | undefined> {
  const store = await readPluginStore(home);
  const record = store.plugins.find((entry) => entry.name === name);
  if (record === undefined) return undefined;
  const installed = path.join(pluginsHome(home), "installed");
  if (inside(installed, path.resolve(record.dir))) await rm(record.dir, { recursive: true, force: true });
  await writePluginStore(home, { ...store, plugins: store.plugins.filter((entry) => entry.name !== name) });
  return record;
}

/** `syn plugin marketplace add <git-url|path>`: a local directory is used in place, a git repository is cloned. */
export async function addMarketplace(spec: string, options: PluginInstallOptions): Promise<{ readonly marketplace: KnownMarketplace; readonly plugins: readonly string[] }> {
  const home = options.home;
  const local = path.resolve(options.cwd, spec);
  let dir: string;
  let temp: string | undefined;
  if (await isDirectory(local)) dir = local;
  else {
    const url = gitUrlOf(spec);
    if (url === undefined) throw new PluginError(`${spec} is neither a directory nor a git URL`);
    temp = await stagingDir(home);
    dir = path.join(temp, "clone");
    try {
      await (options.git ?? defaultGitClone)(url, dir, undefined);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
  const market = await readMarketplace(dir);
  if (market === undefined || !PLUGIN_NAME.test(market.name)) {
    if (temp !== undefined) await rm(temp, { recursive: true, force: true });
    throw new PluginError(`${spec} has no valid .claude-plugin/marketplace.json (name, owner and plugins are required)`);
  }
  if (temp !== undefined) {
    const target = path.join(pluginsHome(home), "marketplaces", market.name);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(dir, target, { recursive: true });
    await rm(temp, { recursive: true, force: true });
    dir = target;
  }
  const store = await readPluginStore(home);
  const record: KnownMarketplace = { name: market.name, source: temp === undefined ? local : spec, dir, added_at: new Date().toISOString() };
  await writePluginStore(home, { ...store, marketplaces: [...store.marketplaces.filter((entry) => entry.name !== market.name), record] });
  return { marketplace: record, plugins: market.plugins.map((entry) => entry.name) };
}

export async function removeMarketplace(home: string, name: string): Promise<boolean> {
  const store = await readPluginStore(home);
  const record = store.marketplaces.find((entry) => entry.name === name);
  if (record === undefined) return false;
  const managed = path.join(pluginsHome(home), "marketplaces");
  if (inside(managed, path.resolve(record.dir))) await rm(record.dir, { recursive: true, force: true });
  await writePluginStore(home, { ...store, marketplaces: store.marketplaces.filter((entry) => entry.name !== name) });
  return true;
}

/** Plugins a known marketplace lists (for `syn plugin marketplace list`). */
export async function marketplacePlugins(dir: string): Promise<readonly { readonly name: string; readonly description: string }[]> {
  const market = await readMarketplace(dir);
  return (market?.plugins ?? []).map((entry) => ({ name: entry.name, description: entry.description ?? "" }));
}

// ---- Claude Code's installed plugins (read only) ----------------------------------------------------

export interface ClaudePlugin {
  /** Claude's id: `<name>@<marketplace>` (or `<name>@skills-dir`). */
  readonly id: string;
  readonly scope: string;
  /** Enabled in Claude Code's settings. */
  readonly enabledInClaude: boolean;
  readonly contents: PluginContents;
}

interface InstallRecord {
  readonly scope: string;
  readonly installPath: string;
  readonly version: string | undefined;
  readonly projectPath: string | undefined;
}

function installRecords(value: unknown): InstallRecord[] {
  const records: InstallRecord[] = [];
  for (const raw of asList(value)) {
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof entry.installPath !== "string") continue;
    records.push({
      scope: typeof entry.scope === "string" ? entry.scope : "user",
      installPath: entry.installPath,
      version: typeof entry.version === "string" ? entry.version : undefined,
      projectPath: typeof entry.projectPath === "string" ? entry.projectPath : undefined,
    });
  }
  return records;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === "win32" || platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function projectEnabledPlugins(workspaceRoot: string): Promise<Record<string, boolean>> {
  const merged: Record<string, boolean> = {};
  for (const file of ["settings.json", "settings.local.json"]) {
    const raw = await readJson(path.join(workspaceRoot, ".claude", file), allowAll);
    const enabled = (raw as { enabledPlugins?: unknown } | undefined)?.enabledPlugins;
    if (typeof enabled !== "object" || enabled === null) continue;
    for (const [id, value] of Object.entries(enabled as Record<string, unknown>)) if (typeof value === "boolean") merged[id] = value;
  }
  return merged;
}

/**
 * The plugins Claude Code has installed (`installed_plugins.json`: `{version, plugins: {id: [{scope,
 * installPath, version, projectPath?}]}}`, version 1's single-object form accepted too) with their
 * enabled state: `enabledPlugins` of `~/.claude/settings.json`, and for a project- or local-scope
 * install of this workspace (only when the workspace is trusted) its `.claude/settings.json` and
 * `.claude/settings.local.json` on top, as Claude merges them. Plugin folders under
 * `~/.claude/skills/` (`<name>@skills-dir`) are on unless a setting turns them off.
 */
export async function discoverClaudePlugins(input: { readonly claudeHome: string; readonly workspaceRoot: string; readonly trusted: boolean; readonly platform: NodeJS.Platform }): Promise<{ readonly plugins: readonly ClaudePlugin[]; readonly problems: readonly string[] }> {
  const guard: ReadGuard = (target) => mayReadReal(input.claudeHome, target);
  const problems: string[] = [];
  const userEnabled = await readClaudeEnabledPlugins(input.claudeHome);
  const projectEnabled = input.trusted ? await projectEnabledPlugins(input.workspaceRoot) : {};
  const plugins: ClaudePlugin[] = [];
  const raw = (await readJson(path.join(claudeDirectory(input.claudeHome, "plugins"), "installed_plugins.json"), guard)) as { plugins?: unknown } | undefined;
  const byId = typeof raw?.plugins === "object" && raw.plugins !== null ? (raw.plugins as Record<string, unknown>) : {};
  for (const [id, value] of Object.entries(byId)) {
    const records = installRecords(value);
    const record =
      records.find((candidate) => candidate.scope === "user") ??
      records.find((candidate) => (candidate.scope === "project" || candidate.scope === "local") && candidate.projectPath !== undefined && samePath(candidate.projectPath, input.workspaceRoot, input.platform));
    if (record === undefined) continue;
    const enabledInClaude = record.scope === "user" ? userEnabled[id] === true : (projectEnabled[id] ?? userEnabled[id]) === true;
    if (!(await isDirectory(record.installPath)) || !(await guard(record.installPath))) {
      if (enabledInClaude) problems.push(`Claude plugin ${id}: ${record.installPath} is missing (run /plugin in Claude Code to refresh)`);
      continue;
    }
    const contents = await readPlugin(record.installPath, { name: id.split("@")[0] ?? id, ...(record.version === undefined ? {} : { version: record.version }) }, guard);
    plugins.push({ id, scope: record.scope, enabledInClaude, contents });
  }
  const skillsDir = claudeDirectory(input.claudeHome, "skills");
  for (const name of await subdirectories(skillsDir)) {
    const root = path.join(skillsDir, name);
    if (!(await isDirectory(path.join(root, ".claude-plugin")))) continue;
    const contents = await readPlugin(root, { name }, guard);
    const id = `${contents.name}@skills-dir`;
    plugins.push({ id, scope: "user", enabledInClaude: userEnabled[id] !== false, contents });
  }
  return { plugins, problems };
}
