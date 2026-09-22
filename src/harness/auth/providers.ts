import {
  credentialRefSchema,
  type AuthMethodKind,
  type AuthProvider,
  type CredentialRef,
  type CredentialStore,
} from "../contracts/index.ts";
import { createApiKeyAuthProvider } from "./api-key.ts";
import { createClaudeBridgeAuthProvider, type ClaudeCliProbe } from "./claude-bridge.ts";
import { createChatGPTAuthProvider, type AuthFetch } from "./openai-chatgpt.ts";
import { ProfileStateStore } from "./profile-state.ts";

export interface AuthProvidersOptions {
  /** Non-secret auth state (login_required markers, notice acknowledgements). Defaults to the store's home. */
  readonly state?: ProfileStateStore;
  readonly fetch?: AuthFetch;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loopbackPort?: number;
  readonly deviceCode?: boolean;
  readonly claudeProbe?: ClaudeCliProbe;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Extra profiles to expose besides `default`. */
  readonly profiles?: readonly string[];
}

/** The (provider, method) pairs Synorch supports in v1 (ADR-05). */
export const SUPPORTED_AUTH_METHODS: readonly { readonly provider: "openai" | "anthropic"; readonly method: AuthMethodKind }[] = [
  { provider: "openai", method: "oauth-subscription" },
  { provider: "openai", method: "api-key" },
  { provider: "anthropic", method: "api-key" },
  { provider: "anthropic", method: "cli-bridge" },
];

function stateFor(store: CredentialStore, options: AuthProvidersOptions): ProfileStateStore {
  if (options.state !== undefined) return options.state;
  const home = (store as Partial<{ home: string | undefined }>).home;
  return new ProfileStateStore(home);
}

/** Builds the auth provider for one identity; `undefined` for an unsupported (provider, method) pair. */
export function authProviderFor(store: CredentialStore, ref: CredentialRef, options: AuthProvidersOptions = {}): AuthProvider | undefined {
  const parsed = credentialRefSchema.parse(ref);
  const state = stateFor(store, options);
  const common = {
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  if (parsed.provider_id === "openai" && parsed.method === "oauth-subscription") {
    return createChatGPTAuthProvider(store, parsed.profile, {
      state,
      ...common,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.loopbackPort === undefined ? {} : { loopbackPort: options.loopbackPort }),
      ...(options.deviceCode === undefined ? {} : { deviceCode: options.deviceCode }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }
  const providerId: string = parsed.provider_id;
  if ((providerId === "openai" || providerId === "anthropic") && parsed.method === "api-key") {
    return createApiKeyAuthProvider(store, providerId, parsed.profile, {
      ...common,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }
  if (parsed.provider_id === "anthropic" && parsed.method === "cli-bridge") {
    return createClaudeBridgeAuthProvider(parsed.profile, {
      state,
      ...common,
      ...(options.claudeProbe === undefined ? {} : { probe: options.claudeProbe }),
    });
  }
  return undefined;
}

/** Every supported identity for the `default` profile (and any extra configured profiles). */
export function createAuthProviders(store: CredentialStore, options: AuthProvidersOptions = {}): readonly AuthProvider[] {
  const state = stateFor(store, options);
  const profiles = [...new Set(["default", ...(options.profiles ?? [])])];
  const providers: AuthProvider[] = [];
  for (const profile of profiles) {
    for (const { provider, method } of SUPPORTED_AUTH_METHODS) {
      const created = authProviderFor(store, credentialRefSchema.parse({ provider_id: provider, method, profile }), { ...options, state });
      if (created !== undefined) providers.push(created);
    }
  }
  return providers;
}
