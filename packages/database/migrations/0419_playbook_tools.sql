-- 0419_playbook_tools
--
-- ONE `tools` field on a playbook and its stages (plan 08e4fba7, founder
-- decisions 3 and 4, 9 Nov 2026). A run gets the floor of its class plus this
-- list and nothing else ("only these"); a stage's `tools` narrows it.
--
-- FOLDED IN, the four places a run's tools were declared until now:
--   1. `playbooks.required_intents` (0291), intent slugs;
--   2. the playbook's `grants` links (playbook --grants--> tool | skill |
--      command | capability): the target's NAME when it is a tool or a skill
--      row, else its id (the resolver matches a capability by name or id);
--   3. `stages[].grants` ({kind, id}): each id joins the stage's `tools` and
--      the playbook's (a stage list is a subset of its playbook's); the
--      stage's `grants` key is removed;
--   4. the playbook's space `settings.taskIntents`: they were offered to every
--      run of every playbook in that space.
--
-- NEVER BREAK AN INSTALLED RUN: until now every IS run got 19 core tools, of
-- which a SHORT run (an `is-agent` / `hybrid` playbook with at most 2 stages
-- and no gate, `runClassOf` in `@synap/playbooks`) now keeps only the 6 reads
-- of its floor. So each existing short playbook (and each of its stages that
-- now carries a list) also gets the 13 write tools it had; the catalog's next
-- update of its space replaces them with the playbook's own lean list.
--
-- `required_intents` STAYS one release, unread and unwritten (the Drizzle
-- schema no longer has it), so a rollback to the previous release still
-- boots; a later migration drops it. The `grants` LINKS stay: they also carry
-- governance (a follow's grant widening), not run tools.
--
-- Kept versions (`playbook_versions`, 0416) are history and stay as they
-- were: their only reader (`stage-uses.ts`) reads a version's name, stages
-- and params, never its tools.
--
-- Fresh installs get the column from 0000_baseline_schema.sql. Re-runnable:
-- every fold is a de-duplicated union.

ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "tools" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The short-class write tools: the long floor minus the short floor.
WITH short_writes AS (
  SELECT '["list_profiles","get_profile","create_entity","update_entity","update_entities","create_document","update_document","create_relation","propose_entity_graph","resolve_identity","attach_facet","update_facet","detach_facet"]'::jsonb AS w
),
klass AS (
  SELECT
    p."id",
    (
      p."executor" IN ('is-agent', 'hybrid')
      AND jsonb_typeof(p."stages") = 'array'
      AND jsonb_array_length(p."stages") < 3
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p."stages") s
        WHERE jsonb_typeof(s) = 'object' AND s ? 'gate' AND s -> 'gate' <> 'null'::jsonb
      )
    ) AS is_short
  FROM "playbooks" p
),
-- Every source, each entry with its order (source rank, then position).
entries AS (
  SELECT p."id", 0 AS src, e.ord, e.v
  FROM "playbooks" p,
    jsonb_array_elements_text(CASE WHEN jsonb_typeof(p."tools") = 'array' THEN p."tools" ELSE '[]'::jsonb END)
      WITH ORDINALITY e(v, ord)
  UNION ALL
  SELECT p."id", 1, e.ord, e.v
  FROM "playbooks" p,
    jsonb_array_elements_text(CASE WHEN jsonb_typeof(p."required_intents") = 'array' THEN p."required_intents" ELSE '[]'::jsonb END)
      WITH ORDINALITY e(v, ord)
  UNION ALL
  SELECT p."id", 2, row_number() OVER (PARTITION BY p."id" ORDER BY l."created_at", l."id"),
    COALESCE(t."name", sk."name", l."to_id")
  FROM "playbooks" p
  JOIN "links" l
    ON l."from_type" = 'playbook' AND l."from_id" = p."id"::text AND l."link_type" = 'grants'
  LEFT JOIN "tools" t ON l."to_type" = 'tool' AND t."id"::text = l."to_id"
  LEFT JOIN "skills" sk ON l."to_type" = 'skill' AND sk."id"::text = l."to_id"
  UNION ALL
  SELECT p."id", 3, (s.sord * 1000 + g.gord), g.g ->> 'id'
  FROM "playbooks" p,
    jsonb_array_elements(CASE WHEN jsonb_typeof(p."stages") = 'array' THEN p."stages" ELSE '[]'::jsonb END)
      WITH ORDINALITY s(stage, sord),
    jsonb_array_elements(CASE WHEN jsonb_typeof(s.stage -> 'grants') = 'array' THEN s.stage -> 'grants' ELSE '[]'::jsonb END)
      WITH ORDINALITY g(g, gord)
  WHERE jsonb_typeof(g.g) = 'object' AND g.g ? 'id'
  UNION ALL
  SELECT p."id", 4, e.ord, e.v
  FROM "playbooks" p
  JOIN "workspaces" w ON w."id" = p."workspace_id",
    jsonb_array_elements_text(CASE WHEN jsonb_typeof(w."settings" -> 'taskIntents') = 'array' THEN w."settings" -> 'taskIntents' ELSE '[]'::jsonb END)
      WITH ORDINALITY e(v, ord)
  UNION ALL
  SELECT k."id", 5, e.ord, e.v
  FROM klass k, short_writes sw,
    jsonb_array_elements_text(sw.w) WITH ORDINALITY e(v, ord)
  WHERE k.is_short
),
firsts AS (
  SELECT "id", btrim(v) AS v, MIN(src * 1000000 + ord) AS rank
  FROM entries
  WHERE v IS NOT NULL AND btrim(v) <> ''
  GROUP BY "id", btrim(v)
),
folded AS (
  SELECT "id", jsonb_agg(to_jsonb(v) ORDER BY rank) AS tools
  FROM firsts
  GROUP BY "id"
)
UPDATE "playbooks" p
SET "tools" = f.tools
FROM folded f
WHERE p."id" = f."id" AND p."tools" IS DISTINCT FROM f.tools;

