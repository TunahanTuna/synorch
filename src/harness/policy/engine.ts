import { realpathSync } from "node:fs";
import path from "node:path";
import { isSafeRelativePath, normalizeRelativePath } from "../../domain/relative-path.ts";
import {
  CONTROL_PLANE_WRITE_PREFIX,
  digestOf,
  effectivePolicySchema,
  execConfinementFor,
  HARD_RAILS,
  HarnessError,
  SESSION_WRITE_SCOPE,
  hasReservedSegment,
  isAncestorOfAnyPattern as isAncestorOfAny,
  isReservedWritePattern,
  isWholeWorkspacePattern,
  matchesAnyPathPattern as matchesAny,
  PATH_ESCAPE_REASON_CODE,
  PERMISSION_LIFTABLE_CODES,
  pathPatternSchema,
  policyModeForPermission,
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
  type PermissionMode,
  type PolicyMode,
  type ToolEffect,
  foldPathCase,
  isCaseInsensitivePlatform,
} from "../contracts/index.ts";
import { classifyCommand } from "./command-classifier.ts";
import { DESTRUCTIVE_COMMAND_RULES } from "./command-rules.ts";
import { readPolicyConfig, type PolicyConfig } from "./config.ts";
import { evaluateExecAllowlist, type ExecAllowlistDecision } from "./exec-allowlist.ts";

type EffectMatrix = { [E in ToolEffect]: EffectDecision };
type PolicyLayer = PolicyDecision["reasons"][number]["layer"];
type NetworkPolicy = EffectivePolicy["network"];

/** What each role may do at most, before mode, scope, sandbox and configuration narrow it. */
export const ROLE_EFFECT_CEILINGS: { readonly [R in AgentRole]: EffectMatrix } = {
  orchestrator: { read: "allow", "workspace-write": "allow", exec: "deny", "external-write": "allow", control: "allow", "network-read": "allow" },
  explorer: { read: "allow", "workspace-write": "deny", exec: "deny", "external-write": "deny", control: "allow", "network-read": "allow" },
  reviewer: { read: "allow", "workspace-write": "deny", exec: "allow", "external-write": "deny", control: "allow", "network-read": "allow" },
  implementer: { read: "allow", "workspace-write": "allow", exec: "allow", "external-write": "allow", control: "allow", "network-read": "allow" },
  debugger: { read: "allow", "workspace-write": "allow", exec: "allow", "external-write": "allow", control: "allow", "network-read": "allow" },
  // ADR-21 D3: the conversation agent edits the main tree and runs commands; mode, scope, sandbox, trust and rails still narrow it.
  session: { read: "allow", "workspace-write": "allow", exec: "allow", "external-write": "allow", control: "allow", "network-read": "allow" },
};

/**
 * Paths the conversation agent may never write even though it owns the workspace (ADR-21 D3):
 * the canonical role manifests are policy sources. `.git/**` and `.synorch/**` are reserved for
 * every role, and the Synorch home (trust, grants, credentials) is refused by its own rail.
 */
export const SESSION_FORBIDDEN_WRITES = [".ai/agents/**"] as const;

const ORCHESTRATOR_WRITE_SCOPE = `${CONTROL_PLANE_WRITE_PREFIX}**`;
const NETWORK_ORDER = ["deny", "allowlist", "allow"] as const;
const MAX_REASONS = 20;

const PLATFORM_DIGEST = digestOf({
  rails: HARD_RAILS,
  destructive: DESTRUCTIVE_COMMAND_RULES.map((rule) => ({ code: rule.code, programs: rule.programs, examples: rule.examples })),
});

