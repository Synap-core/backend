-- Migration 0022: Add messaging_accounts table for provider-agnostic messaging connector
--
-- Stores one row per user+platform connected account (e.g. a user's LinkedIn account).
-- external_id is the provider's account identifier (Unipile account_id).

CREATE TABLE IF NOT EXISTS messaging_accounts (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'connected',
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messaging_accounts_user_id
  ON messaging_accounts(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_accounts_user_provider_external
  ON messaging_accounts(user_id, provider, external_id);
