-- 0375: when a notification's push was SENT (status-flow W6, plan Q4.1).
--
-- The interruption budget caps a person's pushes at 3 a day ("something you
-- own broke" exempt). `NotificationService.create` stamps `pushed_at` on the
-- row it pushes; `push-decision.ts` counts the person's rows pushed since the
-- start of their day. NULL = never pushed (in-app only, muted, quiet hours,
-- not earned, or held back by the cap). No backfill: the count starts today.
--
-- Plain (not CONCURRENTLY): the migration runner applies each file in a
-- transaction. Idempotent.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "pushed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "notifs_user_pushed_idx"
  ON "notifications" ("user_id", "pushed_at")
  WHERE "pushed_at" IS NOT NULL;
