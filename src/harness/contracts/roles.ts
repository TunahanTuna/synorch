import { WORKER_ROLES, type WorkerRole } from "./common.ts";

/**
 * What each worker role can actually do in the harness, stated once so the planner, plan
 * validation and the orchestrator's instructions agree with the policy engine
 * (`ROLE_EFFECT_CEILINGS`, the exec allowlist and tool visibility; a test keeps them in sync).
 * This table describes authority; it never grants any: the policy engine decides every call.
 */

/**
 * - `none`: no command execution at all (the `exec` tool is not even offered).
 * - `verification-and-read-only`: the task's exact verification commands plus the read-only list
 *   (non-mutating git, listing, viewing, `rg`/`grep`).
 * - `verification-and-build`: the above plus the vetted build/test list (or anything a full OS
 *   sandbox confines).
 */
export type CommandCapability = "none" | "verification-and-read-only" | "verification-and-build";

export interface RoleCapability {
  readonly writes: "never" | "owned-paths" | "only-with-owned-paths";
  /** Command capability of the role (for a debugger: without owned paths, i.e. rca-only). */
  readonly commands: CommandCapability;
  readonly summary: string;
}

export const ROLE_CAPABILITIES: { readonly [R in WorkerRole]: RoleCapability } = {
  explorer: {
    writes: "never",
    commands: "none",
    summary:
      "reads and searches inside its read_paths; runs NO commands (no exec tool): its verification must be empty and every acceptance criterion must be satisfiable by reading files",
  },
  implementer: {
    writes: "owned-paths",
    commands: "verification-and-build",
    summary: "changes only its owned_paths in an isolated workspace; runs its exact verification commands and vetted build/test commands",
  },
  debugger: {
    writes: "only-with-owned-paths",
    commands: "verification-and-read-only",
    summary:
      "root-cause analysis; without owned_paths it changes nothing and runs only its exact verification commands and read-only commands; with owned_paths it may fix like an implementer",
  },
  reviewer: {
    writes: "never",
    commands: "verification-and-read-only",
    summary:
      "configures the mandatory independent review of the standard/high-risk tasks it depends on (reviewer tier, extra criteria, extra verification); it never changes files and runs no attempt of its own",
  },
};

export function canRunCommands(role: WorkerRole): boolean {
  return ROLE_CAPABILITIES[role].commands !== "none";
}

/** The concise table the orchestrator plans with. */
export function renderRoleCapabilityTable(): string {
  return [
    "Worker role capabilities (enforced by the harness policy; plans that ignore them are rejected):",
    ...WORKER_ROLES.map((role) => `- ${role}: ${ROLE_CAPABILITIES[role].summary}.`),
    "Put every command that must run (tests, `node check.mjs`, builds) in the verification of a task whose role can run it, usually the implementer that owns the change.",
  ].join("\n");
}
