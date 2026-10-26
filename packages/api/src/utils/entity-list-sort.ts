/**
 * The ONE sort rule for entity lists (tRPC `entities.list`, the Hub
 * `getEntities` forwarder, Hub REST `GET /entities`, MCP `synap_get_entities`).
 *
 * The order is applied in SQL BEFORE limit/offset: sorting an already-paged
 * array reorders one page, never the set, so "the 20 least recently updated"
 * silently returned 20 arbitrary rows in the right order. An unknown field is a
 * 400 at every door — it used to be ignored, which read as "sorted".
 */
import { z } from "zod";
import { asc, desc, drizzleSql } from "@synap/database";
import { entities } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";

export const ENTITY_LIST_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "title",
] as const;
export type EntityListSortField = (typeof ENTITY_LIST_SORT_FIELDS)[number];

export const entityListOrderBySchema = z.object({
  field: z.enum(ENTITY_LIST_SORT_FIELDS),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type EntityListOrderBy = z.infer<typeof entityListOrderBySchema>;

/**
 * Parse `field` or `field:dir` (the Hub `sort` query shape, `updatedAt:desc`).
 * `dir` defaults to `desc`. Anything else is an `error` the caller turns into a
 * 400, never a silent default.
 */
export function parseEntityListSort(
  raw: string
): { orderBy: EntityListOrderBy } | { error: string } {
  const [field, dir, ...rest] = raw.trim().split(":");
  const parsed = entityListOrderBySchema.safeParse({
    field,
    ...(dir === undefined ? {} : { dir: dir.toLowerCase() }),
  });
  if (!parsed.success || rest.length > 0) {
    return {
      error: `Unsupported sort "${raw}". Use <field>[:asc|:desc] with field one of ${ENTITY_LIST_SORT_FIELDS.join(", ")}.`,
    };
  }
  return { orderBy: parsed.data };
}

/**
 * The SQL `ORDER BY` terms. Nulls last (a missing title never leads an
 * ascending list); `id` breaks ties so page 2 always continues page 1.
 * No `orderBy` keeps the list's historical newest-created-first order.
 */
export function entityListOrderBySql(orderBy?: EntityListOrderBy): SQL[] {
  const { field, dir } = orderBy ?? { field: "createdAt", dir: "desc" };
  const direction = dir === "asc" ? drizzleSql`asc` : drizzleSql`desc`;
  const column =
    field === "title"
      ? drizzleSql`lower(${entities.title})`
      : field === "updatedAt"
        ? entities.updatedAt
        : entities.createdAt;
  return [drizzleSql`${column} ${direction} nulls last`, asc(entities.id)];
}

/**
 * Comparator for MERGING lists that were each already ordered in SQL (the
 * `scope=all` fan-out over several lenses). It is not a page sort: every input
 * holds its top `offset + limit` rows, so the merge's top slice is exact.
 */
export function compareListedEntities(
  orderBy: EntityListOrderBy
): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  const sign = orderBy.dir === "asc" ? 1 : -1;
  const key = (row: Record<string, unknown>): number | string | null => {
    const v = row[orderBy.field];
    if (v === null || v === undefined || v === "") return null;
    if (orderBy.field === "title") return String(v).toLowerCase();
    const t = new Date(String(v)).getTime();
    return Number.isNaN(t) ? null : t;
  };
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null || kb === null) {
      if (ka === kb) return String(a.id).localeCompare(String(b.id));
      return ka === null ? 1 : -1;
    }
    if (ka < kb) return -sign;
    if (ka > kb) return sign;
    return String(a.id).localeCompare(String(b.id));
  };
}
