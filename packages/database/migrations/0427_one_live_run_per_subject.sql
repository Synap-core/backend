-- 0427_one_live_run_per_subject
--
-- ONE LIVE RUN PER OBJECT (founder, 2026-11-16). A person who clicks a
-- playbook's run button on an object while a run of it is still live there
-- gets that run back ("Running, open it"), not a second run. The run door
-- (`playbooks.run`, and through it Hub REST, MCP and the approved replay)
-- reads for a live run first; this index is the floor under that read, so two
-- clicks that both read "nothing live" cannot both start one.
--
--   one_live_per_subject  TRUE on a run that HOLDS its object's live slot:
--                         a person's run through the run door, without
--                         "start another". FALSE for every other session —
--                         fan-out and hand-off children, automation runs,
--                         "start another" runs. Written once, at birth.
--   uniq_focus_sessions_one_live_run
--                         at most one live (active, paused, forming, stale)
--                         slot-holder per (playbook, subject, owner). The
--                         owner is part of the key: one person's live run
--                         never blocks, nor is returned to, another person.
--                         Ending the run (closed, failed, cancelled) frees
--                         the object; `scheduled` is not live (an appointment
--                         has run nothing). The status list is
--                         LIVE_RUN_SESSION_STATUSES (@synap-core/types),
--                         pinned equal by migrations-0427.pglite.test.ts.
--
-- No backfill: every existing row is FALSE, so the index cannot fail on the
-- duplicate live runs that already exist. Not CONCURRENTLY: the runner wraps
-- each file in a transaction. Mirrored by the Drizzle schema
-- (`focus-sessions.ts`, ONE_LIVE_RUN_INDEX) and required at boot by
-- `findMissingIndexes` (schema-coherence.ts).
--
-- Fresh installs also get this from 0000_baseline_schema.sql. Re-runnable.

ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "one_live_per_subject" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_focus_sessions_one_live_run"
  ON "focus_sessions" ("playbook_id", "subject_entity_id")
  WHERE "status" IN ('active', 'paused', 'forming', 'stale');
