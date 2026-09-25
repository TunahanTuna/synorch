import type { AnyModelAdapter, AuthMethodKind, CapabilityLevel, ReasoningEffort, RouteRule } from "../contracts/index.ts";
import { isReasoningEffort, rememberListedEfforts, supportedEfforts } from "./effort.ts";
import type { FetchLike } from "./http-stream.ts";

/**
 * K1.5: the model catalog per connected identity. It answers "which models can I pick right now"
 * without a paid request: ChatGPT subscription models come from the Codex models endpoint when it
 * answers (a free listing call, only when explicitly asked) and otherwise from the configured routes
 * plus a known list; Claude models come from the ids Claude Code accepts (bridge) or the Messages API
 * (API key). Capability is `unknown` unless a provider listing said otherwise.
 */

export type CatalogBadge = "subscription" | "API key" | "bridge";

export interface CatalogModel {
  readonly provider: string;
  readonly model: string;
  readonly adapterId: string;
  readonly authMethod: AuthMethodKind;
  readonly badge: CatalogBadge;
  /** True when the identity behind the adapter is logged in / opted in; only connected rows are selectable. */
  readonly connected: boolean;
  /** Why a row is not selectable (login hint); undefined when connected. */
  readonly unavailable?: string;
  /** Where the row came from: a configured route, the provider's listing or the known list. */
  readonly source: "configured" | "provider" | "known";
  readonly capability: "unknown" | "listed";
  /** Image input (K1.5-B pasted images): `supported` for known multimodal models, otherwise `unknown` (sent, the provider decides). */
  readonly imageInput: CapabilityLevel;
  readonly label?: string;
  /** K6: reasoning levels the model takes (provider listing, else the known tables); undefined = not applicable / unknown. */
  readonly efforts?: readonly ReasoningEffort[];
  /** K6: the provider's default level when its listing says so. */
  readonly defaultEffort?: ReasoningEffort;
}

/** One row of a provider listing: an id, optionally with its reasoning levels (Codex `supported_reasoning_levels`). */
export interface ListedModel {
  readonly id: string;
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
}

/** Models known to be served on the ChatGPT subscription (Codex backend) and the OpenAI API, newest first. */
export interface KnownModel {
  readonly id: string;
  readonly label: string;
  readonly imageInput?: CapabilityLevel;
}

export const KNOWN_OPENAI_MODELS: readonly KnownModel[] = [
  { id: "gpt-6-sol", label: "GPT-6 Sol (frontier)" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6-luna", label: "GPT-6 Luna (fast)" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
];

/** Claude models by the short ids Synorch routes use; `anthropicWireModelId` maps them to the ids Claude Code and the API accept. */
export const KNOWN_ANTHROPIC_MODELS: readonly KnownModel[] = [
  { id: "opus-5.5", label: "Claude Opus 5.5" },
  { id: "fable-5.1", label: "Claude Fable 5.1 (most capable)" },
  { id: "opus-5", label: "Claude Opus 5" },
  { id: "sonnet-5", label: "Claude Sonnet 5" },
  { id: "haiku-4.5", label: "Claude Haiku 4.5 (fast)" },
];

/** Aliases Claude Code resolves itself (latest of the family); passed through unchanged. */
const CLAUDE_CODE_ALIASES = new Set(["opus", "sonnet", "haiku", "opusplan", "default"]);

/**
 * Our route id → the id `claude --model` and the Messages API accept: `opus-5.5` → `claude-opus-5-5`,
 * `sonnet-5` → `claude-sonnet-5`, `haiku-4.5` → `claude-haiku-4-5`. Full `claude-*` ids and Claude
 * Code aliases (`opus`, `sonnet`, `haiku`) pass through unchanged.
 */
export function anthropicWireModelId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("claude-") || CLAUDE_CODE_ALIASES.has(trimmed.toLowerCase())) return trimmed;
  const match = /^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:\.(\d+))?$/i.exec(trimmed);
  if (match === null) return trimmed;
  const family = (match[1] ?? "").toLowerCase();
  return match[3] === undefined ? `claude-${family}-${match[2]}` : `claude-${family}-${match[2]}-${match[3]}`;
}

export function badgeOf(method: AuthMethodKind): CatalogBadge {
  return method === "oauth-subscription" ? "subscription" : method === "cli-bridge" ? "bridge" : "API key";
}

export interface CatalogIdentity {
  readonly connected: boolean;
  /** How to connect it, shown on disabled rows. */
  readonly hint: string;
}

export interface CatalogInput {
  readonly adapters: readonly AnyModelAdapter[];
  readonly rules: readonly RouteRule[];
  /** Whether the (provider, method) identity is usable; the runtime answers from auth status (no network). */
  identity(provider: string, method: AuthMethodKind): Promise<CatalogIdentity>;
  /** Optional provider listing (ChatGPT subscription Codex models); undefined = not asked / failed. */
  listed?(adapter: AnyModelAdapter): Promise<readonly (string | ListedModel)[] | undefined>;
}

