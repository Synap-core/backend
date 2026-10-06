-- 0310: app attribution on the write record (App Connect v1).
--
-- A write made with an APP's key is today attributed to the connecting HUMAN
-- (the key's linked user); the app identity (`grants.client_id`) is loaded at
-- auth and then dropped. This records it, so a governed write can say "via
-- <app>" ALONGSIDE the human — on the proposal a reviewer reads and on the
-- immutable event spine.
--
--   proposals.app_id — the `public_id` (`app_<uuid>`) of the app whose key
--     filed the proposal, stamped from `getRequestGrant()?.clientId`.
--   events.app_id    — the same, on the write event, next to `user_id` (the
--     connecting human). NEVER smuggled into `source`.
--
-- Both are plain `text` (NOT a FK): the `apps` row is revocable and events are
-- immutable history, so an attribution must survive an app revoke/delete.
-- Nullable, no default — a bare/human write leaves NULL. Idempotent.

ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "app_id" text;
ALTER TABLE "events"    ADD COLUMN IF NOT EXISTS "app_id" text;
