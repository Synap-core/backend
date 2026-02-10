-- Add sharing capabilities: revoked_at, token_hash, password_hash, access
-- For secure public links with revoke, extend, rotate, and optional password protection

-- Add revoked_at (soft revoke)
ALTER TABLE resource_shares ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Add token_hash (hash of public token for secure lookup)
ALTER TABLE resource_shares ADD COLUMN IF NOT EXISTS token_hash TEXT;

-- Add password_hash (optional password protection for links)
ALTER TABLE resource_shares ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Add access: 'workspace_only' | 'anyone_with_link'
ALTER TABLE resource_shares ADD COLUMN IF NOT EXISTS access TEXT DEFAULT 'anyone_with_link';

-- Index for resolve lookups by token hash
CREATE INDEX IF NOT EXISTS idx_resource_shares_token_hash 
  ON resource_shares (token_hash) WHERE token_hash IS NOT NULL;

-- Index for listing active links by resource
CREATE INDEX IF NOT EXISTS idx_resource_shares_active 
  ON resource_shares (resource_type, resource_id) WHERE revoked_at IS NULL;
