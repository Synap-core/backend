-- ============================================================================
-- 0019_realtime_observe_scope.sql — Realtime observer scope (Phase 3A, Eve OS)
-- ============================================================================
--
-- Phase 3A of the Eve OS vision adds an API-key path to the Socket.IO
-- `/presence` handshake so the Eve dashboard can subscribe to realtime
-- workspace events without holding a Synap user session. Auth is handled
-- entirely through the existing `api_keys` table:
--
--   • A new scope `realtime:observe` (TypeScript-side, in
--     `api-keys.ts:API_KEY_SCOPES`) governs realtime subscription.
--   • A new `keyType` value `'service'` flags service-account keys for
--     audit/UI separation. The column is plain `text` with no DB-level
--     enum constraint, so this migration is documentation-only — adding
--     'service' on the schema/TS side is enough for it to round-trip.
--
-- Why no DDL is strictly required:
--   • `api_keys.scope` is `text[]` — scope strings are free-form on the DB
--     side. The whitelist lives in TypeScript (`API_KEY_SCOPES`).
--   • `api_keys.key_type` is `text` with no CHECK constraint. New values
--     fit without schema change.
--
-- Why we still ship this file:
--   • Paper trail. Migrations are the canonical change log; future readers
--     should be able to grep `git log -- migrations/` and find when the
--     realtime path landed without spelunking through TypeScript history.
--   • Adds a partial index that speeds up the "find a service key by
--     prefix when this scope is in scopes[]" lookup the realtime
--     authenticator does on every handshake. Optional but cheap.
--
-- Idempotent — safe to re-apply.
-- ============================================================================

-- ─── 1. Documenting comment on api_keys.key_type ────────────────────────────
COMMENT ON COLUMN "api_keys"."key_type" IS
  'Categorical purpose label: hub_inbound | user_pat | system | service. '
  '''service'' is for service-account keys (e.g. the Eve realtime observer).';

-- ─── 2. Index supporting realtime-observer lookups ──────────────────────────
-- The realtime authenticator (synap-backend/packages/realtime/src/api-key-auth.ts)
-- looks up active keys by prefix. Most pods will have <50 active keys, so
-- this is overkill for now — but the partial index keeps the lookup at O(1)
-- once a pod accumulates many revoked or expired rows for the same prefix.
-- The expression `'realtime:observe' = ANY(scope)` matches the runtime check.
CREATE INDEX IF NOT EXISTS "api_keys_realtime_observe_idx"
  ON "api_keys" ("key_prefix")
  WHERE "is_active" = true
    AND 'realtime:observe' = ANY("scope");