export interface PolicyEngineOptions {
  /**
   * The Synorch home (`~/.synorch` or `SYNORCH_HOME`). No write may land under it, except inside
   * the current worker's own workspace root (an attempt worktree lives there).
   */
  readonly synorchHome?: string;
  /**
   * Whether the user trusted the session's workspace (SEC-N1). Only the composition root supplies
   * it, from the user-scope trust store or `--trust-workspace`; nothing in the repository, the
   * configuration layers or a model message can. Absent means untrusted.
   */
  readonly workspaceTrusted?: () => boolean;
  /**
   * The session's current permission mode, from the composition root (a CLI flag, the user-scope
   * `ui.permission_mode` or Shift+Tab). Workers (`implementer`, `debugger`) inherit `auto` and
   * `full` (ADR-08 revision 3 applies to workers: auto = autonomous inside the worktree); `ask`,
   * `plan`, headless, every read-only role and the orchestrator keep the default-deny policy.
   */
  readonly permissionMode?: () => PermissionMode | undefined;
  /**
   * K4.1: web domains the user allowed for `web_fetch` ("always allow this domain", user scope,
   * global) plus the built-in documentation domains; `*.example.com` matches subdomains. They
   * extend the network allowlist for `network-read` actions only.
   */
  readonly webDomains?: () => readonly string[];
  /**
   * K4.1 prompt-injection shield: true once web content entered the current turn. An outward-facing
   * action (git push, gh writes, HTTP writes, remote copy) the policy would allow then asks once
   * more, even in full access mode.
   */
  readonly webContentRead?: () => boolean;
  /**
   * Owner revision 3 (2026-09-24): true once the user approved a plain `git push` in this session.
   * `auto` then pushes without asking again (force pushes and history rewrites still ask).
   */
  readonly gitPushApproved?: () => boolean;
}

/**
 * Computes effective policy as an intersection and evaluates normalized actions against it.
 * Nothing in a model message, repository file or tool output reaches either function except
 * through the typed inputs, and no input can relax a hard rail.
 */
export function createPolicyEngine(options: PolicyEngineOptions = {}): PolicyEngine {
  return { compute: (inputs) => computePolicy(inputs, options.workspaceTrusted?.() === true, options.permissionMode?.()), evaluate: (action, policy) => evaluateAction(action, policy, options) };
}

/**
 * `--explain-permission`: the same evaluation the gateway runs, without executing anything. The
 * decision carries the exec allowlist verdict (`exec-allowlisted`, `exec-not-allowlisted`,
 * `exec-unconfined`, `workspace-untrusted`) as one of its reasons.
 */
export function explainPermission(action: NormalizedAction, policy: EffectivePolicy, options: PolicyEngineOptions = {}): PolicyDecision {
  return evaluateAction(action, policy, options);
}

function computePolicy(inputs: PolicyInputs, workspaceTrusted: boolean, enginePermission: PermissionMode | undefined): EffectivePolicy {
  const user = readPolicyConfig(inputs.userConfig, "user");
  const workspace = readPolicyConfig(inputs.workspaceConfig, "workspace");
  const role = inputs.role;
  const requested = role === "session" ? inputs.permissionMode : WORKER_PERMISSION_ROLES.has(role) && (enginePermission === "full" || enginePermission === "auto") ? enginePermission : undefined;
  const configured = strictestMode([inputs.mode, user.mode, workspace.mode]);
  // A configuration layer that asks (`policy.mode: ask`) narrows auto/full to ask (workers: no full); nothing widens.
  const permission: PermissionMode | undefined =
    requested === undefined || requested === "plan" || configured !== "ask" ? requested : role === "session" ? "ask" : undefined;
  const mode = permission === undefined ? configured : policyModeForPermission(permission);
  const readOnly = (READ_ONLY_ROLES as readonly AgentRole[]).includes(role);
  const forbidden = unique([
    ...strictPatterns(inputs.taskScope?.forbidden ?? [], "task forbidden path"),
    ...(user.forbidden ?? []),
    ...(workspace.forbidden ?? []),
  ]);
  const writeScope = role === "orchestrator" ? [ORCHESTRATOR_WRITE_SCOPE] : role === "session" ? [SESSION_WRITE_SCOPE] : readOnly ? [] : ownedPatterns(inputs.taskScope?.owned ?? []);
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
  if (effects["network-read"] === "allow" && mode === "ask") effects["network-read"] = "ask";
  if (requireFullSandbox && inputs.sandbox.enforcement !== "full") {
    effects["workspace-write"] = "deny";
    effects.exec = "deny";
  }
  if (permission === "plan") {
    effects["workspace-write"] = "deny";
    effects.exec = "deny";
    effects["external-write"] = "deny";
  } else if ((permission === "auto" || permission === "full") && effects["external-write"] === "deny" && ceiling["external-write"] === "allow") {
    // Without an allowlist entry an external write is asked for (auto) or allowed (full) at evaluation; rails still deny.
    effects["external-write"] = "allow";
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
    exec_confinement: execConfinementFor(inputs.sandbox.enforcement, mode),
    verification_commands: unique((inputs.taskScope?.verification_commands ?? []).map((command) => command.trim()).filter((command) => command.length > 0)),
    workspace_trusted: workspaceTrusted,
    ...((inputs.taskScope?.dependency_links ?? []).length === 0 ? {} : { dependency_links: unique([...(inputs.taskScope?.dependency_links ?? [])]) }),
    ...(permission === undefined ? {} : { permission_mode: permission }),
    ...(role === "session" ? { command_grants: unique((inputs.commandGrants ?? []).map((entry) => entry.trim().split(/\s+/).join(" ")).filter((entry) => entry.length > 0)).slice(0, 256) } : {}),
    layers,
  });
}

