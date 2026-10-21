-- 0338b — pod app sign-in, apps part (spec 17 §8.2, wave PB2).
--
-- Its own file because the migrator records applied files by NAME: a pod that
-- already ran 0338 (the oauth_clients part, PB1) never re-reads it. The name
-- sorts after 0338_pod_app_oauth.sql and before 0339 (the migrator sorts file
-- names), so 0338's columns exist when this runs.
--
-- Additive + idempotent: every statement is IF NOT EXISTS, guarded by
-- pg_constraint, or an UPDATE that a second run finds nothing to change. Fresh
-- installs get the columns from 0000_baseline_schema.sql as well, without the
-- CHECK and the foreign key: this file adds both on every database.
--
-- A pod app connection is an `apps` row with mode 'oauth', owned by the human
-- who consented, keyed by the app's Client ID Metadata Document URL. One row
-- per (human, app): the app's own agent user, its approved reach and its keys
-- hang off it exactly as for an App Connect app.

-- 1. apps: which pod app (CIMD client_id) a mode='oauth' row is.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "oauth_client_id" text;

-- Before 2026-10 the Hub door stored `mode` as a bounded free string (nothing
-- reads it). Only 'specific' was ever implemented, so any other value on a row
-- that is not a pod app connection is 'specific'; without this the CHECK below
-- could fail on a pod with such a row and block the boot.
UPDATE "apps" SET "mode" = 'specific'
  WHERE "oauth_client_id" IS NULL AND "mode" <> 'specific';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apps_mode_check') THEN
    ALTER TABLE "apps" ADD CONSTRAINT "apps_mode_check"
      CHECK ("mode" IN ('specific', 'oauth')
        AND ("mode" = 'oauth') = ("oauth_client_id" IS NOT NULL));
  END IF;
END $$;

-- One connection per (human, app). The (owner, name) index stays: a pod app's
-- row is named "<client_name> (<host>)" and the consent door upserts on this
-- index, never on the name.
CREATE UNIQUE INDEX IF NOT EXISTS "apps_owner_oauth_client_uidx"
  ON "apps" ("owner_user_id", "oauth_client_id")
  WHERE "oauth_client_id" IS NOT NULL;

-- 2. oauth_authorization_codes: the approved app row a pod app's code redeems
-- to (/token mints that app's key). NULL for an MCP (DCR) client's code.
-- Deleting the app deletes its waiting codes.
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "app_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_authorization_codes_app_id_fkey'
  ) THEN
    ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_app_id_fkey"
      FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- 3. oauth_clients: the workspace templates a pod app's document declares
-- (`synap_templates`, Contract B slugs). The consent screen offers to create a
-- space from one when the person has no space to give the app. Empty for DCR.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "requested_templates" text[] NOT NULL DEFAULT '{}';
