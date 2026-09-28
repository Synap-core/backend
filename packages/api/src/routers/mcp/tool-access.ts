/**
 * The DB half of MCP tool profiles (`tool-profiles.ts` is the pure half).
 *
 * Read FRESH per `tools/list`, never from the validated key record: the
 * api-keys verification cache holds a record for 30s, so an unlock would
 * otherwise not show on the very next list. One primary-key read.
 */

import { apiKeys, db, drizzleSql, eq } from "@synap/database";
import type { KeyToolAccess, ToolGroup } from "./tool-profiles.js";

/**
 * The key's tool access. Throws on a failed read — a tools/list that silently
 * fell back to "every tool" or "no tools" would be a confident wrong answer.
 * A key that no longer exists lists the entry surface (it cannot call anyway).
 */
export async function loadKeyToolAccess(keyId: string): Promise<KeyToolAccess> {
  const [row] = await db
    .select({ profile: apiKeys.toolProfile, groups: apiKeys.toolGroups })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  if (!row) return { profile: "entry", groups: [] };
  return { profile: row.profile ?? null, groups: row.groups ?? [] };
}

/**
 * Add `groups` to an ENTRY key's unlocked set (idempotent, union, one
 * statement). Returns the groups that were NEWLY added — `[]` when the key is
 * not an entry key or already had them all, so the caller knows whether the
 * tool list actually changed.
 */
export async function unlockKeyToolGroups(
  keyId: string,
  groups: readonly ToolGroup[]
): Promise<ToolGroup[]> {
  if (groups.length === 0) return [];
  const [before] = await db
    .select({ profile: apiKeys.toolProfile, groups: apiKeys.toolGroups })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  if (!before || before.profile !== "entry") return [];
  const had = new Set(before.groups ?? []);
  const added = groups.filter((g) => !had.has(g));
  if (added.length === 0) return [];
  await db
    .update(apiKeys)
    .set({
      toolGroups: drizzleSql`ARRAY(SELECT DISTINCT g FROM unnest(${apiKeys.toolGroups} || ${drizzleSql`ARRAY[${drizzleSql.join(
        added.map((g) => drizzleSql`${g}`),
        drizzleSql`, `
      )}]::text[]`}) AS g ORDER BY g)`,
    })
    .where(eq(apiKeys.id, keyId));
  return added;
}
