-- Migration 0008: Create entity_identity_signals table
--
-- Tracks cross-source identity indicators for entities — email addresses,
-- phone numbers, social handles, profile URLs.
--
-- Purpose: enables O(1) cross-source person dedup. The same contact imported
-- from Telegram (phone) and LinkedIn (email) can be matched once a shared
-- signal is discovered (e.g. LinkedIn profile also has their phone number).
--
-- Values are normalized before storage:
--   email       → lowercase + trimmed
--   phone       → digits only with + prefix, E.164 where possible
--   linkedin_url → lowercase, trailing slash stripped
--   github_username → lowercase
--
-- The UNIQUE constraint on (signal_type, signal_value) enforces that only
-- one entity can own a given identity signal across the entire pod.

CREATE TABLE IF NOT EXISTS entity_identity_signals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

  -- Discriminator: 'email' | 'phone' | 'linkedin_url' | 'github_username' | ...
  signal_type     text        NOT NULL,

  -- Normalized value (see normalization rules above)
  signal_value    text        NOT NULL,

  -- Which import source contributed this signal
  source          text        NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Cross-entity uniqueness: one entity owns each (type, value) pair
CREATE UNIQUE INDEX IF NOT EXISTS entity_identity_signals_type_value_idx
  ON entity_identity_signals(signal_type, signal_value);

-- All signals for an entity (profile view, merge operations)
CREATE INDEX IF NOT EXISTS entity_identity_signals_entity_id_idx
  ON entity_identity_signals(entity_id);

-- Lookup by type (find all phone signals, all email signals)
CREATE INDEX IF NOT EXISTS entity_identity_signals_signal_type_idx
  ON entity_identity_signals(signal_type);
