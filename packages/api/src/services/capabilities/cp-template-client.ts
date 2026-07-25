/**
 * Capability-template client — POD-LOCAL CACHE first, Control-Plane fallback.
 *
 * The Control Plane is the SINGLE source of truth for the capability-template
 * catalog (the same place workspace packages live). But the CP must be a CACHED
 * fallback, NOT a live request-path dependency: a blocking CP fetch on the catalog
 * request path hangs ~8s (or returns empty) whenever the CP is slow or down.
 *
 * So the pod keeps a persisted CACHE (`cp_catalog_cache`, kind="capability"),
 * refreshed in the background by packages/jobs `cp-catalog-sync` (every 10 min +
 * on startup). Reads here serve from that cache (fast DB read, no network —
 * STALE-WHILE-REVALIDATE) via the shared `queryCatalogCache` helper. Only on a
 * COLD first boot (cache empty before the sync job has run) do we do ONE inline CP
 * fetch, keeping the 8s timeout and never throwing. This restores pod sovereignty:
 * a slow/down CP degrades the catalog to "what we last knew", never an 8s hang.
 *
 * (Historical: this cache used to be the pod-local `capability_template_cache`
 * filled by `capability-template-sync`; that duplicate was retired in favor of the
 * source-dimensioned `cp_catalog_cache` — P2.4-B cutover.)
 *
 * Source: GET {CP}/api/marketplace/capabilities → { capabilities: [...] }
 * (public read; see synap-control-plane-api/src/routes/marketplace-apps.ts).
 */

import { db, drizzleSql } from "@synap/database";
import { workspaces } from "@synap/database/schema";
import type { CapabilityDefinition } from "@synap/playbooks";
import { queryCatalogCache } from "./catalog-cache-query.js";

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

/** This pod's CP identity (workspace settings `controlPlane.podId`), mirroring
 *  @synap/jobs `cp-project-sync`'s resolveCpPodId. Null when the pod has no CP
 *  identity (self-hosted) — the owner door is then skipped. Never throws. */
async function resolveCpPodId(): Promise<string | null> {
  try {
    const rows = await db
      .select({
        podId: drizzleSql<
          string | null
        >`${workspaces.settings} -> 'controlPlane' ->> 'podId'`,
      })
      .from(workspaces)
      .where(
        drizzleSql`${workspaces.settings} -> 'controlPlane' ->> 'podId' IS NOT NULL`
      )
      .limit(1);
    return rows[0]?.podId ?? null;
  } catch {
    return null;
  }
}

/**
 * OWNER-SCOPED by-key fetch — the private-capability door. Calls the CP internal
 * endpoint (GET /internal/capabilities/:key?podId=…) authenticated with the pod
 * ↔ CP shared secret (X-Internal-Key), the same trust `cp-project-sync` uses. The
 * CP resolves this pod's OWNER and applies the author hatch (isPublic OR
 * authorId=owner), so a PRIVATE capability owned by the pod's owner resolves here
 * where the anonymous public door 404s. Returns null (→ caller falls back to the
 * public door) whenever the pod isn't CP-connected (no CONTROL_PLANE_URL /
 * SYNAP_POD_INTERNAL_KEY / podId) or on any failure. Never throws.
 */
