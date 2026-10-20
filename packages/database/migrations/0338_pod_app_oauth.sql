-- 0338 — pod app sign-in, OAuth clients part (spec 17 §8.2, wave PB1).
--
-- Additive + idempotent: every statement is IF NOT EXISTS or guarded by
-- pg_constraint, so a second run is a no-op. Fresh installs also get the
-- columns from 0000_baseline_schema.sql (no CHECK there: this file adds it on
-- every database).
--
-- A pod app identifies itself by a Client ID Metadata Document (CIMD): its
-- `client_id` is the https URL of a JSON document on the app's own domain. The
-- pod fetches that document at /authorize and caches it in `oauth_clients`, the
-- same table that holds the RFC 7591 (DCR) clients claude.ai registers. Every
-- existing row is a DCR row, so the default 'dcr' leaves them unchanged.
--
-- The `apps` part of spec §8.2 (`apps.oauth_client_id`, its CHECK and unique
-- index, `oauth_authorization_codes.app_id`) is wave PB2's, in its own file:
-- the migrator records applied files by name, so it never re-reads this one.

-- 1. oauth_clients: which registration door made the row, and the CIMD cache.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "client_kind" text NOT NULL DEFAULT 'dcr';
-- The document's `client_uri` and `initiate_login_uri` (same origin as the
-- client_id, checked before caching). NULL for DCR rows.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "client_uri" text;
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "initiate_login_uri" text;
-- The grant-grammar permissions the document declares (`synap_requests`). An
-- app's authorize request is narrowed to these. Empty for DCR rows.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "requested_permissions" text[] NOT NULL DEFAULT '{}';
-- When the document was last fetched and validated, until when the copy is
-- fresh (its Cache-Control, floored at 5 min and capped at 24 h), and the
-- sha256 of the bytes it was read from. NULL for DCR rows.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "metadata_fetched_at" timestamp with time zone;
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "metadata_expires_at" timestamp with time zone;
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "metadata_sha256" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_clients_client_kind_check') THEN
    ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_client_kind_check"
      CHECK ("client_kind" IN ('dcr', 'cimd'));
  END IF;
END $$;

-- 2. oauth_authorization_codes: the RFC 8707 resource the authorization was
-- for (`<issuer>/mcp` or `<issuer>/api/hub`), NULL when the client named none.
-- /token refuses a `resource` that differs from it.
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "resource" text;
