import type { BlobRef, BlobStore } from "../contracts/index.ts";

/**
 * Output hygiene applied by the gateway before anything reaches the model, the event log or a
 * blob: exact credential values reported by the auth layer (`ResolvedCredential.redactionValues`)
 * and well-known secret shapes are replaced, then output above the inline cap moves to a blob.
 */

export const REDACTED = "[redacted]";
export const INLINE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PREVIEW_HEAD_BYTES = 12 * 1024;
const PREVIEW_TAIL_BYTES = 3 * 1024;
const MIN_EXACT_VALUE_LENGTH = 6;

interface SecretShape {
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const whole = (): string => REDACTED;

const SECRET_SHAPES: readonly SecretShape[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: whole },
  { pattern: /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, replace: whole },
  { pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g, replace: whole },
  { pattern: /github_pat_[A-Za-z0-9_]{40,}/g, replace: whole },
  { pattern: /glpat-[A-Za-z0-9_-]{20,}/g, replace: whole },
  { pattern: /npm_[A-Za-z0-9]{36}/g, replace: whole },
  { pattern: /AKIA[0-9A-Z]{16}/g, replace: whole },
  { pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g, replace: whole },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: whole },
  { pattern: /(authorization:\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_match, prefix = "") => `${prefix}${REDACTED}` },
  { pattern: /(:\/\/[^/\s:@]+:)[^/\s@[]{6,}(@)/g, replace: (_match, prefix = "", suffix = "") => `${prefix}${REDACTED}${suffix}` },
  {
    pattern: /\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'[]{6,})\3/gi,
    replace: (_match, name = "", separator = "", quote = "") => `${name}${separator}${quote}${REDACTED}${quote}`,
  },
];

export interface RedactionResult {
  readonly text: string;
  readonly count: number;
}

export type Redactor = (text: string) => RedactionResult;

export function createRedactor(values: () => readonly string[]): Redactor {
  return (text) => {
    let count = 0;
    let output = text;
    const exact = [...new Set(values())].filter((value) => value.length >= MIN_EXACT_VALUE_LENGTH).sort((left, right) => right.length - left.length);
    for (const value of exact) {
      const parts = output.split(value);
      if (parts.length > 1) {
        count += parts.length - 1;
        output = parts.join(REDACTED);
      }
    }
    for (const shape of SECRET_SHAPES) {
      output = output.replace(shape.pattern, (...args: unknown[]) => {
        const match = String(args[0]);
        count += 1;
        const groups = args.slice(1).filter((value): value is string => typeof value === "string");
        return shape.replace(match, ...groups);
      });
    }
    return { text: output, count };
  };
}

/** True when any exact credential value occurs in the text (hard rail `secret-egress` on arguments). */
export function containsCredentialValue(text: string, values: readonly string[]): boolean {
  return values.some((value) => value.length >= MIN_EXACT_VALUE_LENGTH && text.includes(value));
}

export interface BoundedText {
  readonly text: string;
  readonly blob: BlobRef | undefined;
}

/**
 * Keeps text inline up to 16 KiB; larger text is stored whole as a blob and previewed head + tail.
 * `hint` tells the model how to see the omitted part with the same tool (audit F18).
 */
export async function boundText(text: string, blobs: BlobStore, hint?: string): Promise<BoundedText> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= INLINE_OUTPUT_LIMIT_BYTES) return { text, blob: undefined };
  const blob = await blobs.put(new Uint8Array(bytes), "text/plain; charset=utf-8");
  const head = sliceUtf8(bytes, 0, PREVIEW_HEAD_BYTES);
  const tail = sliceUtf8(bytes, bytes.length - PREVIEW_TAIL_BYTES, bytes.length);
  const marker = `\n… [${bytes.length - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes omitted; ${hint ?? "truncated"}; full output in blob ${blob.digest}] …\n`;
  return { text: head + marker + tail, blob };
}

function sliceUtf8(bytes: Buffer, start: number, end: number): string {
  return bytes
    .subarray(Math.max(0, start), end)
    .toString("utf8")
    .replace(/^�+/, "")
    .replace(/�+$/, "");
}
