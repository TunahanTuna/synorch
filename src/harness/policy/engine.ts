import { isSafeRelativePath, normalizeRelativePath } from "../../domain/relative-path.ts";
import {
  CONTROL_PLANE_WRITE_PREFIX,
  digestOf,
  effectivePolicySchema,
  HARD_RAILS,
  HarnessError,
  isReservedWritePattern,
  isWholeWorkspacePattern,
  pathPatternSchema,
  policyDecisionSchema,
  READ_ONLY_ROLES,
  type AgentRole,
  type EffectDecision,
  type EffectivePolicy,
  type HardRail,
  type NormalizedAction,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyInputs,
  type PolicyMode,
  type ToolEffect,
} from "../contracts/index.ts";
import { classifyCommand } from "./command-classifier.ts";
import { DESTRUCTIVE_COMMAND_RULES } from "./command-rules.ts";
import { readPolicyConfig, type PolicyConfig } from "./config.ts";
import { hasReservedSegment, isAncestorOfAny, matchesAny } from "./path-scope.ts";

type EffectMatrix = { [E in ToolEffect]: EffectDecision };
type PolicyLayer = PolicyDecision["reasons"][number]["layer"];
type NetworkPolicy = EffectivePolicy["network"];

/** What each role may do at most, before mode, scope, sandbox and configuration narrow it. */
export const ROLE_EFFECT_CEILINGS: { readonly [R in AgentRole]: EffectMatrix } = {
  orchestrator: { read: "allow", "workspace-write": "allow", exec: "deny", "external-write": "allow", control: "allow" },
  explorer: { read: "allow", "workspace-write": "deny", exec: "deny", "external-write": "deny", control: "allow" },
  reviewer: { read: "allow", "workspace-write": "deny", exec: "allow", "external-write": "deny", control: "allow" },
  implementer: { read: "allow", "workspace-write": "allow", exec: "allow", "external-write": "allow", control: "allow" },
  debugger: { read: "allow", "workspace-write": "allow", exec: "allow", "external-write": "allow", control: "allow" },
};

const ORCHESTRATOR_WRITE_SCOPE = `${CONTROL_PLANE_WRITE_PREFIX}**`;
const NETWORK_ORDER = ["deny", "allowlist", "allow"] as const;
const MAX_REASONS = 20;

const PLATFORM_DIGEST = digestOf({
  rails: HARD_RAILS,
  destructive: DESTRUCTIVE_COMMAND_RULES.map((rule) => ({ code: rule.code, programs: rule.programs, examples: rule.examples })),
});

/**
 * Computes effective policy as an intersection and evaluates normalized actions against it.
 * Nothing in a model message, repository file or tool output reaches either function except
 * through the typed inputs, and no input can relax a hard rail.
 */
export function createPolicyEngine(): PolicyEngine {
  return { compute: computePolicy, evaluate: evaluateAction };
}

/** `--explain-permission`: the same evaluation the gateway runs, without executing anything. */
export function explainPermission(action: NormalizedAction, policy: EffectivePolicy): PolicyDecision {
  return evaluateAction(action, policy);
}

function computePolicy(inputs: PolicyInputs): EffectivePolicy {
  const user = readPolicyConfig(inputs.userConfig, "user");
  const workspace = readPolicyConfig(inputs.workspaceConfig, "workspace");
  const mode = strictestMode([inputs.mode, user.mode, workspace.mode]);
  const role = inputs.role;
  const readOnly = (READ_ONLY_ROLES as readonly AgentRole[]).includes(role);
  const forbidden = unique([
    ...strictPatterns(inputs.taskScope?.forbidden ?? [], "task forbidden path"),
    ...(user.forbidden ?? []),
    ...(workspace.forbidden ?? []),
  ]);
  const writeScope = role === "orchestrator" ? [ORCHESTRATOR_WRITE_SCOPE] : readOnly ? [] : ownedPatterns(inputs.taskScope?.owned ?? []);
  const readPatterns = lenientPatterns(inputs.taskScope?.read ?? []);
  const readScope = readPatterns.length > 0 ? readPatterns : ["**"];
  const requireFullSandbox = user.require_full_sandbox === true || workspace.require_full_sandbox === true;
  const allowlist = intersectAllowlist(user.external_write_allowlist ?? [], workspace.external_write_allowlist);
  const network = intersectNetwork(user.network ?? { mode: "deny", hosts: [] }, workspace.network);

  const ceiling = ROLE_EFFECT_CEILINGS[role];
  const effects: EffectMatrix = { ...ceiling };
  if (writeScope.length === 0) effects["workspace-write"] = "deny";
  for (const effect of ["workspace-write", "exec"] as const) {
    if (effects[effect] === "allow" && mode === "ask") effects[effect] = "ask";
  }
  if (effects["external-write"] === "allow") {
    effects["external-write"] = mode === "ask" ? "ask" : allowlist.length > 0 ? "allow" : "deny";
  }
  if (requireFullSandbox && inputs.sandbox.enforcement !== "full") {
    effects["workspace-write"] = "deny";
    effects.exec = "deny";
  }

  const layers: EffectivePolicy["layers"] = [
    { layer: "platform", source: "builtin-rails", digest: PLATFORM_DIGEST },
    { layer: "user", source: "user-config", digest: digestOf(user) },
    { layer: "workspace", source: "workspace-config", digest: digestOf(workspace) },
    { layer: "role", source: role, digest: digestOf(ceiling) },
  ];
  if (inputs.taskScope !== undefined) {
    layers.push({ layer: "task", source: inputs.taskId ?? "task-scope", digest: digestOf(inputs.taskScope) });
  }
  layers.push({ layer: "sandbox", source: inputs.sandbox.backend, digest: digestOf(inputs.sandbox) });
  if (inputs.grants.length > 0) layers.push({ layer: "approval", source: "grants", digest: digestOf(inputs.grants) });

  return effectivePolicySchema.parse({
    schema_version: 1,
    policy_version: 1,
    mode,
    role,
    run_id: inputs.runId,
    task_id: inputs.taskId,
    workspace_root: inputs.workspaceRoot,
    write_scope: writeScope,
    read_scope: readScope,
    forbidden,
    effects,
    external_write_allowlist: allowlist,
    network,
    sandbox: { backend: inputs.sandbox.backend, enforcement: inputs.sandbox.enforcement },
    require_full_sandbox: requireFullSandbox,
    layers,
  });
}

