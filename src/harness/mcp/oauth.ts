import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { providerIdSchema, type CredentialRef, type CredentialStore } from "../contracts/index.ts";
import type { McpServerDefinition } from "./config.ts";

/**
 * MCP OAuth for remote servers that ask for sign-in (HTTP 401): the official SDK's client auth
 * (`OAuthClientProvider`: discovery, dynamic client registration, PKCE, refresh) with Synorch's
 * own state. Tokens, the registered client and the PKCE verifier live in Synorch's credential store
 * (OS keychain / DPAPI, else the 0600 file), one entry per server, bound to the server's URL. No
 * other application's token store is ever read: a server that also runs in Claude Code signs in
 * here separately.
 */

export interface McpOAuthRecord {
  readonly url: string;
  readonly redirectUrl?: string;
  readonly client?: OAuthClientInformationMixed;
  readonly tokens?: OAuthTokens;
  readonly verifier?: string;
  readonly obtainedAt?: string;
}

export interface McpOAuthStore {
  read(server: string, url: string): Promise<McpOAuthRecord | undefined>;
  write(server: string, record: McpOAuthRecord): Promise<void>;
  remove(server: string): Promise<boolean>;
}

/** Credential-store entry of a server: `mcp-<name>` / api-key / `oauth` (the value is the JSON record). */
export function mcpOAuthRef(server: string): CredentialRef {
  const kebab = server.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
  return { provider_id: providerIdSchema.parse(`mcp-${kebab}`.slice(0, 64).replace(/-+$/, "")), method: "api-key", profile: "oauth" };
}

export function createMcpOAuthStore(store: () => CredentialStore): McpOAuthStore {
  return {
    async read(server, url) {
      const secret = await store().get(mcpOAuthRef(server));
      if (secret?.method !== "api-key") return undefined;
      try {
        const record = JSON.parse(secret.api_key) as McpOAuthRecord;
        return typeof record === "object" && record !== null && record.url === url ? record : undefined;
      } catch {
        return undefined;
      }
    },
    async write(server, record) {
      await store().set(mcpOAuthRef(server), { method: "api-key", api_key: JSON.stringify(record), created_at: new Date().toISOString() });
    },
    async remove(server) {
      return store().delete(mcpOAuthRef(server));
    },
  };
}

/** The server asked for sign-in and no usable token exists (startup never opens a browser). */
export class McpSignInRequiredError extends Error {
  public constructor(server: string) {
    super(`${server} needs sign-in`);
    this.name = "McpSignInRequiredError";
  }
}

const REDIRECT_PATH = "/callback";

class StoredOAuthProvider implements OAuthClientProvider {
  private record: McpOAuthRecord;
  private readonly server: string;
  private readonly store: McpOAuthStore;
  private readonly interactive: { readonly redirectUrl: string; readonly state: string; readonly open: (url: URL) => Promise<void> } | undefined;

  public constructor(server: string, store: McpOAuthStore, record: McpOAuthRecord, interactive: StoredOAuthProvider["interactive"]) {
    this.server = server;
    this.store = store;
    this.record = record;
    this.interactive = interactive;
  }

  public get redirectUrl(): string {
    return this.interactive?.redirectUrl ?? this.record.redirectUrl ?? `http://localhost${REDIRECT_PATH}`;
  }

  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Synorch",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  public state(): string {
    return this.interactive?.state ?? randomBytes(16).toString("hex");
  }

  public clientInformation(): OAuthClientInformationMixed | undefined {
    return this.record.client;
  }

  public async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.save({ ...this.record, client, redirectUrl: this.redirectUrl });
  }

  public tokens(): OAuthTokens | undefined {
    return this.record.tokens;
  }

  public async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.save({ ...this.record, tokens, obtainedAt: new Date().toISOString() });
  }

  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.interactive === undefined) throw new McpSignInRequiredError(this.server);
    await this.interactive.open(authorizationUrl);
  }

  public async saveCodeVerifier(verifier: string): Promise<void> {
    await this.save({ ...this.record, verifier });
  }

  public codeVerifier(): string {
    if (this.record.verifier === undefined) throw new Error("no PKCE verifier saved for this sign-in");
    return this.record.verifier;
  }

  public async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const { client, tokens, verifier, ...rest } = this.record;
    const keep: McpOAuthRecord = {
      ...rest,
      ...(scope === "all" || scope === "client" || client === undefined ? {} : { client }),
      ...(scope === "all" || scope === "tokens" || tokens === undefined ? {} : { tokens }),
      ...(scope === "all" || scope === "verifier" || verifier === undefined ? {} : { verifier }),
    };
    await this.save(keep);
  }

  private async save(record: McpOAuthRecord): Promise<void> {
    this.record = record;
    await this.store.write(this.server, record);
  }
}

/** Is this server configured with its own credentials (an API key header)? Then OAuth stays out. */
export function hasConfiguredCredentials(definition: McpServerDefinition): boolean {
  return Object.keys(definition.headers).some((name) => /^(authorization|x-api-key|api-key)$/i.test(name) || /api[-_]?key|token/i.test(name));
}

/**
 * The provider a session connection uses: only when a sign-in stored tokens for this URL (refresh
 * happens inside the SDK). Without tokens the server's 401 surfaces as "needs sign-in".
 */
