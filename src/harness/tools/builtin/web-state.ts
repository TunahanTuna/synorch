import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * K4.1 per-runtime web state shared by `web_search`, `web_fetch`, the policy engine and the
 * provider-native searches:
 * - the domains `web_fetch` may reach without a prompt: built-in documentation sites plus the
 *   user's "always allow this domain" grants, persisted globally in the user scope
 *   (`<synorch home>/web-domains.json`; nothing in a repository can grant one);
 * - the prompt-injection shield flag: whether web content entered the current turn;
 * - the URLs the user typed in the conversation (robots.txt is not applied to those);
 * - a 15-minute page cache.
 */

export const WEB_DOMAINS_FILE = "web-domains.json";
export const WEB_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_DOMAINS = 1024;
const MAX_CACHE_ENTRIES = 64;
const MAX_USER_URLS = 512;

/** Documentation and package registries `web_fetch` reads without asking (owner: generous defaults). */
export const DEFAULT_WEB_DOMAINS = [
  "developer.mozilla.org",
  "docs.python.org",
  "nodejs.org",
  "learn.microsoft.com",
  "docs.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "registry.npmjs.org",
  "www.npmjs.com",
  "pypi.org",
  "stackoverflow.com",
  "*.stackexchange.com",
  "docs.rs",
  "crates.io",
  "pkg.go.dev",
  "www.typescriptlang.org",
  "react.dev",
  "nextjs.org",
  "vuejs.org",
  "developer.android.com",
  "developer.apple.com",
  "docs.oracle.com",
  "en.wikipedia.org",
] as const;

const domainsFileSchema = z.strictObject({ schema_version: z.literal(1), domains: z.array(z.string().min(1).max(253)).max(MAX_DOMAINS) });

export interface CachedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly title: string | undefined;
  readonly text: string;
  readonly fetchedAt: string;
  readonly truncatedDownload: boolean;
}

export interface WebSession {
  /** Every domain fetches may reach without a prompt (defaults + user grants). */
  domains(): readonly string[];
  /** The user's persisted grants only. */
  grantedDomains(): readonly string[];
  /** Persists "always allow this domain" (global, user scope); false when it was already granted or invalid. */
  allowDomain(host: string): Promise<boolean>;
  removeDomain(host: string): Promise<boolean>;
  /** The shield: web content entered the current turn. */
  markContentRead(): void;
  contentRead(): boolean;
  /** A new user turn of the conversation: the shield resets. */
  startTurn(): void;
  /** Remembers the URLs in a message the user typed (robots.txt is not applied to them). */
  noteUserText(text: string): void;
  isUserUrl(url: string): boolean;
  cacheGet(url: string): CachedPage | undefined;
  cachePut(page: CachedPage): void;
  /** robots.txt verdicts per origin (cached with the pages). */
  robotsGet(origin: string): { readonly rules: string | undefined; readonly at: number } | undefined;
  robotsPut(origin: string, rules: string | undefined): void;
}

export interface WebSessionOptions {
  /** The Synorch home; undefined keeps grants in memory only (tests, `--no-home`). */
  readonly home?: string;
  readonly defaults?: readonly string[];
  readonly now?: () => number;
}

/** Normalizes a host for a grant: lower-case, no port, no trailing dot; `*.` prefix kept. */
export function normalizeDomain(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = trimmed.startsWith("*.");
  const host = (wildcard ? trimmed.slice(2) : trimmed).replace(/:\d+$/, "");
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(host)) return undefined;
  return wildcard ? `*.${host}` : host;
}

/** The URL without its fragment and with a normalized host, used as the cache and user-URL key. */
export function normalizeUrlKey(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    const text = url.toString();
    return text.endsWith("/") && url.pathname === "/" && url.search === "" ? text.slice(0, -1) : text;
  } catch {
    return undefined;
  }
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

