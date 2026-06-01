-- Migration 0036: channel_members
--
-- Source of truth for GROUP channel membership. Replaces the legacy
-- `metadata.participants` array on the channels row. Each row links a channel
-- to a human user OR an AI agent-user (both live in the `users` table), with a
-- role. Visibility queries join against this table so a group channel is
-- visible to all of its members, not just the creator.

BEGIN;

CREATE TABLE IF NOT EXISTS "channel_members" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
    "member_id" text NOT NULL,
    "member_kind" text NOT NULL,
    "role" text NOT NULL DEFAULT 'member',
    "added_by" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "channel_members_channel_id_idx"
    ON "channel_members" ("channel_id");

CREATE INDEX IF NOT EXISTS "channel_members_member_id_idx"
    ON "channel_members" ("member_id");

CREATE UNIQUE INDEX IF NOT EXISTS "channel_members_channel_member_unique"
    ON "channel_members" ("channel_id", "member_id");

COMMIT;
