/**
 * Search index versions — which collections a pod must reindex after a deploy.
 *
 * Typesense keeps what an older indexer wrote until each row is written again.
 * When the indexer starts producing a different document for the SAME rows (a
 * field it now fills, text it now folds in), new writes pick it up but every
 * existing row stays as it was, silently, until someone runs a full reindex by
 * hand. So each collection whose indexed document changed carries a version
 * here; the jobs boot compares it with the version the pod last reindexed at and
 * enqueues one `search-reindex` of the collections that are behind. The version
 * is stamped only once that reindex succeeds, so a failed one is retried at the
 * next boot.
 *
 * Bump a collection's version in the same change that makes its indexer write
 * different documents for existing rows. A new schema FIELD alone is added by
 * `CollectionService.reconcileNewFields`; its backfill still needs the bump.
 *
 * Storage: `pod_settings.settings.searchIndexVersions` (the singleton row, same
 * no-new-table pattern as `catalogSyncStamps`).
 */

import { getDb, eq, drizzleSql } from "@synap/database";
import { podSettings } from "@synap/database/schema";

export const SEARCH_INDEX_VERSIONS: Readonly<Record<string, number>> = {
  // 2: `description` holds the entity's preview (it was always empty), and a
  //    full reindex folds the linked document body into `content`.
  entities: 2,
  // 1: an entity's, view's or skill's body, and an entity's picture, are no
  //    longer indexed as documents (`indexableDocumentWhere`). The reindex
  //    prunes the rows an older indexer wrote.
  documents: 1,
};

/** The collections whose stamped version is below `SEARCH_INDEX_VERSIONS`. */
export function collectionsBehind(
  stamped: Record<string, number> | undefined
): string[] {
  return Object.entries(SEARCH_INDEX_VERSIONS)
    .filter(([collection, version]) => (stamped?.[collection] ?? 0) < version)
    .map(([collection]) => collection);
}

/** The versions this pod last reindexed at. */
export async function readSearchIndexVersions(): Promise<
  Record<string, number>
> {
  const db = await getDb();
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  return row?.settings?.searchIndexVersions ?? {};
}

/**
 * Stamp `collection` at its current version, after a full reindex of it
 * succeeded. Merges the one key, so sibling stamps and settings are kept.
 */
export async function stampSearchIndexVersion(
  collection: string
): Promise<void> {
  const version = SEARCH_INDEX_VERSIONS[collection];
  if (version === undefined) return;
  const db = await getDb();
  const stampObj = JSON.stringify({ [collection]: version });

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
          '{searchIndexVersions}',
          coalesce(${podSettings.settings} -> 'searchIndexVersions', '{}'::jsonb) || ${stampObj}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({
      settings: { searchIndexVersions: { [collection]: version } },
    });
  }
}
