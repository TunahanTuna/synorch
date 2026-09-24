import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import {
  AGENT_ROLES,
  MODEL_TIERS,
  type AgentRole,
  type InteractiveInputControls,
  type ModelPickerEntry,
  type ModelTier,
  type RouteBinding,
  type RouteRule,
} from "../contracts/index.ts";
import { badgeOf, type CatalogModel } from "../providers/index.ts";
import { CONFIG_FILE, DEFAULT_ADAPTER_FOR_PROVIDER } from "./config.ts";
import type { Runtime } from "./runtime.ts";

/**
 * K1.5 `/model`: every logged-in provider's models (ChatGPT subscription, Claude via the Claude Code
 * bridge, API keys) grouped by provider with the auth badge, the current route per tier, and a
 * session-scoped route change per tier (`/model <tier> <provider>/<model>`); `--save` (after a
 * confirmation) writes the route to the user configuration. Only logged-in identities are
 * selectable and nothing falls back silently.
 */

export interface ModelCommandHost {
  readonly runtime: Runtime;
  readonly controls: InteractiveInputControls | undefined;
  readonly signal: AbortSignal;
  readonly ok: string;
  readonly sep: string;
  conversationTier(): ModelTier | undefined;
  print(lines: readonly string[]): void;
  ask(question: string, options: readonly string[]): Promise<string>;
  /** Switches the conversation to a tier's (possibly just changed) route; `save` keeps the tier for new conversations. */
  switchConversation(tier: ModelTier, save: boolean): Promise<void>;
  showFailure(error: unknown): void;
}

const METHOD_PREFERENCE = ["oauth-subscription", "cli-bridge", "api-key"] as const;

interface TierSlot {
  readonly tier: ModelTier;
  readonly role: AgentRole | undefined;
}

function slotLabel(slot: TierSlot): string {
  return slot.role === undefined ? slot.tier : `${slot.tier}/${slot.role}`;
}

/** `session`, `complex_worker/reviewer`… → a tier (and role), or undefined. */
export function parseSlot(text: string): TierSlot | undefined {
  const [tierText, roleText] = text.split("/");
  const tier = MODEL_TIERS.find((candidate) => candidate === tierText);
  if (tier === undefined) return undefined;
  if (roleText === undefined) return { tier, role: undefined };
  const role = AGENT_ROLES.find((candidate) => candidate === roleText);
  return role === undefined ? undefined : { tier, role };
}

/** The rule a slot resolves to first (the router's precedence: session > user > default; role rules before general ones). */
function effectiveRule(rules: readonly RouteRule[], slot: TierSlot): RouteRule | undefined {
  const fits = rules.filter((rule) => rule.tier === slot.tier && (slot.role === undefined ? rule.role === undefined : rule.role === slot.role || rule.role === undefined));
  return fits.find((rule) => rule.role === slot.role) ?? fits[0];
}

function slotsOf(rules: readonly RouteRule[]): TierSlot[] {
  const slots: TierSlot[] = MODEL_TIERS.map((tier) => ({ tier, role: undefined }));
  for (const rule of rules) {
    if (rule.role !== undefined && !slots.some((slot) => slot.tier === rule.tier && slot.role === rule.role)) slots.push({ tier: rule.tier, role: rule.role });
  }
  return slots;
}

function authOf(runtime: Runtime, rule: RouteRule): string {
  const method = runtime.adapters.find((adapter) => adapter.adapterId === rule.route.adapter_id)?.authMethod;
  return method === undefined ? "unknown" : badgeOf(method);
}

/** Picks the catalog row for `provider/model[@adapter]`: the given adapter, else the logged-in identity in preference order. */
export function chooseCatalogRow(catalog: readonly CatalogModel[], provider: string, model: string, adapter: string | undefined): CatalogModel | { readonly error: string } {
  const forProvider = catalog.filter((row) => row.provider === provider && (adapter === undefined || row.adapterId === adapter));
  if (forProvider.length === 0) return { error: `no ${provider} models are available${adapter === undefined ? "" : ` through ${adapter}`}` };
  const connected = forProvider.filter((row) => row.connected);
  if (connected.length === 0) return { error: `${provider} is not logged in: ${forProvider[0]?.unavailable ?? "run syn login"}` };
  const rank = (row: CatalogModel): number => METHOD_PREFERENCE.indexOf(row.authMethod as (typeof METHOD_PREFERENCE)[number]);
  const exact = connected.filter((row) => row.model === model).sort((left, right) => rank(left) - rank(right))[0];
  if (exact !== undefined) return exact;
  // An id the catalog does not know: allowed on a logged-in identity, with unknown capability.
  const base = [...connected].sort((left, right) => rank(left) - rank(right))[0];
  return base === undefined ? { error: `${provider} is not logged in` } : { ...base, model, source: "configured", capability: "unknown", imageInput: "unknown", label: "capability unknown" };
}

