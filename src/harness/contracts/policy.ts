import { z } from "zod";
import { agentRoleSchema, READ_ONLY_ROLES, timestampSchema, type AgentRole } from "./common.ts";
import { digestSchema } from "./digest.ts";
import { approvalIdSchema, runIdSchema, taskIdSchema } from "./ids.ts";
import {
  CONTROL_PLANE_WRITE_PREFIX,
  isReservedWritePattern,
  isWholeWorkspacePattern,
  pathPatternSchema,
} from "./paths.ts";
import { SANDBOX_ENFORCEMENT, toolEffectSchema, TOOL_EFFECTS, type SandboxEnforcement, type SandboxReport } from "./tools.ts";

/**
 * Policy is computed, never prompted: effective = platform ∩ user ∩ workspace ∩ role ∩ task scope
 * ∩ sandbox capability ∩ approvals. Nothing in a model message, repository file or tool output is
 * a policy source. The default mode is `autonomous` (ADR-08): the orchestrator is fully authorized
 * inside the hard rails and no per-action prompt is shown; `ask` is the explicit stricter mode.
 */

export const POLICY_MODES = ["autonomous", "ask"] as const;
export const policyModeSchema = z.enum(POLICY_MODES);

/** The conversation agent's write scope: the whole workspace; reserved paths and policy sources are still refused. */
export const SESSION_WRITE_SCOPE = "**";
export type PolicyMode = (typeof POLICY_MODES)[number];
export const DEFAULT_POLICY_MODE: PolicyMode = "autonomous";

/**
 * Interactive permission modes (ADR-08 owner revision 2026-09-24), cycled with Shift+Tab like
 * Claude Code: `ask` prompts for edits and commands; `auto` (the interactive default) runs edits and
 * allowlisted/trusted commands and turns every allowlist refusal into a prompt; `full` prompts for
 * nothing and allows everything in the workspace except the hard rails; `plan` is read-only.
 * Absent on a policy means the pre-revision behaviour: default-deny without prompts (headless).
 * Hard rails deny in every mode.
 */
export const PERMISSION_MODES = ["ask", "auto", "full", "plan"] as const;
export const permissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/** The policy mode a permission mode computes with: only `ask` prompts per effect. */
export function policyModeForPermission(mode: PermissionMode): PolicyMode {
  return mode === "ask" ? "ask" : "autonomous";
}

/** Shift+Tab order: ask -> auto -> full -> plan -> ask. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length] ?? "auto";
}

/**
 * Policy reason codes a permission mode may lift: an allowlist refusal, an untrusted workspace, an
 * external write or a host outside the allowlist. `auto` turns a decision denied only by these into
 * `ask`, `full` into `allow`; a hard rail or any other denial is never lifted.
 */
export const PERMISSION_LIFTABLE_CODES = ["exec-not-allowlisted", "workspace-untrusted", "external-write-not-allowlisted", "network-denied", "host-not-allowlisted"] as const;

export const POLICY_LAYERS = ["platform", "user", "workspace", "role", "task", "sandbox", "approval"] as const;

/**
 * Hard rails. They are denials, not prompts, and no mode, grant, config or approval relaxes them.
 */
export const HARD_RAILS = [
  "write-outside-scope",
  "reserved-path-write",
  "destructive-command",
  "credential-access",
  "secret-egress",
  "policy-self-modification",
  "foreign-credential-store",
] as const;
export const hardRailSchema = z.enum(HARD_RAILS);
export type HardRail = (typeof HARD_RAILS)[number];

/**
 * How `exec` is confined. `full-sandbox`: an OS backend confines every child, so any
 * non-destructive command may run. Without a full sandbox the gateway cannot stop a child from
 * writing outside the scope, so exec is default-deny: only exact `verification_commands` and a
 * vetted build/test allowlist run (`allowlist`, autonomous mode) or anything else asks (`ask`).
 */
export const EXEC_CONFINEMENTS = ["full-sandbox", "allowlist", "ask"] as const;
export type ExecConfinement = (typeof EXEC_CONFINEMENTS)[number];

export function execConfinementFor(enforcement: SandboxEnforcement, mode: PolicyMode): ExecConfinement {
  if (enforcement === "full") return "full-sandbox";
  return mode === "ask" ? "ask" : "allowlist";
}

export const effectDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type EffectDecision = z.infer<typeof effectDecisionSchema>;

