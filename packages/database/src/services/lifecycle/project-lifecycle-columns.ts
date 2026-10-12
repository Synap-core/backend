/**
 * FILL the lifecycle columns from the read projection — for rows that existed
 * before their kind/role declared a lifecycle (or before 0319).
 *
 * This is DERIVATION, not a data change: it copies the value the row already
 * holds in `properties[<lifecycle slug>]` into `status`, and looks up that
 * option's category. It never invents a value: a value no option declares
 * keeps `status` with `status_category` NULL (reported as `uncategorized`),
 * never a guessed category. Idempotent — it only touches rows whose columns
 * differ from the projection.
 *
 * ONE statement builder, three callers:
 *  - the `projectLifecycleColumns` conversion op (boot; every declared
 *    lifecycle; heals any drift);
 *  - the conversion ENGINE after every op that changed data, scoped to the
 *    profiles that op touches (a value remap / role fold writes the
 *    projection; this keeps the columns — the truth — in step, even for an
 *    op the operator runs long after the boot-time projection was ledgered);
 *  - `declareLifecycle` when a profile newly declares one (that profile and
 *    every profile inheriting from it).
 *
 * The nearest declaration in the profile hierarchy wins, the same rule as
 * `ProfileResolutionService.getEffectiveLifecycle`.
 */
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const CATEGORIES = sql`('open','active','paused','done','lost')`;

/**
 * Which profiles to (re)project: one root and everything inheriting from it,
 * every profile carrying one of these slugs (and its heirs), or the whole pod.
 */
export type LifecycleProjectionScope =
  string | null | { profileSlugs: readonly string[] };

function scopeFilter(scope: LifecycleProjectionScope): SQL {
  if (scope === null) return sql``;
  if (typeof scope === "string") {
    return sql`WHERE c.profile_id IN (SELECT profile_id FROM chain WHERE ancestor_id = ${scope})`;
  }
  const slugs = scope.profileSlugs.length
    ? sql.join(
        scope.profileSlugs.map((s) => sql`${s}`),
        sql`, `
      )
    : sql`NULL`;
  return sql`WHERE c.profile_id IN (SELECT ch.profile_id FROM chain ch JOIN profiles sp ON sp.id = ch.ancestor_id WHERE sp.slug IN (${slugs}))`;
}

function declarations(scope: LifecycleProjectionScope): SQL {
  return sql`
    WITH RECURSIVE chain AS (
      SELECT id AS profile_id, id AS ancestor_id, 0 AS depth FROM profiles
      UNION ALL
      SELECT c.profile_id, p.parent_profile_id, c.depth + 1
        FROM chain c JOIN profiles p ON p.id = c.ancestor_id
       WHERE p.parent_profile_id IS NOT NULL AND c.depth < 16
    ),
    decl AS (
      SELECT DISTINCT ON (c.profile_id)
             c.profile_id, pd.slug, COALESCE(pd.constraints->'enumOptions', '[]'::jsonb) AS opts
        FROM chain c
        JOIN profile_properties pp ON pp.profile_id = c.ancestor_id AND pp.is_lifecycle
        JOIN property_defs pd ON pd.id = pp.property_def_id
       ${scopeFilter(scope)}
       ORDER BY c.profile_id, c.depth
    )`;
}

/** The projection's value + its option's category, per row of `table`. */
function projected(table: "entities" | "entity_facets"): SQL {
  const t = sql.raw(table);
  return sql`
    SELECT r.id,
           NULLIF(r.properties->>d.slug, '') AS val,
           (SELECT o->>'category'
              FROM jsonb_array_elements(d.opts) o
             WHERE o->>'key' = r.properties->>d.slug
               AND o->>'category' IN ${CATEGORIES}
             LIMIT 1) AS cat
      FROM ${t} r JOIN decl d ON d.profile_id = r.profile_id
     WHERE r.deleted_at IS NULL`;
}

/**
 * Every profile that declares a lifecycle or inherits one (the same `chain`
 * the projection walks). `lifecycle.list` counts only these, never every kind.
 */
export function declaredLifecycleProfilesStatement(): SQL {
  return sql`
    WITH RECURSIVE chain AS (
      SELECT id AS profile_id, id AS ancestor_id, 0 AS depth FROM profiles
      UNION ALL
      SELECT c.profile_id, p.parent_profile_id, c.depth + 1
        FROM chain c JOIN profiles p ON p.id = c.ancestor_id
       WHERE p.parent_profile_id IS NOT NULL AND c.depth < 16
    )
    SELECT DISTINCT c.profile_id
      FROM chain c
      JOIN profile_properties pp ON pp.profile_id = c.ancestor_id AND pp.is_lifecycle`;
}

/** UPDATE statements for both tables, each returning the rows it changed. */
export function lifecycleProjectionStatements(
  scope: LifecycleProjectionScope = null
): Array<{ table: "entities" | "entity_facets"; statement: SQL }> {
  return (["entities", "entity_facets"] as const).map((table) => ({
    table,
    statement: sql`
      ${declarations(scope)}
      UPDATE ${sql.raw(table)} x
         SET status = v.val, status_category = v.cat
        FROM (${projected(table)}) v
       WHERE x.id = v.id
         AND (x.status IS DISTINCT FROM v.val
              OR x.status_category IS DISTINCT FROM v.cat)
      RETURNING x.id, (v.val IS NOT NULL AND v.cat IS NULL) AS uncategorized`,
  }));
}

const dialect = new PgDialect();

/** The same statements as text + params, for a postgres.js `Sql` caller. */
export function lifecycleProjectionQueries(
  scope: LifecycleProjectionScope = null
): Array<{
  table: "entities" | "entity_facets";
  text: string;
  params: unknown[];
}> {
  return lifecycleProjectionStatements(scope).map(({ table, statement }) => {
    const q = dialect.sqlToQuery(statement);
    return { table, text: q.sql, params: q.params };
  });
}
