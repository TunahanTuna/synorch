import { providerIdSchema, ProviderFailure, type AgentBackendAdapter } from "../contracts/index.ts";
import { providerError } from "./errors.ts";

/**
 * P2 seam only (ADR-05 plan B): the Codex app-server bridge would drive the user's `codex` binary
 * over JSON-RPC with Synorch tools as `dynamicTools`. It is intentionally not implemented; every
 * entry point reports `bridge_unavailable` and nothing is spawned.
 */
export function createCodexAppServerAdapter(now: () => Date = () => new Date()): AgentBackendAdapter {
  const providerId = providerIdSchema.parse("openai");
  const reason = "the codex-app-server bridge is a reserved seam and is not implemented in this version";
  return {
    kind: "agent-backend",
    adapterId: "codex-app-server",
    providerId,
    authMethod: "cli-bridge",
    async probe() {
      return { installed: false, executable: undefined, version: undefined, minimumVersion: "0.0.0", authSource: "unknown", loginHint: undefined };
    },
    async discoverCapabilities() {
      return {
        schema_version: 1,
        provider_id: providerId,
        adapter_id: "codex-app-server",
        adapter_kind: "agent-backend",
        auth_method: "cli-bridge",
        auth_status: "unknown",
        billing: "unknown",
        quota_visibility: "api",
        loop_owner: "backend",
        tool_channel: "dynamic-tools",
        policy_status: "permitted",
        models: [],
        probed_at: now().toISOString(),
        source: "static-config",
      };
    },
    async startSession() {
      throw new ProviderFailure(providerError("bridge_unavailable", reason));
    },
    async health() {
      return { state: "unknown", checked_at: now().toISOString(), detail: reason };
    },
  };
}
