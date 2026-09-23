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

/**
 * Text digested with line endings normalized to `\n`, matching the static observation ledger and
 * memory `source_digest`. It is **not** a workspace file digest (ADR-19): it decodes as UTF-8 and
 * folds CRLF, so it cannot prove the bytes a tool is about to overwrite. Packets written before
 * ADR-19 (`context.digest_scheme` absent or `text-lf-v1`) cite sources with it.
 */
export function digestText(text: string): Digest {
  return sha256(text.replace(/\r\n?/g, "\n"));
}

/**
 * Digest schemes a packet's `context.sources` can be computed with. `workspace-raw-v1` is the one
 * workspace digest (ADR-19): `workspaceDigest` of the file's bytes as they exist in the attempt's
 * own workspace after isolation. `text-lf-v1` is the pre-ADR-19 `digestText` scheme, read only.
 */
export const SOURCE_DIGEST_SCHEMES = ["text-lf-v1", "workspace-raw-v1"] as const;
export type SourceDigestScheme = (typeof SOURCE_DIGEST_SCHEMES)[number];

/**
 * The single workspace file digest (ADR-19): SHA-256 over the file's raw bytes exactly as they are
 * on disk in one workspace root, with no decoding, EOL folding, BOM stripping or filter. Every
 * model-facing digest (packet sources and known facts, `read_file`, `write_file`/`apply_patch`
 * preconditions, changed-path before/after) uses it, and each one is computed in the workspace the
 * model is working in, so a digest the model reads is always a valid precondition there. Digests
 * from two different trees are never compared with each other; that is `ContentIdentity`'s job.
 */
export function workspaceDigest(bytes: Uint8Array): Digest {
  return sha256(bytes);
}

/**
 * Cross-tree content identity, used only where the same path is compared across two trees that
 * may store it differently (worktree vs main tree: EOL conversion, smudge/clean filters, LFS).
 * `git-blob`: the object id git would store for the file (`git hash-object --path=<p>` over the
 * working-tree bytes, i.e. the clean filter and EOL conversion of *that* tree's attributes and
 * config), so an unchanged checkout equals the `HEAD` blob in every tree. `workspace`:
 * `workspaceDigest`, for files git does not track (untracked, ignored, or no repository). Never
 * shown to a model and never written into a packet.
 */
export type ContentIdentity =
  | { readonly scheme: "git-blob"; readonly oid: string }
  | { readonly scheme: "workspace"; readonly digest: Digest };

/** Equal only within one scheme; identities of different schemes never compare equal. */
export function sameContent(left: ContentIdentity, right: ContentIdentity): boolean {
  if (left.scheme === "git-blob" && right.scheme === "git-blob") return left.oid === right.oid;
  if (left.scheme === "workspace" && right.scheme === "workspace") return left.digest === right.digest;
  return false;
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
