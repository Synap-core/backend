-- 0312: "Remove for good" for a revoked Application (Connected North Star).
--
-- A revoked app stays listed in a collapsed "Removed" group so its history is
-- reachable; its owner may then hide it permanently. That is a SOFT hide:
-- `removed_at` drops the app from every listing, while the row and its events
-- (`events.app_id`) are kept — history is never deleted. Only a revoked app can
-- be removed (enforced in the app-connect service). Re-registering the same
-- name revives the row (clears both stamps), like a revoked app.
--
-- Nullable, no default — every existing app stays visible. Idempotent.

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "removed_at" timestamptz;
