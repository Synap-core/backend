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
 *   - automation → GET {source}/api/packages?category=workflow
 *   - template   → GET {source}/api/packages?category=workspace
 *   - cell       → GET {source}/api/marketplace/cells
 *
 * NOTE on the package `category`: the pod's internal marketplace `kind`
 * vocabulary (capability | automation | template | cell — what agents'
 * `market.search(kind:…)` and the cache's `kind` column speak) predates the
 * CP's `0049_package_vocabulary` migration. The CP's live `PACKAGE_TYPES` are
 * now `workspace | capability | skill | workflow | view | cell` — `template`
 * and `automation` are RETIRED and a request with `category=template` returns
 * HTTP 400. So the OUTBOUND CP query maps kind → the CP's live category
 * (automation→workflow, template→workspace); the cache still STORES
 * kind=automation|template, unchanged, so nothing downstream is orphaned.
 *
 * Runs on a schedule (every 10 minutes) AND once on startup, same as
 * capability-template-sync. Resilience contract:
 *   - 5xx / network error / timeout (8s) → transient: log at warn + leave that
 *     source's existing cache rows INTACT (never wipe).
 *   - 4xx → misconfiguration: the request itself is wrong (e.g. a retired
 *     category) and will NEVER self-heal on retry. Log LOUDLY at error + stamp
 *     `misconfigured` (distinct from `unreachable`) so an operator sees it;
 *     cache still left intact (never wipe).
 *   - source returns 0 entries for a kind → no-op for that (source, kind) —
 *     likely a hiccup, not an intentional empty catalog.
 *   - upsert + prune is scoped per (source, kind): a failure/empty response on
 *     one kind never touches another kind's or another source's rows.
 *
 * Inlined fetches (not imported from @synap/api) for the same reason as
 * capability-template-sync.ts: @synap/jobs cannot import @synap/api (circular
 * dependency — api → jobs).
 */

import {
  db,
  drizzleSql,
  and,
  eq,
  notInArray,
  recordCatalogSyncStamp,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cp-catalog-sync" });

export const CP_CATALOG_SYNC_QUEUE = "cp-catalog-sync";
/** Cron schedule for this worker (every 10 minutes) — mirrors capability-template-sync. */
export const CP_CATALOG_SYNC_CRON = "*/10 * * * *";

// TODO(control-plane-types): adopt MarketplaceCatalogKind/MarketplaceCatalogEntry
// from @synap-core/control-plane-types@1.1.0 once published — this inline shape
// duplicates that contract (P2.10.3) and must not drift from it.
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

/**
 * Outcome of one source fetch. The two failure variants are split on purpose:
 *   - `transient` (5xx / network / timeout) → the source may recover; leave the
 *     cache intact quietly.
 *   - `clientError` (4xx) → the REQUEST is wrong and will never succeed on
 *     retry (e.g. a retired `category`); surface it loudly.
 * A silent `null` for both — the old shape — let a permanent 400 masquerade as
 * a temporary outage for the cache's whole life, which is exactly the bug that
 * kept `market.search(kind:'template')` returning "nothing" since 0049.
 */
type SourceFetch<T> =
  | { ok: true; data: T }
  | { ok: false; clientError: false }
  | { ok: false; clientError: true; status: number };

/** Shared 8s-timeout GET. Distinguishes a 4xx (permanent) from a transient failure. */
async function safeFetchJson(url: string): Promise<SourceFetch<unknown>> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      // 4xx = the request is malformed/unacceptable — will never self-heal.
      // 5xx (and anything else non-2xx) = server-side, treat as transient.
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, clientError: true, status: res.status };
      }
      return { ok: false, clientError: false };
    }
    return { ok: true, data: await res.json() };
  } catch {
    // Network error / timeout / abort — transient, leave cache intact.
    return { ok: false, clientError: false };
  }
}

