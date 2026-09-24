import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodIssues } from "../../domain/zod-issues.ts";
import {
  adapterIdSchema,
  agentRoleSchema,
  HarnessError,
  memoryConfigSchema,
  modelIdSchema,
  modelTierSchema,
  permissionModeSchema,
  profileNameSchema,
  providerIdSchema,
  type MemoryConfig,
  type PermissionMode,
  type ModelRouterConfig,
  type RouteRule,
  type RouteSource,
} from "../contracts/index.ts";
import { policyConfigSchema, type PolicyConfig } from "../policy/index.ts";
import { WEB_SEARCH_PROVIDERS, type WebSearchProvider } from "../providers/index.ts";
import { CLAUDE_CODE_MODES, type ClaudeCodeMode } from "../providers/claude-code/native.ts";
import type { RouteOverride } from "./args.ts";

/** K4.1 `web` block (user layer only): search backend, native provider search, private fetch exceptions. */
const webConfigSchema = z.strictObject({
  search: z
    .strictObject({
      /** `auto` (default): ChatGPT subscription → Claude Code bridge → OpenAI / Anthropic API key → Brave/Tavily/Exa key. */
      provider: z.enum(WEB_SEARCH_PROVIDERS).optional(),
      /** Model of the ChatGPT / OpenAI API search sub-request. */
      model: modelIdSchema.optional(),
    })
    .optional(),
  /** Attach OpenAI's hosted web_search to OpenAI routes (default true; headless only when set to true explicitly). */
  openai_hosted: z.boolean().optional(),
  fetch: z
    .strictObject({
      /** `host:port` entries web_fetch may reach although they resolve to private addresses (local dev servers). */
      allow_private: z.array(z.string().min(3).max(260)).max(64).optional(),
    })
    .optional(),
});

export interface WebConfig {
  readonly searchProvider: WebSearchProvider | undefined;
  readonly searchModel: string | undefined;
  readonly openaiHosted: boolean | undefined;
  readonly allowPrivate: readonly string[];
}

/**
 * Runtime configuration (providers-and-configuration design). Three YAML files are read, each
 * optional, and a session layer comes from `--profile` flags:
 *
 *   user       <synorch home>/config.yaml                  (SYNORCH_HOME or ~/.synorch)
 *   workspace  nearest ancestor of the target with .synorch/config.yaml (never a synorch home)
 *   project    <target>/.synorch/config.yaml                (never a synorch home)
 *
 * A synorch home is never read as a repository layer: the walk skips the `.synorch` directory that
 * canonically (realpath, case-folded on Windows and macOS) equals the resolved home, and any other
 * `.synorch` directory holding a home marker (`SYNORCH_HOME_MARKERS`: credentials, trust or auth
 * state), such as a stray `~/.synorch` while `SYNORCH_HOME` points elsewhere. Skipping a directory
 * can only drop a narrowing layer, never grant anything. `ConfigDiscoveryOptions.ceiling` bounds
 * the walk (tests anchor it at their sandbox root so files above the OS temp dir cannot leak in).
 *
 * Trust layering (SEC-C1): the workspace and project layers are repository content and therefore
 * untrusted. Only the user layer and explicit session flags choose adapters, endpoints, routes,
 * profiles, the memory root and colour. A repository layer may only narrow: a stricter policy
 * (mode, forbidden paths, sandbox, allowlist and network intersections) and tighter budgets. Any
 * other key in a repository layer is ignored and reported as a `ConfigWarning`, which doctor and
 * the session header show and `session/opened.config_ignored` records. Route precedence is
 * therefore `session > user > provider-default`. `.synorch/` is a reserved path, so no worker can
 * edit a repository layer either.
 *
 * Endpoints are pinned (`OFFICIAL_ENDPOINTS`): a `base_url` outside the adapter kind's official
 * origins needs `allow_custom_endpoint: true` on that user adapter entry, and the ChatGPT
 * subscription adapter never accepts a non-official host, because its OAuth token must not leave
 * the official service.
 */

