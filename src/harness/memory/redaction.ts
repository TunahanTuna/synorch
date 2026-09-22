/**
 * Secret redaction applied to every string before it reaches the vault or the review queue
 * (ADR-17, obsidian/README.md §7.2). Patterns err towards redacting: a lost token fragment in a
 * note is cheap, a leaked credential in a synced folder is not.
 */

export const REDACTED = "[REDACTED]";

interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const whole = (): string => REDACTED;

const RULES: readonly RedactionRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: whole,
  },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: whole },
  { name: "openai-key", pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, replace: whole },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: whole },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: whole },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: whole },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: whole },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: whole },
  {
    name: "bearer",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_match, scheme) => `${scheme} ${REDACTED}`,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    name: "assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?)(["']?\s*[:=]\s*)(["']?)([^\s"',;]{4,})\3/gi,
    replace: (_match, key, separator, quote) => `${key}${separator}${quote}${REDACTED}${quote}`,
  },
];

export interface RedactionResult {
  readonly text: string;
  /** Names of the rules that fired; never the matched values. */
  readonly rules: readonly string[];
}

export function redactSecrets(text: string): RedactionResult {
  let current = text;
  const fired: string[] = [];
  for (const rule of RULES) {
    const next = current.replace(rule.pattern, rule.replace as (match: string, ...rest: unknown[]) => string);
    if (next !== current) fired.push(rule.name);
    current = next;
  }
  return { text: current, rules: fired };
}

/** Deeply redacts every string inside a JSON-like value; keys are left untouched. */
export function redactValue<T>(value: T, fired: Set<string> = new Set()): T {
  if (typeof value === "string") {
    const result = redactSecrets(value);
    for (const rule of result.rules) fired.add(rule);
    return result.text as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactValue(item, fired)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, member]) => [key, redactValue(member, fired)]),
    ) as T;
  }
  return value;
}
