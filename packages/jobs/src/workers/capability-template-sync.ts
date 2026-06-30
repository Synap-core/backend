/**
 * Capability Template Sync Worker
 *
 * Background refresher for the pod-local `capability_template_cache` — the
 * stale-while-revalidate mirror of the Control-Plane capability-template catalog.
 *
 * Runs on a schedule (every 10 minutes) AND once on startup. Fetches the CP
 * catalog (GET {CP}/api/marketplace/capabilities) and UPSERTs each template into
 * the cache. This is what lets the catalog read path (cp-template-client.ts in
 * @synap/api) serve from a fast DB read instead of a blocking CP fetch — restoring
 * pod sovereignty: the catalog NEVER hangs on a slow/down CP.
 *
 * Resilience contract:
 *   - CP unreachable / non-2xx / timeout → log + leave the existing cache INTACT
 *     (never wipe). The pod keeps serving "what we last knew".
 *   - CP returns 0 templates → treat as a no-op (likely a CP hiccup), leave cache.
 *
 * The CP fetch is inlined here (not imported from cp-template-client.ts) because
 * @synap/jobs CANNOT import @synap/api — that would be a circular dependency
 * (api → jobs). This mirrors the established pattern in sync-push.ts / proactive-post.ts.
 */

import { db, drizzleSql, notInArray } from "@synap/database";
import { capabilityTemplateCache } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "capability-template-sync" });

export const CAPABILITY_TEMPLATE_SYNC_QUEUE = "capability-template-sync";
/** Cron schedule for this worker (every 10 minutes). */
export const CAPABILITY_TEMPLATE_SYNC_CRON = "*/10 * * * *";

interface CPCapabilityTemplate {
  key: string;
  name: string;
  description?: string | null;
  definition: Record<string, unknown>;
}

/** Resolve the Control Plane base URL (mirrors cp-template-client.ts `cpUrl`). */
function cpUrl(): string | null {
  const url = (
    process.env.CONTROL_PLANE_URL ??
    process.env.CP_URL ??
    ""
  ).replace(/\/$/, "");
  return url || null;
}

/**
 * Fetch the CP catalog. Returns `null` on ANY failure (no CP configured, non-2xx,
 * timeout, parse error) so the handler degrades to "leave cache intact". 8s timeout.
 */
async function fetchFromCP(): Promise<CPCapabilityTemplate[] | null> {
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
 * Called by the cron scheduler (every 10 min) and once on startup. Refreshes the
 * pod-local cache from the CP. On CP failure: leaves the existing cache intact.
 */
export async function handleCapabilityTemplateSync(): Promise<void> {
  const items = await fetchFromCP();

  if (items === null) {
    logger.warn(
      "Control Plane unreachable — leaving capability_template_cache intact"
    );
    return;
  }
  if (items.length === 0) {
    // A 0-length response is almost always a CP hiccup, not an intentional empty
    // catalog. Never wipe the cache on this signal.
    logger.info(
      "Control Plane returned 0 templates — leaving capability_template_cache intact"
    );
    return;
  }

  const now = new Date();
  const rows = items.map((item) => ({
    key: item.key,
    name: item.name,
    description: item.description ?? null,
    definition: item.definition,
    syncedAt: now,
  }));

  const fetchedKeys = rows.map((r) => r.key);

  try {
    await db
      .insert(capabilityTemplateCache)
      .values(rows)
      .onConflictDoUpdate({
        target: capabilityTemplateCache.key,
        set: {
          name: drizzleSql.raw("excluded.name"),
          description: drizzleSql.raw("excluded.description"),
          definition: drizzleSql.raw("excluded.definition"),
          syncedAt: now,
        },
      });

    // PRUNE: delete cache rows whose key is no longer in the CP catalog.
    // Guard: only runs when the fetch succeeded AND returned a non-empty list
    // (both checks already passed above — items.length > 0 and items !== null).
    // This prevents a CP outage or hiccup from wiping the local cache.
    const pruned = await db
      .delete(capabilityTemplateCache)
      .where(notInArray(capabilityTemplateCache.key, fetchedKeys))
      .returning({ key: capabilityTemplateCache.key });

    logger.info(
      { upserted: rows.length, pruned: pruned.length },
      "Synced capability_template_cache from Control Plane"
    );
    if (pruned.length > 0) {
      logger.info(
        { keys: pruned.map((r) => r.key) },
        "Pruned stale capability_template_cache entries"
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to upsert/prune capability_template_cache");
    throw err; // Let pg-boss retry; the cache is left as-is.
  }
}