export const CONFIG_FILE = "config.yaml";
export const GLYPH_SET_CHOICES = ["auto", "rich", "safe", "ascii"] as const;
export type GlyphSetChoice = (typeof GLYPH_SET_CHOICES)[number];
export const ADAPTER_KINDS_CONFIGURABLE = ["openai-chatgpt", "openai-responses", "anthropic-messages", "claude-code", "scripted"] as const;
export type ConfigurableAdapterKind = (typeof ADAPTER_KINDS_CONFIGURABLE)[number];

/** The adapter a route uses when it names only the provider. */
export const DEFAULT_ADAPTER_FOR_PROVIDER: Readonly<Record<string, string>> = {
  openai: "openai-chatgpt",
  anthropic: "anthropic-messages",
  scripted: "scripted",
};

const routeEntrySchema = z.strictObject({
  tier: modelTierSchema,
  role: agentRoleSchema.optional(),
  provider: providerIdSchema,
  model: modelIdSchema,
  adapter: adapterIdSchema.optional(),
  profile: profileNameSchema.optional(),
});

const adapterEntrySchema = z.strictObject({
  id: adapterIdSchema,
  kind: z.enum(ADAPTER_KINDS_CONFIGURABLE),
  /** `scripted` only: a JSON file of scripted responses, relative to the config file. */
  script: z.string().min(1).optional(),
  /** `scripted` only: the provider id the adapter reports (default `scripted`). */
  provider: providerIdSchema.optional(),
  base_url: z.url().optional(),
  /** HTTP API-key adapters only: permits a `base_url` outside `OFFICIAL_ENDPOINTS` (never for `openai-chatgpt`). */
  allow_custom_endpoint: z.boolean().optional(),
  /** `claude-code` only: accept a bridge turn whose reported auth source is not the subscription login. */
  allow_non_subscription_auth: z.boolean().optional(),
});

/**
 * Official origins per HTTP adapter kind. A configured `base_url` must use one of these origins
 * unless the user adapter entry says `allow_custom_endpoint: true`. `openai-chatgpt` carries a
 * subscription OAuth token and never accepts another host.
 */
export const OFFICIAL_ENDPOINTS: Readonly<Record<"openai-chatgpt" | "openai-responses" | "anthropic-messages", readonly string[]>> = {
  "openai-chatgpt": ["https://chatgpt.com"],
  "openai-responses": ["https://api.openai.com"],
  "anthropic-messages": ["https://api.anthropic.com"],
};

/** Keys a repository (workspace or project) layer may set; every other known key is ignored with a warning. */
export const REPOSITORY_LAYER_KEYS = ["policy", "budget"] as const;

const configFileSchema = z.strictObject({
  policy: policyConfigSchema.optional(),
  memory: memoryConfigSchema.optional(),
  routes: z.array(routeEntrySchema).optional(),
  adapters: z.array(adapterEntrySchema).optional(),
  ui: z
    .strictObject({
      color: z.boolean().optional(),
      permission_mode: permissionModeSchema.optional(),
      /** Start the interactive view with mouse capture on (wheel scroll, click to expand). */
      mouse: z.boolean().optional(),
      /** Glyph set of the interactive view; `auto` (or unset) detects it. `SYN_GLYPHS` still wins. */
      glyphs: z.enum(GLYPH_SET_CHOICES).optional(),
    })
    .optional(),
  /** Router preferences (user layer only). */
  routing: z
    .strictObject({
      /** Reviewer independence: prefer a reviewer route on a provider other than the implementer's (default true). */
      prefer_different_provider: z.boolean().optional(),
    })
    .optional(),
  /** Claude Code bridge (user layer only): `native` (default) runs Claude's built-in tools, `restricted` only Synorch's. */
  claude_code: z
    .strictObject({
      mode: z.enum(CLAUDE_CODE_MODES).optional(),
    })
    .optional(),
  budget: z
    .strictObject({
      max_wall_time_seconds: z.int().positive().optional(),
      max_cost_usd: z.number().positive().optional(),
    })
    .optional(),
  web: webConfigSchema.optional(),
});
type ConfigFile = z.infer<typeof configFileSchema>;
export type UserConfigFile = ConfigFile;

