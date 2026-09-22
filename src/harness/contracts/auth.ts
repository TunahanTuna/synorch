import { z } from "zod";
import { timestampSchema } from "./common.ts";
import { providerIdSchema, type ProviderId } from "./ids.ts";

/**
 * Authentication is split from model access. An `AuthProvider` owns one (provider, method,
 * profile) identity; a `CredentialStore` persists secrets for the identities Synorch owns. A
 * `cli-bridge` identity is owned by the user's own installed client (Claude Code, Codex): Synorch
 * never sees, stores or copies its tokens, so no secret schema exists for it.
 */

export const AUTH_METHODS = ["oauth-subscription", "cli-bridge", "api-key"] as const;
export const authMethodSchema = z.enum(AUTH_METHODS);
export type AuthMethodKind = (typeof AUTH_METHODS)[number];

export const AUTH_STATES = [
  "connected",
  "expired",
  "login_required",
  "disconnected",
  "unknown",
  "error",
] as const;

/**
 * Where secrets are kept, reported truthfully: `os-keychain` is a real OS credential store (macOS
 * Keychain, Secret Service); `os-dpapi` is a file holding only ciphertext encrypted with Windows
 * DPAPI for the current user; `file-0600` is plain text protected by file mode only.
 */
export const CREDENTIAL_STORE_BACKENDS = ["os-keychain", "os-dpapi", "file-0600", "memory"] as const;
export type CredentialStoreBackend = (typeof CREDENTIAL_STORE_BACKENDS)[number];

export const profileNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "profile must be kebab-case");

export const credentialRefSchema = z.strictObject({
  provider_id: providerIdSchema,
  method: authMethodSchema,
  profile: profileNameSchema,
});
export type CredentialRef = z.infer<typeof credentialRefSchema>;

/** Keychain service name; the account key is `<provider>:<method>:<profile>`. */
export const CREDENTIAL_SERVICE_NAME = "synorch";

export function credentialAccountKey(ref: CredentialRef): string {
  return `${ref.provider_id}:${ref.method}:${ref.profile}`;
}

