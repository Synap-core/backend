-- 0105_ai_provider_credentials.sql
--
-- Per-workspace and per-user AI provider key overrides.
-- Resolution order at inference time: user-level > workspace-level > pod-wide.
-- Keys are server-side encrypted (same scheme as ai_providers.encrypted_api_key).

CREATE TABLE IF NOT EXISTS ai_provider_credentials (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       text        NOT NULL,
  workspace_id      uuid,
  user_id           text,
  encrypted_api_key text        NOT NULL,
  enabled           boolean     NOT NULL DEFAULT true,
  priority          integer     NOT NULL DEFAULT 10,
  created_by        text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- at least one of workspace_id or user_id must be set (enforced in app layer)
  CONSTRAINT ai_provider_credentials_unique UNIQUE (provider_id, workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS ai_provider_credentials_workspace_idx ON ai_provider_credentials (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_provider_credentials_user_idx      ON ai_provider_credentials (user_id)      WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_provider_credentials_provider_idx  ON ai_provider_credentials (provider_id);
