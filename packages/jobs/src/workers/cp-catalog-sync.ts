/**
 * CP Catalog Sync Worker
 *
 * Background refresher for the pod-local `cp_catalog_cache` — the generalized,
 * source-dimensioned successor to `capability-template-sync.ts` (which keeps
 * running unchanged; this is additive, not a replacement — see P2.4-B in
 * CAPABILITY-MARKETPLACE-PLAN.md). Fills the cache for all four marketplace
 * kinds from each configured catalog-provider `source` (today always
 * `[cpUrl()]` — P2.10.2: a future federated provider is a new entry in that
 * list, never a schema or verb change):
 *
 *   - capability → GET {source}/api/marketplace/capabilities
 *   - automation → GET {source}/api/packages?category=automation
 *   - template   → GET {source}/api/packages?category=template
 *   - cell       → GET {source}/api/marketplace/cells
 *
 * Runs on a schedule (every 10 minutes) AND once on startup, same as
 * capability-template-sync. Resilience contract, identical to that worker:
 *   - source unreachable / non-2xx / timeout (8s) → log + leave that source's
 *     existing cache rows INTACT (never wipe).
 *   - source returns 0 entries for a kind → no-op for that (source, kind) —
 *     likely a hiccup, not an intentional empty catalog.
 *   - upsert + prune is scoped per (source, kind): a failure/empty response on
 *     one kind never touches another kind's or another source's rows.
 *
 * Inlined fetches (not imported from @synap/api) for the same reason as
 * capability-template-sync.ts: @synap/jobs cannot import @synap/api (circular
 * dependency — api → jobs).
 */

import { db, drizzleSql, and, eq, notInArray } from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cp-catalog-sync" });

export const CP_CATALOG_SYNC_QUEUE = "cp-catalog-sync";
/** Cron schedule for this worker (every 10 minutes) — mirrors capability-template-sync. */
export const CP_CATALOG_SYNC_CRON = "*/10 * * * *";

export type CatalogKind = "capability" | "automation" | "template" | "cell";
const CATALOG_KINDS: CatalogKind[] = [
  "capability",
  "automation",
  "template",
  "cell",
];

interface CatalogEntry {
  slug: string;
  name: string;
  description?: string | null;
  version?: string | null;
  tier?: string | null;
  vendor?: string | null;
  tags?: string[] | null;
  contentHash?: string | null;
  /** Full install payload, when the source route returns it inline. */
  definition?: Record<string, unknown> | null;
}

/** Every configured catalog-provider base URL. Today: always just the CP. */
function catalogSources(): string[] {
  const url = (
    process.env.CONTROL_PLANE_URL ??
    process.env.CP_URL ??
    ""
  ).replace(/\/$/, "");
  return url ? [url] : [];
}

/** Shared 8s-timeout GET, tolerant of any failure — returns `null` on error. */
async function safeFetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** GET {source}/api/marketplace/capabilities → CatalogEntry[] | null. */
async function fetchCapabilities(
  source: string
): Promise<CatalogEntry[] | null> {
  const body = (await safeFetchJson(
    `${source}/api/marketplace/capabilities`
  )) as {
    capabilities?: Array<{
      key: string;
      name: string;
      description?: string | null;
      version?: string;
      definition?: Record<string, unknown>;
    }>;
  } | null;
  if (!body) return null;
  const list = Array.isArray(body.capabilities) ? body.capabilities : [];
  return list.map((c) => ({
    slug: c.key,
    name: c.name,
    description: c.description ?? null,
    version: c.version ?? null,
    definition: c.definition ?? null,
  }));
}

/** GET {source}/api/packages?category={category} → CatalogEntry[] | null (list view — no `definition`). */
async function fetchPackages(
  source: string,
  category: "automation" | "template"
): Promise<CatalogEntry[] | null> {
  const body = (await safeFetchJson(
    `${source}/api/packages?category=${category}&limit=100`
  )) as {
    packages?: Array<{
      slug: string;
      displayName: string;
      description?: string | null;
      version?: string;
      requiredTier?: string | null;
      vendorId?: string | null;
      tags?: string[];
    }>;
  } | null;
  if (!body) return null;
  const list = Array.isArray(body.packages) ? body.packages : [];
  return list.map((p) => ({
    slug: p.slug,
    name: p.displayName,
    description: p.description ?? null,
    version: p.version ?? null,
    tier: p.requiredTier ?? null,
    vendor: p.vendorId ?? null,
    tags: p.tags ?? null,
    // List view omits the definition body by design — null here means a
    // per-slug GET /api/packages/:slug/:version fetch is required at install
    // time (Wave 3b's concern).
    definition: null,
  }));
}

