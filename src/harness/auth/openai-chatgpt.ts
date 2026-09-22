import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  credentialSecretSchema,
  HarnessError,
  PROVIDER_ERROR_RETRYABLE,
  ProviderFailure,
  providerIdSchema,
  type AuthInteraction,
  type AuthProvider,
  type AuthStatus,
  type CredentialRef,
  type CredentialSecret,
  type CredentialStore,
  type ProviderErrorCode,
  type ResolvedCredential,
} from "../contracts/index.ts";
import { claimString, decodeJwtClaims, maskEmail, openAiAuthClaims } from "./jwt.ts";
import { CHATGPT_SUBSCRIPTION_NOTICE } from "./notices.ts";
import type { ProfileStateStore } from "./profile-state.ts";
import { createResolvedCredential } from "./resolved-credential.ts";

/** Constants verified in research/provider-auth/openai-chatgpt-oauth.md §2–§6. */
export const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
export const CODEX_PUBLIC_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_LOOPBACK_PORT = 1455;
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CHATGPT_ORIGINATOR = "synorch";
/** Refresh when fewer than five minutes remain (Codex `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`). */
export const REFRESH_WINDOW_MS = 5 * 60_000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const BROWSER_TIMEOUT_MS = 10 * 60_000;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const PERMANENT_REFRESH_CODES = new Set(["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

export type AuthFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ChatGPTAuthOptions {
  readonly state: ProfileStateStore;
  readonly fetch?: AuthFetch;
  readonly now?: () => Date;
  readonly issuer?: string;
  readonly clientId?: string;
  /** Loopback port for the browser flow; tests pass 0 for an ephemeral port. */
  readonly loopbackPort?: number;
  /** `--device-code`: skip the browser flow. */
  readonly deviceCode?: boolean;
  readonly browserTimeoutMs?: number;
  readonly deviceTimeoutMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ChatGPTAuthProvider extends AuthProvider {
  /** Refreshes after the provider rejected a credential (HTTP 401), unless another process already did. */
  forceRefresh(signal: AbortSignal): Promise<ResolvedCredential>;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
  readonly expires_in?: unknown;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function failure(code: ProviderErrorCode, message: string, providerCode?: string): ProviderFailure {
  return new ProviderFailure({
    code,
    message,
    retryable: PROVIDER_ERROR_RETRYABLE[code],
    ...(providerCode === undefined ? {} : { provider_code: providerCode.slice(0, 200) }),
  });
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(failure("cancelled", "login aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") return body.error;
    if (typeof body.error === "object" && body.error !== null) {
      const error = body.error as { code?: unknown; type?: unknown };
      if (typeof error.code === "string") return error.code;
      if (typeof error.type === "string") return error.type;
    }
    return typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `openai` / `oauth-subscription`: Synorch's own "Sign in with ChatGPT" (PKCE loopback on
 * `localhost:1455`, device-code fallback), identifying honestly as `originator=synorch`. Tokens go
 * only to Synorch's credential store; the Codex CLI's own token file is never read or written.
 */
export function createChatGPTAuthProvider(store: CredentialStore, profile: string, options: ChatGPTAuthOptions): ChatGPTAuthProvider {
  const fetchImpl: AuthFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const issuer = (options.issuer ?? OPENAI_AUTH_ISSUER).replace(/\/+$/, "");
  const clientId = options.clientId ?? CODEX_PUBLIC_CLIENT_ID;
  const sleep = options.sleep ?? defaultSleep;
  const ref: CredentialRef = { provider_id: providerIdSchema.parse("openai"), method: "oauth-subscription", profile };
  let inflight: Promise<CredentialSecret> | undefined;
  let lastIssuedAccess: string | undefined;

  function secretFrom(tokens: TokenResponse, previous: CredentialSecret | undefined): CredentialSecret {
    const prior = previous?.method === "oauth-subscription" ? previous : undefined;
    const access = typeof tokens.access_token === "string" && tokens.access_token !== "" ? tokens.access_token : prior?.access_token;
    const refresh = typeof tokens.refresh_token === "string" && tokens.refresh_token !== "" ? tokens.refresh_token : prior?.refresh_token;
    const idToken = typeof tokens.id_token === "string" && tokens.id_token !== "" ? tokens.id_token : prior?.id_token;
    if (access === undefined || refresh === undefined) throw failure("protocol_mismatch", "token response is missing access or refresh token");
    const idClaims = openAiAuthClaims(decodeJwtClaims(idToken));
    const accessClaims = decodeJwtClaims(access);
    const issuedAt = now();
    let expiresAt: Date;
    if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) expiresAt = new Date(issuedAt.getTime() + tokens.expires_in * 1000);
    else if (typeof accessClaims?.exp === "number") expiresAt = new Date(accessClaims.exp * 1000);
    else expiresAt = new Date(issuedAt.getTime() + DEFAULT_TOKEN_LIFETIME_S * 1000);
    const accountId = claimString(idClaims, "chatgpt_account_id") ?? claimString(openAiAuthClaims(accessClaims), "chatgpt_account_id") ?? prior?.account_id;
    const planType = claimString(idClaims, "chatgpt_plan_type") ?? claimString(openAiAuthClaims(accessClaims), "chatgpt_plan_type") ?? prior?.plan_type;
    return credentialSecretSchema.parse({
      method: "oauth-subscription",
      access_token: access,
      refresh_token: refresh,
      ...(idToken === undefined ? {} : { id_token: idToken }),
      expires_at: expiresAt.toISOString(),
      ...(accountId === undefined ? {} : { account_id: accountId }),
      ...(planType === undefined ? {} : { plan_type: planType }),
      originator: CHATGPT_ORIGINATOR,
      obtained_at: prior?.obtained_at ?? issuedAt.toISOString(),
      ...(prior === undefined ? {} : { last_refresh_at: issuedAt.toISOString() }),
    });
  }

  async function exchangeCode(code: string, redirectUri: string, verifier: string, signal: AbortSignal): Promise<TokenResponse> {
    const response = await fetchImpl(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
      signal,
    });
    if (!response.ok) {
      const errorCode = await readErrorCode(response);
      if (errorCode === "missing_codex_entitlement") throw failure("entitlement_missing", "your ChatGPT plan does not include Codex", errorCode);
      throw failure("unauthenticated", `token exchange failed (HTTP ${response.status}${errorCode === undefined ? "" : `, ${errorCode}`})`, errorCode);
    }
    return (await response.json()) as TokenResponse;
  }

  async function browserLogin(interaction: AuthInteraction, signal: AbortSignal): Promise<TokenResponse | "port-busy"> {
    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(32));
    const server = createServer();
    const port = await listen(server, options.loopbackPort ?? CHATGPT_LOOPBACK_PORT);
    if (port === undefined) return "port-busy";
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const url = new URL(`${issuer}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: CHATGPT_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: CHATGPT_ORIGINATOR,
    })) {
      url.searchParams.set(key, value);
    }
    try {
      const code = new Promise<string>((resolve, reject) => {
        server.on("request", (request: IncomingMessage, response: ServerResponse) => {
          const target = new URL(request.url ?? "/", "http://localhost");
          if (target.pathname !== "/auth/callback") {
            respond(response, 404, "Not found.");
            return;
          }
          if (target.searchParams.get("state") !== state) {
            respond(response, 400, "Sign-in state did not match. Return to the terminal and try again.");
            return;
          }
          const error = target.searchParams.get("error");
          if (error !== null) {
            const description = target.searchParams.get("error_description") ?? "";
            const entitlement = `${error} ${description}`.includes("missing_codex_entitlement");
            respond(response, 400, entitlement ? "Your ChatGPT plan does not include Codex." : "Sign-in was not completed.");
            reject(
              entitlement
                ? failure("entitlement_missing", "your ChatGPT plan does not include Codex", "missing_codex_entitlement")
                : failure("unauthenticated", `sign-in failed: ${error}`, error),
            );
            return;
          }
          const value = target.searchParams.get("code");
          if (value === null || value === "") {
            respond(response, 400, "The sign-in response carried no code.");
            return;
          }
          respond(response, 200, "Signed in to Synorch. You can close this tab.");
          resolve(value);
        });
      });
      const opened = await interaction.openBrowser(url.toString());
      if (!opened) interaction.notify(`Open this URL in a browser to sign in:\n${url.toString()}`);
      const authorizationCode = await withDeadline(code, options.browserTimeoutMs ?? BROWSER_TIMEOUT_MS, signal, "browser sign-in");
      return await exchangeCode(authorizationCode, redirectUri, verifier, signal);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async function deviceLogin(interaction: AuthInteraction, signal: AbortSignal): Promise<TokenResponse> {
    const started = await fetchImpl(`${issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
      signal,
    });
    if (!started.ok) throw failure("unauthenticated", `device sign-in could not start (HTTP ${started.status})`);
    const grant = (await started.json()) as { device_auth_id?: unknown; user_code?: unknown; usercode?: unknown; interval?: unknown };
    const deviceAuthId = typeof grant.device_auth_id === "string" ? grant.device_auth_id : undefined;
    const userCode = typeof grant.user_code === "string" ? grant.user_code : typeof grant.usercode === "string" ? grant.usercode : undefined;
    if (deviceAuthId === undefined || userCode === undefined) throw failure("protocol_mismatch", "device sign-in response is incomplete");
    const intervalSeconds = Math.max(1, Number(grant.interval) || 5);
    const timeout = options.deviceTimeoutMs ?? DEVICE_TIMEOUT_MS;
    const deadline = now().getTime() + timeout;
    interaction.showDeviceCode({
      verificationUri: `${issuer}/codex/device`,
      userCode,
      expiresAt: new Date(deadline).toISOString(),
    });
    while (true) {
      if (signal.aborted) throw failure("cancelled", "login aborted");
      if (now().getTime() > deadline) throw failure("timeout", "device sign-in timed out");
      await sleep(intervalSeconds * 1000, signal);
      const polled = await fetchImpl(`${issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal,
      });
      if (polled.status === 403 || polled.status === 404) continue;
      if (!polled.ok) {
        const errorCode = await readErrorCode(polled);
        if (errorCode === "missing_codex_entitlement") throw failure("entitlement_missing", "your ChatGPT plan does not include Codex", errorCode);
        throw failure("unauthenticated", `device sign-in failed (HTTP ${polled.status})`, errorCode);
      }
      const approved = (await polled.json()) as { authorization_code?: unknown; code_verifier?: unknown };
      if (typeof approved.authorization_code !== "string" || typeof approved.code_verifier !== "string") {
        throw failure("protocol_mismatch", "device sign-in approval is incomplete");
      }
      return exchangeCode(approved.authorization_code, `${issuer}/deviceauth/callback`, approved.code_verifier, signal);
    }
  }

  async function refreshTokens(current: CredentialSecret, signal: AbortSignal): Promise<CredentialSecret> {
    if (current.method !== "oauth-subscription") throw failure("invalid_request", "profile does not hold an OAuth secret");
    let response: Response;
    try {
      response = await fetchImpl(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, refresh_token: current.refresh_token }),
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) throw failure("cancelled", "refresh aborted");
      throw failure("provider_internal", `token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const errorCode = await readErrorCode(response);
      const permanent = response.status === 401 || (errorCode !== undefined && PERMANENT_REFRESH_CODES.has(errorCode));
      if (permanent) {
        await options.state.markLoginRequired(ref, errorCode ?? `HTTP ${response.status}`, now());
        throw failure("auth_expired", "the ChatGPT sign-in expired; run `syn login openai`", errorCode);
      }
      throw failure(response.status >= 500 ? "provider_internal" : "unauthenticated", `token refresh failed (HTTP ${response.status})`, errorCode);
    }
    const next = secretFrom((await response.json()) as TokenResponse, current);
    await store.set(ref, next);
    return next;
  }

  function needsRefresh(secret: CredentialSecret): boolean {
    return secret.method === "oauth-subscription" && Date.parse(secret.expires_at) - now().getTime() < REFRESH_WINDOW_MS;
  }

  async function current(): Promise<CredentialSecret> {
    const marker = await options.state.loginRequired(ref);
    if (marker !== undefined) throw failure("auth_expired", "the ChatGPT sign-in expired; run `syn login openai`", marker.reason);
    const secret = await store.get(ref);
    if (secret === undefined) throw failure("unauthenticated", "not signed in to ChatGPT; run `syn login openai`");
    return secret;
  }

  function singleFlight(task: () => Promise<CredentialSecret>): Promise<CredentialSecret> {
    if (inflight !== undefined) return inflight;
    const running = task().finally(() => {
      if (inflight === running) inflight = undefined;
    });
    inflight = running;
    return running;
  }

  function issue(secret: CredentialSecret): ResolvedCredential {
    if (secret.method === "oauth-subscription") lastIssuedAccess = secret.access_token;
    return createResolvedCredential(ref, secret, (headers, value) => {
      if (value.method !== "oauth-subscription") return;
      headers.set("authorization", `Bearer ${value.access_token}`);
      if (value.account_id !== undefined) headers.set("chatgpt-account-id", value.account_id);
    });
  }

  async function status(): Promise<AuthStatus> {
    const base = {
      provider_id: ref.provider_id,
      method: ref.method,
      profile,
      billing: "subscription" as const,
      store_backend: store.backend,
    };
    const marker = await options.state.loginRequired(ref);
    let secret: CredentialSecret | undefined;
    try {
      secret = await store.get(ref);
    } catch {
      return { ...base, state: "error", entitlement: "unknown", detail: "stored credential is unreadable" };
    }
    if (secret === undefined || secret.method !== "oauth-subscription") return { ...base, state: "disconnected", entitlement: "unknown" };
    const email = maskEmail(claimString(decodeJwtClaims(secret.id_token), "email"));
    const labels = {
      ...(email === undefined ? {} : { account_label: email }),
      ...(secret.plan_type === undefined ? {} : { plan_label: secret.plan_type.slice(0, 100) }),
      expires_at: secret.expires_at,
      entitlement: secret.plan_type === undefined ? ("unknown" as const) : ("verified" as const),
    };
    if (marker !== undefined) return { ...base, ...labels, state: "login_required", detail: `refresh failed permanently (${marker.reason})` };
    const expired = Date.parse(secret.expires_at) <= now().getTime();
    return { ...base, ...labels, state: expired ? "expired" : "connected", ...(expired ? { detail: "access token expired; it is refreshed on next use" } : {}) };
  }

  return {
    providerId: ref.provider_id,
    method: "oauth-subscription",
    profile,
    notices: [CHATGPT_SUBSCRIPTION_NOTICE],
    status: () => status(),
    async login(interaction, signal) {
      if (!interaction.interactive) {
        throw new HarnessError({
          code: "auth_required",
          message: "ChatGPT sign-in needs an interactive terminal",
          workspace_effect: "none",
          retry_safe: true,
          next_command: "syn login openai --device-code",
        });
      }
      if (!(await options.state.isAcknowledged(CHATGPT_SUBSCRIPTION_NOTICE.id, ref))) {
        const accepted = await interaction.acknowledge(CHATGPT_SUBSCRIPTION_NOTICE, signal);
        if (!accepted) {
          throw new HarnessError({ code: "auth_required", message: "the ChatGPT subscription notice was not accepted", workspace_effect: "none", retry_safe: true });
        }
        await options.state.acknowledge(CHATGPT_SUBSCRIPTION_NOTICE.id, ref, now());
      }
      let tokens: TokenResponse | "port-busy" = "port-busy";
      if (options.deviceCode !== true) tokens = await browserLogin(interaction, signal);
      if (tokens === "port-busy") {
        if (options.deviceCode !== true) interaction.notify(`Port ${options.loopbackPort ?? CHATGPT_LOOPBACK_PORT} is busy; using device-code sign-in.`);
        tokens = await deviceLogin(interaction, signal);
      }
      await store.set(ref, secretFrom(tokens, undefined));
      await options.state.clearLoginRequired(ref);
      return status();
    },
    async logout() {
      await store.delete(ref);
      await options.state.clearLoginRequired(ref);
    },
    async resolve(signal) {
      const secret = await current();
      if (!needsRefresh(secret)) return issue(secret);
      const refreshed = await singleFlight(() =>
        store.withRefreshLock(
          ref,
          async () => {
            const latest = await current();
            return needsRefresh(latest) ? refreshTokens(latest, signal) : latest;
          },
          signal,
        ),
      );
      return issue(refreshed);
    },
    async forceRefresh(signal) {
      const refreshed = await singleFlight(() =>
        store.withRefreshLock(
          ref,
          async () => {
            const latest = await current();
            if (latest.method === "oauth-subscription" && latest.access_token !== lastIssuedAccess) return latest;
            return refreshTokens(latest, signal);
          },
          signal,
        ),
      );
      return issue(refreshed);
    },
  };
}

async function listen(server: Server, port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(undefined);
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function respond(response: ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Synorch</title></head><body><p>${message}</p></body></html>`;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure("timeout", `${what} timed out`)), timeoutMs);
        onAbort = () => reject(failure("cancelled", `${what} aborted`));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
