-- Channel egress outbox (ADDITIVE — Wave A infra only, nothing wired yet).
--
-- Channel-AGNOSTIC outbound action queue. An external adapter (e.g. the Discord
-- bridge) later PULLs pending rows and executes them, so the backend can stop
-- calling external systems (discord.com etc.) directly. No Discord specifics
-- live in column names — `external_source` + `external_id` name the target
-- generically. This wave only creates the table; nothing enqueues yet.
CREATE TABLE IF NOT EXISTS "channel_egress" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "external_source"  text        NOT NULL,              -- e.g. 'discord'
  "external_id"      text        NOT NULL,              -- target channel id in that system
  "kind"             text        NOT NULL,              -- 'post_message' | 'rename_channel' | 'pin_message' | 'scheduled_event'
  "payload"          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "status"           text        NOT NULL DEFAULT 'pending', -- 'pending' | 'delivered' | 'failed'
  "attempts"         integer     NOT NULL DEFAULT 0,
  "last_error"       text,
  "workspace_id"     uuid,                              -- nullable; audit/scoping only
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "delivered_at"     timestamptz
);

-- Idempotent guard for pre-existing tables.
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "external_source" text;
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "external_id" text;
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "payload" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "channel_egress" ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz;

-- Pending poll index: the adapter reads status='pending' ordered by created_at asc.
CREATE INDEX IF NOT EXISTS "channel_egress_status_created_idx"
  ON "channel_egress" ("status", "created_at");
