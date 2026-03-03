-- Migration: 0036_service_secrets
--
-- Extends the secrets vault table to support server-side encrypted entries.
-- This enables services (OpenClaw, ZeroClaw, …) to store their bootstrap
-- credentials in the vault without requiring the user's master password.
--
-- encryption_mode = 'client' (default) → existing zero-knowledge behaviour
-- encryption_mode = 'server'            → encrypted with VAULT_SERVER_KEY env var;
--                                         server CAN decrypt (for service config pull)
--
-- service_id allows the getServiceConfig endpoint to look up credentials
-- by the registered serviceId (e.g. "openclaw-abc12345") rather than scanning
-- all secrets for the agent user.

ALTER TABLE secrets
  ADD COLUMN IF NOT EXISTS encryption_mode text NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS service_id text;

CREATE INDEX IF NOT EXISTS idx_secrets_service_id ON secrets (service_id);
CREATE INDEX IF NOT EXISTS idx_secrets_encryption_mode ON secrets (encryption_mode);
-- Compound: find service secrets for a given user quickly
CREATE INDEX IF NOT EXISTS idx_secrets_user_service ON secrets (user_id, service_id);
