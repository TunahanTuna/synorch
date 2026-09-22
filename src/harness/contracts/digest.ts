import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Runtime digests are always the full `sha256:<64 hex>`. The shortened prefixes the static
 * observation ledger tolerates are not accepted here: a runtime digest proves freshness and
 * binds approvals, so it is never truncated.
 */
export const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex>")
  .brand<"Digest">();
export type Digest = z.infer<typeof digestSchema>;

export function sha256(data: string | Uint8Array): Digest {
  return digestSchema.parse(`sha256:${createHash("sha256").update(data).digest("hex")}`);
}

/** Text sources are digested with line endings normalized to `\n`, matching the static ledger. */
export function digestText(text: string): Digest {
  return sha256(text.replace(/\r\n?/g, "\n"));
}

/**
 * Deterministic JSON: object keys sorted by code point, `undefined` members dropped, arrays kept
 * in order. Non-finite numbers, bigints, functions and symbols are rejected rather than silently
 * coerced, because a digest over a lossy encoding would bind two different values.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, []);
}

/** The digest every plan, packet, action and envelope is bound by. */
export function digestOf(value: unknown): Digest {
  return sha256(canonicalJson(value));
}

function encode(value: unknown, trail: readonly string[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${where(trail)}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize ${typeof value} at ${where(trail)}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encode(item === undefined ? null : item, [...trail, String(index)])).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${encode(member, [...trail, key])}`).join(",")}}`;
}

function where(trail: readonly string[]): string {
  return trail.length === 0 ? "<root>" : trail.join(".");
}