/**
 * Validates the text of a user configuration file exactly as a session would read it (schema and
 * adapter checks). Returns the parsed file, or throws a `config_invalid` HarnessError.
 */
export function validateUserConfigText(text: string, file: string): ConfigFile {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw configError(`not valid YAML: ${(error as Error).message.split("\n")[0] ?? ""}`, file);
  }
  if (raw === null || raw === undefined) return {};
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) throw configError(formatZodIssues(parsed.error), file);
  adaptersOf(parsed.data, "user", file);
  return parsed.data;
}

export type ConfigLayer = "user" | "workspace" | "project";

export interface ConfiguredAdapter {
  readonly id: string;
  readonly kind: ConfigurableAdapterKind;
  readonly script: string | undefined;
  readonly provider: string | undefined;
  readonly baseUrl: string | undefined;
  readonly source: ConfigLayer;
  /** `claude-code` only: the user opted in to auth sources other than the subscription login. */
  readonly allowNonSubscriptionAuth?: boolean;
}

/** A repository-layer key that was ignored because only the user layer or a session flag may set it. */
export interface ConfigWarning {
  readonly layer: "workspace" | "project";
  readonly path: string;
  readonly key: string;
  readonly message: string;
}

export interface LoadedConfigFile {
  readonly layer: ConfigLayer;
  readonly path: string;
}

export interface RuntimeConfig {
  readonly files: readonly LoadedConfigFile[];
  /** Repository-layer keys that were ignored (trust layering); empty when nothing was ignored. */
  readonly warnings: readonly ConfigWarning[];
  readonly router: ModelRouterConfig;
  readonly adapters: readonly ConfiguredAdapter[];
  readonly userPolicy: PolicyConfig | undefined;
  readonly workspacePolicy: PolicyConfig | undefined;
  readonly memory: MemoryConfig | undefined;
  readonly color: boolean | undefined;
  /** `ui.permission_mode` (user layer only): the interactive conversation's starting permission mode. */
  readonly permissionMode: PermissionMode | undefined;
  /** `routing.prefer_different_provider` (user layer only); undefined means the router default (true). */
  readonly preferDifferentProvider: boolean | undefined;
  /** `ui.mouse` (user layer only). */
  readonly mouse: boolean | undefined;
  /** `ui.glyphs` (user layer only); `auto` or undefined detects the set. */
  readonly glyphs: GlyphSetChoice | undefined;
  /** `claude_code.mode` (user layer only); undefined means `native`. */
  readonly claudeCodeMode: ClaudeCodeMode | undefined;
  readonly budget: { readonly maxWallTimeSeconds: number | undefined; readonly maxCostUsd: number | undefined };
  /** `web.*` (user layer only, K4.1). */
  readonly web: WebConfig;
}

function configError(message: string, file?: string): HarnessError {
  return new HarnessError({
    code: "config_invalid",
    message: (file === undefined ? message : `${file}: ${message}`).slice(0, 2000),
    workspace_effect: "none",
    retry_safe: false,
  });
}

interface LayerRead {
  readonly file: ConfigFile;
  readonly ignored: readonly string[];
}

async function readLayer(file: string): Promise<ConfigFile | undefined>;
async function readLayer(file: string, repository: true): Promise<LayerRead | undefined>;
async function readLayer(file: string, repository = false): Promise<ConfigFile | LayerRead | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw configError(`cannot read configuration: ${(error as Error).message}`, file);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw configError(`not valid YAML: ${(error as Error).message.split("\n")[0] ?? ""}`, file);
  }
  if (raw === null || raw === undefined) return repository ? { file: {}, ignored: [] } : {};
  const ignored: string[] = [];
  if (repository && typeof raw === "object" && !Array.isArray(raw)) {
    // Keys a repository may not set are dropped before validation, so an untrusted file can neither
    // widen trust nor break the run with a malformed value in a key that is ignored anyway.
    const allowed = new Set<string>(REPOSITORY_LAYER_KEYS);
    const known = new Set(Object.keys(configFileSchema.shape));
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (allowed.has(key) || !known.has(key)) kept[key] = value;
      else ignored.push(key);
    }
    raw = kept;
  }
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) throw configError(formatZodIssues(parsed.error), file);
  return repository ? { file: parsed.data, ignored } : parsed.data;
}

