import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, isMap, isSeq, parseDocument, parse as parseYaml } from "yaml";
import { closestMatch } from "../../domain/suggest.ts";
import {
  adapterIdSchema,
  AGENT_ROLES,
  EXIT_CODES,
  MODEL_TIERS,
  modelIdSchema,
  PERMISSION_MODES,
  POLICY_MODES,
  providerIdSchema,
} from "../contracts/index.ts";
import {
  CONFIG_FILE,
  DEFAULT_ADAPTER_FOR_PROVIDER,
  GLYPH_SET_CHOICES,
  loadRuntimeConfig,
  validateUserConfigText,
  type ConfigDiscoveryOptions,
  type RuntimeConfig,
} from "./config.ts";
import { failureInfo } from "./outcome.ts";

/**
 * `syn config` (K1.5-3) and the settings model behind the in-session `/config` screen. Only the
 * user layer (`<synorch home>/config.yaml`) is ever written: repository layers may only narrow
 * (SEC-C1), so `list` shows where a narrowed value comes from but `set` never touches them. Every
 * write is validated with the same schema a session uses before it replaces the file, and the YAML
 * document is edited in place so comments and unrelated keys survive.
 */

export const CONFIG_SUBCOMMANDS = ["list", "get", "set", "unset", "edit", "path"] as const;
export type ConfigSubcommand = (typeof CONFIG_SUBCOMMANDS)[number];

export type SettingKind = "enum" | "boolean" | "int" | "number" | "string" | "route";
export type SettingSource = "user" | "workspace" | "project" | "default";

export interface SettingDefinition {
  readonly key: string;
  readonly kind: SettingKind;
  readonly choices?: readonly string[];
  /** `user`: only the user layer sets it; `narrow`: repository layers may tighten it. */
  readonly scope: "user" | "narrow";
  readonly description: string;
  /** Shown when nothing sets the key. */
  readonly fallback?: string;
  /** The YAML path of a plain key; routes are an array and have none. */
  readonly yamlPath?: readonly string[];
}

const PLAIN_SETTINGS: readonly SettingDefinition[] = [
  { key: "ui.permission_mode", kind: "enum", choices: PERMISSION_MODES, scope: "user", description: "starting permission mode of interactive sessions", fallback: "auto", yamlPath: ["ui", "permission_mode"] },
  { key: "ui.color", kind: "boolean", scope: "user", description: "colour output (unset: detect; --color and NO_COLOR still apply)", fallback: "auto", yamlPath: ["ui", "color"] },
  { key: "ui.mouse", kind: "boolean", scope: "user", description: "start with mouse capture on (wheel scroll, click to expand)", fallback: "false", yamlPath: ["ui", "mouse"] },
  { key: "ui.glyphs", kind: "enum", choices: GLYPH_SET_CHOICES, scope: "user", description: "glyph set of the interactive view (SYN_GLYPHS wins)", fallback: "auto", yamlPath: ["ui", "glyphs"] },
  { key: "policy.mode", kind: "enum", choices: POLICY_MODES, scope: "narrow", description: "approval mode for plans (ask narrows auto/full to ask)", fallback: "autonomous", yamlPath: ["policy", "mode"] },
  { key: "policy.require_full_sandbox", kind: "boolean", scope: "narrow", description: "refuse edits and commands without a full OS sandbox", fallback: "false", yamlPath: ["policy", "require_full_sandbox"] },
  { key: "budget.max_wall_time_seconds", kind: "int", scope: "narrow", description: "wall-time limit of a run in seconds (smallest layer wins)", yamlPath: ["budget", "max_wall_time_seconds"] },
  { key: "budget.max_cost_usd", kind: "number", scope: "narrow", description: "estimated cost limit of a run in USD (smallest layer wins)", yamlPath: ["budget", "max_cost_usd"] },
  { key: "memory.root", kind: "string", scope: "user", description: "memory vault root (default <synorch home>/memory/<project>)", yamlPath: ["memory", "root"] },
];