export async function sessionAuthProvider(definition: McpServerDefinition, store: McpOAuthStore | undefined): Promise<OAuthClientProvider | undefined> {
  if (store === undefined || definition.transport === "stdio" || definition.url === undefined || hasConfiguredCredentials(definition)) return undefined;
  const record = await store.read(definition.name, definition.url).catch(() => undefined);
  if (record?.tokens === undefined) return undefined;
  return new StoredOAuthProvider(definition.name, store, record, undefined);
}

export interface McpLoginDependencies {
  readonly store: McpOAuthStore;
  /** Opens the system browser; false when it could not (the URL is shown either way). */
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly notify: (line: string) => void;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * `/mcp login <server>`: discovery, dynamic client registration and PKCE through the SDK's `auth()`,
 * the browser for consent and a one-shot loopback callback (`http://localhost:<port>/callback`).
 * Earlier tokens are dropped first; the registered client is kept while the redirect URL matches.
 */
export async function loginMcpServer(definition: McpServerDefinition, deps: McpLoginDependencies): Promise<void> {
  if (definition.transport === "stdio" || definition.url === undefined) throw new Error(`${definition.name} is a local (stdio) server; sign-in applies to remote servers`);
  const url = definition.url;
  const previous = await deps.store.read(definition.name, url).catch(() => undefined);
  const preferredPort = portOf(previous?.redirectUrl);
  const callback = await startCallbackServer(preferredPort);
  try {
    const redirectUrl = `http://localhost:${callback.port}${REDIRECT_PATH}`;
    const state = randomBytes(16).toString("hex");
    const base: McpOAuthRecord = { url, redirectUrl, ...(previous?.client !== undefined && previous.redirectUrl === redirectUrl ? { client: previous.client } : {}) };
    await deps.store.write(definition.name, base);
    const provider = new StoredOAuthProvider(definition.name, deps.store, base, {
      redirectUrl,
      state,
      open: async (authorizationUrl) => {
        const opened = await deps.openBrowser(authorizationUrl.href).catch(() => false);
        deps.notify(opened ? `Opened the browser to sign in to ${definition.name}; waiting for you to finish there` : `Open this address to sign in to ${definition.name}:`);
        deps.notify(authorizationUrl.href);
      },
    });
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    const first = await auth(provider, { serverUrl: url });
    if (first === "AUTHORIZED") return;
    const code = await callback.waitForCode(state, deps.timeoutMs ?? LOGIN_TIMEOUT_MS, deps.signal);
    const second = await auth(provider, { serverUrl: url, authorizationCode: code });
    if (second !== "AUTHORIZED") throw new Error("the server did not accept the sign-in");
  } finally {
    callback.close();
  }
}

function portOf(redirectUrl: string | undefined): number {
  if (redirectUrl === undefined) return 0;
  try {
    const port = Number(new URL(redirectUrl).port);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
}

interface CallbackServer {
  readonly port: number;
  waitForCode(state: string, timeoutMs: number, signal: AbortSignal): Promise<string>;
  close(): void;
}

const DONE_PAGE = "<!doctype html><meta charset=utf-8><title>Synorch</title><body style=\"font-family:system-ui;padding:2rem\"><h2>Signed in</h2><p>You can close this tab and return to Synorch.</p>";
const FAILED_PAGE = "<!doctype html><meta charset=utf-8><title>Synorch</title><body style=\"font-family:system-ui;padding:2rem\"><h2>Sign-in did not complete</h2><p>Return to Synorch for details.</p>";

async function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function startCallbackServer(preferredPort: number): Promise<CallbackServer> {
  let deliver: ((params: URLSearchParams) => void) | undefined;
  const pending: URLSearchParams[] = [];
  const server = createServer((request, response) => {
    const target = new URL(request.url ?? "/", "http://localhost");
    if (target.pathname !== REDIRECT_PATH) {
      response.writeHead(404).end();
      return;
    }
    const ok = target.searchParams.has("code");
    response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" }).end(ok ? DONE_PAGE : FAILED_PAGE);
    if (deliver === undefined) pending.push(target.searchParams);
    else deliver(target.searchParams);
  });
  let port: number;
  try {
    port = await listen(server, preferredPort);
  } catch {
    port = await listen(server, 0);
  }
  return {
    port,
    waitForCode(state, timeoutMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`no sign-in within ${Math.round(timeoutMs / 60_000)} min`)), timeoutMs);
        const onAbort = (): void => finish(new Error("sign-in cancelled"));
        const finish = (result: Error | string): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          deliver = undefined;
          if (typeof result === "string") resolve(result);
          else reject(result);
        };
        if (signal.aborted) return finish(new Error("sign-in cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        const take = (params: URLSearchParams): void => {
          const error = params.get("error");
          if (error !== null) return finish(new Error(`the server refused the sign-in: ${params.get("error_description") ?? error}`.slice(0, 200)));
          if (params.get("state") !== state) return finish(new Error("the sign-in answer did not match this request (state mismatch)"));
          const code = params.get("code");
          if (code === null || code === "") return finish(new Error("the sign-in answer carried no code"));
          finish(code);
        };
        deliver = take;
        const early = pending.shift();
        if (early !== undefined) take(early);
      });
    },
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
