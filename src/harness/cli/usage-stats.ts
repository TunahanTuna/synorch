import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKER_ROLES, type SessionEvent } from "../contracts/index.ts";
import type { BillingView, QuotaWindowView, UsageRowView, UsageView } from "../contracts/views.ts";

/**
 * Usage statistics for `/usage`, `/cost` and the footer (X7, UX-10): requests and input/output/cache
 * tokens per provider/model/tier, for this conversation process and per day, subscription quota %
 * where the provider reports it (headers such as `x-codex-*`), and an *estimated* USD cost for
 * API-key routes (the provider's own estimate when present, otherwise a coarse public price table;
 * always shown with `~`). The daily aggregate is persisted under `<synorch home>/usage/usage.json`
 * (numbers only: no prompts, paths or ids). Every session event reaching the runtime is observed,
 * so worker and reviewer requests count too.
 */

interface Bucket {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** Requests whose cost could not be estimated (unknown model price, metered route). */
  unpriced: number;
  billing?: BillingView;
}

/** Session totals for the one-line `/cost` and any footer. */
export interface UsageFooter {
  readonly quotaPercent?: number;
  readonly quotaWindow?: string;
  /** Provider id of the most-used quota (`anthropic`, `openai`). */
  readonly quotaProvider?: string;
  readonly costUsd?: number;
  readonly tokens: number;
  readonly requests: number;
}

interface UsageFile {
  readonly schema_version: 1;
  days: Record<string, Record<string, Bucket>>;
  /** Per provider: the top window (`window`/`percent`/`resetsAt`, kept for older readers) and every window seen. */
  quota: Record<string, ProviderQuota>;
}

interface QuotaWindow {
  readonly name: string;
  readonly percent: number;
  readonly resetsAt?: string;
}

interface ProviderQuota {
  window: string;
  percent: number;
  at: string;
  resetsAt?: string;
  windows?: QuotaWindow[];
}

interface RequestRoute {
  readonly provider: string;
  readonly model: string;
  readonly auth: string;
  readonly tier: string;
  readonly role: string | undefined;
}

interface ProviderRequests {
  total: number;
  workers: number;
  subscription: boolean;
}

const WORKERS: ReadonlySet<string> = new Set(WORKER_ROLES);

/** `in 42m`, `in 3h 5m`, `in 2d` from an ISO time; `now` once passed. */
export function resetIn(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms)) return iso;
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`}`;
  return `in ${Math.round(hours / 24)}d`;
}

/** USD per million tokens (input, output); coarse public list prices, matched by substring. */
const PRICES: readonly (readonly [string, number, number])[] = [
  ["opus", 15, 75],
  ["sonnet", 3, 15],
  ["haiku", 0.8, 4],
  ["gpt-4o-mini", 0.15, 0.6],
  ["gpt-4o", 2.5, 10],
  ["gpt-4.1", 2, 8],
  ["o3", 2, 8],
  ["o4-mini", 1.1, 4.4],
  ["gpt-5", 1.25, 10],
  ["gpt-6", 1.25, 10],
];

const RETAINED_DAYS = 90;

function emptyBucket(): Bucket {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0 };
}

function add(target: Bucket, source: Bucket): void {
  if (source.billing !== undefined) target.billing = source.billing;
  target.requests += source.requests;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.costUsd += source.costUsd;
  target.unpriced += source.unpriced;
}

