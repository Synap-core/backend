-- Secrets Vault: Secure storage for passwords, API keys, and credentials
-- Zero-knowledge architecture: server never sees plaintext secrets

-- Enum for secret types
DO $$ BEGIN
  CREATE TYPE secret_type AS ENUM (
    'password', 'api_key', 'credential', 'note', 'card',
    'identity', 'ssh_key', 'certificate', 'env_variable',
    'database', 'oauth'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Main secrets table
CREATE TABLE IF NOT EXISTS secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  workspace_id UUID,
  name TEXT NOT NULL,
  type secret_type NOT NULL DEFAULT 'password',
  url TEXT,
  category TEXT,
  description TEXT,
  icon_url TEXT,
  encrypted_data TEXT NOT NULL,
  encryption_version INTEGER NOT NULL DEFAULT 1,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  password_strength INTEGER,
  password_last_changed TIMESTAMPTZ,
  is_compromised BOOLEAN DEFAULT false,
  compromised_at TIMESTAMPTZ,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secrets_user_id ON secrets (user_id);
CREATE INDEX IF NOT EXISTS idx_secrets_workspace_id ON secrets (workspace_id);
CREATE INDEX IF NOT EXISTS idx_secrets_type ON secrets (type);
CREATE INDEX IF NOT EXISTS idx_secrets_category ON secrets (category);
CREATE INDEX IF NOT EXISTS idx_secrets_url ON secrets (url);
CREATE INDEX IF NOT EXISTS idx_secrets_deleted_at ON secrets (deleted_at);
CREATE INDEX IF NOT EXISTS idx_secrets_user_type ON secrets (user_id, type);

-- Secret tags (many-to-many)
CREATE TABLE IF NOT EXISTS secret_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT secret_tags_unique UNIQUE (secret_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_secret_tags_tag ON secret_tags (tag);

-- Secret shares (workspace/user sharing)
CREATE TABLE IF NOT EXISTS secret_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  shared_with_user_id TEXT,
  shared_with_workspace_id UUID,
  permission TEXT NOT NULL DEFAULT 'read',
  shared_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secret_shares_secret_id ON secret_shares (secret_id);
CREATE INDEX IF NOT EXISTS idx_secret_shares_shared_with_user ON secret_shares (shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_secret_shares_shared_with_workspace ON secret_shares (shared_with_workspace_id);

-- Secret audit log
CREATE TABLE IF NOT EXISTS secret_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secret_audit_log_secret_id ON secret_audit_log (secret_id);
CREATE INDEX IF NOT EXISTS idx_secret_audit_log_user_id ON secret_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_secret_audit_log_created_at ON secret_audit_log (created_at);

-- Master key metadata (for key derivation verification)
CREATE TABLE IF NOT EXISTS secret_vault_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  key_derivation_algorithm TEXT NOT NULL DEFAULT 'argon2id',
  key_derivation_params JSONB NOT NULL,
  verification_cipher TEXT NOT NULL,
  verification_iv TEXT NOT NULL,
  verification_tag TEXT NOT NULL,
  recovery_key_hash TEXT,
  recovery_key_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_unlocked_at TIMESTAMPTZ
);
