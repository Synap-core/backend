-- 0250 — index the "blocked on you" read.
--
-- `focus_sessions` carries nine indexes and NONE on `expected_outputs`, so the
-- pod-wide owed-slot read (`listOwedSlots`) was a sequential scan over every
-- session the user has ever opened — the exact population that only grows.
--
-- WHAT CAN BE INDEXED, AND WHAT CANNOT. The ordering key is `owedSince`, but it
-- lives PER SLOT inside a JSONB array: there is no row-level column to key on,
-- and an index expression may contain neither a subquery nor a set-returning
-- function like `jsonb_array_elements`. So `owedSince` cannot key an index at
-- all without a generated column, and the ordering stays a per-query
-- computation.
--
-- What CAN be served is the positive PREFILTER: `expected_outputs @>
-- '[{"owner": "human"}]'` is immutable and therefore legal in a partial-index
-- predicate. That narrows the scan to sessions that have ever handed a slot to
-- the human — safe because `owner: 'human'` is always written explicitly, so a
-- session this excludes could not have matched the exact predicate either. The
-- exact `IS DISTINCT FROM 'done'` / `retiredAt IS NULL` test then runs on the
-- survivors; containment cannot express a negative and is never asked to.
--
-- Keyed on `user_id` because that is the owner floor every read starts from.
CREATE INDEX IF NOT EXISTS "idx_focus_sessions_owed_outputs"
  ON "focus_sessions" ("user_id")
  WHERE "expected_outputs" @> '[{"owner": "human"}]'::jsonb;
