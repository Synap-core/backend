-- 0333_user_preferences_home_last_seen
--
-- When the person last had Home on screen: the window Home's brief counts
-- "while you were away" over. It lived in each device's localStorage, so a
-- second device (the phone) counted its own window. One nullable column on the
-- person's own preferences row (one row per user, owner-floored by the access
-- layer); written by `preferences.markHomeSeen` (now()), read by
-- `lifecycle.home` (`homeLastSeenAt`). NULL = never stamped.
--
-- NO INDEX: read by primary key only. Fresh installs also get the column from
-- 0000_baseline_schema.sql; this file is for pods that already booted.

ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "home_last_seen_at" timestamp with time zone;
