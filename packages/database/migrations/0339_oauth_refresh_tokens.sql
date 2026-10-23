-- 0339 — pod app refresh tokens (spec 17 §8.3, wave PB3, founder decision F5:
-- access 1 h, refresh rotating with family revoke, 30-day idle expiry, no
-- absolute cap).
--
-- Only sha256(token) is stored. Each token is single-use: redeeming it sets
-- `last_used_at` and mints a successor in the same `family_id` (`replaced_by`
-- points at it). A used token presented again revokes its whole family and
-- the connection's live access key (RFC 9700 §4.14.2). `revoked_at` means
-- killed, never "used". MCP (DCR) clients get no refresh token: no row here.
--
-- One row set per connection (`app_id`, an `apps` row with mode 'oauth');
-- deleting the connection deletes its tokens. Fresh installs also get the
-- table from 0000_baseline_schema.sql; this file is for pods that already
-- booted. Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash"   text NOT NULL,
  "family_id"    uuid NOT NULL,
  "client_id"    text NOT NULL,
  "user_id"      text NOT NULL,
  "app_id"       uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "expires_at"   timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at"   timestamp with time zone,
  "replaced_by"  uuid,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "oauth_refresh_tokens_token_hash_uidx"
  ON "oauth_refresh_tokens" ("token_hash");
-- A connection's tokens: revoke them all (the app revoked, a newer consent)
-- and sweep the expired ones at each issue.
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_app_idx"
  ON "oauth_refresh_tokens" ("app_id");
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_family_idx"
  ON "oauth_refresh_tokens" ("family_id");
