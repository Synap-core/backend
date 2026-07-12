/**
 * Capability-template client — POD-LOCAL CACHE first, Control-Plane fallback.
 *
 * The Control Plane is the SINGLE source of truth for the capability-template
 * catalog (the same place workspace packages live). But the CP must be a CACHED
 * fallback, NOT a live request-path dependency: a blocking CP fetch on the catalog
 * request path hangs ~8s (or returns empty) whenever the CP is slow or down.
 *
 * So the pod keeps a persisted CACHE (`capability_template_cache`), refreshed in
 * the background (packages/jobs `capability-template-sync` — every 10 min + on
 * startup). Reads here serve from that cache (fast DB read, no network —
 * STALE-WHILE-REVALIDATE). Only on a COLD first boot (cache empty before the job
 * has run) do we do ONE inline CP fetch to populate it, keeping the 8s timeout and
 * never throwing. This restores pod sovereignty: a slow/down CP degrades the
 * catalog to "what we last knew", never an 8s hang.
 *
 * Source: GET {CP}/api/marketplace/capabilities → { capabilities: [...] }
 * (public read; see synap-control-plane-api/src/routes/marketplace-apps.ts).
 */

import { db, eq, drizzleSql } from "@synap/database";
import { capabilityTemplateCache } from "@synap/database/schema";
import type { CapabilityDefinition } from "@synap/playbooks";

export interface CPCapabilityTemplate {
  key: string;
  name: string;
  description?: string | null;
  connectionHint?: {
    required: boolean;
    type: "nango" | "vault" | "external" | "none";
    provider?: string;
  };
  definition: CapabilityDefinition;
}

/** Resolve the Control Plane base URL (mirrors cells.ts `getCpUrl`). */
function cpUrl(): string | null {
  const url = (
    process.env.CONTROL_PLANE_URL ??
    process.env.CP_URL ??
    ""
  ).replace(/\/$/, "");
  return url || null;
}

/**
 * Raw Control-Plane fetch — the network call. Resilient: returns `null` on ANY
 * failure (no CP configured, non-2xx, timeout, parse error) so the caller decides
 * how to degrade. Keeps the 8s timeout. Never throws.
 */
export async function fetchCPCapabilityTemplatesFromCP(): Promise<
  CPCapabilityTemplate[] | null
> {
  const base = cpUrl();
  if (!base) return null;

  try {
    const res = await fetch(`${base}/api/marketplace/capabilities`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      capabilities?: CPCapabilityTemplate[];
    };
    return Array.isArray(data.capabilities) ? data.capabilities : [];
  } catch {
    return null;
  }
}

/**
 * Direct CP fetch of ONE template by key or display name — the "still
 * installable if you know it" door for a capability that's marketplace-listed
 * (isPublic=true) but excluded from the default every-pod sync
 * (syncByDefault=false, e.g. a paid third-party connector like Unipile).
 * Deliberately NOT upserted into `capabilityTemplateCache` by the caller —
 * that cache mirrors the syncByDefault=true list; writing a non-default item
 * into it would leak it back into every pod's default catalog browse, the
 * exact thing syncByDefault exists to prevent. Resilient like the list fetch:
 * returns `null` on ANY failure (404, no CP configured, timeout), never throws.
 */
