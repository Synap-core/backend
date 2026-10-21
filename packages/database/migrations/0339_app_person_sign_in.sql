-- 0339 — "Sign in with Synap" for a registered app (founder decision A1, 2026-10-20).
--
-- Additive + idempotent: every statement is IF NOT EXISTS. Fresh installs also
-- get the columns from 0000_baseline_schema.sql.
--
-- A person signs in to an app their pod's owner approved (`apps`, connect
-- approved) through the pod's own OAuth authorization server, with
-- `client_id` = the app's `public_id`. The token minted is an `api_keys` row
-- HELD BY THE PERSON (`key_type` 'app_person'), carrying the app's approved
-- grant narrowed to what the person can reach — so the person's own clicks in
-- the app write as that person, while the app's AI keeps its agent key.

-- 1. apps.redirect_uris — where an authorization code for this app may be
-- delivered. Exact-match allowlist, written only by the app's owner
-- (`setAppRedirectUris`). Empty = the app cannot sign anyone in.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "redirect_uris" text[] NOT NULL DEFAULT '{}';

-- 2. oauth_authorization_codes.app_grant — the `[{ permission, workspaceId }]`
-- the person SAW and approved on the consent screen. /token mints the
-- intersection of this with the app's approval and the person's reach at mint
-- time, so a token is never wider than what was consented to. NULL for every
-- non-app client.
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "app_grant" jsonb;
