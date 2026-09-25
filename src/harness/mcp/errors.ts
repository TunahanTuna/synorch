/**
 * MCP start failures in words a person reads at a glance. The raw error (protocol text, JSON-RPC
 * bodies, stderr) goes to the server's log and the `/mcp` detail view, never to the first screen.
 */

export type McpFailureKind = "needs-auth" | "failed";

export class McpStartError extends Error {
  public readonly kind: McpFailureKind;
  /** Short, human text: "command not found (npx)", "needs sign-in". */
  public readonly friendly: string;
  /** Everything known (raw message, status, stderr tail), for `/mcp <name>` and the log. */
  public readonly detail: string;

  public constructor(server: string, kind: McpFailureKind, friendly: string, detail: string) {
    super(`${server}: ${friendly}`);
    this.name = "McpStartError";
    this.kind = kind;
    this.friendly = friendly;
    this.detail = detail;
  }
}

const AUTH_PATTERN = /\b401\b|unauthori[sz]ed|authentication required|not authenticated|invalid[_ ]token|missing (?:bearer|access) token|sign[- ]?in required|login required|McpSignInRequiredError|needs sign-in/i;

/** True when a start failure means "the server wants credentials" rather than "it is broken". */
export function isAuthFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === 401) return true;
    const name = (error as { name?: unknown }).name;
    if (name === "UnauthorizedError" || name === "McpSignInRequiredError") return true;
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return AUTH_PATTERN.test(text);
}

/** One short reason for a failure that is not about sign-in. */
export function friendlyFailure(error: unknown, context: { readonly timedOut: boolean; readonly timeoutMs: number; readonly command?: string | undefined; readonly url?: string | undefined; readonly configuredCredentials: boolean }): string {
  if (context.timedOut) return `did not start within ${Math.round(context.timeoutMs / 1000)} s`;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const text = error instanceof Error ? error.message : String(error);
  const host = hostOf(context.url);
  if (code === "ENOENT" || /\bENOENT\b|not recognized as an internal or external command|command not found/i.test(text)) return `command not found${context.command === undefined ? "" : ` (${context.command})`}`;
  if (code === 401 || isAuthFailure(error)) return context.configuredCredentials ? "rejected the configured credentials" : "needs sign-in";
  if (code === 403 || /\b403\b|forbidden/i.test(text)) return "access denied (403)";
  if (code === 404 || /\b404\b|not found/i.test(text)) return `endpoint not found${host === undefined ? "" : ` at ${host}`} (404)`;
  if (typeof code === "number" && code >= 500) return `the server had an error (${code})`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(text)) return `could not reach ${host ?? "the server"}`;
  if (/connection closed|closed the connection|exited|EPIPE/i.test(text)) return "the server exited while starting";
  const first = text.split(/\r?\n/)[0]?.replace(/\{.*$/, "").replace(/:\s*$/, "").trim() ?? "";
  return first === "" ? "could not start" : first.length > 70 ? `${first.slice(0, 67)}...` : first;
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
