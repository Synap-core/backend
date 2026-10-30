-- 0378 — lifecycle rows born with no status get their declared initial status
-- (finding 8c869510, 2026-10-30).
--
-- A kind or role declares its lifecycle on one `profile_properties` link
-- (`is_lifecycle`); that link's `default_value` is the status a new row starts
-- in (`task` → `todo`). Until this fix no create door read it: a creator that
-- named no status (agent capture graphs, direct agent creates) left `status`
-- NULL, so the row sat in the "no status" column. The doors now apply it at
-- birth (`bornLifecycleValue`); this one-off fix gives the rows already born
-- without one the same value.
--
-- Scope: live rows (entities, and role facets) whose nearest lifecycle
-- declaration has a string `default_value` naming an open, active or paused
-- option that is not person-only, whose
-- `status` is NULL AND whose read projection `properties[<slug>]` is absent or
-- empty. A row holding ANY value (even one no option declares) is untouched.
-- Column and projection are written together, so the boot-time
-- `projectLifecycleColumns` keeps agreeing.
--
-- A done/lost or person-only initial (`decision` → `accepted`) is NOT filled
-- here: at the create door an agent born there is a person's call (the
-- lifecycle floor, rungs 2.075 / 2.85), and a migration has no person. Those
-- rows stay "no status" until someone sets them.
--
-- A birth value, NOT a move: no `lifecycle_transition_outbox` row is written
-- (a born status has no "from"). `updated_at` is left alone so recent-activity
-- order does not shift. Idempotent: a filled row no longer matches.
-- Schema is untouched.

WITH RECURSIVE chain AS (
  SELECT id AS profile_id, id AS ancestor_id, 0 AS depth FROM "profiles"
  UNION ALL
  SELECT c.profile_id, p.parent_profile_id, c.depth + 1
    FROM chain c JOIN "profiles" p ON p.id = c.ancestor_id
   WHERE p.parent_profile_id IS NOT NULL AND c.depth < 16
),
decl AS (
  SELECT DISTINCT ON (c.profile_id)
         c.profile_id, pd.slug, pp.default_value,
         CASE WHEN jsonb_typeof(pd.constraints->'enumOptions') = 'array'
              THEN pd.constraints->'enumOptions' ELSE '[]'::jsonb END AS opts
    FROM chain c
    JOIN "profile_properties" pp ON pp.profile_id = c.ancestor_id AND pp.is_lifecycle
    JOIN "property_defs" pd ON pd.id = pp.property_def_id
   ORDER BY c.profile_id, c.depth
),
initial AS (
  SELECT DISTINCT ON (d.profile_id)
         d.profile_id, d.slug, d.default_value #>> '{}' AS val, o->>'category' AS cat
    FROM decl d CROSS JOIN LATERAL jsonb_array_elements(d.opts) o
   WHERE jsonb_typeof(d.default_value) = 'string'
     AND o->>'key' = d.default_value #>> '{}'
     AND o->>'category' IN ('open','active','paused')
     AND (o->'humanOnly') IS DISTINCT FROM 'true'::jsonb
   ORDER BY d.profile_id
)
UPDATE "entities" x
   SET status = i.val,
       status_category = i.cat,
       properties = COALESCE(x.properties, '{}'::jsonb) || jsonb_build_object(i.slug, i.val)
  FROM initial i
 WHERE x.profile_id = i.profile_id
   AND x.deleted_at IS NULL
   AND x.status IS NULL
   AND NULLIF(x.properties->>i.slug, '') IS NULL;

WITH RECURSIVE chain AS (
  SELECT id AS profile_id, id AS ancestor_id, 0 AS depth FROM "profiles"
  UNION ALL
  SELECT c.profile_id, p.parent_profile_id, c.depth + 1
    FROM chain c JOIN "profiles" p ON p.id = c.ancestor_id
   WHERE p.parent_profile_id IS NOT NULL AND c.depth < 16
),
decl AS (
  SELECT DISTINCT ON (c.profile_id)
         c.profile_id, pd.slug, pp.default_value,
         CASE WHEN jsonb_typeof(pd.constraints->'enumOptions') = 'array'
              THEN pd.constraints->'enumOptions' ELSE '[]'::jsonb END AS opts
    FROM chain c
    JOIN "profile_properties" pp ON pp.profile_id = c.ancestor_id AND pp.is_lifecycle
    JOIN "property_defs" pd ON pd.id = pp.property_def_id
   ORDER BY c.profile_id, c.depth
),
initial AS (
  SELECT DISTINCT ON (d.profile_id)
         d.profile_id, d.slug, d.default_value #>> '{}' AS val, o->>'category' AS cat
    FROM decl d CROSS JOIN LATERAL jsonb_array_elements(d.opts) o
   WHERE jsonb_typeof(d.default_value) = 'string'
     AND o->>'key' = d.default_value #>> '{}'
     AND o->>'category' IN ('open','active','paused')
     AND (o->'humanOnly') IS DISTINCT FROM 'true'::jsonb
   ORDER BY d.profile_id
)
UPDATE "entity_facets" x
   SET status = i.val,
       status_category = i.cat,
       properties = COALESCE(x.properties, '{}'::jsonb) || jsonb_build_object(i.slug, i.val)
  FROM initial i
 WHERE x.profile_id = i.profile_id
   AND x.deleted_at IS NULL
   AND x.status IS NULL
   AND NULLIF(x.properties->>i.slug, '') IS NULL;