export function catalogLines(catalog: readonly CatalogModel[]): string[] {
  const lines: string[] = [];
  let group = "";
  for (const row of catalog) {
    const heading = `${row.provider} · ${row.badge} (${row.adapterId})${row.connected ? "" : ` — not logged in: ${row.unavailable ?? ""}`}`;
    if (heading !== group) {
      group = heading;
      lines.push(`  ${heading}`);
    }
    if (!row.connected) continue;
    lines.push(`    ${row.provider}/${row.model}${row.label === undefined ? "" : `  ${row.label}`}${row.capability === "unknown" ? "  [capability unknown]" : ""}`);
  }
  return lines;
}

export async function runModelCommand(host: ModelCommandHost, argument: string): Promise<void> {
  const runtime = host.runtime;
  const parts = argument.split(/\s+/).filter((part) => part !== "");
  const save = parts.includes("--save");
  const [slotText = "", routeText] = parts.filter((part) => !part.startsWith("--"));

  if (slotText === "") {
    if (host.controls !== undefined) {
      await interactivePicker(host, host.controls, save);
      return;
    }
    await printOverview(host);
    return;
  }

  const slot = parseSlot(slotText);
  if (slot === undefined) {
    host.print([`Unknown tier "${slotText}". Tiers: ${MODEL_TIERS.join(", ")} (a role narrows one: complex_worker/reviewer)`]);
    return;
  }
  if (routeText === undefined) {
    if (slot.role !== undefined || !runtime.routeRules().some((rule) => rule.tier === slot.tier && (rule.role === undefined || rule.role === "session"))) {
      host.print([`No route for "${slotLabel(slot)}". Set one: /model ${slotLabel(slot)} <provider>/<model> (see /model for the models you can use)`]);
      return;
    }
    await host.switchConversation(slot.tier, save);
    return;
  }
  const match = /^([^/@\s]+)\/([^@\s]+)(?:@([^@\s]+))?$/.exec(routeText);
  if (match === null) {
    host.print([`Expected <provider>/<model>[@adapter], for example openai/gpt-6-sol or anthropic/opus-5.5@claude-code`]);
    return;
  }
  const catalog = await runtime.modelCatalog(host.signal);
  const row = chooseCatalogRow(catalog, match[1] ?? "", match[2] ?? "", match[3]);
  if ("error" in row) {
    host.print([`Not changed: ${row.error}`]);
    return;
  }
  await applyRoute(host, slot, row, save);
}

async function printOverview(host: ModelCommandHost): Promise<void> {
  const runtime = host.runtime;
  const rules = runtime.routeRules();
  const conversation = host.conversationTier();
  const lines = ["Routes per tier:"];
  for (const slot of slotsOf(rules)) {
    const rule = effectiveRule(rules, slot);
    const marker = slot.role === undefined && slot.tier === conversation ? "  <- conversation" : "";
    lines.push(
      rule === undefined
        ? `  ${slotLabel(slot).padEnd(24)} not configured${slot.tier === "session" ? " (the conversation uses the orchestrator route)" : ""}`
        : `  ${slotLabel(slot).padEnd(24)} ${rule.route.provider_id}/${rule.route.model_id} (${authOf(runtime, rule)}, ${rule.source})${marker}`,
    );
  }
  lines.push("Models you can use:");
  lines.push(...catalogLines(await runtime.modelCatalog(host.signal)));
  lines.push("Set: /model <tier> <provider>/<model> (this session) · --save also writes it to the user configuration · /model <tier> switches the conversation");
  host.print(lines);
}

