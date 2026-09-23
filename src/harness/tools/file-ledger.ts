import { foldPathCase, isCaseInsensitivePlatform, normalizePathUnicode, type AttemptFileLedger, type Digest } from "../contracts/index.ts";

/**
 * The attempt's read/write ledger (ADR-18 D3): the last workspace digest the model saw for each
 * path, so `write_file`/`apply_patch` can default a missing `expected_digest` to it. Keys are NFC
 * and, on case-insensitive platforms, `foldPathCase`d, matching how the file system names them.
 */
export function ledgerKey(path: string, platform: string = process.platform): string {
  const normalized = normalizePathUnicode(path.replaceAll("\\", "/").replace(/^\.\//, ""));
  return isCaseInsensitivePlatform(platform) ? foldPathCase(normalized) : normalized;
}

export function createAttemptFileLedger(platform: string = process.platform): AttemptFileLedger {
  const seen = new Map<string, Digest>();
  return {
    lastSeen: (path) => seen.get(ledgerKey(path, platform)),
    noteRead: (path, digest) => {
      seen.set(ledgerKey(path, platform), digest);
    },
    noteWrite: (path, digest) => {
      if (digest === undefined) seen.delete(ledgerKey(path, platform));
      else seen.set(ledgerKey(path, platform), digest);
    },
  };
}