const effectMatrixSchema = z.strictObject({
  ...(Object.fromEntries(TOOL_EFFECTS.map((effect) => [effect, effectDecisionSchema])) as {
    [E in (typeof TOOL_EFFECTS)[number]]: typeof effectDecisionSchema;
  }),
  // Added in K4.1: a policy recorded before it (an old `policy/snapshot`) reads as "no network".
  "network-read": effectDecisionSchema.default("deny"),
});

export const effectivePolicySchema = z
  .strictObject({
    schema_version: z.literal(1),
    policy_version: z.int().min(1),
    mode: policyModeSchema,
    role: agentRoleSchema,
    /** Required for every role except `session`: conversation turns belong to no run (ADR-21 D1). */
    run_id: runIdSchema.optional(),
    task_id: taskIdSchema.optional(),
    workspace_root: z.string().min(1),
    write_scope: z.array(pathPatternSchema),
    read_scope: z.array(pathPatternSchema).min(1),
    forbidden: z.array(pathPatternSchema),
    effects: effectMatrixSchema,
    external_write_allowlist: z.array(z.string().min(1).max(500)),
    network: z.strictObject({
      mode: z.enum(["deny", "allowlist", "allow"]),
      hosts: z.array(z.string().min(1).max(253)),
    }),
    sandbox: z.strictObject({ backend: z.string().min(1), enforcement: z.enum(SANDBOX_ENFORCEMENT) }),
    require_full_sandbox: z.boolean(),
    /** Optional only so `policy/snapshot` v1 events stay readable; `compute` always sets it (v2). */
    exec_confinement: z.enum(EXEC_CONFINEMENTS).optional(),
    /** Exact commands of the task's verification section; absent means `[]` (v2). */
    verification_commands: z.array(z.string().min(1).max(2000)).max(64).optional(),
    /**
     * Whether the user trusted this workspace (user-scope `trust.json` or `--trust-workspace`);
     * absent means untrusted (v3). Without a full sandbox, commands that run repository code
     * (verification and build/test commands) need it.
     */
    workspace_trusted: z.boolean().optional(),
    /**
     * Dependency directories linked into the attempt worktree from the main tree (ADR-19). They are
     * in `forbidden` too; while any exist, commands that install, add, remove or update
     * dependencies are denied (`dependency-mutation-in-linked-worktree`). Absent means none.
     */
    dependency_links: z.array(pathPatternSchema).max(64).optional(),
    /**
     * Command prefixes the user allowed with `/allow` (ADR-21, orchestrator decision 1), word by
     * word; `session` only. They extend the exec allowlist and still need workspace trust without a
     * full sandbox; hard rails and destructive-command rules are never relaxed by them.
     */
    command_grants: z.array(z.string().min(1).max(500)).max(256).optional(),
    /**
     * The interactive permission mode (ADR-08 revision 2026-09-24). `session` carries any mode;
     * a worker carries only `full` (the user ran with full access). Absent: default-deny, no prompts.
     */
    permission_mode: permissionModeSchema.optional(),
    layers: z
      .array(z.strictObject({ layer: z.enum(POLICY_LAYERS), source: z.string().min(1), digest: digestSchema }))
      .min(1),
  })
  .superRefine((policy, context) => {
    if (policy.run_id === undefined && policy.role !== "session") {
      context.addIssue({ code: "custom", path: ["run_id"], message: `${policy.role} policy belongs to a run` });
    }
    if (policy.command_grants !== undefined && policy.role !== "session") {
      context.addIssue({ code: "custom", path: ["command_grants"], message: "command grants apply to the conversation agent only" });
    }
    if (policy.permission_mode !== undefined) {
      if (policy.role !== "session" && policy.permission_mode !== "full") {
        context.addIssue({ code: "custom", path: ["permission_mode"], message: "only the conversation agent has interactive permission modes; workers carry full access only" });
      }
      if (policy.mode !== policyModeForPermission(policy.permission_mode)) {
        context.addIssue({ code: "custom", path: ["mode"], message: `permission mode ${policy.permission_mode} computes in ${policyModeForPermission(policy.permission_mode)} mode` });
      }
      if (policy.permission_mode === "plan" && (["workspace-write", "exec", "external-write"] as const).some((effect) => policy.effects[effect] !== "deny")) {
        context.addIssue({ code: "custom", path: ["effects"], message: "plan mode is read-only" });
      }
    }
    const readOnly = (READ_ONLY_ROLES as readonly AgentRole[]).includes(policy.role);
    if (readOnly && (policy.write_scope.length > 0 || policy.effects["workspace-write"] !== "deny")) {
      context.addIssue({ code: "custom", path: ["write_scope"], message: `${policy.role} is read-only` });
    }
    if (policy.role === "orchestrator") {
      for (const [index, pattern] of policy.write_scope.entries()) {
        if (!pattern.startsWith(CONTROL_PLANE_WRITE_PREFIX)) {
          context.addIssue({
            code: "custom",
            path: ["write_scope", index],
            message: `the orchestrator writes only under ${CONTROL_PLANE_WRITE_PREFIX}`,
          });
        }
      }
    }
    for (const [index, pattern] of policy.write_scope.entries()) {
      // The conversation agent owns the workspace minus reserved paths (ADR-21 D3); reserved paths stay unwritable for everyone.
      const whole = isWholeWorkspacePattern(pattern) && !(policy.role === "session" && pattern === SESSION_WRITE_SCOPE);
      if (whole || isReservedWritePattern(pattern)) {
        context.addIssue({ code: "custom", path: ["write_scope", index], message: "whole-workspace and reserved paths are never writable" });
      }
    }
    if (policy.mode === "autonomous") {
      for (const effect of TOOL_EFFECTS) {
        if (policy.effects[effect] === "ask") {
          context.addIssue({ code: "custom", path: ["effects", effect], message: "autonomous mode never prompts per action" });
        }
      }
    }
    const lifts = policy.permission_mode === "auto" || policy.permission_mode === "full";
    if (policy.mode === "autonomous" && !lifts && policy.effects["external-write"] === "allow" && policy.external_write_allowlist.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["external_write_allowlist"],
        message: "external writes are allowed autonomously only through a user allowlist",
      });
    }
    if (policy.require_full_sandbox && policy.sandbox.enforcement !== "full") {
      for (const effect of ["workspace-write", "exec"] as const) {
        if (policy.effects[effect] !== "deny") {
          context.addIssue({ code: "custom", path: ["effects", effect], message: "full sandbox is required but not available" });
        }
      }
    }
    if (policy.exec_confinement !== undefined && policy.exec_confinement !== execConfinementFor(policy.sandbox.enforcement, policy.mode)) {
      context.addIssue({
        code: "custom",
        path: ["exec_confinement"],
        message: `exec confinement must be ${execConfinementFor(policy.sandbox.enforcement, policy.mode)} for a ${policy.sandbox.enforcement} sandbox in ${policy.mode} mode`,
      });
    }
    if (policy.network.mode !== "allowlist" && policy.network.hosts.length > 0) {
      context.addIssue({ code: "custom", path: ["network", "hosts"], message: "hosts are only meaningful for allowlist mode" });
    }
  });
