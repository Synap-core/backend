-- 0342: session runners — who is attached to a session right now.
--
-- One row per (session, client conversation) that held the session's change
-- feed wait (`synap_wait_for_answer`, Hub GET /focus-sessions/:id/answers/wait)
-- while naming its own conversation (`X-Synap-Conversation: <harness>:<id>`).
-- Stamped server-side by the wait, at most once a minute per row — telemetry
-- like `api_keys.last_used_at`, never a governance proposal.
--
-- NOT a column on `focus_sessions`: 0277's row trigger NOTIFYs the session
-- channel on every write there, which would wake the very wait that stamped it.
-- No NOTIFY trigger here for the same reason.
--
-- `user_id` = the session owner (the read floor, as on session_evaluations).
-- `api_key_id` carries no FK: keys are revocable, this is history.

CREATE TABLE IF NOT EXISTS "session_runners" (
  "session_id"      uuid        NOT NULL REFERENCES "focus_sessions"("id") ON DELETE CASCADE,
  "client_key"      text        NOT NULL,
  "user_id"         text        NOT NULL,
  "agent_user_id"   text,
  "api_key_id"      uuid,
  "harness"         text        NOT NULL,
  "conversation_id" text        NOT NULL,
  "cwd"             text,
  "machine_user_id" text,
  "first_seen_at"   timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("session_id", "client_key")
);

CREATE INDEX IF NOT EXISTS "idx_session_runners_session_seen"
  ON "session_runners" ("session_id", "last_seen_at");
