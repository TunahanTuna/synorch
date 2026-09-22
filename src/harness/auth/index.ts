/** I2 — AuthProvider implementations, credential store, `syn login/logout/auth status`. */
export type { AuthProvider, CredentialStore } from "../contracts/index.ts";
export { API_KEY_ENV, createApiKeyAuthProvider, type ApiKeyAuthOptions, type ApiKeyProviderId } from "./api-key.ts";
export {
  createClaudeBridgeAuthProvider,
  defaultClaudeProbe,
  type ClaudeBridgeAuthOptions,
  type ClaudeCliProbe,
  type ClaudeCliProbeResult,
} from "./claude-bridge.ts";
export { authCommand, createAuthCommand, resolveSynorchHome, type AuthCommandDependencies } from "./command.ts";
export {
  createCredentialStore,
  createMemoryCredentialStore,
  CREDENTIAL_FILE_NAME,
  type CredentialStoreOptions,
  type SynorchCredentialStore,
} from "./credential-store.ts";
export type { CommandResult, CommandRunner, SyncCommandRunner } from "./keychain.ts";
export {
  API_KEY_BILLING_NOTICE,
  CHATGPT_SUBSCRIPTION_NOTICE,
  CLAUDE_BRIDGE_NOTICE,
  plaintextCredentialNotice,
} from "./notices.ts";
export {
  CHATGPT_LOOPBACK_PORT,
  CHATGPT_ORIGINATOR,
  CODEX_PUBLIC_CLIENT_ID,
  createChatGPTAuthProvider,
  OPENAI_AUTH_ISSUER,
  type AuthFetch,
  type ChatGPTAuthOptions,
} from "./openai-chatgpt.ts";
export { ProfileStateStore } from "./profile-state.ts";
export { authProviderFor, createAuthProviders, SUPPORTED_AUTH_METHODS, type AuthProvidersOptions } from "./providers.ts";
export { createResolvedCredential, REDACTED } from "./resolved-credential.ts";