const ROUTE_ROLES = AGENT_ROLES.filter((role) => role !== "orchestrator");

function routeDefinition(tier: string, role: string | undefined): SettingDefinition {
  return {
    key: role === undefined ? `routes.${tier}` : `routes.${tier}.${role}`,
    kind: "route",
    scope: "user",
    description: role === undefined ? `model route of the ${tier} tier (provider/model[@adapter])` : `route of the ${tier} tier for the ${role} role only`,
  };
}

/** The settings `list` and `/config` show: every tier route, then the plain keys. */
export function settingDefinitions(): readonly SettingDefinition[] {
  return [...MODEL_TIERS.map((tier) => routeDefinition(tier, undefined)), ...PLAIN_SETTINGS];
}

function allKeys(): string[] {
  return [...settingDefinitions().map((definition) => definition.key), ...MODEL_TIERS.flatMap((tier) => ROUTE_ROLES.map((role) => `routes.${tier}.${role}`))];
}

export class ConfigCommandError extends Error {
  public readonly exitCode: number;
  public constructor(message: string, exitCode: number = EXIT_CODES.usage) {
    super(message);
    this.name = "ConfigCommandError";
    this.exitCode = exitCode;
  }
}

/** The definition of `key`, or a friendly error naming the closest known key. */
export function settingFor(key: string): SettingDefinition {
  const plain = PLAIN_SETTINGS.find((definition) => definition.key === key);
  if (plain !== undefined) return plain;
  const route = /^routes\.([a-z_]+)(?:\.([a-z_]+))?$/.exec(key);
  if (route !== null && (MODEL_TIERS as readonly string[]).includes(route[1] ?? "") && (route[2] === undefined || (ROUTE_ROLES as readonly string[]).includes(route[2]))) {
    return routeDefinition(route[1] ?? "", route[2]);
  }
  const match = closestMatch(key, allKeys());
  const hint = match === undefined ? " Run `syn config list` for the keys." : ` Did you mean ${match}?`;
  const special = key.startsWith("adapters") ? " Adapters are edited with `syn config edit`." : "";
  throw new ConfigCommandError(`Unknown configuration key "${key}".${hint}${special}`);
}

export interface RouteValue {
  readonly provider: string;
  readonly model: string;
  readonly adapter?: string;
}

function parseRoute(raw: string, key: string): RouteValue {
  const match = /^([^/@\s]+)\/([^@\s]+)(?:@([^@\s]+))?$/.exec(raw.trim());
  const provider = providerIdSchema.safeParse(match?.[1]);
  const model = modelIdSchema.safeParse(match?.[2]);
  const adapter = match?.[3];
  if (match === null || !provider.success || !model.success || (adapter !== undefined && !adapterIdSchema.safeParse(adapter).success)) {
    throw new ConfigCommandError(`Invalid route "${raw}" for ${key}. Expected <provider>/<model>[@<adapter>], for example openai/gpt-6-sol or anthropic/opus-5.5@claude-code.`);
  }
  if (adapter === undefined && DEFAULT_ADAPTER_FOR_PROVIDER[provider.data] === undefined) {
    const known = Object.keys(DEFAULT_ADAPTER_FOR_PROVIDER);
    const suggestion = closestMatch(provider.data, known);
    throw new ConfigCommandError(
      `Unknown provider "${provider.data}" in ${key}.${suggestion === undefined ? "" : ` Did you mean ${suggestion}?`} Known: ${known.join(", ")}; another provider needs @<adapter> naming a configured adapter.`,
    );
  }
  return { provider: provider.data, model: model.data, ...(adapter === undefined ? {} : { adapter }) };
}

const TRUE_WORDS = ["true", "on", "yes", "1"];
const FALSE_WORDS = ["false", "off", "no", "0"];

