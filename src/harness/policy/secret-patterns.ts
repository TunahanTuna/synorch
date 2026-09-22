/**
 * Shapes of secrets and secret sources, used to spot exfiltration in an argv before it runs
 * (hard rail `secret-egress`). The exact credential values the runtime holds are checked by the
 * ToolGateway; these patterns catch the rest: well-known token formats, key files and
 * environment variables whose names say they hold a secret.
 */

export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{40,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /npm_[A-Za-z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /:\/\/[^/\s:@]+:[^/\s@]{6,}@/,
];

const SENSITIVE_FILES: readonly RegExp[] = [
  /(?:^|[\\/@=\s])\.env(?:\.[\w-]+)?$/i,
  /(?:^|[\\/@=\s])id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.aws[\\/]credentials/i,
  /(?:^|[\\/@=\s])\.(?:npmrc|netrc|pgpass|git-credentials|pypirc)$/i,
  /\.docker[\\/]config\.json/i,
  /\.kube[\\/]config/i,
  /\.ssh[\\/]/i,
  /credentials\.json$/i,
  /\.(?:pem|p12|pfx|key|keystore|jks)$/i,
];

const SECRET_NAME = String.raw`[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*`;
const SECRET_ENV_REFERENCES: readonly RegExp[] = [
  new RegExp(String.raw`\$\{?${SECRET_NAME}`, "i"),
  new RegExp(String.raw`\$env:${SECRET_NAME}`, "i"),
  new RegExp(String.raw`%${SECRET_NAME}%`, "i"),
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

export function referencesSensitiveFile(text: string): boolean {
  return SENSITIVE_FILES.some((pattern) => pattern.test(text.replace(/^@/, "")));
}

export function referencesSecretEnv(text: string): boolean {
  return SECRET_ENV_REFERENCES.some((pattern) => pattern.test(text));
}

export function carriesSecret(text: string): boolean {
  return looksLikeSecret(text) || referencesSensitiveFile(text) || referencesSecretEnv(text);
}