export type EffectivePolicy = z.infer<typeof effectivePolicySchema>;

/** Why a requested path cannot be expressed as a workspace-relative `paths` entry. */
export const PATH_ESCAPE_REASONS = [
  "invalid-path",
  "unc-or-device",
  "outside-workspace",
  "link-escape",
  "dangling-link",
  "hard-link",
  "changed-after-decision",
] as const;
export type PathEscapeReason = (typeof PATH_ESCAPE_REASONS)[number];

/**
 * A requested path that resolved outside the workspace (or could not be resolved safely). It keeps
 * the audit trail complete: such an action is still normalized, evaluated and recorded in
 * `tool/policy_decided`, and the PolicyEngine always denies it (`write-outside-scope` for writes).
 * `requested` is the model's raw argument, bounded; it is evidence, never a scope.
 */
export const pathEscapeSchema = z.strictObject({
  requested: z.string().max(1024),
  access: z.enum(["read", "write"]),
  reason: z.enum(PATH_ESCAPE_REASONS),
});
export type PathEscape = z.infer<typeof pathEscapeSchema>;

/** Decision reason codes the PolicyEngine uses for escapes (layer `platform`); writes also carry the rail. */
export const PATH_ESCAPE_REASON_CODE = { read: "read-outside-workspace", write: "path-escape" } as const;

