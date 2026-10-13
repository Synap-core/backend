/**
 * Marketplace sources — the pod-settings access for the sources a pod admin
 * chose (Pod Console D11). One read for everything the sync and the install
 * door need, one locked read-modify-write for the admin's list, one merge per
 * source for the sync's status.
 *
 * Storage: the singleton `pod_settings.settings` blob, three keys —
 *   marketplaceSources        the admin's list (written under a row lock)
 *   marketplaceOfficialSource the built-in Synap source's on/off switch
 *   marketplaceSourceStatus   per-source sync outcome (written by the worker)
 * Each write replaces only its own key with `jsonb_set`, so it can never
 * clobber the catalog stamps or any other setting written beside it.
 */

import { db } from "../index.js";
import { sql as drizzleSql, eq } from "drizzle-orm";
import {
  podSettings,
  type MarketplaceOfficialSourceSetting,
  type MarketplaceSourceSetting,
  type MarketplaceSourceStatus,
} from "../schema/pod-settings.js";

export interface MarketplaceSourcesSnapshot {
  sources: MarketplaceSourceSetting[];
  official: MarketplaceOfficialSourceSetting | null;
  status: Record<string, MarketplaceSourceStatus>;
}

/** Read the whole marketplace-source state. A failed read THROWS — never "no sources". */
export async function readMarketplaceSources(): Promise<MarketplaceSourcesSnapshot> {
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const settings = row?.settings ?? {};
  return {
    sources: Array.isArray(settings.marketplaceSources)
      ? settings.marketplaceSources
      : [],
    official: settings.marketplaceOfficialSource ?? null,
    status: settings.marketplaceSourceStatus ?? {},
  };
}

/**
 * Change the admin-written list (and/or the official switch) atomically: the
 * singleton row is locked, `mutate` sees the CURRENT list, and only the two
 * admin keys are rewritten. `mutate` may throw to refuse the change — nothing
 * is written then.
 */
export async function updateMarketplaceSources<T>(
  mutate: (current: {
    sources: MarketplaceSourceSetting[];
    official: MarketplaceOfficialSourceSetting | null;
  }) => {
    sources: MarketplaceSourceSetting[];
    official: MarketplaceOfficialSourceSetting | null;
    result: T;
  }
): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: podSettings.id, settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1)
      .for("update");
    const settings = row?.settings ?? {};
    const next = mutate({
      sources: Array.isArray(settings.marketplaceSources)
        ? settings.marketplaceSources
        : [],
      official: settings.marketplaceOfficialSource ?? null,
    });
    const patch = {
      marketplaceSources: next.sources,
      ...(next.official ? { marketplaceOfficialSource: next.official } : {}),
    };
    if (row) {
      await tx
        .update(podSettings)
        .set({
          settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(podSettings.id, row.id));
    } else {
      await tx.insert(podSettings).values({ settings: patch });
    }
    return next.result;
  });
}

/**
 * Record one source's sync outcome. Replaces only `marketplaceSourceStatus.<id>`.
 * Never throws: a status write that fails must not fail the sync it reports.
 */
export async function recordMarketplaceSourceStatus(
  sourceId: string,
  status: MarketplaceSourceStatus
): Promise<void> {
  const patch = JSON.stringify({ [sourceId]: status });
  try {
    const [existing] = await db
      .select({ id: podSettings.id })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    if (existing) {
      await db
        .update(podSettings)
        .set({
          settings: drizzleSql`jsonb_set(
            coalesce(${podSettings.settings}, '{}'::jsonb),
            '{marketplaceSourceStatus}',
            coalesce(${podSettings.settings} -> 'marketplaceSourceStatus', '{}'::jsonb) || ${patch}::jsonb,
            true
          )`,
          updatedAt: new Date(),
        })
        .where(eq(podSettings.id, existing.id));
    } else {
      await db.insert(podSettings).values({
        settings: { marketplaceSourceStatus: { [sourceId]: status } },
      });
    }
  } catch {
    // Observability best-effort — the next sync writes it again.
  }
}

/** Forget a removed source's status. Throws on failure (the caller is a person's action). */
export async function clearMarketplaceSourceStatus(
  sourceId: string
): Promise<void> {
  await db.update(podSettings).set({
    settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) #- ${`{marketplaceSourceStatus,${sourceId}}`}::text[]`,
    updatedAt: new Date(),
  });
}
