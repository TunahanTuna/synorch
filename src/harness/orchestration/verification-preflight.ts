import {
  canRunCommands,
  digestOf,
  normalizedActionSchema,
  WORKSPACE_UNTRUSTED_CODE,
  type PlanTask,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyMode,
  type RunId,
  type SandboxReport,
} from "../contracts/index.ts";
import { commandArgv } from "./evidence.ts";

/**
 * Plan-time dry run of verification commands (live run 01M37V2J). The plan put
 * `node --input-type=module -e "import …"` in an implementer's verification; nothing checked it
 * before the worker ran, the harness recorded it `not-run` (shell syntax, and inline interpreter
 * code is refused anyway), and the worker was asked twice to repair a plan problem it could not fix.
 *
 * Every verification command of a plan is now put through what the harness runner does after the
 * worker's turn: the same argv split (`commandArgv`) and the same policy evaluation (`exec` action,
 * the task's role and scope, its exact verification commands, the workspace trust state and the
 * sandbox level) — without running anything. A command the runner would record `not-run` is a plan
 * problem the orchestrator fixes in `plan_propose`.
 *
 * Refusals the orchestrator cannot fix by changing the command (the workspace is not trusted, the
 * configuration requires a full sandbox) are reported separately as `environment`: they concern
 * every command of the run, not this plan, and are left to the run's trust gate and triage.
 */

export interface VerificationPreflightContext {
  readonly policy: PolicyEngine;
  readonly mode: PolicyMode;
  readonly runId: RunId;
  readonly workspaceRoot: string;
  readonly sandbox: SandboxReport;
  readonly userConfig?: unknown;
  readonly workspaceConfig?: unknown;
}

export interface VerificationRefusal {
  readonly index: number;
  readonly taskKey: string;
  readonly command: string;
  /** `shell-syntax`, or the policy reason code of the denial (e.g. `exec-not-allowlisted`). */
  readonly code: string;
  readonly reason: string;
  readonly suggestion: string;
}

export interface VerificationPreflight {
  /** Commands the harness would refuse or not run because of the command itself: the plan must change. */
  readonly refusals: readonly VerificationRefusal[];
  /** Commands refused only because of the environment (trust, required sandbox). */
  readonly environment: readonly VerificationRefusal[];
}

const ENVIRONMENT_CODES: ReadonlySet<string> = new Set([WORKSPACE_UNTRUSTED_CODE, "sandbox-insufficient"]);

function scriptName(task: PlanTask): string {
  return `check-${task.key.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "task"}.mjs`;
}

/** A quote-aware word split of a command that is not a plain argv, only to ask the policy what else it would refuse. */
function looseArgv(command: string): string[] {
  return [...command.trim().matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "").filter((word) => word !== "");
}

function suggestionFor(task: PlanTask, argv: readonly string[] | undefined, code: string, reason: string): string {
  const script = scriptName(task);
  const checkScript = `write a check script owned by the implementer (add ${script} to its owned_paths; it imports the code and asserts) and verify with \`node ${script}\`, or use the project's test runner (\`node --test\`, \`npm test\`, \`pnpm test\`)`;
  const inline = /inline code/.test(reason) ? "inline interpreter code (node -e/-p, python -c, sh -c, powershell -Command) is always refused; " : "";
  if (argv === undefined) {
    return `the harness runs each verification command as a plain argv (no shell: no quoted code, pipes, redirects, &&, ;, globs or VAR=value); ${inline}${checkScript}`;
  }
  if (inline !== "") return `${inline}${checkScript}`;
  if (code === "read-only-role-mutation") return `a ${task.role} cannot run a command that can write; put it on the implementer that owns the change`;
  if (/only the harness integrates/.test(reason)) return "only the harness integrates changes: drop git commands that write the repository";
  if (/loads code or configuration/.test(reason)) return `node options that load modules or config files are refused; ${checkScript}`;
  if (code === "exec-not-allowlisted") return `only exact verification commands, the read-only list and the vetted build/test list can run without a full sandbox; ${checkScript}`;
  return checkScript;
}

