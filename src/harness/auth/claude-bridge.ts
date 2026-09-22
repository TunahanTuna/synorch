import { spawn } from "node:child_process";
import {
  BRIDGE_STRIPPED_ENV,
  HarnessError,
  PROVIDER_ERROR_RETRYABLE,
  ProviderFailure,
  providerIdSchema,
  type AuthProvider,
  type AuthStatus,
  type CredentialRef,
} from "../contracts/index.ts";
import { CLAUDE_BRIDGE_NOTICE } from "./notices.ts";
import type { ProfileStateStore } from "./profile-state.ts";

export interface ClaudeCliProbeResult {
  readonly installed: boolean;
  readonly version: string | undefined;
}

/** Checks the user's own `claude` install. It only runs `claude --version`; no Claude file is read. */
export type ClaudeCliProbe = (signal: AbortSignal) => Promise<ClaudeCliProbeResult>;

export interface ClaudeBridgeAuthOptions {
  readonly state: ProfileStateStore;
  readonly probe?: ClaudeCliProbe;
  readonly now?: () => Date;
}

export const defaultClaudeProbe: ClaudeCliProbe = (signal) =>
  new Promise((resolve) => {
    const env: Record<string, string> = {};
    const stripped = new Set<string>(BRIDGE_STRIPPED_ENV.map((name) => name.toUpperCase()));
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !stripped.has(key.toUpperCase())) env[key] = value;
    }
    let stdout = "";
    const child = spawn("claude --version", { shell: true, env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), 15_000);
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-4096);
    });
    const finish = (installed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ installed, version: /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] });
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && /\d+\.\d+\.\d+/.test(stdout)));
  });

/**
 * `anthropic` / `cli-bridge`: the Claude subscription is used only through the user's installed
 * Claude Code. "Login" is the explicit experimental opt-in (a one-time notice); signing in to
 * Claude itself happens inside `claude` (`/login`). No token exists on Synorch's side, so
 * `resolve` always rejects and nothing is ever written to the credential store.
 */
export function createClaudeBridgeAuthProvider(profile: string, options: ClaudeBridgeAuthOptions): AuthProvider {
  const now = options.now ?? (() => new Date());
  const probe = options.probe ?? defaultClaudeProbe;
  const ref: CredentialRef = { provider_id: providerIdSchema.parse("anthropic"), method: "cli-bridge", profile };

  async function status(signal: AbortSignal): Promise<AuthStatus> {
    const base = { provider_id: ref.provider_id, method: ref.method, profile, entitlement: "unknown" as const, billing: "unknown" as const };
    const probed = await probe(signal).catch((): ClaudeCliProbeResult => ({ installed: false, version: undefined }));
    if (!probed.installed) return { ...base, state: "disconnected", detail: "claude executable not found; install Claude Code to use the bridge" };
    const version = `Claude Code ${probed.version ?? "unknown version"}`;
    if (!(await options.state.isAcknowledged(CLAUDE_BRIDGE_NOTICE.id, ref))) {
      return { ...base, state: "login_required", detail: `${version}; experimental bridge not enabled (syn login anthropic --method cli-bridge)` };
    }
    return { ...base, state: "unknown", detail: `${version}; Claude sign-in is checked by Claude Code on first use (run \`claude\`, then /login)` };
  }

  return {
    providerId: ref.provider_id,
    method: "cli-bridge",
    profile,
    notices: [CLAUDE_BRIDGE_NOTICE],
    status,
    async login(interaction, signal) {
      if (!interaction.interactive) {
        throw new HarnessError({
          code: "auth_required",
          message: "enabling the experimental Claude Code bridge needs an interactive terminal",
          workspace_effect: "none",
          retry_safe: true,
        });
      }
      const probed = await probe(signal);
      if (!probed.installed) {
        throw new ProviderFailure({
          code: "bridge_unavailable",
          message: "claude executable not found on PATH; install Claude Code and sign in with `claude` then `/login`",
          retryable: PROVIDER_ERROR_RETRYABLE.bridge_unavailable,
        });
      }
      if (!(await options.state.isAcknowledged(CLAUDE_BRIDGE_NOTICE.id, ref))) {
        const accepted = await interaction.acknowledge(CLAUDE_BRIDGE_NOTICE, signal);
        if (!accepted) {
          throw new HarnessError({ code: "auth_required", message: "the experimental bridge notice was not accepted", workspace_effect: "none", retry_safe: true });
        }
        await options.state.acknowledge(CLAUDE_BRIDGE_NOTICE.id, ref, now());
      }
      interaction.notify("Synorch never sees your Claude credentials. If Claude Code is not signed in yet, run `claude` and then `/login`.");
      return status(signal);
    },
    async logout() {
      await options.state.revokeAcknowledgement(CLAUDE_BRIDGE_NOTICE.id, ref);
    },
    async resolve() {
      throw new ProviderFailure({
        code: "invalid_request",
        message: "cli-bridge credentials are resolved inside the user's Claude Code, never by Synorch",
        retryable: PROVIDER_ERROR_RETRYABLE.invalid_request,
      });
    },
  };
}
