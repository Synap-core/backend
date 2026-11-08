-- 0408: wait episodes say IN WHICH STATUS a thing waited, and on which
-- blocker (plan e7f753db §9, "blockers, not steps").
--
--   status       the status the subject stood on when the wait was first
--                found (an entity's own, a role facet's, a goal's, a
--                session's); NULL when it has none. Written once, at open:
--                the episode is keyed by the wait, not the status.
--   blocker_key  the owed slot's declared blocker name (`not_connected`),
--                NULL for every other wait.
--
-- What the recurrence scanner groups repeats by: (kind or role, status,
-- blocker). No backfill: episodes opened before this read NULL ("not
-- recorded"), never a guessed status.
-- Fresh installs get the columns from 0000_baseline_schema.sql. Idempotent.

ALTER TABLE "status_wait_episode" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "status_wait_episode" ADD COLUMN IF NOT EXISTS "blocker_key" text;
