import type { AgentRole, AttemptId, RunId, TaskId, ToolExecutionContext, ToolResult } from "../contracts/index.ts";

/**
 * Skill catalog (progressive disclosure). Every step sees the one-line catalog (a skill already in
 * context is only marked as such); the full SKILL.md body is injected only for the role's primary
 * skills and for a skill whose name or trigger phrase appears in the task text. `load_skill` serves any
 * other catalog skill once per conversation (ADR-20): a skill already in context, or already
 * loaded, is answered without its content.
 */

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
}

export interface SkillCatalog {
  list(role?: AgentRole): readonly SkillEntry[] | Promise<readonly SkillEntry[]>;
  /** The full SKILL.md text, or undefined when the skill cannot be loaded (or is not for `role`). */
  load(name: string, role?: AgentRole): Promise<string | undefined>;
  /** Skills always loaded for `role` (e.g. the ones its agent manifest points at); a subset of `list(role)`. */
  primary?(role: AgentRole): readonly string[] | Promise<readonly string[]>;
}

const CATALOG_DESCRIPTION_LIMIT = 120;
const COMBINING_DOT_ABOVE = String.fromCharCode(0x0307);

/** The first sentence of a catalog description, capped: enough to choose a skill, not to apply it. */
export function catalogSummary(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length <= CATALOG_DESCRIPTION_LIMIT ? sentence : `${sentence.slice(0, CATALOG_DESCRIPTION_LIMIT - 1).trimEnd()}…`;
}

export function renderCatalog(entries: readonly SkillEntry[], inContext: ReadonlySet<string> = new Set()): string {
  return [
    "Skill catalog (call load_skill with a name; never read_file a SKILL.md):",
    ...entries.map((entry) => `- ${entry.name}: ${inContext.has(entry.name) ? "(in context below)" : catalogSummary(entry.description)}`),
  ].join("\n");
}

/**
 * Locale-safe folding for trigger matching: Turkish dotted/dotless I (`İ`, `I`, `ı`) all fold to
 * `i` before lowercasing, so `İMPLEMENTATION`, `implementatıon` and `Implementation` match the same
 * phrase and `"İ".toLowerCase()` never leaves a stray combining dot behind.
 */
export function foldForMatch(text: string): string {
  return text.normalize("NFC").replace(/[İIı]/g, "i").toLowerCase().replaceAll(COMBINING_DOT_ABOVE, "");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = foldForMatch(phrase.trim());
  return needle.length > 0 && haystack.includes(needle);
}

export function triggeredSkills(entries: readonly SkillEntry[], text: string): readonly SkillEntry[] {
  const haystack = foldForMatch(text);
  return entries.filter((entry) => containsPhrase(haystack, entry.name) || entry.triggers.some((trigger) => containsPhrase(haystack, trigger)));
}

/** One conversation's skill scope: the same key for the ContextBuilder and the `load_skill` callback. */
export interface SkillScope {
  /** Undefined for the conversation agent (`session`), whose turns belong to no run. */
  readonly runId: RunId | undefined;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly role: AgentRole;
}

/**
 * Which skills are already in a conversation's context: injected by the ContextBuilder on its last
 * build, or served by `load_skill`. Shared by the builder and `createSkillLoadCallback`; it is a
 * de-duplication hint, never a permission.
 */
export interface SkillContextRegistry {
  /** Called by the ContextBuilder on every build: the injected skills and the loads still visible in history. */
  sync(scope: SkillScope, injected: readonly string[], loaded: readonly string[]): void;
  noteLoaded(scope: SkillScope, name: string): void;
  state(scope: SkillScope, name: string): "injected" | "loaded" | undefined;
}

const REGISTRY_SCOPES = 512;

export function skillScopeKey(scope: SkillScope): string {
  return [scope.runId, scope.taskId ?? "-", scope.attemptId ?? "-", scope.role].join("|");
}

export function createSkillContextRegistry(): SkillContextRegistry {
  const scopes = new Map<string, { injected: Set<string>; loaded: Set<string> }>();
  const entry = (scope: SkillScope) => {
    const key = skillScopeKey(scope);
    let found = scopes.get(key);
    if (found === undefined) {
      found = { injected: new Set(), loaded: new Set() };
      scopes.set(key, found);
      if (scopes.size > REGISTRY_SCOPES) scopes.delete(scopes.keys().next().value as string);
    }
    return found;
  };
  return {
    sync(scope, injected, loaded) {
      const found = entry(scope);
      found.injected = new Set(injected);
      found.loaded = new Set(loaded);
    },
    noteLoaded(scope, name) {
      entry(scope).loaded.add(name);
    },
    state(scope, name) {
      const found = scopes.get(skillScopeKey(scope));
      if (found?.injected.has(name) === true) return "injected";
      if (found?.loaded.has(name) === true) return "loaded";
      return undefined;
    },
  };
}

export interface SkillLoadDependencies {
  readonly skills: SkillCatalog;
  /** The registry the ContextBuilder records into (`ContextBuilderDependencies.skillContext`). */
  readonly registry?: SkillContextRegistry;
  /** Longest skill text returned, in characters (default 60 KiB). */
  readonly maxChars?: number;
}

export type SkillLoadCallback = (input: { readonly name: string }, context: ToolExecutionContext) => Promise<ToolResult>;

const SKILL_TEXT_LIMIT = 60 * 1024;
const NOT_LOADED_AGAIN = "it was not loaded again";

/** True for a `load_skill` result that carried no skill content (the skill was already in context). */
export function isDuplicateSkillLoad(resultText: string): boolean {
  return resultText.includes(NOT_LOADED_AGAIN);
}

function ok(text: string, truncated = false): ToolResult {
  return { status: "ok", text, truncated, redactions: 0 };
}

/**
 * The `load_skill` control callback (ADR-20, AC-d5). It serves a catalog skill allowed for the
 * caller's role once per conversation: a skill the ContextBuilder already injected (or the role's
 * primary skill) answers "already in your context" and a skill loaded earlier answers "already
 * loaded", both without repeating the content. It never widens a task's read scope to `.ai/**`.
 */
export function createSkillLoadCallback(deps: SkillLoadDependencies): SkillLoadCallback {
  const registry = deps.registry ?? createSkillContextRegistry();
  const limit = deps.maxChars ?? SKILL_TEXT_LIMIT;
  return async (input, context) => {
    const name = input.name.trim();
    const scope: SkillScope = { runId: context.runId, taskId: context.taskId, attemptId: context.attemptId, role: context.role };
    const primary = (await deps.skills.primary?.(context.role)) ?? [];
    const state = registry.state(scope, name) ?? (primary.includes(name) ? "injected" : undefined);
    if (state === "injected") return ok(`Skill ${name} is already in your context (system instructions); use that copy, ${NOT_LOADED_AGAIN}.`);
    if (state === "loaded") return ok(`Skill ${name} was already loaded earlier in this conversation; use that result, ${NOT_LOADED_AGAIN}.`);
    const text = await deps.skills.load(name, context.role);
    if (text === undefined) {
      const available = (await deps.skills.list(context.role)).map((entry) => entry.name);
      return {
        status: "error",
        text: "",
        truncated: false,
        redactions: 0,
        error: { code: "invalid_arguments", message: `skill ${name} is not in the ${context.role} catalog; available: ${available.join(", ") || "none"}`.slice(0, 2000) },
      };
    }
    registry.noteLoaded(scope, name);
    return ok(text.slice(0, limit), text.length > limit);
  };
}