-- Stages: `grants` → `tools` (plus the short-class writes), the key removed.
WITH short_writes AS (
  SELECT '["list_profiles","get_profile","create_entity","update_entity","update_entities","create_document","update_document","create_relation","propose_entity_graph","resolve_identity","attach_facet","update_facet","detach_facet"]'::jsonb AS w
),
klass AS (
  SELECT
    p."id",
    (
      p."executor" IN ('is-agent', 'hybrid')
      AND jsonb_array_length(p."stages") < 3
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p."stages") s
        WHERE jsonb_typeof(s) = 'object' AND s ? 'gate' AND s -> 'gate' <> 'null'::jsonb
      )
    ) AS is_short
  FROM "playbooks" p
  WHERE jsonb_typeof(p."stages") = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p."stages") s
      WHERE jsonb_typeof(s) = 'object' AND s ? 'grants'
    )
),
rewritten AS (
  SELECT
    k."id",
    jsonb_agg(
      CASE
        WHEN jsonb_typeof(s.stage) = 'object' AND s.stage ? 'grants' THEN
          (s.stage - 'grants') || jsonb_build_object(
            'tools',
            (
              SELECT COALESCE(jsonb_agg(to_jsonb(d.v) ORDER BY d.rank), '[]'::jsonb)
              FROM (
                SELECT btrim(x.v) AS v, MIN(x.rank) AS rank
                FROM (
                  SELECT e.v, e.ord AS rank
                  FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.stage -> 'tools') = 'array' THEN s.stage -> 'tools' ELSE '[]'::jsonb END)
                    WITH ORDINALITY e(v, ord)
                  UNION ALL
                  SELECT g.g ->> 'id', 1000 + g.gord
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.stage -> 'grants') = 'array' THEN s.stage -> 'grants' ELSE '[]'::jsonb END)
                    WITH ORDINALITY g(g, gord)
                  WHERE jsonb_typeof(g.g) = 'object' AND g.g ? 'id'
                  UNION ALL
                  SELECT e.v, 100000 + e.ord
                  FROM short_writes sw, jsonb_array_elements_text(sw.w) WITH ORDINALITY e(v, ord)
                  WHERE k.is_short
                ) x
                WHERE x.v IS NOT NULL AND btrim(x.v) <> ''
                GROUP BY btrim(x.v)
              ) d
            )
          )
        ELSE s.stage
      END
      ORDER BY s.sord
    ) AS stages
  FROM klass k
  JOIN "playbooks" p ON p."id" = k."id",
    jsonb_array_elements(p."stages") WITH ORDINALITY s(stage, sord)
  GROUP BY k."id"
)
UPDATE "playbooks" p
SET "stages" = r.stages
FROM rewritten r
WHERE p."id" = r."id";
