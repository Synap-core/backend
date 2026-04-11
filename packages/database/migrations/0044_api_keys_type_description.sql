-- Migration 0044: Add keyType and description to api_keys
--
-- Improves clarity of API key purpose:
--   keyType: categorical label (hub_inbound | user_pat | system)
--   description: free-text human-readable explanation of what this key is for
--
-- keyType values:
--   hub_inbound - External service authenticating TO the backend (OpenClaw, ZeroClaw, etc.)
--   user_pat    - Personal access token for human API access (future)
--   system      - Internal or bootstrap keys (legacy)

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS key_type TEXT NOT NULL DEFAULT 'hub_inbound'
    CHECK (key_type IN ('hub_inbound', 'user_pat', 'system')),
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Backfill: keys with keyPrefix = 'synap_user_' are user PATs
UPDATE api_keys SET key_type = 'user_pat' WHERE key_prefix = 'synap_user_';

COMMENT ON COLUMN api_keys.key_type IS 'hub_inbound: external service auth token | user_pat: human user PAT | system: internal bootstrap key';
COMMENT ON COLUMN api_keys.description IS 'Human-readable explanation of what this key is used for';
