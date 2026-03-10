-- Migration: Channel Connections
-- Persistent mapping between external channel users and Synap users.
-- Replaces in-memory user mapping in the channel gateway (Option B architecture).

-- channel_connections: maps external platform user → Synap user + workspace + thread
CREATE TABLE IF NOT EXISTS channel_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         TEXT NOT NULL,          -- 'telegram' | 'whatsapp' | 'discord'
  channel_user_id TEXT NOT NULL,          -- external platform user ID
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  default_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  external_username  TEXT,               -- display name from external platform
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_connections_channel_user_unique UNIQUE (channel, channel_user_id)
);

CREATE INDEX IF NOT EXISTS channel_connections_channel_user_idx
  ON channel_connections (channel, channel_user_id);

CREATE INDEX IF NOT EXISTS channel_connections_user_idx
  ON channel_connections (user_id);

-- channel_link_tokens: single-use tokens for the /link flow in Telegram/WhatsApp
CREATE TABLE IF NOT EXISTS channel_link_tokens (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token            TEXT NOT NULL UNIQUE,  -- short alphanumeric token shown to user
  channel          TEXT NOT NULL,         -- which channel this token is for
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id     UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  default_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS channel_link_tokens_token_idx
  ON channel_link_tokens (token);

CREATE INDEX IF NOT EXISTS channel_link_tokens_user_idx
  ON channel_link_tokens (user_id);

-- Also add a migration to handle existing personal channels becoming pod-wide
-- Personal channels with workspaceId can stay as-is; new ones from Telegram will have null workspaceId
