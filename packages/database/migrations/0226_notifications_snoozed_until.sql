-- 0226: notifications snooze (triage-defer)
--
-- Adds `snoozed_until` so a notification can be deferred (Linear-style): the
-- reader sets status='snoozed' + snoozed_until, hides it from active/unread
-- lists until that instant, then flips it back to 'unread'. The `snoozed`
-- status value needs NO DB change — `status` is a plain text column (the enum
-- is enforced in the Drizzle/TS layer, no CHECK constraint), so it already
-- accepts the new value. Only the timestamp column is new.
--
-- Idempotent per the migration contract. Also mirrored into 0000_baseline_schema.sql.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;

-- Hot path: the reader wakes due snoozes (`status='snoozed' AND snoozed_until <= now()`)
-- and lists a user's snoozed items. Partial index keeps it small (snoozed is a
-- minority state), mirroring the unread partial index.
CREATE INDEX IF NOT EXISTS "notifs_snoozed_until_idx"
  ON "notifications" ("user_id", "snoozed_until")
  WHERE "status" = 'snoozed';
