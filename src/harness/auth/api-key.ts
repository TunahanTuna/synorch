import {
  HarnessError,
  PROVIDER_ERROR_RETRYABLE,
  ProviderFailure,
  providerIdSchema,
  type AuthProvider,
  type AuthStatus,
  type CredentialRef,
  type CredentialSecret,
  type CredentialStore,
} from "../contracts/index.ts";
import { API_KEY_BILLING_NOTICE } from "./notices.ts";
import { createResolvedCredential } from "./resolved-credential.ts";

export type ApiKeyProviderId = "openai" | "anthropic";

/** Read-only environment fallback for the `default` profile; Synorch never writes it to disk. */
export const API_KEY_ENV: { readonly [P in ApiKeyProviderId]: string } = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const LABELS: { readonly [P in ApiKeyProviderId]: string } = {
  openai: "OpenAI API key",
  anthropic: "Anthropic API key",
};

export interface ApiKeyAuthOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

/** `api-key` for OpenAI Responses (`Authorization: Bearer`) and Anthropic Messages (`x-api-key`). */
export function createApiKeyAuthProvider(
  store: CredentialStore,
  providerId: ApiKeyProviderId,
  profile: string,
  options: ApiKeyAuthOptions = {},
): AuthProvider {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const ref: CredentialRef = { provider_id: providerIdSchema.parse(providerId), method: "api-key", profile };
  const envName = API_KEY_ENV[providerId];

  function fromEnv(): CredentialSecret | undefined {
    if (profile !== "default") return undefined;
    const value = env[envName]?.trim();
    return value === undefined || value === "" ? undefined : { method: "api-key", api_key: value, created_at: new Date(0).toISOString() };
  }

  function apply(headers: Headers, secret: CredentialSecret): void {
    if (secret.method !== "api-key") return;
    if (providerId === "anthropic") headers.set("x-api-key", secret.api_key);
    else headers.set("authorization", `Bearer ${secret.api_key}`);
  }

  async function status(): Promise<AuthStatus> {
    const base = { provider_id: ref.provider_id, method: ref.method, profile, billing: "metered" as const };
    let stored: CredentialSecret | undefined;
    try {
      stored = await store.get(ref);
    } catch {
      return { ...base, state: "error", entitlement: "unknown", store_backend: store.backend, detail: "stored credential is unreadable" };
    }
    if (stored !== undefined) return { ...base, state: "connected", entitlement: "unverified", store_backend: store.backend };
    if (fromEnv() !== undefined) return { ...base, state: "connected", entitlement: "unverified", detail: `from environment variable ${envName}` };
    return { ...base, state: "disconnected", entitlement: "unknown" };
  }

  return {
    providerId: ref.provider_id,
    method: "api-key",
    profile,
    notices: [API_KEY_BILLING_NOTICE],
    status: () => status(),
    async login(interaction, signal) {
      if (!interaction.interactive) {
        throw new HarnessError({
          code: "auth_required",
          message: `${LABELS[providerId]} entry needs an interactive terminal; set ${envName} for headless use`,
          workspace_effect: "none",
          retry_safe: true,
        });
      }
      interaction.notify(API_KEY_BILLING_NOTICE.text);
      const value = (await interaction.promptSecret(LABELS[providerId], signal)).trim();
      if (value === "" || /\s/.test(value)) {
        throw new HarnessError({ code: "usage_invalid", message: "the API key is empty or contains whitespace", workspace_effect: "none", retry_safe: true });
      }
      await store.set(ref, { method: "api-key", api_key: value, created_at: now().toISOString() });
      return status();
    },
    async logout() {
      await store.delete(ref);
    },
    async resolve() {
      const secret = (await store.get(ref)) ?? fromEnv();
      if (secret === undefined) {
        throw new ProviderFailure({
          code: "unauthenticated",
          message: `no ${LABELS[providerId]} for profile ${profile}; run \`syn login ${providerId} --method api-key\``,
          retryable: PROVIDER_ERROR_RETRYABLE.unauthenticated,
        });
      }
      return createResolvedCredential(ref, secret, apply);
    },
  };
}