export function createWebSession(options: WebSessionOptions = {}): WebSession {
  const now = options.now ?? (() => Date.now());
  const defaults = [...(options.defaults ?? DEFAULT_WEB_DOMAINS)];
  const file = options.home === undefined ? undefined : path.join(options.home, WEB_DOMAINS_FILE);
  let granted: string[] = [];
  if (file !== undefined) {
    try {
      const parsed = domainsFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) granted = parsed.data.domains.flatMap((entry) => normalizeDomain(entry) ?? []);
    } catch {
      granted = [];
    }
  }
  let tainted = false;
  const userUrls = new Set<string>();
  const cache = new Map<string, CachedPage & { readonly storedAt: number }>();
  const robots = new Map<string, { readonly rules: string | undefined; readonly at: number }>();

  const persist = async (): Promise<void> => {
    if (file === undefined) return;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schema_version: 1, domains: granted }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  };

  return {
    domains: () => [...defaults, ...granted],
    grantedDomains: () => [...granted],
    async allowDomain(host) {
      const domain = normalizeDomain(host);
      if (domain === undefined || granted.includes(domain)) return false;
      granted = [...granted, domain].slice(-MAX_DOMAINS);
      await persist();
      return true;
    },
    async removeDomain(host) {
      const domain = normalizeDomain(host);
      if (domain === undefined || !granted.includes(domain)) return false;
      granted = granted.filter((entry) => entry !== domain);
      await persist();
      return true;
    },
    markContentRead: () => {
      tainted = true;
    },
    contentRead: () => tainted,
    startTurn: () => {
      tainted = false;
    },
    noteUserText(text) {
      for (const match of text.matchAll(URL_IN_TEXT)) {
        const key = normalizeUrlKey(match[0].replace(/[.,;:!?]+$/, ""));
        if (key === undefined) continue;
        userUrls.add(key);
        if (userUrls.size > MAX_USER_URLS) {
          const oldest = userUrls.values().next().value;
          if (oldest !== undefined) userUrls.delete(oldest);
        }
      }
    },
    isUserUrl(url) {
      const key = normalizeUrlKey(url);
      return key !== undefined && userUrls.has(key);
    },
    cacheGet(url) {
      const key = normalizeUrlKey(url);
      const entry = key === undefined ? undefined : cache.get(key);
      if (entry === undefined || key === undefined) return undefined;
      if (now() - entry.storedAt > WEB_CACHE_TTL_MS) {
        cache.delete(key);
        return undefined;
      }
      return entry;
    },
    cachePut(page) {
      const key = normalizeUrlKey(page.url);
      if (key === undefined) return;
      cache.delete(key);
      cache.set(key, { ...page, storedAt: now() });
      while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    },
    robotsGet(origin) {
      const entry = robots.get(origin);
      if (entry === undefined || now() - entry.at > WEB_CACHE_TTL_MS) return undefined;
      return entry;
    },
    robotsPut(origin, rules) {
      robots.set(origin, { rules, at: now() });
    },
  };
}

/**
 * Whether robots.txt allows `path` for our user agent: the longest matching Allow/Disallow rule of
 * the most specific group (`synorch` before `*`) wins; `*` and `$` patterns are honoured.
 */
export function robotsAllows(rules: string, pathAndQuery: string, agent = "synorch"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: { agents: string[]; rules: { allow: boolean; pattern: string }[] } | undefined;
  let lastWasAgent = false;
  for (const rawLine of rules.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const field = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (field === "user-agent") {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === undefined) continue;
    if (field === "allow" || field === "disallow") {
      if (field === "disallow" && value === "") continue;
      current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const own = groups.filter((group) => group.agents.some((name) => name !== "*" && agent.toLowerCase().includes(name)));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes("*"));
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of chosen.flatMap((group) => group.rules)) {
    if (!robotsPatternMatches(rule.pattern, pathAndQuery)) continue;
    const length = rule.pattern.length;
    if (best === undefined || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best?.allow ?? true;
}

function robotsPatternMatches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(`^${body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
  return regex.test(target);
}