export function estimateCostUsd(model: string, input: number, output: number): number | undefined {
  const lower = model.toLowerCase();
  const price = PRICES.find(([needle]) => lower.includes(needle));
  if (price === undefined) return undefined;
  return (input * price[1] + output * price[2]) / 1_000_000;
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function money(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

export class UsageLedger {
  private readonly file: string;
  private readonly now: () => Date;
  private data: UsageFile = { schema_version: 1, days: {}, quota: {} };
  private readonly session = new Map<string, Bucket>();
  private readonly routes = new Map<string, RequestRoute>();
  private readonly tiers = new Map<string, string>();
  private readonly sessionQuota = new Map<string, { window: string; percent: number }>();
  private readonly providerRequests = new Map<string, ProviderRequests>();
  private loaded: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<() => void>();

  public constructor(home: string, now: () => Date = () => new Date()) {
    this.file = path.join(home, "usage", "usage.json");
    this.now = now;
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<UsageFile>;
      if (parsed.schema_version === 1 && typeof parsed.days === "object" && parsed.days !== null) {
        this.data = { schema_version: 1, days: parsed.days, quota: parsed.quota ?? {} };
      }
    } catch {
      return;
    }
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feeds every session event of the runtime (conversation, runs, attempts). */
  public observe(event: SessionEvent): void {
    if (event.type === "route/decided") {
      const route = event.data.decision.route;
      this.tiers.set(`${route.provider_id}/${route.model_id}`, event.data.decision.tier);
      return;
    }
    if (event.type === "model/request_prepared") {
      const route = event.data.route;
      const key = `${route.provider_id}/${route.model_id}`;
      this.routes.set(event.data.request_id, {
        provider: route.provider_id,
        model: route.model_id,
        auth: route.auth_method,
        tier: this.tiers.get(key) ?? event.actor.role ?? "unknown",
        role: event.actor.role,
      });
      return;
    }
    if (event.type !== "provider/usage") return;
    const route = this.routes.get(event.data.request_id);
    this.routes.delete(event.data.request_id);
    const usage = event.data.usage;
    const bucket = emptyBucket();
    bucket.requests = 1;
    bucket.input = usage.input_tokens ?? 0;
    bucket.output = usage.output_tokens ?? 0;
    bucket.cacheRead = usage.cache_read_tokens ?? 0;
    bucket.cacheWrite = usage.cache_write_tokens ?? 0;
    const subscription = route?.auth === "oauth-subscription" || route?.auth === "cli-bridge";
    bucket.billing = subscription ? "subscription" : route?.auth === "api-key" ? "api_key" : "unknown";
    if (!subscription) {
      const cost = usage.cost_usd_estimate ?? (route === undefined ? undefined : estimateCostUsd(route.model, bucket.input, bucket.output));
      if (cost === undefined) bucket.unpriced = 1;
      else bucket.costUsd = cost;
    }
    const key = `${route?.provider ?? "unknown"}/${route?.model ?? "unknown"}|${route?.tier ?? event.actor.role ?? "unknown"}`;
    const sessionBucket = this.session.get(key) ?? emptyBucket();
    add(sessionBucket, bucket);
    this.session.set(key, sessionBucket);
    const day = today(this.now());
    const days = (this.data.days[day] ??= {});
    const dayBucket = days[key] ?? emptyBucket();
    add(dayBucket, bucket);
    days[key] = dayBucket;
    const provider = event.data.provider_id ?? route?.provider;
    if (provider !== undefined) {
      const counts = this.providerRequests.get(provider) ?? { total: 0, workers: 0, subscription: false };
      counts.total += 1;
      if (WORKERS.has(route?.role ?? event.actor.role ?? "")) counts.workers += 1;
      if (subscription) counts.subscription = true;
      this.providerRequests.set(provider, counts);
    }
    const quota = event.data.quota;
    if (quota !== undefined && quota.windows.length > 0 && provider !== undefined) this.recordQuota(provider, quota.windows);
    this.schedule();
    for (const listener of this.listeners) listener();
  }

  /** Merges a snapshot into the provider's windows (a bridge may report one window at a time). */
  private recordQuota(provider: string, windows: readonly { readonly name: string; readonly used_percent: number; readonly resets_at?: string | undefined }[]): void {
    const previous = this.data.quota[provider];
    const merged = new Map<string, QuotaWindow>((previous?.windows ?? []).map((window) => [window.name, window]));
    for (const window of windows) merged.set(window.name, { name: window.name, percent: window.used_percent, ...(window.resets_at === undefined ? {} : { resetsAt: window.resets_at }) });
    const all = [...merged.values()].sort((left, right) => right.percent - left.percent);
    const top = all[0];
    if (top === undefined) return;
    this.sessionQuota.set(provider, { window: top.name, percent: top.percent });
    this.data.quota[provider] = { window: top.name, percent: top.percent, at: this.now().toISOString(), ...(top.resetsAt === undefined ? {} : { resetsAt: top.resetsAt }), windows: all };
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 500);
    this.timer.unref?.();
  }

  public async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.loaded;
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const cutoff = today(new Date(this.now().getTime() - RETAINED_DAYS * 86_400_000));
    for (const day of Object.keys(this.data.days)) if (day < cutoff) delete this.data.days[day];
    const text = `${JSON.stringify(this.data, null, 2)}\n`;
    this.saving = this.saving
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        await writeFile(temp, text, "utf8");
        await rename(temp, this.file);
      })
      .catch(() => undefined);
    return this.saving;
  }

  private totals(buckets: Iterable<Bucket>): Bucket {
    const total = emptyBucket();
    for (const bucket of buckets) add(total, bucket);
    return total;
  }

  /** Session totals (footer-style figures): tokens, requests, the highest quota window, the estimated cost. */
  public footer(): UsageFooter {
    const total = this.totals(this.session.values());
    const quota = [...this.sessionQuota.entries()].sort((left, right) => right[1].percent - left[1].percent)[0];
    return {
      tokens: total.input + total.output,
      requests: total.requests,
      ...(quota === undefined ? {} : { quotaPercent: Math.round(quota[1].percent), quotaWindow: quota[1].window, quotaProvider: quota[0] }),
      ...(total.costUsd > 0 ? { costUsd: total.costUsd } : {}),
    };
  }

  private viewRows(buckets: ReadonlyMap<string, Bucket> | Record<string, Bucket>): UsageRowView[] {
    const entries = buckets instanceof Map ? [...buckets.entries()] : Object.entries(buckets);
    return entries
      .sort((left, right) => right[1].input + right[1].output - (left[1].input + left[1].output))
      .map(([key, bucket]) => {
        const [route = key, tier] = key.split("|");
        const slash = route.indexOf("/");
        return {
          provider: slash === -1 ? route : route.slice(0, slash),
          model: slash === -1 ? route : route.slice(slash + 1),
          ...(tier === undefined ? {} : { tier }),
          billing: bucket.billing ?? "unknown",
          requests: bucket.requests,
          inputTokens: bucket.input,
          outputTokens: bucket.output,
          cacheReadTokens: bucket.cacheRead,
          cacheWriteTokens: bucket.cacheWrite,
          ...(bucket.costUsd > 0 ? { costUsd: bucket.costUsd, costEstimated: true } : {}),
        };
      });
  }

  /** Providers to list under quota: every one with a reported quota, then subscriptions used this session. */
  private quotaProviders(): string[] {
    const names = Object.keys(this.data.quota);
    for (const [provider, counts] of this.providerRequests) if (counts.subscription && !names.includes(provider)) names.push(provider);
    const top = (provider: string): number => this.data.quota[provider]?.percent ?? -1;
    return names.sort((left, right) => top(right) - top(left));
  }

  /**
   * `/usage` as U3's `UsageView` (session rows, today's rows, quota windows per provider). `plans`
   * maps provider id → plan label, `label` provider id → short name (`claude`, `chatgpt`).
   */
  public async view(sessionElapsedMs: number | undefined, plans: ReadonlyMap<string, string> = new Map(), label: (provider: string) => string = (provider) => provider): Promise<UsageView> {
    await this.loaded;
    const day = this.data.days[today(this.now())] ?? {};
    const quotas: QuotaWindowView[] = [];
    for (const provider of this.quotaProviders()) {
      const quota = this.data.quota[provider];
      const counts = this.providerRequests.get(provider);
      const plan = plans.get(provider);
      const head = { ...(plan === undefined ? {} : { plan }), ...(counts === undefined ? {} : { requests: { total: counts.total, workers: counts.workers } }) };
      const windows = quota === undefined ? [] : (quota.windows ?? [{ name: quota.window, percent: quota.percent, ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }) }]);
      if (windows.length === 0) quotas.push({ provider: label(provider), window: "", usedPercent: undefined, ...head });
      windows.forEach((window, index) =>
        quotas.push({
          provider: label(provider),
          window: window.name,
          usedPercent: window.percent,
          ...(window.resetsAt === undefined ? {} : { resetsAt: resetIn(window.resetsAt, this.now()) }),
          ...(index === 0 ? head : {}),
        }),
      );
    }
    return {
      kind: "usage",
      session: this.viewRows(this.session),
      today: this.viewRows(day),
      ...(quotas.length === 0 ? {} : { quotas }),
      ...(sessionElapsedMs === undefined ? {} : { sessionElapsedMs }),
    };
  }

  private rows(buckets: ReadonlyMap<string, Bucket> | Record<string, Bucket>): string[] {
    const entries = buckets instanceof Map ? [...buckets.entries()] : Object.entries(buckets);
    return entries
      .sort((left, right) => right[1].input + right[1].output - (left[1].input + left[1].output))
      .map(([key, bucket]) => {
        const [model = key, tier = "?"] = key.split("|");
        const cache = bucket.cacheRead + bucket.cacheWrite > 0 ? ` · cache ${compact(bucket.cacheRead)} read ${compact(bucket.cacheWrite)} written` : "";
        const cost = bucket.costUsd > 0 ? ` · ~${money(bucket.costUsd)}` : bucket.unpriced > 0 ? " · cost unknown" : "";
        return `  ${model} (${tier}): ${bucket.requests} req · ${compact(bucket.input)} in · ${compact(bucket.output)} out${cache}${cost}`;
      });
  }

  private summary(label: string, total: Bucket): string {
    return `${label}: ${total.requests} request${total.requests === 1 ? "" : "s"} · ${compact(total.input)} in · ${compact(total.output)} out · ${compact(total.cacheRead)} cached${total.costUsd > 0 ? ` · ~${money(total.costUsd)} (API key estimate)` : ""}`;
  }

  /** `/usage`: this session, today, and the provider quota windows seen. */
  public async report(): Promise<string[]> {
    await this.loaded;
    const day = this.data.days[today(this.now())] ?? {};
    const lines = [this.summary("This session", this.totals(this.session.values())), ...this.rows(this.session)];
    lines.push(this.summary("Today", this.totals(Object.values(day))), ...this.rows(day));
    const providers = this.quotaProviders();
    if (providers.length === 0) lines.push("Quota: no subscription quota reported by the providers used so far");
    for (const provider of providers) {
      const quota = this.data.quota[provider];
      const counts = this.providerRequests.get(provider);
      const requests = counts === undefined ? "" : ` · ${counts.total} request${counts.total === 1 ? "" : "s"} this session (${counts.workers} by workers)`;
      if (quota === undefined) {
        lines.push(`Quota ${provider}: not reported by the provider${requests}`);
        continue;
      }
      const windows = (quota.windows ?? [{ name: quota.window, percent: quota.percent, ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }) }])
        .map((window) => `${Math.round(window.percent)}% of the ${window.name} window${window.resetsAt === undefined ? "" : ` (resets ${resetIn(window.resetsAt, this.now())})`}`)
        .join(", ");
      lines.push(`Quota ${provider}: ${windows} used${requests} (as of ${quota.at.slice(0, 16).replace("T", " ")})`);
    }
    lines.push("Costs marked ~ are estimates for API-key routes; subscription routes show quota instead.");
    return lines;
  }

  /** `/cost`: the one-line session total. */
  public cost(): string[] {
    const total = this.totals(this.session.values());
    const footer = this.footer();
    const quota = footer.quotaPercent === undefined ? "" : ` · quota ${footer.quotaPercent}% (${footer.quotaProvider === undefined ? "" : `${footer.quotaProvider} `}${footer.quotaWindow ?? "window"})`;
    const cost = total.costUsd > 0 ? `~${money(total.costUsd)} estimated` : total.unpriced > 0 ? "cost unknown for this route" : "no API-key cost (subscription or no requests)";
    return [`This session: ${cost} · ${compact(total.input + total.output)} tokens · ${total.requests} request${total.requests === 1 ? "" : "s"}${quota}`];
  }
}
