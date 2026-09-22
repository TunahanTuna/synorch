import { inspect } from "node:util";
import type { CredentialRef, CredentialSecret, ProviderId, ResolvedCredential } from "../contracts/index.ts";

export const REDACTED = "[redacted]" as const;

/**
 * Wraps a stored secret so it can only be applied to outgoing headers or handed to the redactor.
 * JSON, `util.inspect`, string coercion and enumeration all show `[redacted]`; the secret lives in
 * a closure, not on the object.
 */
export function createResolvedCredential(
  ref: CredentialRef,
  secret: CredentialSecret,
  apply: (headers: Headers, secret: CredentialSecret) => void,
): ResolvedCredential {
  const values = secretValues(secret);
  const credential: ResolvedCredential = {
    providerId: ref.provider_id as ProviderId,
    method: secret.method,
    profile: ref.profile,
    expiresAt: secret.method === "oauth-subscription" ? secret.expires_at : undefined,
    applyTo(headers) {
      apply(headers, secret);
    },
    redactionValues() {
      return values;
    },
    toJSON() {
      return REDACTED;
    },
  };
  Object.defineProperty(credential, inspect.custom, { value: () => REDACTED, enumerable: false });
  Object.defineProperty(credential, "toString", { value: () => REDACTED, enumerable: false });
  return Object.freeze(credential);
}

/** Every secret string a redactor must mask for this credential. */
export function secretValues(secret: CredentialSecret): readonly string[] {
  if (secret.method === "api-key") return [secret.api_key];
  return [secret.access_token, secret.refresh_token, ...(secret.id_token === undefined ? [] : [secret.id_token])];
}
