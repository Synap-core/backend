-- Durable sender turn journal.  Kept separate from messages so message history
-- remains a stable domain timeline while active/reconnectable transport state
-- has explicit ownership and ordering.
CREATE TABLE IF NOT EXISTS "chat_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "request_id" uuid NOT NULL,
  -- IDs are allocated before the assistant row exists. Deliberately no FK:
  -- a failed/cancelled turn may never produce that message row.
  "user_message_id" uuid NOT NULL,
  "assistant_message_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'running' CHECK ("status" IN ('running', 'completed', 'failed', 'cancelled')),
  "cancel_requested" boolean NOT NULL DEFAULT false,
  "last_event_seq" integer NOT NULL DEFAULT 0,
  "error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_turns_user_request_unique"
  ON "chat_turns" ("user_id", "request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "chat_turns_user_message_unique"
  ON "chat_turns" ("user_message_id");
CREATE UNIQUE INDEX IF NOT EXISTS "chat_turns_assistant_message_unique"
  ON "chat_turns" ("assistant_message_id");
CREATE INDEX IF NOT EXISTS "chat_turns_channel_started_idx"
  ON "chat_turns" ("channel_id", "started_at");

CREATE TABLE IF NOT EXISTS "chat_turn_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "turn_id" uuid NOT NULL REFERENCES "chat_turns"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "event_id" uuid NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_turn_events_turn_seq_unique"
  ON "chat_turn_events" ("turn_id", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "chat_turn_events_event_id_unique"
  ON "chat_turn_events" ("event_id");
CREATE INDEX IF NOT EXISTS "chat_turn_events_turn_seq_idx"
  ON "chat_turn_events" ("turn_id", "seq");
