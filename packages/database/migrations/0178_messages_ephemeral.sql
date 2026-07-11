-- 0178_messages_ephemeral.sql
-- Adds an ephemeral marker to messages. When TRUE, the message is delivered live
-- over the realtime socket (so the requester sees it in-session) but is EXCLUDED
-- from all channel history/list reads, so it disappears on reload. Powers the
-- "catch me up" recap flow: visible live, gone on refresh. Defaults to false so
-- every existing/normal message stays a durable part of channel history.
-- Idempotent per repo migration rules.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "ephemeral" boolean NOT NULL DEFAULT false;
