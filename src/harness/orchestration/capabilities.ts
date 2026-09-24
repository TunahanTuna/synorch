import { canRunCommands, ROLE_CAPABILITIES, type Plan, type PlanTask } from "../contracts/index.ts";

/**
 * Plan checks against what each role can actually do (`ROLE_CAPABILITIES`). The first live run
 * failed because the plan gave an explorer (no exec tool) a verification command and a criterion
 * that demanded running it: the explorer could only report `partial`, and the run failed. A plan
 * like that is now rejected with a reason the orchestrator can act on, before anything runs.
 *
 * The criterion check is deliberately narrow and deterministic: a statement is flagged only when it
 * names a verification command of the plan or an unmistakable command line (`node check.mjs`,
 * `pnpm test`, `go test ./...`). Anything subtler is left to the orchestrator's triage at runtime.
 */

const RUNNERS = ["node", "npm", "pnpm", "yarn", "npx", "bun", "deno", "python", "python3", "pytest", "go", "cargo", "dotnet", "mvn", "gradle", "gradlew", "jest", "vitest", "tsc"];
const SUBCOMMANDS = ["test", "run", "build", "exec", "install", "check", "lint", "start", "ci", "verify"];
const COMMAND_LINE = new RegExp(
  `(?:^|[\\s\`'"(])((?:${RUNNERS.join("|")})\\s+(?:-{1,2}[\\w-]+\\s+)*(?:[\\w@-]*[./\\\\][\\w@./\\\\-]*|(?:${SUBCOMMANDS.join("|")})\\b))`,
  "i",
);

/** The command a statement asks to run, when it names one of `commands` or an obvious command line. */
export function commandMentioned(statement: string, commands: readonly string[]): string | undefined {
  const lowered = statement.toLowerCase();
  for (const command of commands) {
    const needle = command.trim().toLowerCase();
    if (needle.length > 0 && lowered.includes(needle)) return command.trim();
  }
  return COMMAND_LINE.exec(statement)?.[1]?.trim();
}

function dependentsOf(plan: Plan, key: string): PlanTask[] {
  const reach = new Set<string>([key]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of plan.tasks) {
      if (!reach.has(task.key) && task.depends_on.some((dependency) => reach.has(dependency))) {
        reach.add(task.key);
        grew = true;
      }
    }
  }
  return plan.tasks.filter((task) => task.key !== key && reach.has(task.key));
}

function runnerHint(plan: Plan, task: PlanTask): string {
  const candidates = dependentsOf(plan, task.key).filter((other) => other.role === "implementer" || (other.role === "debugger" && other.owned_paths.length > 0));
  return candidates.length > 0
    ? `move it to ${candidates.map((other) => other.key).join(" or ")} (a task whose role can run commands)`
    : "move it to an implementer task that depends on this one";
}

/** Human- and model-readable problems of a structurally valid plan; empty when roles fit their tasks. */
export function roleCapabilityIssues(plan: Plan): string[] {
  const issues: string[] = [];
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
  const knownCommands = [...new Set([...plan.verification, ...plan.tasks.flatMap((task) => task.verification)])];
  for (const [index, task] of plan.tasks.entries()) {
    const at = `tasks[${index}] ${task.key} (${task.role})`;
    if (!canRunCommands(task.role)) {
      if (task.verification.length > 0) {
        issues.push(
          `${at}: the ${task.role} role cannot run commands (command capability ${ROLE_CAPABILITIES[task.role].commands}), so verification [${task.verification.join(", ")}] could never run; ${runnerHint(plan, task)} and leave this task's verification empty`,
        );
      }
      for (const criterion of task.acceptance_criteria) {
        const command = commandMentioned(criterion.statement, knownCommands);
        if (command !== undefined) {
          issues.push(
            `${at} ${criterion.id}: it requires running "${command}", which the ${task.role} role cannot do; phrase the criterion as something to find by reading, and ${runnerHint(plan, task)}`,
          );
        }
      }
    }
    if (task.role === "reviewer") {
      if (task.depends_on.length === 0) {
        issues.push(
          `${at}: a reviewer task configures the independent review of the tasks it depends on; add depends_on with the standard/high-risk task to review (to inspect existing code, use an explorer)`,
        );
      }
      for (const key of task.depends_on) {
        const dependency = byKey.get(key);
        if (dependency === undefined) continue;
        // An integration review (2+ dependencies) may cover trivial tasks: it checks the combined result.
        if (dependency.role === "reviewer" || (dependency.risk === "trivial" && task.depends_on.length < 2)) {
          issues.push(
            `${at}: it depends on ${key}, which is ${dependency.role === "reviewer" ? "another reviewer task" : "trivial"} and gets no independent review; raise ${key}'s risk to standard or drop the reviewer task`,
          );
        }
      }
    }
  }
  return issues;
}