interface DecisionBuilder {
  decision: EffectDecision;
  rail: HardRail | undefined;
  readonly reasons: { code: string; layer: PolicyLayer; message: string }[];
}

function evaluateAction(action: NormalizedAction, policy: EffectivePolicy): PolicyDecision {
  const builder: DecisionBuilder = { decision: "allow", rail: undefined, reasons: [] };
  const deny = (layer: PolicyLayer, code: string, message: string, rail?: HardRail): void => {
    builder.decision = "deny";
    if (rail !== undefined && builder.rail === undefined) builder.rail = rail;
    builder.reasons.push({ code, layer, message: message.slice(0, 500) });
  };

  evaluatePaths(action, policy, deny);
  const effect = evaluateCommand(action, policy, deny);
  evaluateNetwork(action, policy.network, deny);

  const configured = policy.effects[effect];
  const sandboxShort = policy.require_full_sandbox && policy.sandbox.enforcement !== "full" && (effect === "workspace-write" || effect === "exec");
  if (configured === "deny") {
    const layer: PolicyLayer = sandboxShort ? "sandbox" : "role";
    const why = sandboxShort ? `full sandbox required but ${policy.sandbox.backend} is ${policy.sandbox.enforcement}` : `${policy.role} may not ${effect} in ${policy.mode} mode`;
    deny(layer, sandboxShort ? "sandbox-insufficient" : `${effect}-denied`, why);
  } else if (effect === "external-write" && configured === "allow" && !isAllowlisted(action, policy.external_write_allowlist)) {
    deny("user", "external-write-not-allowlisted", "autonomous external writes need an exact entry in the user allowlist");
  } else if (configured === "ask" && builder.decision !== "deny") {
    builder.decision = "ask";
    builder.reasons.push({ code: "approval-required", layer: "approval", message: `${effect} needs approval in ask mode` });
  }

  if (builder.reasons.length === 0) {
    const writes = action.paths.filter((entry) => entry.access === "write");
    builder.reasons.push(
      writes.length > 0
        ? { code: "owned-path-write", layer: "task", message: `${writes.map((entry) => entry.path).join(", ")} inside the write scope`.slice(0, 500) }
        : { code: "effect-allowed", layer: "role", message: `${effect} is allowed for ${policy.role}` },
    );
  }
  return policyDecisionSchema.parse({
    decision: builder.decision,
    action_digest: digestOf(action),
    policy_digest: digestOf(policy),
    reasons: builder.reasons.slice(0, MAX_REASONS),
    rail: builder.rail,
  });
}

type Deny = (layer: PolicyLayer, code: string, message: string, rail?: HardRail) => void;

function evaluatePaths(action: NormalizedAction, policy: EffectivePolicy, deny: Deny): void {
  const policySources = policy.layers
    .map((layer) => layer.source)
    .filter((source) => isSafeRelativePath(source) && source.includes("."))
    .map((source) => normalizeRelativePath(source).toLowerCase());
  for (const entry of action.paths) {
    if (entry.access === "write") {
      if (hasReservedSegment(entry.path)) deny("platform", "reserved-path", `${entry.path} is a reserved path`, "reserved-path-write");
      else if (policySources.includes(entry.path.toLowerCase())) deny("platform", "policy-source", `${entry.path} is a policy source`, "policy-self-modification");
      else if (matchesAny(entry.path, policy.forbidden, { caseInsensitive: true })) deny("task", "forbidden-path", `${entry.path} is forbidden for this task`, "write-outside-scope");
      else if (!matchesAny(entry.path, policy.write_scope, { caseInsensitive: false })) deny("task", "outside-write-scope", `${entry.path} is outside the write scope`, "write-outside-scope");
      continue;
    }
    if (matchesAny(entry.path, policy.forbidden, { caseInsensitive: true })) deny("task", "forbidden-read", `${entry.path} is forbidden for this task`);
    else if (!matchesAny(entry.path, policy.read_scope, { caseInsensitive: false }) && !isAncestorOfAny(entry.path, policy.read_scope, { caseInsensitive: false })) {
      deny("task", "outside-read-scope", `${entry.path} is outside the read scope`);
    }
  }
}

