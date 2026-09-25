import type { ModelTier } from "../contracts/index.ts";
import type { CatalogModel } from "./catalog.ts";

/**
 * Cross-provider review (ADR-09, K1.5-2, K3): the reviewer prefers a provider other than the
 * implementer's. When no configured route is on another provider, the reviewer takes that
 * provider's best logged-in catalog model for its tier: the frontier model for worker and
 * orchestrator tiers, the fast one for `fast_worker`. Subscription / bridge identities come before
 * API keys (no surprise billing); only connected rows are ever picked (no silent fallback).
 */

export const REVIEW_CROSS_PROVIDER_MODES = ["prefer", "off", "require"] as const;
export type ReviewCrossProviderMode = (typeof REVIEW_CROSS_PROVIDER_MODES)[number];

const FAST_MODEL = /luna|haiku|mini|flash|fast/i;

function badgeRank(row: CatalogModel): number {
  return row.badge === "subscription" || row.badge === "bridge" ? 0 : 1;
}

function sourceRank(row: CatalogModel): number {
  return row.source === "configured" ? 0 : row.source === "known" ? 1 : 2;
}

/** The best connected catalog model on a provider other than `excludeProvider`, or undefined. */
export function pickCrossProviderReviewer(catalog: readonly CatalogModel[], excludeProvider: string, tier: ModelTier): CatalogModel | undefined {
  const fast = tier === "fast_worker";
  const rows = catalog
    .map((row, position) => ({ row, position }))
    .filter(({ row }) => row.connected && row.provider !== excludeProvider && row.provider !== "scripted");
  if (rows.length === 0) return undefined;
  const fits = (row: CatalogModel): boolean => FAST_MODEL.test(`${row.model} ${row.label ?? ""}`) === fast;
  rows.sort(
    (left, right) =>
      Number(!fits(left.row)) - Number(!fits(right.row)) ||
      badgeRank(left.row) - badgeRank(right.row) ||
      sourceRank(left.row) - sourceRank(right.row) ||
      left.position - right.position,
  );
  return rows[0]?.row;
}