/** The canonical form of one requested action; its digest is what an approval binds to. */
export const normalizedActionSchema = z.strictObject({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  effect: toolEffectSchema,
  role: agentRoleSchema,
  task_id: taskIdSchema.optional(),
  args_digest: digestSchema,
  paths: z.array(z.strictObject({ path: pathPatternSchema, access: z.enum(["read", "write"]) })),
  /** Paths that escape the workspace; present only when non-empty (`tool/policy_decided` v2). */
  escapes: z.array(pathEscapeSchema).min(1).optional(),
  command: z
    .strictObject({ argv: z.array(z.string()).min(1), cwd: pathPatternSchema })
    .optional(),
  network_hosts: z.array(z.string().min(1).max(253)),
  destructive: z.boolean(),
  /** `network-read` actions (K4.1): a web search (no host) or a page fetch of `network_hosts` (`tool/policy_decided` v3). */
  network_purpose: z.enum(["search", "fetch"]).optional(),
  /** Secret-looking fragments found in an outbound URL or query; any entry is the `secret-egress` hard rail (v3). */
  egress_findings: z.array(z.string().min(1).max(200)).min(1).max(16).optional(),
});
export type NormalizedAction = z.infer<typeof normalizedActionSchema>;

export const policyDecisionSchema = z
  .strictObject({
    decision: effectDecisionSchema,
    action_digest: digestSchema,
    policy_digest: digestSchema,
    reasons: z
      .array(z.strictObject({ code: z.string().min(1).max(64), layer: z.enum(POLICY_LAYERS), message: z.string().min(1).max(500) }))
      .min(1),
    rail: hardRailSchema.optional(),
  })
  .superRefine((decision, context) => {
    if (decision.rail !== undefined && decision.decision !== "deny") {
      context.addIssue({ code: "custom", path: ["decision"], message: "a hard rail always denies" });
    }
  });
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const APPROVAL_SUBJECTS = ["plan", "action", "scope-expansion", "provider-change", "budget", "memory", "workspace-trust"] as const;
/**
 * Subjects only a human may approve: a paid provider switch, a budget increase and trusting a
 * workspace's code are never orchestrator-granted.
 */
export const HUMAN_ONLY_APPROVAL_SUBJECTS = ["provider-change", "budget", "workspace-trust"] as const;