const IGNORED_KEY_REASON: Readonly<Record<string, string>> = {
  routes: "routes choose providers, models and billing; set them in the user configuration or with --profile",
  adapters: "adapters choose endpoints and credentials; declare them in the user configuration",
  memory: "the memory root is chosen in the user configuration only",
  ui: "display settings are chosen in the user configuration only",
  routing: "routing preferences are chosen in the user configuration only",
  web: "web search and fetch settings are chosen in the user configuration only",
  claude_code: "the Claude Code bridge mode is chosen in the user configuration only",
};

function warningsOf(layer: "workspace" | "project", file: string, read: LayerRead | undefined): ConfigWarning[] {
  return (read?.ignored ?? []).map((key) => ({
    layer,
    path: file,
    key,
    message: `ignored ${key} in the ${layer} configuration (${file}): ${IGNORED_KEY_REASON[key] ?? "a repository layer may only narrow policy and budgets"}`,
  }));
}

/** Why a `base_url` is refused for an adapter kind, or undefined when it is allowed. */
export function checkEndpoint(kind: ConfigurableAdapterKind, baseUrl: string, allowCustom: boolean): string | undefined {
  if (kind === "claude-code" || kind === "scripted") return `base_url does not apply to kind ${kind}`;
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (url.username !== "" || url.password !== "") return "base_url must not carry credentials";
    origin = url.origin;
  } catch {
    return "base_url is not a valid URL";
  }
  const official = OFFICIAL_ENDPOINTS[kind];
  if (official.includes(origin)) return undefined;
  if (kind === "openai-chatgpt") return `the ChatGPT subscription token is only sent to ${official.join(", ")}; ${origin} is refused`;
  if (!allowCustom) return `${origin} is not an official ${kind} endpoint (${official.join(", ")}); set allow_custom_endpoint: true on this adapter to use it`;
  return undefined;
}

/** Files that only a synorch home holds; a `.synorch` directory containing one is never a repository layer. */
export const SYNORCH_HOME_MARKERS = ["credentials.json", "credentials.dpapi.json", "trust.json", "auth-state.json"] as const;

export interface ConfigDiscoveryOptions {
  /** The highest directory the workspace walk may inspect; directories above it are never read. */
  readonly ceiling?: string;
  readonly platform?: NodeJS.Platform;
}

function canonicalPath(target: string, platform: NodeJS.Platform): string {
  let resolved = path.resolve(target);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // A missing path keeps its lexical form.
  }
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/** Whether `dotDir` is the resolved synorch home or looks like another synorch home (holds a home marker). */
export function isSynorchHome(dotDir: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (canonicalPath(dotDir, platform) === canonicalPath(home, platform)) return true;
  return SYNORCH_HOME_MARKERS.some((marker) => existsSync(path.join(dotDir, marker)));
}

/** The nearest ancestor (strictly above `target`, not above `ceiling`) holding `.synorch/config.yaml`, skipping synorch homes. */
export function findWorkspaceConfig(target: string, home: string, options: ConfigDiscoveryOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const ceiling = options.ceiling === undefined ? undefined : canonicalPath(options.ceiling, platform);
  let current = path.dirname(path.resolve(target));
  if (ceiling !== undefined && canonicalPath(path.resolve(target), platform) === ceiling) return undefined;
  for (;;) {
    const dotDir = path.join(current, ".synorch");
    const candidate = path.join(dotDir, CONFIG_FILE);
    if (existsSync(candidate) && !isSynorchHome(dotDir, home, platform)) return candidate;
    const parent = path.dirname(current);
    if (parent === current || (ceiling !== undefined && canonicalPath(current, platform) === ceiling)) return undefined;
    current = parent;
  }
}

