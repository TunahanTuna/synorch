import {
  MODEL_TIERS,
  REASONING_EFFORTS,
  type AgentRole,
  type InteractiveInputControls,
  type ModelTier,
  type ReasoningEffort,
  type RouteRule,
} from "../contracts/index.ts";
import { isReasoningEffort, type EffortResolution } from "../providers/index.ts";
import { setUserSetting } from "./config-command.ts";
import type { Runtime } from "./runtime.ts";

/**
 * K6 `/effort [level] [--tier <tier>] [--save]`: the reasoning effort of the conversation (or of a
 * tier) for this session. No level opens a picker of the levels the current model takes, the current
 * one marked. The next model request uses the new level; an unsupported level is clamped to the
 * nearest supported one and the user is told. `--save` also writes `effort.<slot>` to the user
 * configuration.
 */

export interface EffortCommandHost {
  readonly runtime: Runtime;
  readonly controls: InteractiveInputControls | undefined;
  readonly signal: AbortSignal;
  readonly ok: string;
  readonly sep: string;
  /** The route the conversation runs on now. */
  conversationRule(): RouteRule | undefined;
  print(lines: readonly string[]): void;
  showFailure(error: unknown): void;
  /** Redraws the footer from live state (model, effort). */
  refreshStatus(): void;
}

/** What an effort setting is about: the settings slot, and the tier/role/route it resolves on. */
export interface EffortTarget {
  /** `session` (the conversation) or a tier. */
  readonly slot: ModelTier;
  readonly tier: ModelTier;
  readonly role: AgentRole | undefined;
  readonly rule: RouteRule;
}

const DEFAULT_WORDS = ["default", "reset", "auto", "clear"];

/** `high`, `default` (nothing set: the provider decides) or `n/a` (the route takes no effort). */
export function effortLabel(resolution: EffortResolution, adapterId: string): string {
  if (adapterId === "scripted") return "n/a";
  return resolution.effective ?? "default";
}

export function effortTarget(host: Pick<EffortCommandHost, "runtime" | "conversationRule">, tier: ModelTier | undefined): EffortTarget | { readonly error: string } {
  if (tier === undefined || tier === "session") {
    const rule = host.conversationRule();
    return rule === undefined ? { error: "the conversation has no model route" } : { slot: "session", tier: rule.tier, role: "session", rule };
  }
  const rule = host.runtime.routeRules().find((candidate) => candidate.tier === tier && candidate.role === undefined);
  return rule === undefined ? { error: `no route for the ${tier} tier (set one with /model ${tier} <provider>/<model>)` } : { slot: tier, tier, role: undefined, rule };
}

export function resolveTarget(runtime: Runtime, target: EffortTarget): EffortResolution {
  return runtime.effortFor(target.tier, target.role, target.rule.route);
}

function slotName(target: EffortTarget): string {
  return target.slot === "session" ? "conversation" : target.slot;
}

export async function runEffortCommand(host: EffortCommandHost, argument: string): Promise<void> {
  const parts = argument.split(/\s+/).filter((part) => part !== "");
  const save = parts.includes("--save");
  let tier: ModelTier | undefined;
  const tierAt = parts.indexOf("--tier");
  if (tierAt >= 0) {
    const text = parts[tierAt + 1] ?? "";
    tier = MODEL_TIERS.find((candidate) => candidate === text);
    if (tier === undefined) {
      host.print([`Unknown tier "${text}". Tiers: ${MODEL_TIERS.join(", ")}`]);
      return;
    }
    parts.splice(tierAt, 2);
  }
  const [levelText] = parts.filter((part) => !part.startsWith("--")).map((part) => part.toLowerCase());
  const target = effortTarget(host, tier);
  if ("error" in target) {
    host.print([`Effort not changed: ${target.error}`]);
    return;
  }
  if (levelText === undefined) {
    if (host.controls === undefined) {
      host.print(effortOverview(host.runtime, target, host.sep));
      return;
    }
    await pickEffort(host, target, save);
    return;
  }
  if (DEFAULT_WORDS.includes(levelText)) {
    await applyEffort(host, target, undefined, save);
    return;
  }
  if (!isReasoningEffort(levelText)) {
    host.print([`Unknown effort "${levelText}". Levels: ${REASONING_EFFORTS.join(", ")} (default clears it)`]);
    return;
  }
  await applyEffort(host, target, levelText, save);
}

function effortOverview(runtime: Runtime, target: EffortTarget, sep: string): string[] {
  const resolution = resolveTarget(runtime, target);
  const levels = resolution.supported ?? (target.rule.route.adapter_id === "scripted" ? [] : REASONING_EFFORTS);
  return [
    `Effort (${slotName(target)}, ${target.rule.route.model_id}): ${effortLabel(resolution, target.rule.route.adapter_id)}`,
    levels.length === 0 ? "This route takes no reasoning effort." : `Levels: ${levels.join(", ")} ${sep} /effort <level> (this session) ${sep} --save keeps it ${sep} --tier <tier> sets another tier`,
  ];
}

/** The level picker (K5 `controls.ask`): the model's levels, the current one marked, plus the provider default. */
export async function pickEffort(host: EffortCommandHost, target: EffortTarget, save = false): Promise<void> {
  const controls = host.controls;
  if (controls === undefined) return;
  const resolution = resolveTarget(host.runtime, target);
  if (target.rule.route.adapter_id === "scripted") {
    host.print([`${target.rule.route.model_id} takes no reasoning effort.`]);
    return;
  }
  const levels = resolution.supported ?? REASONING_EFFORTS;
  const current = resolution.effective;
  const options = [
    ...levels.map((level) => `${level}${level === current ? "  (current)" : ""}`),
    `default  (provider decides)${current === undefined ? "  (current)" : ""}`,
  ];
  const answer = await controls.ask(`Reasoning effort for ${slotName(target)} (${target.rule.route.model_id})`, options, host.signal).catch(() => undefined);
  if (answer === undefined) return;
  const word = answer.trim().split(/\s+/)[0] ?? "";
  if (word === "default") {
    if (current !== undefined) await applyEffort(host, target, undefined, save);
    return;
  }
  if (!isReasoningEffort(word) || word === current) return;
  await applyEffort(host, target, word, save);
}

async function applyEffort(host: EffortCommandHost, target: EffortTarget, level: ReasoningEffort | undefined, save: boolean): Promise<void> {
  const runtime = host.runtime;
  runtime.setSessionEffort(target.slot, level);
  const resolution = resolveTarget(runtime, target);
  const shown = effortLabel(resolution, target.rule.route.adapter_id);
  host.print([
    `${host.ok} Effort ${slotName(target)}: ${shown}${level === undefined ? "" : ` (${target.rule.route.model_id})`} ${host.sep} applies to the next request${save ? "" : ` ${host.sep} --save keeps it`}`,
    ...(resolution.notice === undefined ? [] : [resolution.notice]),
  ]);
  host.refreshStatus();
  if (!save || level === undefined) return;
  try {
    const change = await setUserSetting(runtime.home, `effort.${target.slot}`, level);
    host.print([`${host.ok} Saved effort.${target.slot} = ${level} to ${change.file}`]);
  } catch (error) {
    host.showFailure(error);
  }
}