/** Parses a typed value for `definition`; friendly errors with the accepted values. */
export function parseSettingValue(definition: SettingDefinition, raw: string): string | number | boolean | RouteValue {
  const value = raw.trim();
  switch (definition.kind) {
    case "enum": {
      const choices = definition.choices ?? [];
      const exact = choices.find((choice) => choice === value.toLowerCase());
      if (exact !== undefined) return exact;
      const match = closestMatch(value, choices);
      throw new ConfigCommandError(`Invalid value "${raw}" for ${definition.key}. Expected ${choices.join(", ")}.${match === undefined ? "" : ` Did you mean ${match}?`}`);
    }
    case "boolean":
      if (TRUE_WORDS.includes(value.toLowerCase())) return true;
      if (FALSE_WORDS.includes(value.toLowerCase())) return false;
      throw new ConfigCommandError(`Invalid value "${raw}" for ${definition.key}. Expected true or false.`);
    case "int": {
      if (!/^\d+$/.test(value) || Number(value) <= 0) throw new ConfigCommandError(`Invalid value "${raw}" for ${definition.key}. Expected a positive whole number, for example 1800.`);
      return Number(value);
    }
    case "number": {
      const number = Number(value);
      if (value === "" || !Number.isFinite(number) || number <= 0) throw new ConfigCommandError(`Invalid value "${raw}" for ${definition.key}. Expected a positive number, for example 5 or 2.5.`);
      return number;
    }
    case "string":
      if (value === "") throw new ConfigCommandError(`${definition.key} must not be empty; use \`syn config unset ${definition.key}\` to remove it.`);
      return value;
    case "route":
      return parseRoute(value, definition.key);
  }
}

// ---- the user document ----------------------------------------------------------------------

export function userConfigPath(home: string): string {
  return path.join(home, CONFIG_FILE);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigCommandError(`Cannot read ${file}: ${(error as Error).message}`, EXIT_CODES.internal);
  }
}

function routeKeyParts(definition: SettingDefinition): { readonly tier: string; readonly role: string | undefined } {
  const [, tier = "", role] = definition.key.split(".");
  return { tier, role };
}

interface RouteEntryLike {
  readonly tier?: unknown;
  readonly role?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly adapter?: unknown;
}

function routeIndex(document: Document, definition: SettingDefinition): number {
  const { tier, role } = routeKeyParts(definition);
  const routes = document.get("routes");
  if (!isSeq(routes)) return -1;
  const entries = routes.toJSON() as RouteEntryLike[];
  return entries.findIndex((entry) => entry !== null && typeof entry === "object" && entry.tier === tier && (entry.role ?? undefined) === role);
}

function applyValue(document: Document, definition: SettingDefinition, value: ReturnType<typeof parseSettingValue>): void {
  if (definition.kind !== "route") {
    document.setIn([...(definition.yamlPath ?? [])], value);
    return;
  }
  const route = value as RouteValue;
  const { tier, role } = routeKeyParts(definition);
  const node = document.createNode({ tier, ...(role === undefined ? {} : { role }), provider: route.provider, model: route.model, ...(route.adapter === undefined ? {} : { adapter: route.adapter }) });
  node.flow = true;
  const index = routeIndex(document, definition);
  if (index >= 0) document.setIn(["routes", index], node);
  else if (isSeq(document.get("routes"))) document.addIn(["routes"], node);
  else document.set("routes", document.createNode([node]));
}

/** Removes the key; an empty parent map (or routes list) is removed too. Returns whether anything was set. */
function removeValue(document: Document, definition: SettingDefinition): boolean {
  if (definition.kind === "route") {
    const index = routeIndex(document, definition);
    if (index < 0) return false;
    document.deleteIn(["routes", index]);
    const routes = document.get("routes");
    if (isSeq(routes) && routes.items.length === 0) document.delete("routes");
    return true;
  }
  const yamlPath = definition.yamlPath ?? [];
  if (!document.hasIn(yamlPath)) return false;
  document.deleteIn(yamlPath);
  const parentPath = yamlPath.slice(0, -1);
  const parent = parentPath.length === 0 ? undefined : document.getIn(parentPath);
  if (isMap(parent) && parent.items.length === 0) document.deleteIn(parentPath);
  return true;
}