function denialOf(decision: PolicyDecision): { readonly code: string; readonly reason: string; readonly environment: boolean } | undefined {
  if (decision.decision !== "deny") return undefined;
  const reasons = decision.reasons.filter((reason) => reason.code !== "approval-required");
  const blocking = reasons.find((reason) => !ENVIRONMENT_CODES.has(reason.code) && reason.code !== "exec-denied") ?? reasons[0];
  if (blocking === undefined) return { code: "denied", reason: "the policy refuses it", environment: false };
  return { code: blocking.code, reason: blocking.message, environment: reasons.every((reason) => ENVIRONMENT_CODES.has(reason.code)) };
}

/** Dry-runs every verification command of the plan's tasks (roles that run commands) through the runner's argv split and policy. */
export function preflightVerification(tasks: readonly PlanTask[], context: VerificationPreflightContext, include: (task: PlanTask) => boolean = () => true): VerificationPreflight {
  const refusals: VerificationRefusal[] = [];
  const environment: VerificationRefusal[] = [];
  for (const [index, task] of tasks.entries()) {
    if (task.verification.length === 0 || !canRunCommands(task.role) || !include(task)) continue;
    const writes = task.role !== "reviewer" && task.owned_paths.length > 0;
    const policy = context.policy.compute({
      mode: context.mode,
      role: task.role,
      runId: context.runId,
      taskId: undefined,
      workspaceRoot: context.workspaceRoot,
      taskScope: { owned: writes ? task.owned_paths : [], read: task.read_paths, forbidden: [], verification_commands: task.verification },
      userConfig: context.userConfig,
      workspaceConfig: context.workspaceConfig,
      sandbox: context.sandbox,
      grants: [],
    });
    const evaluate = (argv: readonly string[]): ReturnType<typeof denialOf> => {
      const action = normalizedActionSchema.parse({
        tool_name: "exec",
        tool_version: "1.0.0",
        effect: "exec",
        role: task.role,
        args_digest: digestOf({ argv }),
        paths: [{ path: ".", access: "read" }],
        command: { argv, cwd: "." },
        network_hosts: [],
        destructive: false,
      });
      try {
        const denial = denialOf(context.policy.evaluate(action, policy));
        // Policy messages echo the argv (up to 200 characters); the command is already named, so keep only the verdict.
        const shown = argv.join(" ").slice(0, 200);
        return denial === undefined ? undefined : { ...denial, reason: denial.reason.split(shown).join("it").trim() };
      } catch (error) {
        return { code: "policy-error", reason: error instanceof Error ? error.message : String(error), environment: false };
      }
    };
    for (const command of task.verification) {
      const argv = commandArgv(command);
      if (argv === undefined || argv.length === 0) {
        // Not a plain argv: the runner records it not-run. The policy verdict on its quote-aware split says what else is wrong (e.g. inline code).
        const loose = looseArgv(command);
        const denial = loose.length === 0 ? undefined : evaluate(loose);
        const reason = `the command uses shell syntax and cannot be run as a plain argv${denial === undefined || denial.environment ? "" : `; the policy also refuses it: ${denial.reason}`}`;
        refusals.push({ index, taskKey: task.key, command, code: "shell-syntax", reason, suggestion: suggestionFor(task, undefined, "shell-syntax", reason) });
        continue;
      }
      const denial = evaluate(argv);
      if (denial === undefined) continue;
      const refusal: VerificationRefusal = { index, taskKey: task.key, command, code: denial.code, reason: denial.reason, suggestion: suggestionFor(task, argv, denial.code, denial.reason) };
      (denial.environment ? environment : refusals).push(refusal);
    }
  }
  return { refusals, environment };
}

/** One actionable plan problem per refused command: which command, why (code), and what to use instead. */
export function formatVerificationRefusal(refusal: VerificationRefusal): string {
  return `tasks[${refusal.index}] ${refusal.taskKey}: verification command "${refusal.command.slice(0, 300)}" would not run (${refusal.code}: ${refusal.reason.slice(0, 300)}); instead, ${refusal.suggestion}`;
}
