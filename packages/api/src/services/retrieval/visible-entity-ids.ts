/**
 * THE floor over entity SEARCH HITS: which of these ids may this person (and
 * the calling key) list?
 *
 * The keyword index's own floor is owner OR member space
 * (`visibleInWorkspaces`): it knows nothing of the key's grant, the exposure
 * axis, probe rows or demo rows. So every door that reads entity ids out of
 * the index (or out of pgvector) intersects them with the REAL entity floor
 * before it shows them:
 *   - `accessScopeWhere({ facetLens: true })`, the resolver `entities.list`
 *     reads through (owner + membership + role-as-lens + exposure), which
 *     ANDs the calling key's grant itself;
 *   - `listableEntityWhere`, THE listing rule (no probe rows; no demo rows
 *     unless a project lens is set, the lens being the demo toggle);
 *   - not soft-deleted.
 *
 * One read, one copy: hybrid recall (both halves) and find's `entities`
 * catalog call this, so the floor over search hits cannot fork. A failed read
 * THROWS (empty ≠ failed).
 */
import {
  and,
  db,
  entities,
  inArray,
  isNull,
  listableEntityWhere,
} from "@synap/database";
import { accessScopeWhere } from "../../utils/project-scope.js";

export async function visibleEntityIds(
  ids: readonly string[],
  userId: string,
  opts: { projectLens?: readonly string[] } = {}
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        inArray(entities.id, unique),
        isNull(entities.deletedAt),
        void accessScopeWhere,
        void listableEntityWhere,
        void userId,
        void opts
      )
    );
  return new Set(rows.map((r) => r.id));
}