/** GET {source}/api/marketplace/cells → CatalogEntry[] | null. */
async function fetchCells(source: string): Promise<CatalogEntry[] | null> {
  const body = (await safeFetchJson(
    `${source}/api/marketplace/cells?limit=100`
  )) as {
    cells?: Array<{
      key: string;
      name: string;
      packageSlug: string;
      code: string;
      deps?: Record<string, string>;
      previewCode?: string;
      defaultSize?: { w: number; h: number };
      configSchema?: Record<string, unknown>;
      author?: string;
    }>;
  } | null;
  if (!body) return null;
  const list = Array.isArray(body.cells) ? body.cells : [];
  return list.map((cell) => ({
    // Cells aren't independently versioned/sluggable in the CP today — scope
    // the cache slug to the owning package so two packages' same-named cell
    // never collides under the (source, kind, slug) unique index.
    slug: `${cell.packageSlug}/${cell.key}`,
    name: cell.name,
    vendor: cell.author ?? null,
    definition: {
      key: cell.key,
      code: cell.code,
      deps: cell.deps,
      previewCode: cell.previewCode,
      defaultSize: cell.defaultSize,
      configSchema: cell.configSchema,
      packageSlug: cell.packageSlug,
    },
  }));
}

async function fetchKind(
  source: string,
  kind: CatalogKind
): Promise<CatalogEntry[] | null> {
  switch (kind) {
    case "capability":
      return fetchCapabilities(source);
    case "automation":
      return fetchPackages(source, "automation");
    case "template":
      return fetchPackages(source, "template");
    case "cell":
      return fetchCells(source);
  }
}

/** Sync one (source, kind) pair: upsert fetched rows, prune stale ones. Never throws. */
async function syncOne(source: string, kind: CatalogKind): Promise<void> {
  const entries = await fetchKind(source, kind);

  if (entries === null) {
    logger.warn(
      { source, kind },
      "Catalog source unreachable — leaving cache intact"
    );
    return;
  }
  if (entries.length === 0) {
    logger.info(
      { source, kind },
      "Catalog source returned 0 entries — leaving cache intact"
    );
    return;
  }

  const now = new Date();
  const rows = entries.map((e) => ({
    source,
    kind,
    slug: e.slug,
    name: e.name,
    description: e.description ?? null,
    version: e.version ?? null,
    tier: e.tier ?? null,
    vendor: e.vendor ?? null,
    tags: e.tags ?? null,
    contentHash: e.contentHash ?? null,
    definition: e.definition ?? null,
    syncedAt: now,
  }));

  try {
    await db
      .insert(cpCatalogCache)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          cpCatalogCache.source,
          cpCatalogCache.kind,
          cpCatalogCache.slug,
        ],
        set: {
          name: drizzleSql.raw("excluded.name"),
          description: drizzleSql.raw("excluded.description"),
          version: drizzleSql.raw("excluded.version"),
          tier: drizzleSql.raw("excluded.tier"),
          vendor: drizzleSql.raw("excluded.vendor"),
          tags: drizzleSql.raw("excluded.tags"),
          contentHash: drizzleSql.raw("excluded.content_hash"),
          definition: drizzleSql.raw("excluded.definition"),
          syncedAt: now,
        },
      });

    const fetchedSlugs = rows.map((r) => r.slug);
    const pruned = await db
      .delete(cpCatalogCache)
      .where(
        and(
          eq(cpCatalogCache.source, source),
          eq(cpCatalogCache.kind, kind),
          notInArray(cpCatalogCache.slug, fetchedSlugs)
        )
      )
      .returning({ slug: cpCatalogCache.slug });

    logger.info(
      { source, kind, upserted: rows.length, pruned: pruned.length },
      "Synced cp_catalog_cache"
    );
  } catch (err) {
    logger.error(
      { err, source, kind },
      "Failed to upsert/prune cp_catalog_cache"
    );
    throw err; // Let pg-boss retry; the cache is left as-is.
  }
}

/**
 * Called by the cron scheduler (every 10 min) and once on startup. Refreshes
 * cp_catalog_cache for every configured source × every kind. Each (source,
 * kind) pair is independent: one failing never blocks the others.
 */
export async function handleCpCatalogSync(): Promise<void> {
  const sources = catalogSources();
  if (sources.length === 0) {
    logger.info(
      "No catalog sources configured (CONTROL_PLANE_URL unset) — skipping"
    );
    return;
  }

  for (const source of sources) {
    for (const kind of CATALOG_KINDS) {
      await syncOne(source, kind);
    }
  }
}
