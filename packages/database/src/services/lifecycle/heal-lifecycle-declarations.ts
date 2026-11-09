/**
 * Two HEALS for lifecycles, both run by conversion ops (never a migration):
 *
 *  - {@link fillFacetInitialStatus}: a role's facet born with no status (before
 *    facets filled `initialStatus` at birth) gets the lifecycle's initial
 *    status, column + category + the `properties[<slug>]` mirror written in one
 *    statement, exactly what `bornLifecycleFor` does at a birth. Only a
 *    non-terminal, non-person-only initial is filled (the same rule as a
 *    birth); a facet holding a mirror value is left to `projectLifecycleColumns`.
 *  - {@link deriveLifecycleLists}: the stored `uiHints.enumValues` and
 *    `constraints.defaultValue` of a lifecycle def are rewritten from the one
 *    declaration (`constraints.enumOptions`), the same derivation
 *    `withDerivedLifecycleLists` applies on read.
 *
 * Both are idempotent: they touch only rows that differ from the derivation.
 * The nearest declaration in the profile hierarchy wins (as
 * `getEffectiveLifecycle`).
 */
import type { Sql } from "postgres";

/** Facets with no status → their role lifecycle's initial status. Returns rows filled. */
export async function fillFacetInitialStatus(tx: Sql): Promise<number> {
  const rows = await tx`
    WITH RECURSIVE chain AS (
      SELECT id AS profile_id, id AS ancestor_id, 0 AS depth FROM profiles
      UNION ALL
      SELECT c.profile_id, p.parent_profile_id, c.depth + 1
        FROM chain c JOIN profiles p ON p.id = c.ancestor_id
       WHERE p.parent_profile_id IS NOT NULL AND c.depth < 16
    ),
    decl AS (
      SELECT DISTINCT ON (c.profile_id)
             c.profile_id, pd.slug,
             pp.default_value #>> '{}' AS init,
             COALESCE(pd.constraints->'enumOptions', '[]'::jsonb) AS opts
        FROM chain c
        JOIN profile_properties pp ON pp.profile_id = c.ancestor_id AND pp.is_lifecycle
        JOIN property_defs pd ON pd.id = pp.property_def_id
       ORDER BY c.profile_id, c.depth
    ),
    pick AS (
      SELECT d.profile_id, d.slug, d.init, o->>'category' AS cat
        FROM decl d, jsonb_array_elements(d.opts) o
       WHERE o->>'key' = d.init
         AND o->>'category' IN ('open','active','paused')
         AND COALESCE((o->>'humanOnly')::boolean, false) = false
    )
    UPDATE entity_facets f
       SET status = p.init,
           status_category = p.cat,
           properties = COALESCE(f.properties, '{}'::jsonb)
                        || jsonb_build_object(p.slug, p.init),
           updated_at = now()
      FROM pick p
     WHERE f.profile_id = p.profile_id
       AND f.deleted_at IS NULL
       AND f.status IS NULL
       AND NULLIF(f.properties->>p.slug, '') IS NULL
    RETURNING f.id`;
  return rows.length;
}

/** Lifecycle defs' stored `uiHints.enumValues` / `constraints.defaultValue` → derived. Returns defs rewritten. */
export async function deriveLifecycleLists(tx: Sql): Promise<number> {
  const rows = await tx`
    WITH lc AS (
      SELECT pp.property_def_id AS def_id,
             COUNT(DISTINCT pp.default_value #>> '{}')
               FILTER (WHERE pp.default_value #>> '{}' IS NOT NULL) AS n_defaults,
             MIN(pp.default_value #>> '{}') AS init
        FROM profile_properties pp
       WHERE pp.is_lifecycle
       GROUP BY pp.property_def_id
    ),
    want AS (
      SELECT pd.id,
             COALESCE((SELECT jsonb_agg(o->>'key' ORDER BY ord)
                         FROM jsonb_array_elements(pd.constraints->'enumOptions')
                              WITH ORDINALITY AS t(o, ord)
                        WHERE o->>'category' IN ('open','active','paused','done','lost')),
                      '[]'::jsonb) AS keys,
             CASE WHEN lc.n_defaults = 1 THEN to_jsonb(lc.init) END AS init
        FROM property_defs pd JOIN lc ON lc.def_id = pd.id
       WHERE jsonb_typeof(pd.constraints->'enumOptions') = 'array'
         AND jsonb_array_length(pd.constraints->'enumOptions') > 0
    )
    UPDATE property_defs pd
       SET ui_hints = jsonb_set(COALESCE(pd.ui_hints, '{}'::jsonb), '{enumValues}', w.keys),
           constraints = CASE WHEN w.init IS NULL
                              THEN pd.constraints - 'defaultValue'
                              ELSE jsonb_set(pd.constraints, '{defaultValue}', w.init) END,
           updated_at = now()
      FROM want w
     WHERE pd.id = w.id
       AND (pd.ui_hints->'enumValues' IS DISTINCT FROM w.keys
            AND pd.ui_hints ? 'enumValues'
            OR pd.constraints->'defaultValue' IS DISTINCT FROM w.init
               AND pd.constraints ? 'defaultValue')
    RETURNING pd.id`;
  return rows.length;
}
