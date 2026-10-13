/**
 * Catalog cache read helper — queries the pod-local `cp_catalog_cache` (Wave 3a,
 * P2.4-B) so Wave 3b's `market.search` builtin verb (and any other consumer)
 * reads a fast DB cache, never a live Control-Plane fetch.
 *
 * Ranking uses `rankByTerms` from `utils/term-match.ts` — the ONE term matcher
 * `listCapabilities` and instruction-skill search also use — so a query has
 * ONE scoring implementation across "what's installed" and "what's in the
 * marketplace", not a second reimplementation (SSOT, per this repo's
 * engineering bar).
 */

import { getDb, and, eq, inArray, isNull } from "@synap/database";
import { cpCatalogCache, type CatalogListing } from "@synap/database/schema";
import type { CatalogKind } from "@synap/jobs";
import { officialCatalogUrl } from "@synap/jobs/workers/cp-catalog-sync.js";
import { rankByTerms } from "../../utils/term-match.js";

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
  /** Third-party rows only: the signed listing (definition URL + digest, publisher pages). */
  listing: CatalogListing | null;
}

/**
 * Only the OFFICIAL catalog's rows. Every reader that is not the marketplace
 * itself (capability templates, template health, ensure-template, the intent
 * finder, …) reads through this, so a package from a source a person added
 * can never stand in for Synap's own — not by slug, not by key.
 */
export function officialCatalogCondition() {
  return eq(cpCatalogCache.source, officialCatalogUrl());
}

export interface QueryCatalogCacheOptions {
  /** Ranked tokenized substring match over name + tags + description. */
  query?: string;
  /**
   * Exact kind filter. `workspace` is an alias for the cache kind `template`
   * (the CP's live PACKAGE_TYPES name); agents should send `kind:template`.
   */
  kind?: CatalogKind | "workspace";
  /**
   * The cache keys to read (`CatalogSource.cacheKey`: the official URL, or an
   * added source's id). Omitted: the OFFICIAL source only — a third-party row
   * is read only by a caller that names its source.
   */
  sources?: string[];
  /** Cap the result count. Defaults to 20 when `query` is set; unset otherwise. */
  limit?: number;
}

const DEFAULT_QUERY_LIMIT = 20;

/**
 * Query the cp_catalog_cache. With no options, returns every cached row
 * (unranked) — mirrors `listCapabilities`'s back-compat contract. With `query`
 * set, ranks via the shared `rankByTerms` and drops zero-score rows.
 */
export async function queryCatalogCache(
  opts?: QueryCatalogCacheOptions
): Promise<CatalogCacheEntry[]> {
  const db = await getDb();

  // A retired (tombstoned) template is known, never offered: browse/search
  // never return it. Template health is its only reader.
  const conditions = [isNull(cpCatalogCache.retiredAt)];
  if (opts?.kind) {
    const kind = opts.kind === "workspace" ? "template" : opts.kind;
    conditions.push(eq(cpCatalogCache.kind, kind));
  }
  conditions.push(
    opts?.sources
      ? inArray(cpCatalogCache.source, opts.sources)
      : officialCatalogCondition()
  );

  const rows = await db
    .select()
    .from(cpCatalogCache)
    .where(and(...conditions));

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
    listing: row.listing ?? null,
  }));

  if (opts?.query && opts.query.trim().length > 0) {
    return rankByTerms(opts.query, entries, (entry) => ({
      primary: entry.name,
      secondary: entry.tags ?? [],
      tertiary: entry.description,
    }))
      .map((s) => s.item)
      .slice(0, opts.limit ?? DEFAULT_QUERY_LIMIT);
  }
  if (typeof opts?.limit === "number") return entries.slice(0, opts.limit);
  return entries;
}