function knownFor(provider: string): readonly KnownModel[] {
  if (provider === "openai") return KNOWN_OPENAI_MODELS;
  if (provider === "anthropic") return KNOWN_ANTHROPIC_MODELS;
  return [];
}

/** Every selectable model per adapter, grouped by provider (openai, anthropic, then the rest), deduplicated. */
export async function buildModelCatalog(input: CatalogInput): Promise<CatalogModel[]> {
  const rows: CatalogModel[] = [];
  const order = (provider: string): number => (provider === "openai" ? 0 : provider === "anthropic" ? 1 : 2);
  const adapters = [...input.adapters].sort((left, right) => order(left.providerId) - order(right.providerId));
  for (const adapter of adapters) {
    const identity = await input.identity(adapter.providerId, adapter.authMethod).catch((): CatalogIdentity => ({ connected: false, hint: "status unavailable" }));
    const seen = new Set<string>();
    const push = (model: string, source: CatalogModel["source"], label?: string, defaultEffort?: string): void => {
      const known = knownFor(adapter.providerId).find((candidate) => candidate.id === model || anthropicWireModelId(candidate.id) === model);
      const shown = label ?? known?.label;
      if (seen.has(model)) return;
      seen.add(model);
      const efforts = supportedEfforts({ provider: adapter.providerId, model, adapterId: adapter.adapterId });
      rows.push({
        provider: adapter.providerId,
        model,
        adapterId: adapter.adapterId,
        authMethod: adapter.authMethod,
        badge: badgeOf(adapter.authMethod),
        connected: identity.connected,
        ...(identity.connected ? {} : { unavailable: identity.hint }),
        source,
        capability: source === "provider" ? "listed" : "unknown",
        imageInput: known?.imageInput ?? (known === undefined ? "unknown" : "supported"),
        ...(shown === undefined ? {} : { label: shown }),
        ...(efforts === undefined ? {} : { efforts }),
        ...(defaultEffort !== undefined && isReasoningEffort(defaultEffort) ? { defaultEffort } : {}),
      });
    };
    const listed = identity.connected && input.listed !== undefined ? await input.listed(adapter).catch(() => undefined) : undefined;
    // Listed levels first, so configured rows of the same model pick them up too.
    for (const entry of listed ?? []) if (typeof entry !== "string" && entry.efforts !== undefined) rememberListedEfforts(entry.id, entry.efforts);
    for (const rule of input.rules) if (rule.route.adapter_id === adapter.adapterId) push(rule.route.model_id, "configured");
    for (const entry of listed ?? []) push(typeof entry === "string" ? entry : entry.id, "provider", undefined, typeof entry === "string" ? undefined : entry.defaultEffort);
    if (listed === undefined || listed.length === 0) for (const known of knownFor(adapter.providerId)) push(known.id, "known", known.label);
  }
  return rows;
}

/**
 * `GET <chatgpt>/backend-api/codex/models`: the Codex models listing for a ChatGPT subscription.
 * A free listing call (no model request); the response shape is parsed leniently (`models[].slug|id`
 * or `data[].id`) and any failure returns undefined so the known list is used instead.
 */
export async function fetchCodexModels(fetchImpl: FetchLike, headers: Headers, signal: AbortSignal, baseUrl = "https://chatgpt.com/backend-api/codex"): Promise<readonly ListedModel[] | undefined> {
  const timeout = AbortSignal.timeout(8_000);
  try {
    const response = await fetchImpl(`${baseUrl}/models?client_version=1.0.0`, { method: "GET", headers, signal: AbortSignal.any([signal, timeout]) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const list = Array.isArray(record.models) ? record.models : Array.isArray(record.data) ? record.data : [];
    const rows = new Map<string, ListedModel>();
    for (const entry of list) {
      const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
      const id = typeof entry === "string" ? entry : (item?.slug ?? item?.id);
      if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(id) || rows.has(id)) continue;
      // K6: `supported_reasoning_levels: [{ effort: "low", … }]` and `default_reasoning_level`.
      const levels = Array.isArray(item?.supported_reasoning_levels)
        ? item.supported_reasoning_levels.map((level) => (typeof level === "string" ? level : typeof level === "object" && level !== null ? (level as Record<string, unknown>).effort : undefined)).filter((level): level is string => typeof level === "string")
        : undefined;
      const fallback = item?.default_reasoning_level;
      rows.set(id, { id, ...(levels === undefined || levels.length === 0 ? {} : { efforts: levels }), ...(typeof fallback === "string" ? { defaultEffort: fallback } : {}) });
    }
    return rows.size === 0 ? undefined : [...rows.values()];
  } catch {
    return undefined;
  }
}
