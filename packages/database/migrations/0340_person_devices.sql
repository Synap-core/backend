-- 0340 — signed-in devices of the Synap apps (join plan target A, founder
-- decision `decision:join-target-a-2026-10-21`: access 1 h, refresh rotating
-- with family revoke, 30-day idle expiry, 180-day absolute cap).
--
-- A FIRST-PARTY client (Synap Desktop, Synap Relay — `FIRST_PARTY_CLIENTS`,
-- routers/oauth/config.ts) that signs a person in through the pod's own OAuth
-- server gets one DEVICE: a row here, listed to the person and revocable.
--
--   person_devices        one per sign-in (= one refresh family). `expires_at`
--                         is the absolute cap; `revoked_at` ends it, and with
--                         it every access token and refresh token it holds.
--   person_device_tokens  its short-lived ACCESS tokens. Only sha256(token) is
--                         stored, looked up by that hash (no bcrypt per
--                         request, unlike `api_keys`). Accepted ONLY on the
--                         app API (/trpc, realtime); /mcp and Hub REST refuse
--                         them (they are not `api_keys` rows).
--
-- The device's REFRESH tokens live in `oauth_refresh_tokens` beside a pod
-- app's, with the same single-use / reuse-kills-the-family rules: a row now
-- belongs to EXACTLY ONE owner, a pod app connection (`app_id`) or a device
-- (`device_id`). `app_id` therefore loses its NOT NULL; the CHECK keeps every
-- existing row valid (each has an `app_id` and no `device_id`).
--
-- `person_devices.auth_time` (and the code's `auth_time` that feeds it) is
-- the step-up clock: when the person last really signed in for that device.
--
-- Forward-only and idempotent (IF [NOT] EXISTS throughout). Fresh installs get
-- the same statements from 0000_baseline_schema.sql.

CREATE TABLE IF NOT EXISTS "person_devices" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_id"      text NOT NULL,
  "label"          text,
  "user_agent"     text,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at"   timestamp with time zone,
  "expires_at"     timestamp with time zone NOT NULL,
  "revoked_at"     timestamp with time zone,
  "revoked_reason" text,
  "auth_time"      timestamp with time zone
);

-- When the person last really AUTHENTICATED for this device (a password,
-- passkey or Cloud login at /authorize; a step-up refreshes it, a token
-- refresh never does). Credential doors accept a device only within minutes
-- of it. ADD COLUMN too, for a pod that ran an earlier draft of this file.
ALTER TABLE "person_devices" ADD COLUMN IF NOT EXISTS "auth_time" timestamp with time zone;

-- A person's devices (the devices list, revoke-all).
CREATE INDEX IF NOT EXISTS "person_devices_user_idx"
  ON "person_devices" ("user_id");

CREATE TABLE IF NOT EXISTS "person_device_tokens" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL,
  "device_id"  uuid NOT NULL REFERENCES "person_devices"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "person_device_tokens_token_hash_uidx"
  ON "person_device_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "person_device_tokens_device_idx"
  ON "person_device_tokens" ("device_id");

-- The authorization code carries the consenting session's real
-- `authenticated_at` to /token, which copies it onto the device.
ALTER TABLE "oauth_authorization_codes"
  ADD COLUMN IF NOT EXISTS "auth_time" timestamp with time zone;

ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "app_id" DROP NOT NULL;
ALTER TABLE "oauth_refresh_tokens"
  ADD COLUMN IF NOT EXISTS "device_id" uuid
  REFERENCES "person_devices"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_device_idx"
  ON "oauth_refresh_tokens" ("device_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_refresh_tokens_one_owner_chk'
  ) THEN
    ALTER TABLE "oauth_refresh_tokens"
      ADD CONSTRAINT "oauth_refresh_tokens_one_owner_chk"
      CHECK (true);
  END IF;
END $$;
