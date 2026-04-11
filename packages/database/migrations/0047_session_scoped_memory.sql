-- Migration 0047: Session-Scoped Memory System
--
-- Implements the data layer for session-scoped AI memory (PRD: Session-Scoped AI Memory System).
--
-- What this adds:
--   1. sessions table          — tracks bounded interaction periods per channel
--   2. compacted_states table  — structured memory snapshots (5 blocks) produced by compaction engine
--   3. messages.session_id     — links each message to its session
--   4. channel_context_items.relevance_score — set during compaction to rank entity importance
--   5. channels.result_summary             — branch result on completion
--   6. channels.merged_into_state_id       — which compacted state incorporated branch results
--
-- All new columns are nullable — zero behavior change for existing data.
-- The compaction engine and session lifecycle run forward-only;
-- no backfill of existing messages is required.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. sessions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id          uuid        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,

  -- Links to compacted states (FKs added after compacted_states exists below)
  bootstrap_state_id  uuid,
  produced_state_id   uuid,

  -- Metrics
  total_tokens_used   integer     NOT NULL DEFAULT 0,
  message_count       integer     NOT NULL DEFAULT 0,
  compaction_count    integer     NOT NULL DEFAULT 0,

  -- Lifecycle: active → compacting → closed
  status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'compacting', 'closed'))
);

CREATE INDEX IF NOT EXISTS sessions_channel_id_idx
  ON sessions (channel_id);

CREATE INDEX IF NOT EXISTS sessions_channel_status_idx
  ON sessions (channel_id, status);

CREATE INDEX IF NOT EXISTS sessions_started_at_idx
  ON sessions (channel_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. compacted_states
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS compacted_states (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id            uuid        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id            uuid        REFERENCES sessions(id) ON DELETE SET NULL,
  version               integer     NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- The five memory blocks
  identity_block        text        NOT NULL DEFAULT '',
  user_model_block      text        NOT NULL DEFAULT '',
  continuity_block      text        NOT NULL DEFAULT '',
  active_goals_block    text        NOT NULL DEFAULT '',
  entity_context_block  text        NOT NULL DEFAULT '',

  -- Compression metrics
  raw_token_count       integer,
  compressed_token_count integer,

  -- Operational metadata
  compaction_model      text,
  metadata              jsonb,

  UNIQUE(channel_id, version)
);

CREATE INDEX IF NOT EXISTS compacted_states_channel_version_idx
  ON compacted_states (channel_id, version DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add FK constraints from sessions to compacted_states
--    (circular dep — sessions refs compacted_states, compacted_states refs sessions)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sessions
  ADD CONSTRAINT sessions_bootstrap_state_id_fk
    FOREIGN KEY (bootstrap_state_id) REFERENCES compacted_states(id) ON DELETE SET NULL;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_produced_state_id_fk
    FOREIGN KEY (produced_state_id) REFERENCES compacted_states(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. messages.session_id
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_session_id_idx
  ON messages (session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. channel_context_items.relevance_score
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE channel_context_items
  ADD COLUMN IF NOT EXISTS relevance_score real;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. channels: result_summary + merged_into_state_id
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS result_summary text;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS merged_into_state_id uuid
    REFERENCES compacted_states(id) ON DELETE SET NULL;
