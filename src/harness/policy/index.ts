/** I3 — PolicyEngine (effective policy, hard rails, destructive command rules), ApprovalBroker adapters. */
export type { ApprovalBroker, PolicyEngine } from "../contracts/index.ts";
export { createHeadlessApprovalBroker, type HeadlessApprovalBrokerOptions } from "./approval-broker.ts";
export { classifyCommand, type CommandClassification, type CommandFinding } from "./command-classifier.ts";
export { DESTRUCTIVE_COMMAND_RULES, EXTERNAL_WRITE_RULES, type CommandRule, type CommandScope } from "./command-rules.ts";
export { policyConfigSchema, readPolicyConfig, type PolicyConfig } from "./config.ts";
export { createPolicyEngine, explainPermission, ROLE_EFFECT_CEILINGS } from "./engine.ts";
