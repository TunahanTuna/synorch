import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  digestOf,
  digestText,
  HarnessError,
  type EffectivePolicy,
  type NormalizedAction,
  type PolicyDecision,
  type PolicyEngine,
} from "../contracts/index.ts";
import { isControlPlanePath, normalizeWorkspacePath } from "./paths.ts";

/**
 * The orchestrator's only write path into the workspace: plan, packet and report files under
 * `.ai/tasks/**`. Every write is evaluated by the PolicyEngine against the orchestrator's
 * effective policy *and* by a local rule that does not depend on the engine, so a lenient or
 * misconfigured engine still cannot let the orchestrator touch a product file (AC-8).
 */

export interface ControlPlaneWriterDependencies {
  readonly workspaceRoot: string;
  readonly policy: EffectivePolicy;
  readonly engine: PolicyEngine;
  readonly onDecision?: (action: NormalizedAction, decision: PolicyDecision) => void;
}

export interface ControlPlaneWriter {
  write(relativePath: string, content: string): Promise<PolicyDecision>;
}

function denied(message: string, decision: PolicyDecision | undefined): HarnessError {
  return new HarnessError({
    code: "policy_denied",
    message,
    ids: decision === undefined ? undefined : { action_digest: decision.action_digest },
    workspace_effect: "none",
    retry_safe: false,
  });
}

async function nearestExistingRealpath(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), path.relative(current, target));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      current = parent;
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function createControlPlaneWriter(deps: ControlPlaneWriterDependencies): ControlPlaneWriter {
  if (deps.policy.role !== "orchestrator") {
    throw new TypeError("the control-plane writer is bound to the orchestrator policy");
  }
  return {
    async write(relativePath, content) {
      const normalized = normalizeWorkspacePath(relativePath);
      if (normalized === undefined) throw denied(`not a workspace-relative path: ${relativePath}`, undefined);
      const action: NormalizedAction = {
        tool_name: "control_plane_write",
        tool_version: "1.0.0",
        effect: "workspace-write",
        role: "orchestrator",
        args_digest: digestOf({ path: normalized, content: digestText(content) }),
        paths: [{ path: normalized, access: "write" }],
        network_hosts: [],
        destructive: false,
      };
      const decision = deps.engine.evaluate(action, deps.policy);
      deps.onDecision?.(action, decision);
      if (decision.decision !== "allow") {
        throw denied(`policy ${decision.decision}: the orchestrator may not write ${normalized}`, decision);
      }
      if (!isControlPlanePath(normalized)) {
        throw denied(`the orchestrator writes only under .ai/tasks/**, not ${normalized}`, decision);
      }
      const root = await realpath(deps.workspaceRoot);
      const controlRoot = path.join(root, ".ai", "tasks");
      const target = path.join(root, ...normalized.split("/"));
      const resolved = await nearestExistingRealpath(target);
      if (!isInside(controlRoot, resolved) && !isInside(await nearestExistingRealpath(controlRoot), resolved)) {
        throw denied(`${normalized} resolves outside .ai/tasks`, decision);
      }
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, content, "utf8");
      await rename(temporary, target);
      return decision;
    },
  };
}
