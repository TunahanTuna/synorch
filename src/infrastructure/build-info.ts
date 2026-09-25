import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYNORCH_VERSION } from "../domain/product.ts";

const BUILD_INFO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build-info.json");

/** Short commit the build was made from; `undefined` when running from sources or without git. */
export function buildCommit(file: string = BUILD_INFO): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { commit?: unknown };
    return typeof parsed.commit === "string" && /^[0-9a-f]{4,40}$/.test(parsed.commit) ? parsed.commit : undefined;
  } catch {
    return undefined;
  }
}

/** `0.4.0-beta.0 (abc1234)` for a built package, plain `0.4.0-beta.0` from sources (the legacy snapshot). */
export function versionLine(file?: string): string {
  const commit = buildCommit(file);
  return commit === undefined ? SYNORCH_VERSION : `${SYNORCH_VERSION} (${commit})`;
}
