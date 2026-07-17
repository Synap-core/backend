/**
 * Catalog Sync Staleness Stamps
 *
 * The catalog-sync workers (cp-catalog-sync, capability-template-sync) treat a
 * "0 entries" or "unreachable" response as keep-cache — the safe choice, but it
 * means a never-seeded prod kind is invisible: it just silently keeps an empty
 * cache and logs at info. This records a durable per (source, kind) stamp on
 * every attempt so `/health` can surface "kind empty+stale for N syncs".
 *
 * Storage: `pod_settings.settings.catalogSyncStamps` (JSONB on the existing
 * singleton row) — NO new table/migration. The write is a single atomic UPDATE
 * that deep-merges just the one stamp key (Postgres row-lock serializes the two
 * workers), so sibling stamps and sibling settings keys are never clobbered.
 */

import { db } from "../index.js";
import { sql as drizzleSql, eq } from "drizzle-orm";
import {
  podSettings,
  type CatalogSyncStamp,
  type CatalogSyncStatus,
} from "../schema/pod-settings.js";

/** Stamp map key. Distinct per cache being maintained (see capability-template-sync note). */
export function catalogSyncStampKey(source: string, kind: string): string {
  return `${source}::${kind}`;
}

/**
 * Record the outcome of one (source, kind) sync attempt. Never throws — a
 * stamp-write failure must not fail the sync it observes.
 */
export async function recordCatalogSyncStamp(
  source: string,
  kind: string,
  status: CatalogSyncStatus,
  count: number
): Promise<void> {
  const key = catalogSyncStampKey(source, kind);
  const stamp: CatalogSyncStamp = {
    lastSyncAt: new Date().toISOString(),
    lastStatus: status,
    lastCount: count,
  };
  const stampObj = JSON.stringify({ [key]: stamp });

  try {
    const [existing] = await db
      .select({ id: podSettings.id })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);

    if (existing) {
      // Deep-merge into settings.catalogSyncStamps: jsonb_set creates the
      // `catalogSyncStamps` object if missing; the inner `||` replaces only
      // this one key, preserving other stamps and other settings.
      await db
        .update(podSettings)
        .set({
          settings: drizzleSql`jsonb_set(
            coalesce(${podSettings.settings}, '{}'::jsonb),
            '{catalogSyncStamps}',
            coalesce(${podSettings.settings} -> 'catalogSyncStamps', '{}'::jsonb) || ${stampObj}::jsonb,
            true
          )`,
          updatedAt: new Date(),
        })
        .where(eq(podSettings.id, existing.id));
    } else {
      await db.insert(podSettings).values({
        settings: { catalogSyncStamps: { [key]: stamp } },
      });
    }
  } catch {
    // Observability best-effort — swallow so the observed sync is unaffected.
  }
}

/** Read all catalog-sync stamps from the singleton pod_settings row. */
export async function getCatalogSyncStamps(): Promise<
  Record<string, CatalogSyncStamp>
> {
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  return row?.settings?.catalogSyncStamps ?? {};
}