function evaluateCommand(action: NormalizedAction, policy: EffectivePolicy, deny: Deny): ToolEffect {
  if (action.command === undefined) {
    if (action.destructive) deny("platform", "destructive-action", `${action.tool_name} is marked destructive`, "destructive-command");
    return action.effect;
  }
  const classification = classifyCommand(action.command.argv, {
    cwd: action.command.cwd,
    writeScope: policy.write_scope,
    forbidden: policy.forbidden,
  });
  for (const finding of classification.findings) deny("platform", finding.code, finding.message, finding.rail);
  if (action.destructive && !classification.destructive) {
    deny("platform", "tool-marked-destructive", `${action.tool_name} marked this command destructive`, "destructive-command");
  }
  if ((READ_ONLY_ROLES as readonly AgentRole[]).includes(action.role) && classification.mutating) {
    deny("role", "read-only-role-mutation", `${action.role} is read-only and this command can write`);
  }
  return classification.effect === "external-write" && action.effect === "exec" ? "external-write" : action.effect;
}

function evaluateNetwork(action: NormalizedAction, network: NetworkPolicy, deny: Deny): void {
  if (action.network_hosts.length === 0 || network.mode === "allow") return;
  if (network.mode === "deny") {
    deny("user", "network-denied", `network access to ${action.network_hosts.join(", ")} is denied`);
    return;
  }
  const allowed = new Set(network.hosts.map((host) => host.toLowerCase()));
  const blocked = action.network_hosts.filter((host) => !allowed.has(host.toLowerCase()));
  if (blocked.length > 0) deny("user", "host-not-allowlisted", `hosts outside the allowlist: ${blocked.join(", ")}`);
}

function isAllowlisted(action: NormalizedAction, allowlist: readonly string[]): boolean {
  const subject = action.command?.argv ?? [`tool:${action.tool_name}`];
  return allowlist.some((entry) => {
    const words = entry.trim().split(/\s+/);
    const prefix = words[words.length - 1] === "*";
    const expected = prefix ? words.slice(0, -1) : words;
    if (prefix ? subject.length < expected.length : subject.length !== expected.length) return false;
    return expected.every((word, index) => subject[index] === word);
  });
}

function strictestMode(modes: readonly (PolicyMode | undefined)[]): PolicyMode {
  return modes.includes("ask") ? "ask" : "autonomous";
}

function ownedPatterns(owned: readonly string[]): string[] {
  return unique(lenientPatterns(owned).filter((pattern) => !isWholeWorkspacePattern(pattern) && !isReservedWritePattern(pattern)));
}

function lenientPatterns(values: readonly string[]): string[] {
  return values.flatMap((value) => {
    const parsed = pathPatternSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Forbidden paths are never dropped: an unreadable denial must fail the computation, not widen it. */
function strictPatterns(values: readonly string[], label: string): string[] {
  return values.map((value) => {
    const parsed = pathPatternSchema.safeParse(value);
    if (!parsed.success) {
      throw new HarnessError({ code: "config_invalid", message: `Invalid ${label}: ${value}`.slice(0, 2000), workspace_effect: "none", retry_safe: false });
    }
    return parsed.data;
  });
}

function intersectAllowlist(user: readonly string[], workspace: readonly string[] | undefined): string[] {
  if (workspace === undefined) return unique(user);
  const narrowed = new Set(workspace);
  return unique(user.filter((entry) => narrowed.has(entry)));
}

function intersectNetwork(user: NetworkPolicy, workspace: PolicyConfig["network"]): NetworkPolicy {
  const clean = (network: NetworkPolicy): NetworkPolicy => ({ mode: network.mode, hosts: network.mode === "allowlist" ? unique(network.hosts) : [] });
  if (workspace === undefined) return clean(user);
  const mode = NETWORK_ORDER[Math.min(NETWORK_ORDER.indexOf(user.mode), NETWORK_ORDER.indexOf(workspace.mode))] ?? "deny";
  if (mode !== "allowlist") return { mode, hosts: [] };
  const lists = [user, workspace].filter((network) => network.mode === "allowlist").map((network) => new Set(network.hosts));
  const [first, ...rest] = lists;
  return { mode, hosts: [...(first ?? [])].filter((host) => rest.every((list) => list.has(host))) };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
