/**
 * Reads JWT claims without verifying the signature. Only used to learn display metadata (account
 * id, plan, expiry) from tokens the issuer just handed to us over TLS; never for authorization.
 */
export function decodeJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The OpenAI auth namespace claims (`chatgpt_account_id`, `chatgpt_plan_type`, …). */
export function openAiAuthClaims(claims: Record<string, unknown> | undefined): Record<string, unknown> {
  const namespace = claims?.["https://api.openai.com/auth"];
  return typeof namespace === "object" && namespace !== null ? (namespace as Record<string, unknown>) : {};
}

export function claimString(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = claims?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `t***@example.com`: enough to recognize the account, not enough to leak the address. */
export function maskEmail(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const at = email.indexOf("@");
  if (at <= 0) return undefined;
  return `${email[0]}***${email.slice(at)}`.slice(0, 200);
}
