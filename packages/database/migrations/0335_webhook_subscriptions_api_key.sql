-- 0335_webhook_subscriptions_api_key
--
-- S2 (founder decision 2026-10-20): a webhook subscription is tied to the API
-- key that created it. `api_key_id` names that key; NULL = created by a human
-- session (or the server), which keeps today's owner-wide delivery. A key-bound
-- subscription is delivered only while its key is live (checked at delivery
-- time) and only what the key's grant can read (D7).
--
-- ON DELETE CASCADE, not SET NULL: a hard-deleted key must take its
-- subscriptions with it. A NULL would turn a key-bound row into a session row,
-- i.e. widen it to everything its owner can read.
--
-- Index: the delivery path joins on it, and listing a key's own rows filters
-- on it. Fresh installs also get the column from 0000_baseline_schema.sql;
-- this file is for pods that already booted.

ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_api_key_id_idx"
  ON "webhook_subscriptions" ("api_key_id");