export const approvalRequestSchema = z.strictObject({
  approval_id: approvalIdSchema,
  /** Absent for a conversation turn outside any run (ADR-21). */
  run_id: runIdSchema.optional(),
  task_id: taskIdSchema.optional(),
  subject_kind: z.enum(APPROVAL_SUBJECTS),
  subject_digest: digestSchema,
  summary: z.string().min(1).max(2000),
  effect: toolEffectSchema.optional(),
  scope: z.enum(["once", "plan", "session"]),
  /** The command an `action` approval would run (argv, redacted); the prompt offers "always allow <prefix>" from it. */
  command: z.array(z.string().max(2000)).min(1).max(256).optional(),
  /** The web hosts a `network-read` action would reach; the prompt offers "always allow <host>" (`approval/requested` v2). */
  hosts: z.array(z.string().min(1).max(253)).min(1).max(16).optional(),
  /** Why the policy asks and what allowing does (UX-03 action card). */
  details: z.strictObject({ why: z.string().min(1).max(1000), consequence: z.string().min(1).max(1000) }).optional(),
  requested_at: timestampSchema,
  expires_at: timestampSchema.optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const APPROVAL_OUTCOMES = ["allowed-once", "allowed-for-scope", "rejected", "cancelled", "unavailable", "expired"] as const;
export const ALLOWING_OUTCOMES = ["allowed-once", "allowed-for-scope"] as const;

export const approvalDecisionSchema = z
  .strictObject({
    approval_id: approvalIdSchema,
    subject_kind: z.enum(APPROVAL_SUBJECTS),
    subject_digest: digestSchema,
    outcome: z.enum(APPROVAL_OUTCOMES),
    decided_by: z.enum(["user", "orchestrator", "session", "config", "broker"]),
    mode: policyModeSchema,
    decided_at: timestampSchema,
    reason: z.string().max(1000).optional(),
  })
  .superRefine((decision, context) => {
    const allows = (ALLOWING_OUTCOMES as readonly string[]).includes(decision.outcome);
    if (decision.decided_by === "orchestrator" || decision.decided_by === "session") {
      if (decision.mode !== "autonomous") {
        context.addIssue({ code: "custom", path: ["decided_by"], message: `the ${decision.decided_by} agent approves only in autonomous mode` });
      }
      if (allows && (HUMAN_ONLY_APPROVAL_SUBJECTS as readonly string[]).includes(decision.subject_kind)) {
        context.addIssue({ code: "custom", path: ["subject_kind"], message: `${decision.subject_kind} requires a human decision` });
      }
    }
    if (decision.decided_by === "broker" && allows) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "a broker-generated outcome can only refuse (unavailable/expired/cancelled)" });
    }
    if ((decision.outcome === "unavailable" || decision.outcome === "expired") && decision.decided_by !== "broker") {
      context.addIssue({ code: "custom", path: ["decided_by"], message: `${decision.outcome} is produced by the broker` });
    }
  });
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** Human prompts, when the mode or subject needs one. Headless brokers answer `unavailable`. */
export interface ApprovalBroker {
  readonly availability: "interactive" | "headless";
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface PolicyInputs {
  readonly mode: PolicyMode;
  readonly role: AgentRole;
  /** Undefined only for the `session` role. */
  readonly runId: z.infer<typeof runIdSchema> | undefined;
  readonly taskId: z.infer<typeof taskIdSchema> | undefined;
  readonly workspaceRoot: string;
  /** `/allow` prefixes from the user scope; used for the `session` role only. */
  readonly commandGrants?: readonly string[];
  /** The interactive permission mode; `session` only (a worker inherits only `full` from the engine). */
  readonly permissionMode?: PermissionMode;
  readonly taskScope:
    | {
        readonly owned: readonly string[];
        readonly read: readonly string[];
        readonly forbidden: readonly string[];
        /** The packet's exact verification commands; the only exec a partial sandbox allows beyond the vetted list. */
        readonly verification_commands?: readonly string[];
        /** Dependency directories linked into the attempt worktree (ADR-19); see `EffectivePolicy.dependency_links`. */
        readonly dependency_links?: readonly string[];
      }
    | undefined;
  readonly userConfig: unknown;
  readonly workspaceConfig: unknown;
  readonly sandbox: SandboxReport;
  readonly grants: readonly ApprovalDecision[];
}

/**
 * Workspace trust (SEC-N1). Without a full OS sandbox the harness cannot confine code a build or
 * test command runs, so such commands need the user to trust the workspace once. Trust lives only
 * in the user scope (`<synorch home>/trust.json`), keyed by the canonical workspace root and a
 * repository identity; nothing in the repository can grant it. `flag` is `--trust-workspace`,
 * valid for one run and never persisted; `session` is the prompt's "Trust for this session only",
 * valid for the current runtime and never persisted.
 */
export const TRUST_GRANT_SOURCES = ["prompt", "command"] as const;
export type TrustGrantSource = (typeof TRUST_GRANT_SOURCES)[number];
export const TRUST_USE_SOURCES = ["store", "flag", "session"] as const;
export type TrustUseSource = (typeof TRUST_USE_SOURCES)[number];

export interface WorkspaceTrustState {
  readonly trusted: boolean;
  /** Where the trust came from, when trusted. */
  readonly source: TrustUseSource | undefined;
  /** Canonical workspace root the record is keyed by. */
  readonly root: string;
  /** Repository identity (`git:<hex>` or `dir:<hex>`). */
  readonly identity: string;
  /** Why the workspace is not trusted, when it is not. */
  readonly reason: string | undefined;
}

/** The policy reason code for a code-executing command in an untrusted workspace. */
export const WORKSPACE_UNTRUSTED_CODE = "workspace-untrusted";

/**
 * What trusting a workspace means, shown by the prompt, `syn trust` and the docs. It names both
 * halves of the risk: the repository's own tests/build scripts and any code the AI writes during
 * the session run unconfined, and can reach files outside the workspace, credentials included.
 */
export const WORKSPACE_TRUST_NOTICE =
  "In a trusted workspace, its tests and build scripts, and any code the AI writes during the session, run with your user permissions. They can read and change files outside the workspace, including your Synorch credentials, because Synorch's sandbox on this platform is not full.";

/** The choices the workspace-trust prompt offers, in order; the first is pre-selected. */
export const WORKSPACE_TRUST_CHOICES = [
  { outcome: "rejected", label: "Not now", key: "n" },
  { outcome: "allowed-once", label: "Trust for this session only", key: "s" },
  { outcome: "allowed-for-scope", label: "Trust this workspace", key: "t" },
] as const;

export interface PolicyEngine {
  compute(inputs: PolicyInputs): EffectivePolicy;
  evaluate(action: NormalizedAction, policy: EffectivePolicy): PolicyDecision;
}