interface DecisionBuilder {
  decision: EffectDecision;
  rail: HardRail | undefined;
  readonly reasons: { code: string; layer: PolicyLayer; message: string }[];
  /** Whether every denial so far is one a permission mode may lift (see `PERMISSION_LIFTABLE_CODES`), or a destructive-command rule. */
  liftable: boolean;
  /** A destructive-command rule denied (owner decision 2026-09-24: an interactive mode asks instead). */
  destructive: boolean;
}

/** Roles that inherit `auto`/`full` from the session's permission mode; read-only roles and the orchestrator never do. */
const WORKER_PERMISSION_ROLES: ReadonlySet<AgentRole> = new Set(["implementer", "debugger"]);

function evaluateAction(action: NormalizedAction, policy: EffectivePolicy, options: PolicyEngineOptions): PolicyDecision {
  const builder: DecisionBuilder = { decision: "allow", rail: undefined, reasons: [], liftable: true, destructive: false };
  const deny = (layer: PolicyLayer, code: string, message: string, rail?: HardRail): void => {
    builder.decision = "deny";
    if (rail !== undefined && (builder.rail === undefined || (builder.rail === "destructive-command" && rail !== "destructive-command"))) builder.rail = rail;
    // An allowlist refusal is liftable only on the partial-sandbox list; the read-only list and hard refusals (layer role) never are.
    const liftable = rail === undefined && (PERMISSION_LIFTABLE_CODES as readonly string[]).includes(code) && !(code === "exec-not-allowlisted" && layer === "role");
    // A destructive-command rule (force push, publish, recursive delete…) is promptable; every other rail stays a hard rail.
    const promptable = rail === "destructive-command" && layer === "platform";
    if (promptable) builder.destructive = true;
    else if (!liftable) builder.liftable = false;
    builder.reasons.push({ code, layer, message: message.slice(0, 500) });
  };

  evaluatePaths(action, policy, options, deny);
  const { effect, confinement, external } = evaluateCommand(action, policy, deny);
  if (action.egress_findings !== undefined) {
    deny("platform", "secret-egress", `the outbound request carries what looks like a secret (${action.egress_findings.join(", ")})`.slice(0, 500), "secret-egress");
  }
  if (action.effect === "network-read") evaluateNetworkRead(action, policy, options, builder, deny);
  else evaluateNetwork(action, policy.network, deny);

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
  if (confinement?.decision === "deny" && (builder.decision !== "deny" || confinement.layer === "role")) {
    // A sandbox-layer refusal is reported only when nothing else denied, so it never masks a clearer code.
    deny(confinement.layer, confinement.code, confinement.message);
  } else if (confinement !== undefined && confinement.decision !== "deny" && builder.decision !== "deny") {
    if (confinement.decision === "ask") builder.decision = "ask";
    builder.reasons.push({ code: confinement.code, layer: confinement.layer, message: confinement.message.slice(0, 500) });
  }

  liftByPermission(builder, policy, isReadOnlyWorker(action.role, policy), external, options);

  if (builder.decision === "allow" && effect === "external-write" && options.webContentRead?.() === true) {
    // Owner decision 2026-09-24 (K4): web content read in this turn may carry injected instructions.
    builder.decision = "ask";
    builder.reasons.push({ code: "web-content-shield", layer: "approval", message: "web content was read in this turn; an action that sends data outside this machine asks you first, in every mode" });
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

/**
 * ADR-08 revision 3 (2026-09-24): in `auto` a decision denied only by liftable reasons is allowed,
 * except an outward-facing external write, which asks (a plain git push only once per session);
 * in `full` it is allowed. Hard rails, reserved paths, escapes, git integration, module
 * injection, configured effect denials and read-only roles are never lifted.
 */
function liftByPermission(builder: DecisionBuilder, policy: EffectivePolicy, readOnly: boolean, external: readonly string[], options: PolicyEngineOptions): void {
  const mode = policy.permission_mode;
  if (readOnly || builder.decision !== "deny" || !builder.liftable) return;
  if (builder.destructive) {
    // Owner decision 2026-09-24: destructive-command rules ask in every interactive mode, `full` included
    // (an action card, never silent); headless has no human, so its broker still refuses. Sandbox escapes,
    // reserved paths, credential stores, secret egress and policy sources remain hard rails (not liftable).
    if (mode !== "ask" && mode !== "auto" && mode !== "full") return;
    if (builder.rail !== "destructive-command") return;
    builder.decision = "ask";
    builder.rail = undefined;
    builder.reasons.push({ code: "destructive-prompt", layer: "approval", message: "a destructive command always asks you first, in every permission mode" });
    return;
  }
  if ((mode !== "auto" && mode !== "full") || builder.rail !== undefined) return;
  if (mode === "auto") {
    // Owner revision 3 (2026-09-24): auto acts autonomously inside the workspace (any command, installs,
    // background processes, repository code); only outward-facing writes ask. A plain git push asks once per session.
    const outward = builder.reasons.some((reason) => reason.code === "external-write-not-allowlisted");
    const pushApproved = external.length > 0 && external.every((code) => code === "git-push") && options.gitPushApproved?.() === true;
    if (outward && !pushApproved) {
      builder.decision = "ask";
      builder.reasons.push({ code: "permission-prompt", layer: "approval", message: "auto mode asks before an action that sends data or changes things outside this machine" });
      return;
    }
    builder.decision = "allow";
    builder.reasons.push({
      code: "permission-auto",
      layer: "user",
      message: outward ? "auto mode: git push was approved earlier in this session" : "auto mode: allowed without a prompt; it runs with your user permissions",
    });
    return;
  }
  builder.decision = "allow";
  builder.reasons.push({ code: "permission-full-access", layer: "user", message: "full access mode: allowed without a prompt; it runs with your user permissions" });
}

function evaluatePaths(action: NormalizedAction, policy: EffectivePolicy, options: PolicyEngineOptions, deny: Deny): void {
  // Repository-relative layer sources (e.g. the canonical `.ai/agents/<role>/AGENT.md` role layer) are policy sources no tool may write.
  const policySources = policy.layers
    .map((layer) => layer.source)
    .filter((source) => isSafeRelativePath(source) && source.includes("."))
    .map((source) => foldPathCase(normalizeRelativePath(source)));
  for (const escape of action.escapes ?? []) {
    const message = `${escape.requested || "<empty path>"} cannot be expressed inside the workspace (${escape.reason})`.slice(0, 500);
    if (escape.access === "write") deny("platform", PATH_ESCAPE_REASON_CODE.write, message, "write-outside-scope");
    else deny("platform", PATH_ESCAPE_REASON_CODE.read, message);
  }
  for (const entry of action.paths) {
    if (entry.access === "write") {
      const canonical = canonicalTarget(policy.workspace_root, entry.path);
      if (isGitHooksOrConfig(entry.path) || isGitHooksOrConfig(canonical)) {
        deny("platform", "git-hooks-or-config", `${entry.path} is a git hook or git config; writing it would run or reconfigure code`, "reserved-path-write");
      } else if (hasReservedSegment(entry.path)) deny("platform", "reserved-path", `${entry.path} is a reserved path`, "reserved-path-write");
      else if (policySources.includes(foldPathCase(entry.path))) deny("platform", "policy-source", `${entry.path} is a policy source`, "policy-self-modification");
      else if (policy.role === "session" && matchesAny(entry.path, SESSION_FORBIDDEN_WRITES, { caseInsensitive: true })) {
        deny("platform", "policy-source", `${entry.path} is a canonical role manifest (a policy source)`, "policy-self-modification");
      }
      else if (options.synorchHome !== undefined && isUnderSynorchHome(canonical, policy.workspace_root, options.synorchHome)) {
        deny("platform", "synorch-home-write", `${entry.path} resolves inside the Synorch home`, "reserved-path-write");
      } else if (matchesAny(entry.path, policy.forbidden, { caseInsensitive: true })) deny("task", "forbidden-path", `${entry.path} is forbidden for this task`, "write-outside-scope");
      else if (!matchesAny(entry.path, policy.write_scope, GRANT_MATCH)) deny("task", "outside-write-scope", `${entry.path} is outside the write scope`, "write-outside-scope");
      continue;
    }
    if (matchesAny(entry.path, policy.forbidden, { caseInsensitive: true })) deny("task", "forbidden-read", `${entry.path} is forbidden for this task`);
    else if (!matchesAny(entry.path, policy.read_scope, GRANT_MATCH) && !isAncestorOfAny(entry.path, policy.read_scope, GRANT_MATCH)) {
      deny("task", "outside-read-scope", `${entry.path} is outside the read scope`);
    }
  }
}

interface CommandEvaluation {
  readonly effect: ToolEffect;
  /** The exec allowlist verdict when one narrows this command (not a writer under a full sandbox). */
  readonly confinement: ExecAllowlistDecision | undefined;
  /** External-write rule codes the command matched (`git-push`, `http-write`…). */
  readonly external: readonly string[];
}

function evaluateCommand(action: NormalizedAction, policy: EffectivePolicy, deny: Deny): CommandEvaluation {
  if (action.command === undefined) {
    if (action.destructive) deny("platform", "destructive-action", `${action.tool_name} is marked destructive`, "destructive-command");
    return { effect: action.effect, confinement: undefined, external: [] };
  }
  const classification = classifyCommand(action.command.argv, {
    cwd: action.command.cwd,
    writeScope: policy.write_scope,
    forbidden: policy.forbidden,
    dependencyLinks: (policy.dependency_links ?? []).length > 0,
  });
  for (const finding of classification.findings) deny("platform", finding.code, finding.message, finding.rail);
  if (action.destructive && !classification.destructive) {
    deny("platform", "tool-marked-destructive", `${action.tool_name} marked this command destructive`, "destructive-command");
  }
  if ((READ_ONLY_ROLES as readonly AgentRole[]).includes(action.role) && classification.mutating) {
    deny("role", "read-only-role-mutation", `${action.role} is read-only and this command can write`);
  }
  const confinement = evaluateExecAllowlist({
    argv: action.command.argv,
    readOnly: isReadOnlyWorker(action.role, policy),
    confinement: policy.exec_confinement ?? execConfinementFor(policy.sandbox.enforcement, policy.mode),
    mode: policy.mode,
    verificationCommands: policy.verification_commands ?? [],
    workspaceTrusted: policy.workspace_trusted === true,
    exactGrants: policy.external_write_allowlist.filter((entry) => !entry.trim().endsWith("*")),
    commandGrants: policy.command_grants ?? [],
  });
  const effect = classification.effect === "external-write" && action.effect === "exec" ? "external-write" : action.effect;
  return { effect, confinement, external: classification.external.map((entry) => entry.code) };
}

/** Explorer and reviewer, and a debugger whose packet owns no paths (root-cause analysis only). */
function isReadOnlyWorker(role: AgentRole, policy: EffectivePolicy): boolean {
  return (READ_ONLY_ROLES as readonly AgentRole[]).includes(role) || (role === "debugger" && policy.write_scope.length === 0);
}

const CASE_INSENSITIVE_FS = isCaseInsensitivePlatform(process.platform);
/** Grants match with the platform's path-case policy (ADR-19); denials always case-insensitively. */
const GRANT_MATCH = { caseInsensitive: CASE_INSENSITIVE_FS } as const;

/**
 * The canonical absolute form of a workspace-relative target: the deepest existing ancestor
 * resolved with `realpath` (links, junctions, 8.3 names), the rest appended, case-folded where
 * the file system is case-insensitive.
 */
function canonicalTarget(workspaceRoot: string, relative: string): string {
  return canonicalPath(path.resolve(workspaceRoot, ...relative.split("/")));
}

function canonicalPath(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const resolved = path.join(realpathSync.native(current), ...[...missing].reverse());
      return CASE_INSENSITIVE_FS ? foldPathCase(resolved) : resolved;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        const unresolved = path.join(current, ...[...missing].reverse());
        return CASE_INSENSITIVE_FS ? foldPathCase(unresolved) : unresolved;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Under the Synorch home and not inside this worker's own workspace root (which may itself live there). */
function isUnderSynorchHome(canonical: string, workspaceRoot: string, synorchHome: string): boolean {
  const home = canonicalPath(synorchHome);
  if (!isInside(home, canonical)) return false;
  const root = canonicalPath(workspaceRoot);
  const ownWorktree = root !== home && isInside(home, root) && isInside(root, canonical);
  return !ownWorktree;
}

/** `.git/hooks/**` or `.git/config`, compared case-insensitively on any path shape. */
function isGitHooksOrConfig(candidate: string): boolean {
  const segments = foldPathCase(candidate.replaceAll("\\", "/")).split("/");
  return segments.some((segment, index) => segment === ".GIT" && (segments[index + 1] === "HOOKS" || (segments[index + 1] === "CONFIG" && index + 2 === segments.length)));
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

/** `example.com` matches itself; `*.example.com` matches its subdomains and itself. */
export function hostMatches(host: string, pattern: string): boolean {
  const wanted = pattern.trim().toLowerCase().replace(/\.$/, "");
  const actual = host.toLowerCase().replace(/\.$/, "");
  if (wanted.startsWith("*.")) {
    const base = wanted.slice(2);
    return actual === base || actual.endsWith(`.${base}`);
  }
  return actual === wanted;
}

/**
 * K4.1 network policy for `network-read` (web_search / web_fetch), by permission mode (owner
 * decisions 2026-09-24, revision 3): `ask` prompts every call (effect matrix), `auto` and `full`
 * search and fetch any public domain without a prompt, `plan`
 * searches freely and asks at a new-domain fetch, headless allows only the allowlist. Workers use
 * the session's mode. Hard rails (SSRF, secret egress) are enforced before and inside the tool.
 */
function evaluateNetworkRead(action: NormalizedAction, policy: EffectivePolicy, options: PolicyEngineOptions, builder: DecisionBuilder, deny: Deny): void {
  const mode = policy.permission_mode ?? (policy.role === "session" ? undefined : options.permissionMode?.());
  if (action.network_purpose !== "fetch" || action.network_hosts.length === 0) {
    if (mode === undefined && policy.network.mode === "deny") {
      deny("user", "network-denied", "web search is off in a run without a permission mode; set policy.network.mode (allowlist or allow) in the user configuration");
    }
    return;
  }
  const granted = [...(policy.network.mode === "allowlist" ? policy.network.hosts : []), ...(options.webDomains?.() ?? [])];
  const blocked = policy.network.mode === "allow" ? [] : action.network_hosts.filter((host) => !granted.some((pattern) => hostMatches(host, pattern)));
  if (blocked.length === 0) return;
  if (mode === "full" || mode === "auto") {
    // Owner revision 3 (2026-09-24): auto reads any public domain without a prompt; SSRF and secret egress stay hard rails.
    const code = mode === "full" ? "permission-full-access" : "permission-auto";
    builder.reasons.push({ code, layer: "user", message: `${mode === "full" ? "full access" : "auto"} mode: fetching ${blocked.join(", ")} without a prompt` });
    return;
  }
  if (mode === undefined) {
    deny("user", "host-not-allowlisted", `web hosts outside the allowlist: ${blocked.join(", ")} (headless runs fetch only allowlisted domains)`);
    return;
  }
  if (builder.decision === "allow") builder.decision = "ask";
  builder.reasons.push({ code: "network-new-domain", layer: "approval", message: `first fetch from ${blocked.join(", ")}: allow once, or always allow this domain` });
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
