-- 0255_calendar_feed_tokens.sql
--
-- Personal ICS calendar-feed tokens. One live token per user (v1).
-- Plaintext is shown once at mint/rotate; only sha256 hex is stored.

CREATE TABLE IF NOT EXISTS "calendar_feed_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "token_lookup_hash" text NOT NULL,
  "token_prefix" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_accessed_at" timestamptz,
  "revoked_at" timestamptz
);

ALTER TABLE "calendar_feed_tokens" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "calendar_feed_tokens" ADD COLUMN IF NOT EXISTS "token_lookup_hash" text;
ALTER TABLE "calendar_feed_tokens" ADD COLUMN IF NOT EXISTS "token_prefix" text;
ALTER TABLE "calendar_feed_tokens" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "calendar_feed_tokens" ADD COLUMN IF NOT EXISTS "last_accessed_at" timestamptz;
ALTER TABLE "calendar_feed_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;

DO $$ BEGIN
  ALTER TABLE "calendar_feed_tokens" ALTER COLUMN "user_id" SET NOT NULL;
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "calendar_feed_tokens" ALTER COLUMN "token_lookup_hash" SET NOT NULL;
EXCEPTION WHEN others THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_feed_tokens_user_id_uidx"
  ON "calendar_feed_tokens" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_feed_tokens_token_lookup_hash_uidx"
  ON "calendar_feed_tokens" ("token_lookup_hash");
