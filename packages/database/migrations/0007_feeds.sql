-- Feeds: long-running AI researcher rows bound 1:1 to FEED-type channels.
-- Each feed has a natural-language `criteria`, a schedule, and a status.
-- Source subscriptions (binding feeds to source_configs) live in a sibling
-- table owned by the source-configs work and reference feeds.id.

CREATE TABLE IF NOT EXISTS "feeds" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        text NOT NULL,
  "workspace_id"   uuid,
  "name"           text NOT NULL,
  "feed_type"      text NOT NULL,
  "criteria"       text NOT NULL,
  "channel_id"     uuid NOT NULL,
  "schedule_cron"  text NOT NULL DEFAULT '*/15 * * * *',
  "status"         text NOT NULL DEFAULT 'active',
  "error_message"  text,
  "last_run_at"    timestamp with time zone,
  "next_run_at"    timestamp with time zone,
  "item_count"     integer NOT NULL DEFAULT 0,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "feeds_feed_type_check" CHECK (
    feed_type IN ('leads', 'hiring', 'investors', 'trends', 'competitors', 'press')
  ),
  CONSTRAINT "feeds_status_check" CHECK (
    status IN ('active', 'paused', 'error')
  )
);

CREATE INDEX IF NOT EXISTS "idx_feeds_user"     ON "feeds" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_feeds_status"   ON "feeds" ("status");
CREATE INDEX IF NOT EXISTS "idx_feeds_next_run" ON "feeds" ("next_run_at");
CREATE INDEX IF NOT EXISTS "idx_feeds_channel"  ON "feeds" ("channel_id");