async function interactivePicker(host: ModelCommandHost, controls: InteractiveInputControls, save: boolean): Promise<void> {
  const runtime = host.runtime;
  const rules = runtime.routeRules();
  const conversation = host.conversationTier();
  const slots = slotsOf(rules);
  const tierRows: ModelPickerEntry[] = slots.map((slot, index) => {
    const rule = effectiveRule(rules, slot);
    return {
      id: String(index),
      tier: slotLabel(slot),
      provider: rule?.route.provider_id ?? "-",
      model: rule?.route.model_id ?? "not configured",
      auth: rule === undefined ? "none" : authOf(runtime, rule),
      current: slot.role === undefined && slot.tier === conversation,
      description: slot.tier === "session" ? "the conversation" : slot.role === undefined && slot.tier === conversation ? "the conversation uses this tier" : rule === undefined ? "choose a model for this tier" : `${rule.source} route`,
    };
  });
  const pickedTier = await controls.openModelPicker(tierRows, host.signal).catch(() => undefined);
  const slot = pickedTier === undefined ? undefined : slots[Number(pickedTier.id)];
  if (slot === undefined) return;

  const catalog = await runtime.modelCatalog(host.signal, { listing: true });
  const current = effectiveRule(rules, slot);
  const modelRows: ModelPickerEntry[] = catalog.map((row, index) => ({
    id: String(index),
    tier: `${row.provider} · ${row.badge}`,
    provider: row.provider,
    model: row.model,
    auth: row.badge,
    current: current !== undefined && current.route.adapter_id === row.adapterId && current.route.model_id === row.model,
    description: [row.label, row.capability === "unknown" ? "capability unknown" : "listed by the provider", row.imageInput === "supported" ? "images" : undefined, `via ${row.adapterId}`].filter((part) => part !== undefined).join(" · "),
    ...(row.connected ? {} : { disabled: row.unavailable ?? "not logged in" }),
  }));
  if (modelRows.length === 0) {
    host.print(["No models: log in first (syn login openai · syn login anthropic --method cli-bridge · syn login anthropic --method api-key)"]);
    return;
  }
  const picked = await controls.openModelPicker(modelRows, host.signal).catch(() => undefined);
  const row = picked === undefined ? undefined : catalog[Number(picked.id)];
  if (row === undefined || picked?.current === true) return;
  await applyRoute(host, slot, row, save, true);
}

async function applyRoute(host: ModelCommandHost, slot: TierSlot, row: CatalogModel, save: boolean, offerSave = false): Promise<void> {
  const runtime = host.runtime;
  const binding: RouteBinding = { provider_id: row.provider, model_id: row.model, adapter_id: row.adapterId };
  try {
    await runtime.setSessionRoute(slot.tier, slot.role, binding);
  } catch (error) {
    host.showFailure(error);
    return;
  }
  host.print([`${host.ok} ${slotLabel(slot)} -> ${row.provider}/${row.model} (${row.badge}${row.capability === "unknown" ? ", capability unknown" : ""}) for this session`]);
  if (slot.role === undefined && (slot.tier === "session" || slot.tier === host.conversationTier())) await host.switchConversation(slot.tier, false);
  if (!save && !offerSave) return;
  const answer = await host.ask(`Save ${slotLabel(slot)} -> ${row.provider}/${row.model} as the default in ${path.join(runtime.home, CONFIG_FILE)}?`, save ? ["Yes", "No"] : ["No", "Yes"]).catch(() => "No");
  if (!/^(yes|y|evet|e)$/i.test(answer.trim())) {
    host.print(["Not saved; the route applies to this session only."]);
    return;
  }
  try {
    const file = await saveUserRoute(runtime.home, slot.tier, slot.role, binding);
    host.print([`${host.ok} Saved to ${file}`]);
  } catch (error) {
    host.showFailure(error);
  }
}

/**
 * Writes (replaces) the user-configuration route of a tier (and role), keeping every other key and
 * comment. The adapter is written only when it is not the provider's default.
 */
export async function saveUserRoute(home: string, tier: ModelTier, role: AgentRole | undefined, binding: RouteBinding): Promise<string> {
  const file = path.join(home, CONFIG_FILE);
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${file} is not valid YAML; fix it before saving routes`);
  if (doc.contents === null || !isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  let routes = doc.get("routes");
  if (!isSeq(routes)) {
    routes = new YAMLSeq();
    doc.set("routes", routes);
  }
  const seq = routes as YAMLSeq;
  seq.items = seq.items.filter((item) => {
    if (!isMap(item)) return true;
    return !(item.get("tier") === tier && (item.get("role") ?? undefined) === role);
  });
  const entry: Record<string, string> = { tier, provider: binding.provider_id, model: binding.model_id };
  if (DEFAULT_ADAPTER_FOR_PROVIDER[binding.provider_id] !== binding.adapter_id) entry.adapter = binding.adapter_id;
  if (role !== undefined) entry.role = role;
  if (binding.profile !== undefined && binding.profile !== "default") entry.profile = binding.profile;
  const node = doc.createNode(entry);
  node.flow = true;
  seq.items.push(node);
  await mkdir(home, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, doc.toString(), "utf8");
  await rename(temporary, file);
  return file;
}
