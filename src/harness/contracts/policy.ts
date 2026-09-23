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
export type PolicyMode = (typeof POLICY_MODES)[number];
export const DEFAULT_POLICY_MODE: PolicyMode = "autonomous";

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

const effectMatrixSchema = z.strictObject(
  Object.fromEntries(TOOL_EFFECTS.map((effect) => [effect, effectDecisionSchema])) as {
    [E in (typeof TOOL_EFFECTS)[number]]: typeof effectDecisionSchema;
  },
);

export const effectivePolicySchema = z
  .strictObject({
    schema_version: z.literal(1),
    policy_version: z.int().min(1),
    mode: policyModeSchema,
    role: agentRoleSchema,
    run_id: runIdSchema,
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
    layers: z
      .array(z.strictObject({ layer: z.enum(POLICY_LAYERS), source: z.string().min(1), digest: digestSchema }))
      .min(1),
  })
  .superRefine((policy, context) => {
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
      if (isWholeWorkspacePattern(pattern) || isReservedWritePattern(pattern)) {
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
    if (policy.mode === "autonomous" && policy.effects["external-write"] === "allow" && policy.external_write_allowlist.length === 0) {
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
  run_id: runIdSchema,
  task_id: taskIdSchema.optional(),
  subject_kind: z.enum(APPROVAL_SUBJECTS),
  subject_digest: digestSchema,
  summary: z.string().min(1).max(2000),
  effect: toolEffectSchema.optional(),
  scope: z.enum(["once", "plan", "session"]),
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
    decided_by: z.enum(["user", "orchestrator", "config", "broker"]),
    mode: policyModeSchema,
    decided_at: timestampSchema,
    reason: z.string().max(1000).optional(),
  })
  .superRefine((decision, context) => {
    const allows = (ALLOWING_OUTCOMES as readonly string[]).includes(decision.outcome);
    if (decision.decided_by === "orchestrator") {
      if (decision.mode !== "autonomous") {
        context.addIssue({ code: "custom", path: ["decided_by"], message: "the orchestrator approves only in autonomous mode" });
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
  readonly runId: z.infer<typeof runIdSchema>;
  readonly taskId: z.infer<typeof taskIdSchema> | undefined;
  readonly workspaceRoot: string;
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
