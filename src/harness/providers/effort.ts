import { REASONING_EFFORTS, type ReasoningEffort } from "../contracts/index.ts";
import { anthropicWireModelId } from "./catalog.ts";

/**
 * K6 reasoning effort: which levels a model takes and how a requested level lands on it.
 *
 * Levels come from the catalog: the ChatGPT subscription's Codex models listing reports
 * `supported_reasoning_levels` per model (remembered here when the catalog lists them), otherwise
 * the known tables below (read from that listing and the Anthropic model docs, 2026-09-25). A level
 * the model does not take is clamped to the nearest one it does, and the caller tells the user;
 * nothing is dropped silently.
 */

const ALL: readonly ReasoningEffort[] = REASONING_EFFORTS;
const UP_TO_MAX: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const UP_TO_HIGH: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** Codex listing, 2026-09-25: frontier models add `ultra`; the fast ones stop at `max`. */
const KNOWN_OPENAI_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  "gpt-6-sol": ALL,
  "gpt-6-astra": ALL,
  "gpt-6-luna": UP_TO_MAX,
  "gpt-5.6-sol": ALL,
  "gpt-5.6-terra": ALL,
  "gpt-5.6-luna": UP_TO_MAX,
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
};

/** Levels the ChatGPT listing reported this process (model id → levels). */
const listedEfforts = new Map<string, readonly ReasoningEffort[]>();

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Records the levels a provider listing reported for a model (unknown level names are ignored). */
export function rememberListedEfforts(model: string, levels: readonly string[]): readonly ReasoningEffort[] | undefined {
  const known = REASONING_EFFORTS.filter((level) => levels.includes(level));
  if (known.length === 0) return undefined;
  listedEfforts.set(model, known);
  return known;
}

export interface EffortTarget {
  readonly provider: string;
  readonly model: string;
  readonly adapterId: string;
}

/**
 * The levels a route's model takes, lowest first; undefined when effort does not apply (scripted
 * adapters) or the model is unknown (the requested level is then sent unchanged; the provider decides).
 */
export function supportedEfforts(target: EffortTarget): readonly ReasoningEffort[] | undefined {
  if (target.adapterId === "scripted" || target.provider === "scripted") return undefined;
  const listed = listedEfforts.get(target.model);
  if (target.provider === "openai") return listed ?? KNOWN_OPENAI_EFFORTS[target.model];
  if (target.provider === "anthropic") {
    const wire = anthropicWireModelId(target.model).toLowerCase();
    // Haiku 4.5 has no effort parameter: the Messages adapter maps low/medium/high to thinking budgets.
    if (/haiku/.test(wire)) return target.adapterId === "claude-code" ? UP_TO_MAX : UP_TO_HIGH;
    if (/^(claude-)?(opus|sonnet|fable|mythos)/.test(wire) || wire === "opusplan" || wire === "default") return UP_TO_MAX;
    return target.adapterId === "claude-code" ? UP_TO_MAX : undefined;
  }
  return listed;
}

/**
 * The level a model runs at when nothing is set (for display only; nothing extra is sent): the
 * Codex models default to `medium`, the Anthropic models with an effort parameter to `high`.
 */
export function defaultEffort(target: EffortTarget): ReasoningEffort | undefined {
  const supported = supportedEfforts(target);
  if (supported === undefined) return undefined;
  const preferred: ReasoningEffort = target.provider === "anthropic" ? "high" : "medium";
  return supported.includes(preferred) ? preferred : undefined;
}

export interface EffortResolution {
  /** What the settings asked for; undefined = nothing set (provider default). */
  readonly requested: ReasoningEffort | undefined;
  /** What is sent; differs from `requested` only when it was clamped. */
  readonly effective: ReasoningEffort | undefined;
  readonly supported: readonly ReasoningEffort[] | undefined;
  /** One short line for the user when the level was clamped. */
  readonly notice: string | undefined;
}

/** The nearest supported level (ties go to the lower one). */
export function clampEffort(requested: ReasoningEffort, supported: readonly ReasoningEffort[]): ReasoningEffort {
  if (supported.length === 0 || supported.includes(requested)) return requested;
  const index = REASONING_EFFORTS.indexOf(requested);
  let best = supported[0] ?? requested;
  let distance = Number.POSITIVE_INFINITY;
  for (const level of supported) {
    const gap = Math.abs(REASONING_EFFORTS.indexOf(level) - index);
    if (gap < distance) {
      best = level;
      distance = gap;
    }
  }
  return best;
}

/** The levels that may ask for a step's effort, by source. */
export interface EffortSources {
  /** `/effort` or `--effort <tier>=<level>` for this session. */
  readonly session?: ReasoningEffort | undefined;
  /** `--effort <level>`. */
  readonly flag?: ReasoningEffort | undefined;
  /** `effort.<role>` of the user configuration. */
  readonly role?: ReasoningEffort | undefined;
  /** `effort.<tier>` of the user configuration. */
  readonly tier?: ReasoningEffort | undefined;
  /** The orchestrator's per-task hint (task packet `effort`). */
  readonly hint?: ReasoningEffort | undefined;
}

/**
 * K6 precedence: session override > `--effort` flag > configured role > configured tier > the
 * orchestrator's task hint > model default (undefined). The user's settings always win; a hint only
 * fills the gap where the user set nothing.
 */
export function requestedEffort(sources: EffortSources): ReasoningEffort | undefined {
  return sources.session ?? sources.flag ?? sources.role ?? sources.tier ?? sources.hint;
}

export function resolveEffort(requested: ReasoningEffort | undefined, target: EffortTarget): EffortResolution {
  const supported = supportedEfforts(target);
  if (target.adapterId === "scripted" || target.provider === "scripted") return { requested, effective: undefined, supported, notice: undefined };
  if (requested === undefined || supported === undefined) return { requested, effective: requested, supported, notice: undefined };
  const effective = clampEffort(requested, supported);
  return {
    requested,
    effective,
    supported,
    notice: effective === requested ? undefined : `${target.model} does not support effort ${requested}; using ${effective} (supported: ${supported.join(", ")})`,
  };
}
