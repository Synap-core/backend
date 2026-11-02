-- 0391 — `related_to` → `relates_to` (wave 0 lane B, pod session 1aa7937b).
--
-- `relates_to` is the relation the pod defines (`default-relation-defs.ts`);
-- `related_to` was never a relation def, only a leftover spelling: the AI
-- relationship vocabulary (`@synap-core/core` AIRelationshipMetadataSchema,
-- `entity_relationships.relationship_type`) and edges replayed by peer sync
-- (`sync-materializer.ts`, a direct insert). From this release no code writes
-- it (`canonicalRelationType`, `@synap-core/core`); readers still accept it.
-- This rewrites the rows already stored, in the two link stores that can hold
-- it. No column changes: the baseline needs nothing.
--
-- ── Uniqueness ───────────────────────────────────────────────────────────────
-- Both stores are unique on the edge INCLUDING its type, so an edge stored
-- under both spellings would collide on rename. The `related_to` twin is then
-- deleted (the `relates_to` row already says the same thing), and only then is
-- the rest renamed:
--   · relations: 0239's two partial unique indexes — workspace edges keyed on
--     (source, target, type, workspace_id), pod-wide edges on
--     (source, target, type, user_id), entity↔entity only;
--   · entity_relationships: UNIQUE (source, target, relationship_type).
--
-- ── A pod that DEFINED `related_to` ─────────────────────────────────────────
-- A person may have created a `related_to` relation def. Its edges are then
-- that def's, not a misspelling, so `relations` is left untouched on such a
-- pod (and a NOTICE says so). `entity_relationships` has no defs: it always
-- converges.
--
-- Idempotent: a second run finds no `related_to` row and changes nothing.

DO $$
DECLARE
  has_def      boolean := false;
  twins_rel    bigint  := 0;
  renamed_rel  bigint  := 0;
  twins_er     bigint  := 0;
  renamed_er   bigint  := 0;
BEGIN
  IF to_regclass('public.relation_defs') IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM relation_defs WHERE slug = 'related_to')
      INTO has_def;
  END IF;

  IF to_regclass('public.relations') IS NOT NULL AND NOT has_def THEN
    -- 1. The `related_to` twin of an edge already stored as `relates_to`,
    --    under the same key as the unique index that would refuse the rename.
    DELETE FROM relations r
    USING relations t
    WHERE r.type = 'related_to'
      AND t.type = 'relates_to'
      AND r.source_kind = 'entity' AND r.target_kind = 'entity'
      AND t.source_kind = 'entity' AND t.target_kind = 'entity'
      AND r.source_entity_id = t.source_entity_id
      AND r.target_entity_id = t.target_entity_id
      AND (
        (r.workspace_id IS NOT NULL AND r.workspace_id = t.workspace_id)
        OR (r.workspace_id IS NULL AND t.workspace_id IS NULL
            AND r.user_id = t.user_id)
      );
    GET DIAGNOSTICS twins_rel = ROW_COUNT;

    -- 2. Every other `related_to` edge takes the canonical spelling.
    UPDATE relations SET type = 'relates_to' WHERE type = 'related_to';
    GET DIAGNOSTICS renamed_rel = ROW_COUNT;
  END IF;

  IF to_regclass('public.entity_relationships') IS NOT NULL THEN
    DELETE FROM entity_relationships r
    USING entity_relationships t
    WHERE r.relationship_type = 'related_to'
      AND t.relationship_type = 'relates_to'
      AND r.source_entity_id = t.source_entity_id
      AND r.target_entity_id = t.target_entity_id;
    GET DIAGNOSTICS twins_er = ROW_COUNT;

    UPDATE entity_relationships
      SET relationship_type = 'relates_to'
      WHERE relationship_type = 'related_to';
    GET DIAGNOSTICS renamed_er = ROW_COUNT;
  END IF;

  -- Migrations run unattended at pod start: the log line is the only record
  -- of what this changed.
  IF has_def THEN
    RAISE NOTICE '[0391] relations left as they are: this pod defines a related_to relation def';
  END IF;
  RAISE NOTICE '[0391] relations: % renamed, % duplicate twins removed; entity_relationships: % renamed, % duplicate twins removed',
    renamed_rel, twins_rel, renamed_er, twins_er;
END $$;
