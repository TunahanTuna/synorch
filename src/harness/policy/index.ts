/** I3 — PolicyEngine (effective policy, hard rails, destructive command rules), ApprovalBroker adapters. */
export type { ApprovalBroker, PolicyEngine } from "../contracts/index.ts";
export { createHeadlessApprovalBroker, type HeadlessApprovalBrokerOptions } from "./approval-broker.ts";
export { classifyCommand, type CommandClassification, type CommandFinding } from "./command-classifier.ts";
export { DEPENDENCY_MUTATION_CODE, dependencyMutation, DESTRUCTIVE_COMMAND_RULES, EXTERNAL_WRITE_RULES, type CommandRule, type CommandScope } from "./command-rules.ts";
export { classifyVerificationCommand, evaluateExecAllowlist, type ExecAllowlistDecision } from "./exec-allowlist.ts";
export { policyConfigSchema, readPolicyConfig, type PolicyConfig } from "./config.ts";
export { createPolicyEngine, explainPermission, hostMatches, ROLE_EFFECT_CEILINGS, SESSION_FORBIDDEN_WRITES, type PolicyEngineOptions } from "./engine.ts";
export { createWorkspaceTrustStore, TRUST_FILE, workspaceIdentity, type WorkspaceIdentity, type WorkspaceTrustOptions, type WorkspaceTrustStore } from "./workspace-trust.ts";