function rulesOf(file: ConfigFile | undefined, source: RouteSource): RouteRule[] {
  return (file?.routes ?? []).map((entry) => ({
    source,
    tier: entry.tier,
    ...(entry.role === undefined ? {} : { role: entry.role }),
    route: {
      provider_id: entry.provider,
      model_id: entry.model,
      adapter_id: entry.adapter ?? DEFAULT_ADAPTER_FOR_PROVIDER[entry.provider] ?? entry.provider,
      ...(entry.profile === undefined ? {} : { profile: entry.profile }),
    },
  }));
}

/**
 * `--profile <tier>=<route>` with route `<provider>/<model>[@<adapter>]`. The adapter defaults to
 * the one a configured rule already uses for that provider, then to the provider's default adapter.
 */
export function sessionRules(overrides: readonly RouteOverride[], configured: readonly RouteRule[]): RouteRule[] {
  return overrides.map((override) => {
    const match = /^([^/@\s]+)\/([^@\s]+)(?:@([^@\s]+))?$/.exec(override.route);
    const provider = providerIdSchema.safeParse(match?.[1]);
    const model = modelIdSchema.safeParse(match?.[2]);
    const explicit = match?.[3];
    if (match === null || !provider.success || !model.success || (explicit !== undefined && !adapterIdSchema.safeParse(explicit).success)) {
      throw new HarnessError({
        code: "usage_invalid",
        message: `Invalid --profile route: ${override.route}. Expected <provider>/<model>[@<adapter>], for example openai/gpt-5.`,
        workspace_effect: "none",
        retry_safe: true,
      });
    }
    const adapter =
      explicit ??
      configured.find((rule) => rule.route.provider_id === provider.data)?.route.adapter_id ??
      DEFAULT_ADAPTER_FOR_PROVIDER[provider.data] ??
      provider.data;
    return { source: "session", tier: override.tier, route: { provider_id: provider.data, model_id: model.data, adapter_id: adapter } };
  });
}

function strictestMode(modes: readonly (PolicyConfig["mode"] | undefined)[]): PolicyConfig["mode"] {
  if (modes.includes("ask")) return "ask";
  return modes.find((mode) => mode !== undefined);
}

const NETWORK_ORDER = ["deny", "allowlist", "allow"] as const;

/** Project and workspace layers both live in repositories; each may only narrow, so they are intersected. */
export function narrowPolicies(first: PolicyConfig | undefined, second: PolicyConfig | undefined): PolicyConfig | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  const mode = strictestMode([first.mode, second.mode]);
  const forbidden = [...new Set([...(first.forbidden ?? []), ...(second.forbidden ?? [])])];
  const allowlist =
    first.external_write_allowlist === undefined
      ? second.external_write_allowlist
      : second.external_write_allowlist === undefined
        ? first.external_write_allowlist
        : first.external_write_allowlist.filter((entry) => second.external_write_allowlist?.includes(entry));
  let network = first.network ?? second.network;
  if (first.network !== undefined && second.network !== undefined) {
    const rank = Math.min(NETWORK_ORDER.indexOf(first.network.mode), NETWORK_ORDER.indexOf(second.network.mode));
    network = { mode: NETWORK_ORDER[rank] ?? "deny", hosts: first.network.hosts.filter((host) => second.network?.hosts.includes(host)) };
  }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(first.require_full_sandbox === true || second.require_full_sandbox === true ? { require_full_sandbox: true } : {}),
    ...(forbidden.length === 0 ? {} : { forbidden }),
    ...(allowlist === undefined ? {} : { external_write_allowlist: allowlist }),
    ...(network === undefined ? {} : { network }),
  };
}

