-- 0374: indexes for the HOLD reads (status-flow W4).
--
-- A pause's hold has no column: it travels in the transition that entered the
-- pause, and the current hold is read off this table by ONE helper,
-- `listHolds` (@synap/database services/lifecycle/holds.ts). Two of its
-- questions run often enough to need an index:
--
--   (1) "which holds wait on the thing that just moved?" — asked by the
--       hold-resume job on EVERY transition (its reactor). PARTIAL on the rows
--       that carry an `until.moves`, a small minority of transitions.
--   (2) "is this the subject's latest transition?" — the NOT EXISTS every
--       hold read runs per candidate, and the read of given subjects. The
--       expression is the one `listHolds` writes (a row owed before W1 names
--       only `entityId`), with `created_at` for the order.
--
-- Plain (not CONCURRENTLY): the migration runner applies each file in a
-- transaction, and the table is small (one row per status move). Idempotent.

CREATE INDEX IF NOT EXISTS "lifecycle_transition_outbox_hold_moves_idx"
  ON "lifecycle_transition_outbox" (((transition -> 'hold' -> 'until' ->> 'moves')))
  WHERE (transition -> 'hold' -> 'until' ->> 'moves') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "lifecycle_transition_outbox_subject_idx"
  ON "lifecycle_transition_outbox"
  ((coalesce(transition ->> 'subjectId', transition ->> 'entityId')), "created_at");
