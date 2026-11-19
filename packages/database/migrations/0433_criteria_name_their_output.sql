-- 0433 — a criterion names the output it checks (work-model W4)
--
-- Until now a criterion "checked" a session output only by sharing its key:
-- the outcome projection folded a slot and a criterion under one key into one
-- outcome, and the evidence closers left such a slot to the criterion. From
-- now on the pairing is the criterion's `outputKey` (`criteriaByOutput`,
-- @synap-core/types/units) and a shared key pairs nothing.
--
-- This stamps `outputKey = key` on every stored criterion that shares a key
-- with one of its session's outcome slots, so those pairs read exactly as
-- before. A slot's key is its stored `key`, else (a slot from before keys were
-- stamped) the slug of its label or description, as `slotKeyBase` makes it
-- (lowercase, runs of other characters to `-`, trimmed, at most 48). Two
-- approximations, both safe: accents are not folded (no `unaccent`), so an
-- accented legacy label may miss its pair; collision suffixes (`-2`) are not
-- derived, so a legacy duplicate label pairs with the first slot, as the
-- projection's first holder did. Param and escalated-criterion slots are not
-- outcomes and are never paired. Only keys in the output-key alphabet are
-- written (the write door's rule for `outputKey`). Only sessions with a pair
-- are rewritten (each update fires the session-changed notify).
--
-- Idempotent: a criterion that already names an output is left as it is.

WITH slot_keys AS (
  SELECT fs."id",
    coalesce(
      nullif(btrim(s->>'key'), ''),
      nullif(
        rtrim(
          left(
            btrim(
              regexp_replace(
                lower(coalesce(
                  nullif(btrim(s->>'label'), ''),
                  nullif(btrim(s->>'description'), '')
                )),
                '[^a-z0-9]+', '-', 'g'
              ),
              '-'
            ),
            48
          ),
          '-'
        ),
        ''
      )
    ) AS "key"
  FROM "focus_sessions" AS fs,
    jsonb_array_elements(
      CASE WHEN jsonb_typeof(fs."expected_outputs") = 'array'
        THEN fs."expected_outputs" ELSE '[]'::jsonb END
    ) AS s
  WHERE jsonb_typeof(s) = 'object'
    AND coalesce(s->>'kind', s->>'type', 'output')
      NOT IN ('playbook_param', 'criterion')
),
paired AS (
  SELECT DISTINCT fs."id"
  FROM "focus_sessions" AS fs,
    jsonb_array_elements(
      CASE WHEN jsonb_typeof(fs."criteria") = 'array'
        THEN fs."criteria" ELSE '[]'::jsonb END
    ) AS c
  JOIN slot_keys AS sk ON sk."key" = c->>'key'
  WHERE sk."id" = fs."id"
    AND jsonb_typeof(c) = 'object'
    AND NOT (c ? 'outputKey')
    AND c->>'key' ~ '^[a-z0-9][a-z0-9-]{0,63}$'
)
UPDATE "focus_sessions" AS fs
SET "criteria" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(c) = 'object'
        AND NOT (c ? 'outputKey')
        AND c->>'key' ~ '^[a-z0-9][a-z0-9-]{0,63}$'
        AND c->>'key' IN (
          SELECT sk."key" FROM slot_keys AS sk WHERE sk."id" = fs."id"
        )
      THEN c || jsonb_build_object('outputKey', c->>'key')
      ELSE c
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(fs."criteria") WITH ORDINALITY AS t(c, ord)
)
WHERE fs."id" IN (SELECT "id" FROM paired);