function adaptersOf(file: ConfigFile | undefined, layer: ConfigLayer, configPath: string): ConfiguredAdapter[] {
  return (file?.adapters ?? []).map((entry) => {
    if (entry.kind !== "scripted" && (entry.script !== undefined || entry.provider !== undefined)) {
      throw configError(`adapter ${entry.id}: script and provider apply only to kind scripted`, configPath);
    }
    if (entry.kind === "scripted" && entry.script === undefined) throw configError(`adapter ${entry.id}: a scripted adapter needs script`, configPath);
    if (entry.allow_non_subscription_auth !== undefined && entry.kind !== "claude-code") {
      throw configError(`adapter ${entry.id}: allow_non_subscription_auth applies only to kind claude-code`, configPath);
    }
    if (entry.base_url !== undefined) {
      const refused = checkEndpoint(entry.kind, entry.base_url, entry.allow_custom_endpoint === true);
      if (refused !== undefined) throw configError(`adapter ${entry.id}: ${refused}`, configPath);
    }
    return {
      id: entry.id,
      kind: entry.kind,
      script: entry.script === undefined ? undefined : path.resolve(path.dirname(configPath), entry.script),
      provider: entry.provider,
      baseUrl: entry.base_url,
      source: layer,
      ...(entry.allow_non_subscription_auth === true ? { allowNonSubscriptionAuth: true } : {}),
    };
  });
}

/** `~/.synorch` or `$SYNORCH_HOME`, matching the auth module's resolution. */
export function resolveHome(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.SYNORCH_HOME;
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".synorch");
}

export async function loadRuntimeConfig(
  home: string,
  target: string,
  overrides: readonly RouteOverride[] = [],
  discovery: ConfigDiscoveryOptions = {},
): Promise<RuntimeConfig> {
  const userPath = path.join(home, CONFIG_FILE);
  const workspacePath = findWorkspaceConfig(target, home, discovery);
  const projectPath = path.join(path.resolve(target), ".synorch", CONFIG_FILE);
  const samePlace = isSynorchHome(path.dirname(projectPath), home, discovery.platform ?? process.platform);
  const user = await readLayer(userPath);
  const workspaceRead = workspacePath === undefined ? undefined : await readLayer(workspacePath, true);
  const projectRead = samePlace ? undefined : await readLayer(projectPath, true);
  const workspace = workspaceRead?.file;
  const project = projectRead?.file;

  const files: LoadedConfigFile[] = [];
  if (user !== undefined) files.push({ layer: "user", path: userPath });
  if (workspace !== undefined && workspacePath !== undefined) files.push({ layer: "workspace", path: workspacePath });
  if (project !== undefined) files.push({ layer: "project", path: projectPath });
  const warnings = [...warningsOf("workspace", workspacePath ?? "", workspaceRead), ...warningsOf("project", projectPath, projectRead)];

  // Only the user layer and session flags route requests or declare adapters (SEC-C1).
  const configured = rulesOf(user, "user");
  const rules = [...sessionRules(overrides, configured), ...configured];

  const byId = new Map<string, ConfiguredAdapter>();
  for (const adapter of adaptersOf(user, "user", userPath)) byId.set(adapter.id, adapter);

  const smallest = (values: readonly (number | undefined)[]): number | undefined => {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length === 0 ? undefined : Math.min(...defined);
  };
  const layers = [user, workspace, project];
  return {
    files,
    warnings,
    router: { rules },
    adapters: [...byId.values()],
    userPolicy: user?.policy,
    workspacePolicy: narrowPolicies(workspace?.policy, project?.policy),
    memory: user?.memory,
    color: user?.ui?.color,
    permissionMode: user?.ui?.permission_mode,
    preferDifferentProvider: user?.routing?.prefer_different_provider,
    mouse: user?.ui?.mouse,
    glyphs: user?.ui?.glyphs,
    claudeCodeMode: user?.claude_code?.mode,
    budget: {
      maxWallTimeSeconds: smallest(layers.map((layer) => layer?.budget?.max_wall_time_seconds)),
      maxCostUsd: smallest(layers.map((layer) => layer?.budget?.max_cost_usd)),
    },
    web: {
      searchProvider: user?.web?.search?.provider,
      searchModel: user?.web?.search?.model,
      openaiHosted: user?.web?.openai_hosted,
      allowPrivate: user?.web?.fetch?.allow_private ?? [],
    },
  };
}