/** GET {source}/api/marketplace/capabilities → SourceFetch<CatalogEntry[]>. */
async function fetchCapabilities(
  source: string
): Promise<SourceFetch<CatalogEntry[]>> {
  const result = await safeFetchJson(`${source}/api/marketplace/capabilities`);
  if (!result.ok) return result;
  const body = result.data as {
    capabilities?: Array<{
      key: string;
      name: string;
      description?: string | null;
      version?: string;
      definition?: Record<string, unknown>;
    }>;
  } | null;
  const list = Array.isArray(body?.capabilities) ? body.capabilities : [];
  return {
    ok: true,
    data: list.map((c) => ({
      slug: c.key,
      name: c.name,
      description: c.description ?? null,
      version: c.version ?? null,
      definition: c.definition ?? null,
    })),
  };
}

/**
 * GET {source}/api/packages?category={category} → SourceFetch<CatalogEntry[]>
 * (list view — no `definition`). `category` is the CP's LIVE `PACKAGE_TYPES`
 * vocabulary (`workspace` / `workflow`), NOT the pod's internal cache `kind` —
 * see fetchKind for the mapping and the header note.
 */
async function fetchPackages(
  source: string,
  category: "workspace" | "workflow"
): Promise<SourceFetch<CatalogEntry[]>> {
  const result = await safeFetchJson(
    `${source}/api/packages?category=${category}&limit=100`
  );
  if (!result.ok) return result;
  const body = result.data as {
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
  const list = Array.isArray(body?.packages) ? body.packages : [];
  return {
    ok: true,
    data: list.map((p) => ({
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
    })),
  };
}

/** GET {source}/api/marketplace/cells → SourceFetch<CatalogEntry[]>. */
async function fetchCells(
  source: string
): Promise<SourceFetch<CatalogEntry[]>> {
  const result = await safeFetchJson(`${source}/api/marketplace/cells?limit=100`);
  if (!result.ok) return result;
  const body = result.data as {
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
  const list = Array.isArray(body?.cells) ? body.cells : [];
  return {
    ok: true,
    data: list.map((cell) => ({
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
    })),
  };
}

async function fetchKind(
  source: string,
  kind: CatalogKind
): Promise<SourceFetch<CatalogEntry[]>> {
  switch (kind) {
    case "capability":
      return fetchCapabilities(source);
    // Map the pod's internal cache `kind` → the CP's LIVE `category`
    // (PACKAGE_TYPES after migration 0049). The cache still stores
    // kind=automation|template — only the outbound CP query is translated.
    case "automation":
      return fetchPackages(source, "workflow");
    case "template":
      return fetchPackages(source, "workspace");
    case "cell":
      return fetchCells(source);
  }
}

/** Sync one (source, kind) pair: upsert fetched rows, prune stale ones. Never throws. */
async function syncOne(source: string, kind: CatalogKind): Promise<void> {
  const result = await fetchKind(source, kind);

  if (!result.ok) {
    if (result.clientError) {
      // 4xx: the pod is asking for a category/kind the source no longer
      // accepts (e.g. a retired `category`). This will NEVER self-heal on
      // retry — surface it loudly and stamp it distinctly so `/health` and an
      // operator can tell it apart from a transient outage. Cache left intact.
      logger.error(
        { source, kind, status: result.status },
        "Catalog source REJECTED the request (4xx) — the pod asked for a category/kind the Control Plane no longer accepts. This will NOT self-heal; fix the request vocabulary in cp-catalog-sync.ts. Cache left intact."
      );
      await recordCatalogSyncStamp(source, kind, "misconfigured", 0);
      return;
    }
    logger.warn(
      { source, kind },
      "Catalog source unreachable — leaving cache intact"
    );
    await recordCatalogSyncStamp(source, kind, "unreachable", 0);
    return;
  }
  const entries = result.data;
  if (entries.length === 0) {
    logger.info(
      { source, kind },
      "Catalog source returned 0 entries — leaving cache intact"
    );
    await recordCatalogSyncStamp(source, kind, "empty", 0);
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
    await recordCatalogSyncStamp(source, kind, "ok", rows.length);
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
