-- 0176_messages_edited_at.sql
-- Adds an edit marker to messages: `edited_at` is set to NOW() when a user edits
-- their own message content (see chat router `updateMessage`). NULL = never edited.
-- Idempotent per repo migration rules.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;