function currentValue(document: Document, definition: SettingDefinition): string | undefined {
  if (definition.kind === "route") {
    const index = routeIndex(document, definition);
    if (index < 0) return undefined;
    const entry = (document.getIn(["routes", index]) as { toJSON(): RouteEntryLike }).toJSON();
    return formatRoute(entry);
  }
  const value = document.getIn([...(definition.yamlPath ?? [])]);
  return value === undefined || value === null ? undefined : String(value);
}

function formatRoute(entry: RouteEntryLike): string {
  return `${String(entry.provider)}/${String(entry.model)}${typeof entry.adapter === "string" ? `@${entry.adapter}` : ""}`;
}

async function writeValidated(home: string, document: Document): Promise<string> {
  const file = userConfigPath(home);
  const text = document.contents === null ? "" : document.toString({ lineWidth: 0 });
  validateUserConfigText(text, file);
  await mkdir(home, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
  return file;
}

async function userDocument(home: string): Promise<Document> {
  const file = userConfigPath(home);
  const text = await readText(file);
  const document = text === undefined ? new Document({}) : parseDocument(text);
  if (document.errors.length > 0) throw new ConfigCommandError(`${file} is not valid YAML (${document.errors[0]?.message.split("\n")[0] ?? ""}); fix it with \`syn config edit\`.`);
  if (document.contents === null) document.contents = document.createNode({}) as unknown as typeof document.contents;
  return document;
}

export interface SettingChange {
  readonly key: string;
  readonly previous: string | undefined;
  readonly value: string | undefined;
  readonly file: string;
}

/** `syn config set` / `/config`: validates the typed value and the resulting file, then writes the user layer. */
export async function setUserSetting(home: string, key: string, raw: string): Promise<SettingChange> {
  const definition = settingFor(key);
  const value = parseSettingValue(definition, raw);
  const document = await userDocument(home);
  const previous = currentValue(document, definition);
  applyValue(document, definition, value);
  const file = await writeValidated(home, document).catch((error: unknown) => {
    throw error instanceof ConfigCommandError ? error : new ConfigCommandError(failureInfo(error).message);
  });
  return { key: definition.key, previous, value: currentValue(document, definition), file };
}

/** `syn config unset`: removes the key from the user layer (a no-op when it is not set). */
export async function unsetUserSetting(home: string, key: string): Promise<SettingChange> {
  const definition = settingFor(key);
  const file = userConfigPath(home);
  if (!existsSync(file)) return { key: definition.key, previous: undefined, value: undefined, file };
  const document = await userDocument(home);
  const previous = currentValue(document, definition);
  if (removeValue(document, definition)) {
    await writeValidated(home, document).catch((error: unknown) => {
      throw error instanceof ConfigCommandError ? error : new ConfigCommandError(failureInfo(error).message);
    });
  }
  return { key: definition.key, previous, value: undefined, file };
}

// ---- effective values -----------------------------------------------------------------------

export interface SettingRow {
  readonly key: string;
  readonly kind: SettingKind;
  readonly choices?: readonly string[];
  /** Display form; undefined when nothing sets it and there is no fallback. */
  readonly value: string | undefined;
  readonly source: SettingSource;
  readonly scope: "user" | "narrow";
  readonly description: string;
}

type RawLayer = Record<string, unknown> | undefined;

async function rawLayer(file: string | undefined): Promise<RawLayer> {
  if (file === undefined) return undefined;
  const text = await readText(file);
  if (text === undefined) return undefined;
  try {
    const raw: unknown = parseYaml(text);
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function lookup(layer: RawLayer, yamlPath: readonly string[]): unknown {
  let current: unknown = layer;
  for (const segment of yamlPath) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export interface ConfigListing {
  readonly userFile: string;
  readonly config: RuntimeConfig;
  readonly rows: readonly SettingRow[];
}

/** Effective values with the layer that decides each one (routes and ui: user; policy and budget: narrowed by repository layers). */
export async function listSettings(home: string, target: string, discovery: ConfigDiscoveryOptions = {}): Promise<ConfigListing> {
  const config = await loadRuntimeConfig(home, target, [], discovery);
  const layerFile = (layer: "user" | "workspace" | "project"): string | undefined => config.files.find((file) => file.layer === layer)?.path;
  const layers = {
    user: await rawLayer(layerFile("user")),
    workspace: await rawLayer(layerFile("workspace")),
    project: await rawLayer(layerFile("project")),
  };
  const rows: SettingRow[] = [];
  for (const definition of settingDefinitions()) {
    const base = { key: definition.key, kind: definition.kind, scope: definition.scope, description: definition.description, ...(definition.choices === undefined ? {} : { choices: definition.choices }) };
    if (definition.kind === "route") {
      const { tier } = routeKeyParts(definition);
      for (const rule of config.router.rules.filter((candidate) => candidate.tier === tier && candidate.source === "user")) {
        const key = rule.role === undefined ? definition.key : `${definition.key}.${rule.role}`;
        const adapterExplicit = rule.route.adapter_id !== (DEFAULT_ADAPTER_FOR_PROVIDER[rule.route.provider_id] ?? rule.route.provider_id);
        rows.push({ ...base, key, value: `${rule.route.provider_id}/${rule.route.model_id}${adapterExplicit ? `@${rule.route.adapter_id}` : ""}`, source: "user" });
      }
      if (!rows.some((row) => row.key === definition.key)) rows.push({ ...base, value: undefined, source: "default" });
      continue;
    }
    const yamlPath = definition.yamlPath ?? [];
    const userValue = lookup(layers.user, yamlPath);
    if (definition.scope === "user") {
      rows.push({ ...base, value: userValue === undefined ? definition.fallback : String(userValue), source: userValue === undefined ? "default" : "user" });
      continue;
    }
    // Narrowable keys: the strictest (ask / true / smallest) of the layers decides.
    let best: { value: unknown; source: SettingSource } | undefined = userValue === undefined ? undefined : { value: userValue, source: "user" };
    for (const layer of ["workspace", "project"] as const) {
      const value = lookup(layers[layer], yamlPath);
      if (value === undefined) continue;
      const stricter =
        best === undefined ||
        (definition.kind === "enum" && value === "ask" && best.value !== "ask") ||
        (definition.kind === "boolean" && value === true && best.value !== true) ||
        ((definition.kind === "int" || definition.kind === "number") && typeof value === "number" && typeof best.value === "number" && value < best.value);
      if (stricter) best = { value, source: layer };
    }
    rows.push({ ...base, value: best === undefined ? definition.fallback : String(best.value), source: best?.source ?? "default" });
  }
  return { userFile: userConfigPath(home), config, rows };
}

export function formatListing(listing: ConfigListing): string[] {
  const keyWidth = Math.max(...listing.rows.map((row) => row.key.length)) + 2;
  const valueWidth = Math.min(40, Math.max(...listing.rows.map((row) => (row.value ?? "(not set)").length)) + 2);
  const lines = [`User configuration: ${listing.userFile}${existsSync(listing.userFile) ? "" : " (not created yet)"}`];
  for (const file of listing.config.files.filter((candidate) => candidate.layer !== "user")) lines.push(`${file.layer === "project" ? "Project" : "Workspace"} layer (may only narrow): ${file.path}`);
  lines.push("");
  for (const row of listing.rows) {
    const source = row.source === "workspace" || row.source === "project" ? `${row.source} (narrowed)` : row.source;
    lines.push(`${row.key.padEnd(keyWidth)}${(row.value ?? "(not set)").padEnd(valueWidth)}${source}`);
  }
  for (const warning of listing.config.warnings) lines.push(`warning: ${warning.message}`);
  lines.push("", "Change: syn config set <key> <value> · remove: syn config unset <key> · everything else: syn config edit");
  return lines;
}

function typedValue(row: SettingRow): unknown {
  if (row.value === undefined) return null;
  if (row.kind === "boolean") return row.value === "true" ? true : row.value === "false" ? false : row.value;
  if (row.kind === "int" || row.kind === "number") return Number(row.value);
  return row.value;
}

// ---- syn config ----------------------------------------------------------------------------

export interface ConfigCommandIO {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly discovery?: ConfigDiscoveryOptions;
  /** Opens `file` in the user's editor and resolves with its exit status (tests replace it). */
  readonly runEditor?: (file: string) => Promise<number>;
}

export interface ConfigInvocation {
  readonly subcommand: ConfigSubcommand;
  readonly args: readonly string[];
  readonly json: boolean;
  readonly target: string | undefined;
}

/** `$VISUAL`, `$EDITOR`, then notepad (Windows) or vi. */
export function editorCommand(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
  const configured = [env.VISUAL, env.EDITOR].find((candidate) => candidate !== undefined && candidate.trim() !== "");
  return configured?.trim() ?? (platform === "win32" ? "notepad" : "vi");
}

function defaultEditor(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): (file: string) => Promise<number> {
  return async (file) => {
    const result = spawnSync(`${editorCommand(env, platform)} "${file}"`, { stdio: "inherit", shell: true });
    if (result.error !== undefined) throw new ConfigCommandError(`Cannot start the editor (${editorCommand(env, platform)}): ${result.error.message}. Set EDITOR, for example EDITOR="code --wait".`, EXIT_CODES.internal);
    return result.status ?? 1;
  };
}

const NEW_FILE_TEMPLATE = `# Synorch user configuration. \`syn config set <key> <value>\` edits it too; \`syn config list\` shows every key.
# Repository layers (.synorch/config.yaml) may only narrow policy and budgets.
#
# routes:
#   - { tier: orchestrator, provider: openai, model: gpt-6-sol }
#   - { tier: complex_worker, provider: anthropic, model: opus-5.5, adapter: claude-code }
# ui: { permission_mode: auto, mouse: false }
# budget: { max_wall_time_seconds: 1800 }
`;

async function editCommand(io: ConfigCommandIO): Promise<number> {
  const file = userConfigPath(io.home);
  const draft = `${file}.edit`;
  await mkdir(io.home, { recursive: true });
  if (existsSync(draft)) io.stderr(`Continuing your unsaved edit (${draft}).\n`);
  else await writeFile(draft, (await readText(file)) ?? NEW_FILE_TEMPLATE, "utf8");
  const status = await (io.runEditor ?? defaultEditor(io.env, io.platform))(draft);
  if (status !== 0) {
    io.stderr(`The editor exited with status ${status}; nothing was saved (your draft stays in ${draft}).\n`);
    return EXIT_CODES.internal;
  }
  const text = (await readText(draft)) ?? "";
  try {
    validateUserConfigText(text, file);
  } catch (error) {
    io.stderr(`Error: ${failureInfo(error).message}\nNothing was saved: ${file} is unchanged. Run \`syn config edit\` again to fix the draft (${draft}).\n`);
    return EXIT_CODES.usage;
  }
  const previous = await readText(file);
  if (previous === text) {
    await rm(draft, { force: true });
    io.stdout("No changes.\n");
    return EXIT_CODES.success;
  }
  await rename(draft, file);
  io.stdout(`Saved ${file}\n`);
  return EXIT_CODES.success;
}

function describeChange(change: SettingChange): string {
  if (change.value === undefined) return change.previous === undefined ? `${change.key} was not set; nothing changed.` : `Removed ${change.key} (was ${change.previous}).`;
  return change.previous === undefined || change.previous === change.value ? `${change.key} = ${change.value}` : `${change.key} = ${change.value} (was ${change.previous})`;
}

const USAGE = "Usage: syn config [list [--json] | get <key> | set <key> <value> | unset <key> | edit | path]";

function expectArgs(invocation: ConfigInvocation, count: number, shape: string): void {
  if (invocation.args.length !== count) {
    const extra = invocation.args.length > count ? ` (quote a value that contains spaces)` : "";
    throw new ConfigCommandError(`syn config ${invocation.subcommand} expects ${shape}${extra}. ${USAGE}`);
  }
}

export async function configCommand(invocation: ConfigInvocation, io: ConfigCommandIO): Promise<number> {
  const target = path.resolve(io.cwd, invocation.target ?? ".");
  try {
    switch (invocation.subcommand) {
      case "path":
        expectArgs(invocation, 0, "no arguments");
        io.stdout(`${userConfigPath(io.home)}\n`);
        return EXIT_CODES.success;
      case "list": {
        expectArgs(invocation, 0, "no arguments");
        const listing = await listSettings(io.home, target, io.discovery);
        if (invocation.json) {
          io.stdout(
            `${JSON.stringify(
              {
                user_config: listing.userFile,
                files: listing.config.files,
                settings: listing.rows.map((row) => ({ key: row.key, value: typedValue(row), source: row.source, scope: row.scope })),
                warnings: listing.config.warnings,
              },
              null,
              2,
            )}\n`,
          );
        } else io.stdout(`${formatListing(listing).join("\n")}\n`);
        return EXIT_CODES.success;
      }
      case "get": {
        expectArgs(invocation, 1, "a key");
        const key = invocation.args[0] ?? "";
        const definition = settingFor(key);
        const listing = await listSettings(io.home, target, io.discovery);
        const row = listing.rows.find((candidate) => candidate.key === definition.key);
        if (row?.value === undefined) {
          io.stderr(`${definition.key} is not set.\n`);
          return 1;
        }
        io.stdout(invocation.json ? `${JSON.stringify({ key: row.key, value: typedValue(row), source: row.source })}\n` : `${row.value}\n`);
        return EXIT_CODES.success;
      }
      case "set": {
        expectArgs(invocation, 2, "a key and a value");
        const change = await setUserSetting(io.home, invocation.args[0] ?? "", invocation.args[1] ?? "");
        io.stdout(`${describeChange(change)}\n`);
        if (settingFor(change.key).scope === "narrow") io.stdout("Note: a repository layer may still narrow this value (syn config list shows the effective one).\n");
        return EXIT_CODES.success;
      }
      case "unset": {
        expectArgs(invocation, 1, "a key");
        io.stdout(`${describeChange(await unsetUserSetting(io.home, invocation.args[0] ?? ""))}\n`);
        return EXIT_CODES.success;
      }
      case "edit":
        expectArgs(invocation, 0, "no arguments");
        return await editCommand(io);
    }
  } catch (error) {
    if (error instanceof ConfigCommandError) {
      io.stderr(`Error: ${error.message}\n`);
      return error.exitCode;
    }
    const info = failureInfo(error);
    io.stderr(`Error: ${info.message}\n${info.code === "config_invalid" ? `Fix it with \`syn config edit\` (${userConfigPath(io.home)}).\n` : ""}`);
    return info.code === "config_invalid" ? EXIT_CODES.usage : EXIT_CODES.internal;
  }
}

/** Parses the positionals of `syn config` (the first names the sub-command; `list` is the default). */
export function parseConfigPositionals(positionals: readonly string[]): { readonly subcommand: ConfigSubcommand; readonly args: readonly string[] } | { readonly error: string } {
  const [first, ...rest] = positionals;
  if (first === undefined) return { subcommand: "list", args: [] };
  if ((CONFIG_SUBCOMMANDS as readonly string[]).includes(first)) return { subcommand: first as ConfigSubcommand, args: rest };
  const aliases: Record<string, ConfigSubcommand> = { ls: "list", show: "list", rm: "unset", remove: "unset", delete: "unset", open: "edit" };
  const alias = aliases[first];
  if (alias !== undefined) return { subcommand: alias, args: rest };
  const match = closestMatch(first, CONFIG_SUBCOMMANDS);
  return { error: `Unknown config sub-command: ${first}. ${match === undefined ? `Expected ${CONFIG_SUBCOMMANDS.join(", ")}.` : `Did you mean: syn config ${match}?`}` };
}
