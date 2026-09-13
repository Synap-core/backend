/**
 * Compare-and-set on a proposal's `updated_at` — at the precision a JS `Date`
 * carries.
 *
 * Postgres stores microseconds; the row read back into JS keeps milliseconds.
 * So `eq(proposals.updatedAt, loaded.updatedAt)` never matches a row stamped by
 * `now()`, and every write guarded by it would read as a conflict. Truncating
 * the column to milliseconds compares what both sides actually hold.
 *
 * LIMIT, stated: it only detects writers that move `updated_at`. The revert
 * doors do; `stampMaterialized` does not (the column has no `$onUpdate`).
 */

import { drizzleSql, proposals } from "@synap/database";
import type { SQL } from "@synap/database";

export function proposalUnchangedSince(loadedUpdatedAt: Date): SQL {
  return drizzleSql`date_trunc('milliseconds', ${proposals.updatedAt}) = ${loadedUpdatedAt.toISOString()}::timestamptz`;
}