/** What `syn auth status` and `doctor --runtime` show. Never carries a secret. */
export const authStatusSchema = z.strictObject({
  provider_id: providerIdSchema,
  method: authMethodSchema,
  profile: profileNameSchema,
  state: z.enum(AUTH_STATES),
  account_label: z.string().max(200).optional(),
  plan_label: z.string().max(100).optional(),
  entitlement: z.enum(["verified", "unverified", "unknown"]),
  billing: z.enum(["subscription", "metered", "unknown"]),
  expires_at: timestampSchema.optional(),
  store_backend: z.enum(CREDENTIAL_STORE_BACKENDS).optional(),
  detail: z.string().max(500).optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

const oauthSubscriptionSecretSchema = z.strictObject({
  method: z.literal("oauth-subscription"),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  expires_at: timestampSchema,
  account_id: z.string().min(1).optional(),
  plan_type: z.string().min(1).optional(),
  originator: z.literal("synorch"),
  obtained_at: timestampSchema,
  last_refresh_at: timestampSchema.optional(),
});

const apiKeySecretSchema = z.strictObject({
  method: z.literal("api-key"),
  api_key: z.string().min(1),
  created_at: timestampSchema,
});

/** Stored secret shapes. `cli-bridge` is deliberately absent: its credentials are never ours. */
export const credentialSecretSchema = z.discriminatedUnion("method", [
  oauthSubscriptionSecretSchema,
  apiKeySecretSchema,
]);
export type CredentialSecret = z.infer<typeof credentialSecretSchema>;

/** File fallback layout: `~/.synorch/credentials.json`, mode 0600, directory 0700. */
export const credentialFileSchema = z.strictObject({
  schema_version: z.literal(1),
  profiles: z.record(z.string().min(1), z.strictObject({ ref: credentialRefSchema, secret: credentialSecretSchema })),
});
export type CredentialFile = z.infer<typeof credentialFileSchema>;

/**
 * Other applications' credential stores. Reading, copying or writing any of them is a hard
 * non-goal (ADR-05): Synorch performs its own login or drives the official client, never both.
 */
export const FORBIDDEN_CREDENTIAL_SOURCES = [
  "~/.claude/.credentials.json",
  "~/.claude.json",
  "~/.codex/auth.json",
  "keychain:Claude Code-credentials",
] as const;

/** Removed from a bridge child's environment so a subscription bridge never bills an API key silently. */
export const BRIDGE_STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

export const AUTH_NOTICE_IDS = [
  "chatgpt-subscription",
  "claude-bridge-experimental",
  "api-key-billing",
  "plaintext-credential-file",
] as const;

export interface AuthNotice {
  readonly id: (typeof AUTH_NOTICE_IDS)[number];
  readonly text: string;
  /** When true the login does not proceed until the user acknowledges it once per profile. */
  readonly requiresAcknowledgement: boolean;
}

export interface DeviceCodePrompt {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly expiresAt: string;
}

/** The only channel an auth flow may use to reach the user; the TUI and plain renderers implement it. */
export interface AuthInteraction {
  readonly interactive: boolean;
  openBrowser(url: string): Promise<boolean>;
  showDeviceCode(prompt: DeviceCodePrompt): void;
  promptSecret(label: string, signal: AbortSignal): Promise<string>;
  acknowledge(notice: AuthNotice, signal: AbortSignal): Promise<boolean>;
  notify(message: string): void;
}

/**
 * A usable credential for one request. The secret stays inside the implementation: it can be
 * applied to outgoing headers and reported to the redactor, but never serialized.
 */
export interface ResolvedCredential {
  readonly providerId: ProviderId;
  readonly method: Exclude<AuthMethodKind, "cli-bridge">;
  readonly profile: string;
  readonly expiresAt: string | undefined;
  applyTo(headers: Headers): void;
  redactionValues(): readonly string[];
  toJSON(): "[redacted]";
}

export interface ResolveOptions {
  /**
   * The provider rejected a credential that still looked valid locally (HTTP 401): refresh under the
   * profile's refresh lock unless another process already rotated it since this process last
   * issued it. Only `oauth-subscription` providers can refresh; other methods resolve as usual, so
   * callers retry a rejected request only for that method.
   */
  readonly forceRefresh?: boolean;
}

export interface AuthProvider {
  readonly providerId: ProviderId;
  readonly method: AuthMethodKind;
  readonly profile: string;
  readonly notices: readonly AuthNotice[];
  status(signal: AbortSignal): Promise<AuthStatus>;
  login(interaction: AuthInteraction, signal: AbortSignal): Promise<AuthStatus>;
  logout(signal: AbortSignal): Promise<void>;
  /**
   * Returns a fresh credential, refreshing under the store's per-profile refresh lock when needed.
   * Throws `ProviderFailure` with `auth_expired` / `unauthenticated`; never falls back to another
   * method or profile. A `cli-bridge` provider rejects with `invalid_request`: bridges resolve
   * their own credentials inside the user's client.
   */
  resolve(signal: AbortSignal, options?: ResolveOptions): Promise<ResolvedCredential>;
}

export interface CredentialStore {
  readonly backend: CredentialStoreBackend;
  get(ref: CredentialRef): Promise<CredentialSecret | undefined>;
  set(ref: CredentialRef, secret: CredentialSecret): Promise<void>;
  delete(ref: CredentialRef): Promise<boolean>;
  list(): Promise<readonly CredentialRef[]>;
  /**
   * Runs `refresh` while holding a cross-process lock for this profile. The old secret is kept
   * until the new one is durably written; a permanent refresh failure moves the profile to
   * `login_required` instead of deleting it.
   */
  withRefreshLock<T>(ref: CredentialRef, refresh: () => Promise<T>, signal: AbortSignal): Promise<T>;
}
