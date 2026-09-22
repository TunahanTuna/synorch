import type { WorkerFactory } from "./coordinator.ts";
import type { GitRunner } from "./git.ts";
import { createIsolationProvider } from "./isolation.ts";
import { createWorkerManager, type WorkerManagerDependencies } from "./worker-manager.ts";

export type SharedWorkerDependencies = Omit<WorkerManagerDependencies, "run" | "budget" | "isolation"> & {
  /** Parent of `.synorch/worktrees`; defaults to the user's home directory. */
  readonly home?: string;
  readonly git?: GitRunner;
};

/** Wires a per-run WorkerManager with its own IsolationProvider for the coordinator. */
export function createWorkerFactory(shared: SharedWorkerDependencies): WorkerFactory {
  return (scope, budget) =>
    createWorkerManager({
      ...shared,
      run: scope,
      budget,
      isolation: createIsolationProvider({
        workspaceRoot: scope.workspaceRoot,
        projectId: scope.projectId,
        blobs: shared.blobs,
        ...(shared.home === undefined ? {} : { home: shared.home }),
        ...(shared.git === undefined ? {} : { git: shared.git }),
        ...(shared.platform === undefined ? {} : { platform: shared.platform }),
      }),
    });
}
