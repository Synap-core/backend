/**
 * A Library item's picture SKIPPED because its signed CDN link had already
 * expired (`metadata.importMediaSkipped`) — written by the thumbnail backfill
 * only, BEFORE any fetch (`isExpiredSignedMediaUrl`: Instagram / Facebook
 * `oe=`, TikTok `x-expires`).
 *
 * A skip is NOT a failure: no `importMediaFailures` entry, no failed count, no
 * error mark (an old post's dead link is expected, not something that went
 * wrong) — the row draws the platform tile. Marking a skip also drops a
 * failure an earlier pass recorded for that same link (it was the same expiry,
 * reported as an error before the pod could tell).
 *
 * The skipped items are what `library.readers` / `library.readWith`
 * `{ missingMedia: true }` act on: re-read them with a reader to get fresh
 * pictures ({@link missingMediaSql}).
 */

import { documents, drizzleSql, eq, type SQL } from "@synap/database";
import type { db as DbType } from "@synap/database";

/** `metadata.importMediaSkipped` as stored. */
export interface LibraryMediaSkip {
  reason: "expired";
  /** The link that was skipped (the card picture). */
  sourceUrl: string;
  /** When the link expired, per its own signature (ISO). */
  expiredAt: string;
  /** When the backfill skipped it (ISO). */
  at: string;
}

/** Was this item's picture skipped as an expired signed link? */
export function mediaSkippedExpired(metadata: unknown): boolean {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).importMediaSkipped
      : undefined;
  return (
    !!raw &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).reason === "expired"
  );
}

/**
 * SQL: a live item whose picture was skipped as expired and that still holds
 * NO pod copy (a later read that copied pictures takes it out of the scope).
 * Owner floor / archive / link filters are the caller's.
 */
export const missingMediaSql: SQL = drizzleSql`(${documents.metadata} -> 'importMediaSkipped' ->> 'reason' = 'expired' AND (jsonb_typeof(${documents.metadata} -> 'importMedia') IS DISTINCT FROM 'array' OR jsonb_array_length(${documents.metadata} -> 'importMedia') = 0))`;

/**
 * Record the skip on the item and drop any failure recorded for that same
 * link (the failed count follows). One UPDATE; nothing is fetched.
 */
export async function markLibraryMediaSkipped(
  database: Pick<typeof DbType, "update">,
  itemId: string,
  skip: LibraryMediaSkip
): Promise<void> {
  const failuresKept = drizzleSql`(SELECT COALESCE(jsonb_agg(f), '[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${documents.metadata} -> 'importMediaFailures') = 'array' THEN ${documents.metadata} -> 'importMediaFailures' ELSE '[]'::jsonb END) AS f WHERE f ->> 'sourceUrl' IS DISTINCT FROM ${skip.sourceUrl})`;
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`COALESCE(${documents.metadata}, '{}'::jsonb) || jsonb_build_object('importMediaSkipped', ${JSON.stringify(skip)}::jsonb, 'importMediaFailures', ${failuresKept}, 'importMediaFailed', jsonb_array_length(${failuresKept}))`,
    })
    .where(eq(documents.id, itemId));
}
