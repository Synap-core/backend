-- Migration: 0281_notifications_open_dedupe_key.sql
--
-- W2 "calm": a DB guard behind the notification dedupe window.
--
-- `NotificationService.create()` suppresses a repeat of a windowed type
-- (`dedupeWindowMs` in the registry) by READING for a same-key row first. That
-- read-then-write is not race-safe: two simultaneous events both peek empty and
-- both insert, and the bell and the needs-you badge count one piece of news
-- twice. `dedupe_key` is the windowed type's resolved group key (NULL for every
-- non-windowed type, so `proposal.created` — which legitimately shares a group
-- key across an agent's run — is never constrained), and the partial unique
-- index allows at most ONE open (unread or snoozed) row per (user, key). The
-- writer inserts with ON CONFLICT on this index: a repeat whose window has
-- elapsed REFRESHES the open row (content + created_at — a re-raise, never a
-- second row); a repeat inside the window does nothing.
--
-- `snoozed` is inside the predicate on purpose: the snooze reader flips a due
-- row back to `unread`, and a second open row under the same key would then
-- violate the index on that UPDATE.
--
-- Legacy `session.room_update` rows: the type's producer was retired (founder
-- decision F, 2026-09-25) and the registry now classifies it informational, so
-- open rows no longer count in needs-you. They still inflate the bell's unread
-- count, so they are marked read here, once. A receipt, not a delete.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "dedupe_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "notifs_open_dedupe_key_uq"
  ON "notifications" ("user_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "status" IN ('unread', 'snoozed');

UPDATE "notifications"
   SET "status" = 'read', "read_at" = coalesce("read_at", now())
 WHERE "type" = 'session.room_update'
   AND "status" IN ('unread', 'snoozed');
