import { pathPatternsOverlap } from "../contracts/index.ts";

/**
 * DAG scheduler. The graph is validated acyclic up front; a task becomes startable when every
 * dependency completed, and it starts only if the global, per-provider and per-workspace limits
 * allow it and no running task owns an overlapping path. The overlap rule is enforced here even
 * though the plan schema already rejects parallel overlapping owners: a second, independent
 * guard means a bypassed plan check still cannot produce two concurrent writers.
 */

export interface SchedulableTask {
  readonly key: string;
  readonly dependsOn: readonly string[];
  readonly ownedPaths: readonly string[];
  readonly provider: string | undefined;
  readonly workspace: string;
}

export interface ConcurrencyLimits {
  readonly global: number;
  readonly perProvider: number;
  readonly perWorkspace: number;
}

export const DEFAULT_CONCURRENCY: ConcurrencyLimits = { global: 4, perProvider: 2, perWorkspace: 4 };

export type ScheduledState = "pending" | "running" | "completed" | "failed" | "skipped";

export interface DagScheduler {
  /** Keys that may start now, in plan order; calling it does not start them. */
  startable(): readonly string[];
  start(key: string): void;
  finish(key: string, outcome: "completed" | "failed"): void;
  /** Marks every pending task as skipped (budget stop, cancellation). */
  skipPending(): readonly string[];
  state(key: string): ScheduledState;
  running(): readonly string[];
  done(): boolean;
  /** Adds a pending task (an approved plan revision); its dependencies must already be known. */
  add(task: SchedulableTask): void;
}

export class SchedulerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SchedulerError";
  }
}

export function findDependencyCycle(tasks: readonly Pick<SchedulableTask, "key" | "dependsOn">[]): readonly string[] | undefined {
  const edges = new Map(tasks.map((task) => [task.key, task.dependsOn]));
  const marks = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    const mark = marks.get(key);
    if (mark === "done") return undefined;
    if (mark === "visiting") return [...stack.slice(stack.indexOf(key)), key];
    marks.set(key, "visiting");
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    marks.set(key, "done");
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.key);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

export function createDagScheduler(initial: readonly SchedulableTask[], limits: ConcurrencyLimits = DEFAULT_CONCURRENCY): DagScheduler {
  const tasks: SchedulableTask[] = [...initial];
  if (limits.global < 1 || limits.perProvider < 1 || limits.perWorkspace < 1) {
    throw new SchedulerError("concurrency limits must be at least 1");
  }
  const byKey = new Map<string, SchedulableTask>();
  for (const task of tasks) {
    if (byKey.has(task.key)) throw new SchedulerError(`duplicate task ${task.key}`);
    byKey.set(task.key, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byKey.has(dependency)) throw new SchedulerError(`${task.key} depends on unknown task ${dependency}`);
    }
  }
  const cycle = findDependencyCycle(tasks);
  if (cycle !== undefined) throw new SchedulerError(`dependency cycle: ${cycle.join(" -> ")}`);

  const states = new Map<string, ScheduledState>(tasks.map((task) => [task.key, "pending"]));

  const require = (key: string): SchedulableTask => {
    const task = byKey.get(key);
    if (task === undefined) throw new SchedulerError(`unknown task ${key}`);
    return task;
  };

  const runningTasks = (): SchedulableTask[] => tasks.filter((task) => states.get(task.key) === "running");

  const conflicts = (candidate: SchedulableTask, active: readonly SchedulableTask[]): boolean =>
    active.some((other) =>
      candidate.ownedPaths.some((pattern) => other.ownedPaths.some((owned) => pathPatternsOverlap(pattern, owned))),
    );

  const fits = (candidate: SchedulableTask, active: readonly SchedulableTask[]): boolean => {
    if (active.length >= limits.global) return false;
    if (active.filter((task) => task.workspace === candidate.workspace).length >= limits.perWorkspace) return false;
    if (
      candidate.provider !== undefined &&
      active.filter((task) => task.provider === candidate.provider).length >= limits.perProvider
    ) {
      return false;
    }
    return !conflicts(candidate, active);
  };

  const skipDependents = (key: string): void => {
    for (const task of tasks) {
      if (states.get(task.key) === "pending" && task.dependsOn.includes(key)) {
        states.set(task.key, "skipped");
        skipDependents(task.key);
      }
    }
  };

  return {
    startable() {
      const active = runningTasks();
      const selected: string[] = [];
      for (const task of tasks) {
        if (states.get(task.key) !== "pending") continue;
        if (!task.dependsOn.every((dependency) => states.get(dependency) === "completed")) continue;
        if (!fits(task, active)) continue;
        active.push(task);
        selected.push(task.key);
      }
      return selected;
    },
    start(key) {
      const task = require(key);
      if (states.get(key) !== "pending") throw new SchedulerError(`${key} is not pending`);
      if (!task.dependsOn.every((dependency) => states.get(dependency) === "completed")) {
        throw new SchedulerError(`${key} has unfinished dependencies`);
      }
      if (!fits(task, runningTasks())) throw new SchedulerError(`${key} would exceed a limit or overlap a running owner`);
      states.set(key, "running");
    },
    finish(key, outcome) {
      require(key);
      if (states.get(key) !== "running") throw new SchedulerError(`${key} is not running`);
      states.set(key, outcome);
      if (outcome === "failed") skipDependents(key);
    },
    skipPending() {
      const skipped: string[] = [];
      for (const task of tasks) {
        if (states.get(task.key) === "pending") {
          states.set(task.key, "skipped");
          skipped.push(task.key);
        }
      }
      return skipped;
    },
    state(key) {
      require(key);
      return states.get(key) ?? "pending";
    },
    running() {
      return runningTasks().map((task) => task.key);
    },
    done() {
      return tasks.every((task) => {
        const state = states.get(task.key);
        return state === "completed" || state === "failed" || state === "skipped";
      });
    },
    add(task) {
      if (byKey.has(task.key)) throw new SchedulerError(`duplicate task ${task.key}`);
      for (const dependency of task.dependsOn) {
        if (!byKey.has(dependency)) throw new SchedulerError(`${task.key} depends on unknown task ${dependency}`);
      }
      const blocked = task.dependsOn.some((dependency) => states.get(dependency) === "failed" || states.get(dependency) === "skipped");
      byKey.set(task.key, task);
      tasks.push(task);
      states.set(task.key, blocked ? "skipped" : "pending");
    },
  };
}