export async function fetchCPCapabilityTemplateByKey(
  key: string
): Promise<CPCapabilityTemplate | null> {
  const base = cpUrl();
  if (!base) return null;

  try {
    const res = await fetch(
      `${base}/api/marketplace/capabilities/${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as CPCapabilityTemplate | { error: string };
    if ("error" in data) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * UPSERT the given templates into the pod-local cache (one row per key). Used by
 * the cold-boot inline fetch below (the background sync job in @synap/jobs owns
 * its own upsert — it cannot import @synap/api, circular dep). Never throws.
 */
export async function upsertCapabilityTemplateCache(
  items: CPCapabilityTemplate[]
): Promise<void> {
  if (items.length === 0) return;
  const now = new Date();
  const rows = items.map((item) => ({
    key: item.key,
    name: item.name,
    description: item.description ?? null,
    definition: item.definition as unknown as Record<string, unknown>,
    syncedAt: now,
  }));
  try {
    await db
      .insert(capabilityTemplateCache)
      .values(rows)
      .onConflictDoUpdate({
        target: capabilityTemplateCache.key,
        set: {
          name: sqlExcluded("name"),
          description: sqlExcluded("description"),
          definition: sqlExcluded("definition"),
          syncedAt: now,
        },
      });
  } catch {
    // Cache write is best-effort; a failure here must never break a read.
  }
}

// Reference the conflicting row's incoming value (the standard `EXCLUDED.<col>`)
// in onConflictDoUpdate. Column names are the DB (snake_case) names.
function sqlExcluded(column: string) {
  return drizzleSql.raw(`excluded.${column}`);
}

/** Map a cache row → the CP template shape the catalog consumes. */
function rowToTemplate(row: {
  key: string;
  name: string;
  description: string | null;
  definition: Record<string, unknown>;
}): CPCapabilityTemplate {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    definition: row.definition as unknown as CapabilityDefinition,
  };
}

/**
 * Resolve the capability-template catalog — POD-LOCAL CACHE first (fast DB read,
 * no network). STALE-WHILE-REVALIDATE: whatever is in the cache is served
 * immediately. Only if the cache is EMPTY (cold first boot before the background
 * sync ran) do we do ONE inline CP fetch to populate it. Never throws — returns []
 * if even the cold-boot fetch fails. Never blocks on the CP when the cache has data.
 */
export async function fetchCPCapabilityTemplates(): Promise<
  CPCapabilityTemplate[]
> {
  // 1. Serve from the pod-local cache (fast, no network).
  let rows: Array<{
    key: string;
    name: string;
    description: string | null;
    definition: Record<string, unknown>;
  }> = [];
  try {
    rows = await db
      .select({
        key: capabilityTemplateCache.key,
        name: capabilityTemplateCache.name,
        description: capabilityTemplateCache.description,
        definition: capabilityTemplateCache.definition,
      })
      .from(capabilityTemplateCache);
  } catch {
    rows = [];
  }
  if (rows.length > 0) return rows.map(rowToTemplate);

  // 2. Cold boot: cache empty → ONE inline CP fetch, populate, return.
  const items = await fetchCPCapabilityTemplatesFromCP();
  if (items && items.length > 0) {
    await upsertCapabilityTemplateCache(items);
    return items;
  }
  return [];
}

/** Resolve ONE capability definition by key — cache first, CP fallback on miss. */
export async function fetchCPCapabilityTemplate(
  key: string
): Promise<CapabilityDefinition | null> {
  // 1. Cache hit (fast).
  try {
    const [row] = await db
      .select({ definition: capabilityTemplateCache.definition })
      .from(capabilityTemplateCache)
      .where(eq(capabilityTemplateCache.key, key))
      .limit(1);
    if (row) return row.definition as unknown as CapabilityDefinition;
  } catch {
    // Fall through to the CP fallback.
  }

  // 2. Cache miss → try the default-sync list first (covers the common case
  //    and opportunistically warms the cache for next time).
  const items = await fetchCPCapabilityTemplatesFromCP();
  const fromList = items?.find((c) => c.key === key);
  if (fromList) {
    if (items && items.length > 0) await upsertCapabilityTemplateCache(items);
    return fromList.definition;
  }

  // 3. Not in the default-sync list → it may still be a real, installable
  //    template that's just excluded from default sync (syncByDefault=false).
  //    Direct by-key lookup, deliberately not cached (see fn doc).
  const byKey = await fetchCPCapabilityTemplateByKey(key);
  return byKey?.definition ?? null;
}
