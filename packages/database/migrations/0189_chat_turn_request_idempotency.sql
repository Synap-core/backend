-- A request id represents one user intent before Home has resolved a channel.
-- Keep this additive: Pods that already ran 0187 must receive the corrected
-- uniqueness constraint rather than silently retaining channel-scoped retries.
DROP INDEX IF EXISTS "chat_turns_user_channel_request_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "chat_turns_user_request_unique"
  ON "chat_turns" ("user_id", "request_id");
