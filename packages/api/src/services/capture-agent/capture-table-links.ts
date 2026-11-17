/**
 * The one database read of `synap_capture`'s `table` shape: the existing
 * entities a `linkBy` column names (see `capture-table.ts`).
 */

import {
  and,
  drizzleSql,
  entities,
  eq,
  inArray,
  isNull,
  type db as Database,
} from "@synap/database";
import { entityWriteVisibleWhere } from "../../routers/entities/helpers.js";
import { grantMayLinkRecord } from "./fenced-capture-graph.js";
import type { CaptureTableLinkBy, LinkByMatches } from "./capture-table.js";

/**
 * One read per `linkBy`: the entities of its kind whose property equals one of
 * the table's values, among the records the caller may link (the write floor
 * and, for a key limited to spaces, its grant: the same two checks the capture
 * core applies before it links an identity match).
 */
export async function findLinkByMatches(
  database: typeof Database,
  input: { userId: string; linkBy: CaptureTableLinkBy; values: string[] }
): Promise<LinkByMatches> {
  const matches: LinkByMatches = new Map();
  if (input.values.length === 0) return matches;
  const valueOf = drizzleSql<string | null>`${entities.properties} ->> ${input.linkBy.property}`;
  const rows = await database
    .select({ id: entities.id, value: valueOf })
    .from(entities)
    .where(
      and(
        eq(entities.type, input.linkBy.profileSlug),
        isNull(entities.deletedAt),
        inArray(valueOf, input.values),
        entityWriteVisibleWhere(input.userId)
      )
    );
  for (const row of rows) {
    if (row.value === null || !(await grantMayLinkRecord(row.id))) continue;
    const ids = matches.get(row.value) ?? [];
    if (!ids.includes(row.id)) ids.push(row.id);
    matches.set(row.value, ids);
  }
  return matches;
}
