import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { RouteBinding } from "../contracts/index.ts";
import {
  BUILTIN_THEMES,
  builtinTheme,
  customTheme,
  defaultThemeName,
  detectColorDepth,
  WELCOME_FIELDS,
  type ColorDepth,
  type ThemeDefinition,
  type WelcomeSettings,
} from "../tui/index.ts";
import type { RuntimeConfig } from "./config.ts";
import type { Runtime } from "./runtime.ts";

/**
 * K8 appearance for the interactive view: the themes (built-ins plus `<synorch home>/themes/*.yaml`),
 * the active one, the terminal's colour depth, the welcome settings (`ui.welcome.*`, the custom
 * logo from `<synorch home>/logo.txt`) and the welcome's facts (plan label, worker team).
 */

export interface Appearance {
  readonly theme: ThemeDefinition;
  readonly themes: readonly ThemeDefinition[];
  readonly colorDepth: ColorDepth;
  readonly welcome: WelcomeSettings;
  /** Theme file problems, shown once as a note. */
  readonly problems: readonly string[];
}

const LOGO_FILE = "logo.txt";

async function loadCustomThemes(home: string): Promise<{ readonly themes: ThemeDefinition[]; readonly problems: string[] }> {
  const directory = path.join(home, "themes");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => /\.ya?ml$/i.test(name)).sort();
  } catch {
    return { themes: [], problems: [] };
  }
  const themes: ThemeDefinition[] = [];
  const problems: string[] = [];
  for (const file of names.slice(0, 50)) {
    const name = file.replace(/\.ya?ml$/i, "");
    if (builtinTheme(name) !== undefined) {
      problems.push(`themes/${file}: "${name}" is a built-in theme; rename the file and use extends: ${name}`);
      continue;
    }
    try {
      const raw: unknown = parseYaml(await readFile(path.join(directory, file), "utf8"));
      const loaded = customTheme(name, raw, [...BUILTIN_THEMES, ...themes]);
      problems.push(...loaded.problems);
      if (loaded.theme !== undefined) themes.push(loaded.theme);
    } catch (error) {
      problems.push(`themes/${file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  return { themes, problems };
}

async function loadLogo(home: string): Promise<string[] | undefined> {
  try {
    const text = await readFile(path.join(home, LOGO_FILE), "utf8");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    return lines.length === 0 ? undefined : lines.slice(0, 6);
  } catch {
    return undefined;
  }
}

export async function loadAppearance(home: string, config: RuntimeConfig, env: Readonly<Record<string, string | undefined>>, platform: string): Promise<Appearance> {
  const custom = await loadCustomThemes(home);
  const themes = [...BUILTIN_THEMES, ...custom.themes];
  const problems = [...custom.problems];
  const wanted = config.theme;
  let theme = wanted === undefined ? undefined : themes.find((candidate) => candidate.name === wanted);
  if (wanted !== undefined && theme === undefined) problems.push(`ui.theme "${wanted}" is not a built-in theme or a file in ${path.join(home, "themes")}; using the default`);
  theme ??= builtinTheme(defaultThemeName(env)) ?? BUILTIN_THEMES[0]!;
  const customLogo = await loadLogo(home);
  const welcome: WelcomeSettings = {
    style: config.welcome.style ?? "full",
    logo: config.welcome.logo === "custom" && customLogo === undefined ? "on" : (config.welcome.logo ?? "on"),
    fields: config.welcome.fields ?? WELCOME_FIELDS,
    tips: config.welcome.tips ?? true,
    ...(customLogo === undefined ? {} : { customLogo }),
  };
  return { theme, themes, colorDepth: detectColorDepth(env, platform), welcome, problems };
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI" };

/** `ChatGPT`, `Claude Code`, `OpenAI API`… from the route's adapter; undefined for scripted test routes. */
export function planLabel(runtime: Runtime, route: Pick<RouteBinding, "provider_id" | "adapter_id">): string | undefined {
  if (route.provider_id === "scripted") return undefined;
  const method = runtime.adapters.find((adapter) => adapter.adapterId === route.adapter_id)?.authMethod;
  const provider = PROVIDER_NAMES[route.provider_id] ?? route.provider_id;
  if (route.provider_id === "openai") return method === "oauth-subscription" ? "ChatGPT" : method === "cli-bridge" ? "Codex CLI" : "OpenAI API";
  if (route.provider_id === "anthropic") return method === "cli-bridge" ? "Claude Code" : method === "oauth-subscription" ? "Claude" : "Anthropic API";
  return method === "api-key" ? `${provider} API` : method === "cli-bridge" ? `${provider} CLI` : provider;
}

/** The subscription's plan (`ChatGPT Plus`) from the stored login; undefined when unknown. No network request. */
export async function subscriptionPlan(runtime: Runtime, route: Pick<RouteBinding, "provider_id" | "adapter_id" | "profile">, signal: AbortSignal): Promise<string | undefined> {
  const method = runtime.adapters.find((adapter) => adapter.adapterId === route.adapter_id)?.authMethod;
  if (method !== "oauth-subscription") return undefined;
  const status = await runtime.authProvider(route.provider_id, method, route.profile ?? "default")?.status(signal).catch(() => undefined);
  const plan = status?.plan_label?.trim();
  if (plan === undefined || plan === "") return undefined;
  const base = planLabel(runtime, route) ?? route.provider_id;
  const pretty = plan.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  return pretty.toLowerCase().startsWith(base.toLowerCase()) ? pretty : `${base} ${pretty}`;
}

/** Worker models (other tiers' general routes) that differ from the conversation model, at most three. */
export function workerModels(runtime: Runtime, sessionTier: string, sessionModel: string): string[] {
  const models: string[] = [];
  for (const rule of runtime.routeRules()) {
    if (rule.role !== undefined || rule.tier === sessionTier) continue;
    const model = rule.route.model_id;
    if (model !== sessionModel && !models.includes(model)) models.push(model);
  }
  return models.slice(0, 3);
}

/** Short commit of a built package (`dist/build-info.json`, written by the build); undefined from sources. */
export function buildCommit(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(fileURLToPath(new URL("../../build-info.json", import.meta.url)), "utf8")) as { commit?: unknown };
    return typeof parsed.commit === "string" && /^[0-9a-f]{4,40}$/.test(parsed.commit) ? parsed.commit : undefined;
  } catch {
    return undefined;
  }
}

export function userHome(env: Readonly<Record<string, string | undefined>>): string {
  return env.HOME ?? env.USERPROFILE ?? os.homedir();
}
