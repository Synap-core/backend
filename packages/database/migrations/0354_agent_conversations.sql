-- 0354: agent conversations — the ONE registry of live agent terminals.
--
-- One row per (person, computer, harness, conversation): a Claude Code
-- terminal on the Mac, a CLI conversation on the devbox, bound to a session or
-- not. Written by the heartbeat door (Hub POST /conversations/heartbeat) — an
-- idempotent upsert; `ended_at` set by a heartbeat that says `ended: true`.
-- Telemetry like `api_keys.last_used_at` and `session_runners` (0342): never a
-- governance proposal, it records that a terminal is open and changes nothing
-- a person owns.
--
-- Its link to sessions is `session_runners` (0342), joined on
-- (harness, conversation_id): no session column here, never a second link.
--
-- NEVER stored (the heartbeat codec drops or refuses them before any write):
-- prompt text, pid, tty, resume paths, tokens, full folder paths, account
-- labels. `folder` is a basename; `computer` a normalised host name.
--
-- `user_id` = the person the reporting key acts for (the read floor).
-- `agent_user_id` / `api_key_id` / `machine_user_id` carry no FK: keys are
-- revocable and agents retire, this is history. Ended or abandoned rows are
-- pruned by the focus-session reaper after a week.

CREATE TABLE IF NOT EXISTS "agent_conversations" (
  "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         text        NOT NULL,
  "agent_user_id"   text,
  "api_key_id"      uuid,
  "machine_user_id" text,
  "computer"        text        NOT NULL,
  "harness"         text        NOT NULL,
  "conversation_id" text        NOT NULL,
  "folder"          text,
  "state"           text        NOT NULL,
  "state_since"     timestamptz NOT NULL DEFAULT now(),
  "subagent_count"  integer     NOT NULL DEFAULT 0,
  "first_seen_at"   timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"    timestamptz NOT NULL DEFAULT now(),
  "ended_at"        timestamptz,
  CONSTRAINT "agent_conversations_state_chk"
    CHECK ("state" IN ('working', 'idle', 'waiting')),
  CONSTRAINT "agent_conversations_subagents_chk"
    CHECK ("subagent_count" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_conversations_identity"
  ON "agent_conversations" ("user_id", "computer", "harness", "conversation_id");

CREATE INDEX IF NOT EXISTS "idx_agent_conversations_user_seen"
  ON "agent_conversations" ("user_id", "last_seen_at");
