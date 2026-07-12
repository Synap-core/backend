/**
 * Catalog cache read helper — queries the pod-local `cp_catalog_cache` (Wave 3a,
 * P2.4-B) so Wave 3b's `market.search` builtin verb (and any other consumer)
 * reads a fast DB cache, never a live Control-Plane fetch.
 *
 * Ranking reuses `scoreTextMatch` from `capability-registry.ts` — the SAME
 * matcher `listCapabilities` uses over installed capabilities — so a query has
 * ONE scoring implementation across "what's installed" and "what's in the
 * marketplace", not a second reimplementation (SSOT, per this repo's
 * engineering bar). Both live in `@synap/api`, so the import has no cycle risk.
 */

import { getDb, and, eq } from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import type { CatalogKind } from "@synap/jobs";
import { scoreTextMatch } from "./capability-registry.js";

// TODO(control-plane-types): adopt MarketplaceCatalogEntry from
// @synap-core/control-plane-types@1.1.0 once published (P2.10.3) — inline
// duplicate of that contract, keep in sync until then.
export interface CatalogCacheEntry {
  source: string;
  kind: CatalogKind;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  tier: string | null;
  vendor: string | null;
  tags: string[] | null;
  contentHash: string | null;
  /** Full install payload — null for kinds whose list-view source omits it (see cp-catalog-sync.ts). */
  definition: Record<string, unknown> | null;
}

export interface QueryCatalogCacheOptions {
  /** Ranked tokenized substring match over name + tags + description. */
  query?: string;
  /** Exact kind filter. */
  kind?: CatalogKind;
  /** Exact source filter (the catalog provider base URL). Omit to search all configured sources. */
  source?: string;
  /** Cap the result count. Defaults to 20 when `query` is set; unset otherwise. */
  limit?: number;
}

const DEFAULT_QUERY_LIMIT = 20;

/**
 * Query the cp_catalog_cache. With no options, returns every cached row
 * (unranked) — mirrors `listCapabilities`'s back-compat contract. With `query`
 * set, ranks via the shared `scoreTextMatch` and drops zero-score rows.
 */
export async function queryCatalogCache(
  opts?: QueryCatalogCacheOptions
): Promise<CatalogCacheEntry[]> {
  const db = await getDb();

  const conditions = [];
  if (opts?.kind) conditions.push(eq(cpCatalogCache.kind, opts.kind));
  if (opts?.source) conditions.push(eq(cpCatalogCache.source, opts.source));

  const rows = await db
    .select()
    .from(cpCatalogCache)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const entries: CatalogCacheEntry[] = rows.map((row) => ({
    source: row.source,
    kind: row.kind as CatalogKind,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    tier: row.tier,
    vendor: row.vendor,
    tags: row.tags,
    contentHash: row.contentHash,
    definition: row.definition,
  }));

  if (opts?.query && opts.query.trim().length > 0) {
    return entries
      .map((entry) => ({
        entry,
        score: scoreTextMatch(opts.query as string, {
          primary: entry.name,
          secondary: entry.tags ?? [],
          tertiary: entry.description,
        }),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.entry)
      .slice(0, opts.limit ?? DEFAULT_QUERY_LIMIT);
  }
  if (typeof opts?.limit === "number") return entries.slice(0, opts.limit);
  return entries;
}
