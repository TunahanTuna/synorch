import { existsSync } from "node:fs";
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
  profileNameSchema,
  providerIdSchema,
  type MemoryConfig,
  type ModelRouterConfig,
  type RouteRule,
  type RouteSource,
} from "../contracts/index.ts";
import { policyConfigSchema, type PolicyConfig } from "../policy/index.ts";
import type { RouteOverride } from "./args.ts";

/**
 * Runtime configuration (providers-and-configuration design). Three YAML files are read, each
 * optional, and a session layer comes from `--profile` flags:
 *
 *   user       <synorch home>/config.yaml                  (SYNORCH_HOME or ~/.synorch)
 *   workspace  nearest ancestor of the target with .synorch/config.yaml (never the synorch home)
 *   project    <target>/.synorch/config.yaml
 *
 * Route precedence is `session > project > workspace > user > provider-default`; the router
 * applies it from each rule's `source`. `.synorch/` is a reserved path, so no worker can edit a
 * repository layer. Repository layers may only narrow policy, and only the user layer chooses the
 * memory root and colour.
 */

export const CONFIG_FILE = "config.yaml";
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
});

const configFileSchema = z.strictObject({
  policy: policyConfigSchema.optional(),
  memory: memoryConfigSchema.optional(),
  routes: z.array(routeEntrySchema).optional(),
  adapters: z.array(adapterEntrySchema).optional(),
  ui: z.strictObject({ color: z.boolean().optional() }).optional(),
  budget: z
    .strictObject({
      max_wall_time_seconds: z.int().positive().optional(),
      max_cost_usd: z.number().positive().optional(),
    })
    .optional(),
});
type ConfigFile = z.infer<typeof configFileSchema>;

export type ConfigLayer = "user" | "workspace" | "project";

export interface ConfiguredAdapter {
  readonly id: string;
  readonly kind: ConfigurableAdapterKind;
  readonly script: string | undefined;
  readonly provider: string | undefined;
  readonly baseUrl: string | undefined;
  readonly source: ConfigLayer;
}

export interface LoadedConfigFile {
  readonly layer: ConfigLayer;
  readonly path: string;
}

export interface RuntimeConfig {
  readonly files: readonly LoadedConfigFile[];
  readonly router: ModelRouterConfig;
  readonly adapters: readonly ConfiguredAdapter[];
  readonly userPolicy: PolicyConfig | undefined;
  readonly workspacePolicy: PolicyConfig | undefined;
  readonly memory: MemoryConfig | undefined;
  readonly color: boolean | undefined;
  readonly budget: { readonly maxWallTimeSeconds: number | undefined; readonly maxCostUsd: number | undefined };
}

function configError(message: string, file?: string): HarnessError {
  return new HarnessError({
    code: "config_invalid",
    message: (file === undefined ? message : `${file}: ${message}`).slice(0, 2000),
    workspace_effect: "none",
    retry_safe: false,
  });
}

async function readLayer(file: string): Promise<ConfigFile | undefined> {
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
  if (raw === null || raw === undefined) return {};
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) throw configError(formatZodIssues(parsed.error), file);
  return parsed.data;
}

/** The nearest ancestor (strictly above `target`) holding `.synorch/config.yaml`, excluding the synorch home. */
export function findWorkspaceConfig(target: string, home: string): string | undefined {
  const homeResolved = path.resolve(home).toLowerCase();
  let current = path.dirname(path.resolve(target));
  for (;;) {
    const dotDir = path.join(current, ".synorch");
    const candidate = path.join(dotDir, CONFIG_FILE);
    if (path.resolve(dotDir).toLowerCase() !== homeResolved && existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
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
    return {
      id: entry.id,
      kind: entry.kind,
      script: entry.script === undefined ? undefined : path.resolve(path.dirname(configPath), entry.script),
      provider: entry.provider,
      baseUrl: entry.base_url,
      source: layer,
    };
  });
}

/** `~/.synorch` or `$SYNORCH_HOME`, matching the auth module's resolution. */
export function resolveHome(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.SYNORCH_HOME;
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".synorch");
}

export async function loadRuntimeConfig(home: string, target: string, overrides: readonly RouteOverride[] = []): Promise<RuntimeConfig> {
  const userPath = path.join(home, CONFIG_FILE);
  const workspacePath = findWorkspaceConfig(target, home);
  const projectPath = path.join(path.resolve(target), ".synorch", CONFIG_FILE);
  const samePlace = path.resolve(path.dirname(projectPath)).toLowerCase() === path.resolve(home).toLowerCase();
  const user = await readLayer(userPath);
  const workspace = workspacePath === undefined ? undefined : await readLayer(workspacePath);
  const project = samePlace ? undefined : await readLayer(projectPath);

  const files: LoadedConfigFile[] = [];
  if (user !== undefined) files.push({ layer: "user", path: userPath });
  if (workspace !== undefined && workspacePath !== undefined) files.push({ layer: "workspace", path: workspacePath });
  if (project !== undefined) files.push({ layer: "project", path: projectPath });

  for (const [layer, file] of [["workspace", workspace], ["project", project]] as const) {
    if (file?.memory !== undefined) throw configError(`the memory root is chosen in the user configuration only (found in the ${layer} layer)`);
  }

  const configured = [...rulesOf(user, "user"), ...rulesOf(workspace, "workspace"), ...rulesOf(project, "project")];
  const rules = [...sessionRules(overrides, configured), ...configured];

  const byId = new Map<string, ConfiguredAdapter>();
  for (const adapter of [
    ...adaptersOf(user, "user", userPath),
    ...adaptersOf(workspace, "workspace", workspacePath ?? ""),
    ...adaptersOf(project, "project", projectPath),
  ]) {
    byId.set(adapter.id, adapter);
  }

  const smallest = (values: readonly (number | undefined)[]): number | undefined => {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length === 0 ? undefined : Math.min(...defined);
  };
  const layers = [user, workspace, project];
  return {
    files,
    router: { rules },
    adapters: [...byId.values()],
    userPolicy: user?.policy,
    workspacePolicy: narrowPolicies(workspace?.policy, project?.policy),
    memory: user?.memory,
    color: user?.ui?.color,
    budget: {
      maxWallTimeSeconds: smallest(layers.map((layer) => layer?.budget?.max_wall_time_seconds)),
      maxCostUsd: smallest(layers.map((layer) => layer?.budget?.max_cost_usd)),
    },
  };
}