async function fetchCPCapabilityTemplateByKeyAsOwner(
  key: string
): Promise<CPCapabilityTemplate | null> {
  const base = cpUrl();
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  if (!base || !internalKey) return null;

  const podId = await resolveCpPodId();
  if (!podId) return null;

  try {
    const res = await fetch(
      `${base}/internal/capabilities/${encodeURIComponent(
        key
      )}?podId=${encodeURIComponent(podId)}`,
      {
        headers: { "X-Internal-Key": internalKey },
        signal: AbortSignal.timeout(8000),
      }
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
 * Direct CP fetch of ONE template by key or display name — the "still
 * installable if you know it" door for a capability excluded from the default
 * every-pod sync (syncByDefault=false, e.g. a paid third-party connector like
 * Unipile). Tries the OWNER-scoped internal door FIRST (resolves PRIVATE caps
 * owned by this pod's owner — isPublic=false, e.g. arch-backend), then falls
 * back to the anonymous public door (isPublic=true only). Deliberately NOT written
 * into the catalog cache by the caller — that cache (cp_catalog_cache, owned by
 * cp-catalog-sync) mirrors the syncByDefault=true public list; writing a non-default
 * item into it would leak it back into every pod's default catalog browse, the exact
 * thing syncByDefault exists to prevent. Resilient: returns `null` on ANY failure
 * (404, no CP configured, timeout), never throws.
 */
export async function fetchCPCapabilityTemplateByKey(
  key: string
): Promise<CPCapabilityTemplate | null> {
  // Owner-scoped first: the only door that can see a private (isPublic:false)
  // capability. On a self-hosted / non-CP pod this no-ops and we fall through.
  const owned = await fetchCPCapabilityTemplateByKeyAsOwner(key);
  if (owned) return owned;

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
 * Map a cp_catalog_cache capability entry → the CP template shape the catalog
 * consumes. Capability rows carry the full `definition` inline (cp-catalog-sync
 * `fetchCapabilities`, from the same `/api/marketplace/capabilities` endpoint), so
 * a row missing a definition is treated as a cache MISS (returns null) rather than
 * mapped to an empty def — the caller then falls through to the CP fetch.
 */
function entryToTemplate(entry: {
  slug: string;
  name: string;
  description: string | null;
  definition: Record<string, unknown> | null;
}): CPCapabilityTemplate | null {
  if (!entry.definition) return null;
  return {
    key: entry.slug,
    name: entry.name,
    description: entry.description,
    definition: entry.definition as unknown as CapabilityDefinition,
  };
}

/**
 * Resolve the capability-template catalog — POD-LOCAL CACHE first (fast DB read,
 * no network) from `cp_catalog_cache` (kind="capability"), owned/refreshed by
 * @synap/jobs `cp-catalog-sync`. STALE-WHILE-REVALIDATE: whatever is cached is
 * served immediately. Only if the cache is EMPTY (cold first boot before the sync
 * ran) do we do ONE inline CP fetch. The cache itself is populated by
 * cp-catalog-sync (its own startup run), never written from this read path. Never
 * throws — returns [] if even the cold-boot fetch fails. Never blocks on the CP
 * when the cache has data.
 */
export async function fetchCPCapabilityTemplates(): Promise<
  CPCapabilityTemplate[]
> {
  // 1. Serve from the pod-local cache (fast, no network).
  try {
    const entries = await queryCatalogCache({ kind: "capability" });
    const mapped = entries
      .map(entryToTemplate)
      .filter((t): t is CPCapabilityTemplate => t !== null);
    if (mapped.length > 0) return mapped;
  } catch {
    // Fall through to the cold-boot CP fetch.
  }

  // 2. Cold boot: cache empty → ONE inline CP fetch, return.
  const items = await fetchCPCapabilityTemplatesFromCP();
  return items && items.length > 0 ? items : [];
}

/** Resolve ONE capability definition by key — cache first, CP fallback on miss. */
export async function fetchCPCapabilityTemplate(
  key: string
): Promise<CapabilityDefinition | null> {
  // 1. Cache hit (fast) — a cp_catalog_cache capability row whose slug IS the key.
  try {
    const entries = await queryCatalogCache({ kind: "capability" });
    const entry = entries.find((e) => e.slug === key);
    if (entry?.definition) {
      return entry.definition as unknown as CapabilityDefinition;
    }
  } catch {
    // Fall through to the CP fallback.
  }

  // 2. Cache miss → try the default-sync list first (covers the common case).
  const items = await fetchCPCapabilityTemplatesFromCP();
  const fromList = items?.find((c) => c.key === key);
  if (fromList) return fromList.definition;

  // 3. Not in the default-sync list → it may still be a real, installable
  //    template excluded from default sync (syncByDefault=false), or a PRIVATE
  //    (isPublic=false) capability owned by this pod's owner. Direct by-key lookup.
  const byKey = await fetchCPCapabilityTemplateByKey(key);
  return byKey?.definition ?? null;
}
