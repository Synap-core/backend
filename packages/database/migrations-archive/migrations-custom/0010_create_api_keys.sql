-- ============================================================================
-- Migration 0010: Create API Keys Table
-- Hub Protocol V1.0 - Phase 2
-- ============================================================================
--
-- Purpose: Store API keys for Hub authentication with security best practices
--
-- Features:
-- - Bcrypt hashed keys for security
-- - Prefixes for key identification (synap_hub_, synap_user_)
-- - Granular scopes for permissions
-- - Rotation support with key lineage tracking
-- - Complete audit trail
-- - Rate limiting metadata
--
-- Based on industry best practices from:
-- - GitHub: Personal Access Tokens (bcrypt hashed)
-- - Stripe: Secret Keys (with prefixes)
-- - AWS: IAM Access Keys (with rotation)
-- ============================================================================

-- ============================================================================
-- STEP 1: Create api_keys table
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  -- Primary Key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Ownership
  user_id TEXT NOT NULL,
  
  -- Key Identification
  key_name TEXT NOT NULL, -- User-friendly name (e.g., "Production Hub Key")
  key_prefix TEXT NOT NULL, -- Prefix for identification (e.g., "synap_hub_live_")
  key_hash TEXT NOT NULL, -- Bcrypt hash of the full key (cost factor 12)
  
  -- Metadata
  hub_id TEXT, -- NULL for user keys, set for Hub keys
  scope TEXT[] NOT NULL DEFAULT '{}', -- Granular permissions (e.g., ['preferences', 'notes', 'tasks'])
  expires_at TIMESTAMPTZ, -- NULL = no expiration
  
  -- State
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  usage_count BIGINT NOT NULL DEFAULT 0,
  
  -- Rotation (key lineage tracking)
  rotated_from_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  rotation_scheduled_at TIMESTAMPTZ, -- When rotation is recommended
  
  -- Audit Trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT, -- User ID who created the key
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT, -- User ID who revoked the key
  revoked_reason TEXT, -- Why the key was revoked
  
  -- Constraints
  CONSTRAINT api_keys_user_id_check CHECK (user_id IS NOT NULL AND LENGTH(TRIM(user_id)) > 0),
  CONSTRAINT api_keys_key_name_check CHECK (LENGTH(TRIM(key_name)) > 0),
  CONSTRAINT api_keys_key_prefix_check CHECK (key_prefix IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_')),
  CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash),
  CONSTRAINT api_keys_scope_check CHECK (array_length(scope, 1) > 0 OR scope = '{}')
);

-- ============================================================================
-- STEP 2: Create indexes for performance
-- ============================================================================

-- Index for looking up keys by user
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);

-- Index for looking up Hub keys specifically
CREATE INDEX idx_api_keys_hub_id ON api_keys(hub_id) WHERE hub_id IS NOT NULL;

-- Index for finding active keys (most common query)
CREATE INDEX idx_api_keys_is_active ON api_keys(is_active) WHERE is_active = true;

-- Index for finding keys with prefix (optimization for validation)
CREATE INDEX idx_api_keys_prefix_active ON api_keys(key_prefix, is_active) WHERE is_active = true;

-- Index for expiration checks (for cleanup jobs)
CREATE INDEX idx_api_keys_expires_at ON api_keys(expires_at) WHERE expires_at IS NOT NULL;

-- Index for rotation recommendations
CREATE INDEX idx_api_keys_rotation_scheduled ON api_keys(rotation_scheduled_at) 
  WHERE rotation_scheduled_at IS NOT NULL AND is_active = true;

-- ============================================================================
-- STEP 3: Create function to clean up expired keys
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_expired_api_keys()
RETURNS INTEGER AS $$
DECLARE
  affected_count INTEGER;
BEGIN
  -- Deactivate expired keys
  UPDATE api_keys
  SET 
    is_active = false,
    revoked_at = NOW(),
    revoked_reason = 'Expired automatically'
  WHERE 
    is_active = true
    AND expires_at IS NOT NULL
    AND expires_at < NOW();
  
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  
  RETURN affected_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 4: Create function to update last_used_at efficiently
-- ============================================================================

CREATE OR REPLACE FUNCTION update_api_key_usage(p_key_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE api_keys
  SET 
    last_used_at = NOW(),
    usage_count = usage_count + 1
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 5: Add comments for documentation
-- ============================================================================

COMMENT ON TABLE api_keys IS 'API keys for Hub authentication with bcrypt hashing and audit trail';
COMMENT ON COLUMN api_keys.key_prefix IS 'Prefix for key identification (synap_hub_live_, synap_hub_test_, synap_user_)';
COMMENT ON COLUMN api_keys.key_hash IS 'Bcrypt hash (cost factor 12) of the complete API key';
COMMENT ON COLUMN api_keys.scope IS 'Array of permissions (preferences, calendar, notes, tasks, etc.)';
COMMENT ON COLUMN api_keys.hub_id IS 'NULL for user keys, set to hub identifier for Hub keys';
COMMENT ON COLUMN api_keys.rotated_from_id IS 'Links to the previous key in rotation chain';
COMMENT ON COLUMN api_keys.rotation_scheduled_at IS 'When rotation is recommended (e.g., 90 days after creation)';

-- ============================================================================
-- STEP 6: Create initial scopes enum for documentation
-- ============================================================================

-- Note: We use TEXT[] instead of ENUM for flexibility
-- Valid scopes are documented here for reference:
-- - 'preferences': Access to user preferences
-- - 'calendar': Access to calendar events
-- - 'notes': Access to notes (summary only)
-- - 'tasks': Access to tasks (summary only)
-- - 'projects': Access to projects (summary only)
-- - 'conversations': Access to conversations (summary only)
-- - 'entities': Access to entities (summary only)
-- - 'relations': Access to relations
-- - 'knowledge_facts': Access to knowledge facts

-- ============================================================================
-- STEP 7: Sample data for testing (optional, can be removed in production)
-- ============================================================================

-- Uncomment to create sample Hub key for development
-- INSERT INTO api_keys (
--   user_id,
--   key_name,
--   key_prefix,
--   key_hash,
--   hub_id,
--   scope,
--   expires_at,
--   created_by
-- ) VALUES (
--   'dev-user-123',
--   'Development Hub Key',
--   'synap_hub_test_',
--   '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5eoWf7oSx7BDK', -- Hash of "synap_hub_test_dev123"
--   'synap-hub-dev',
--   ARRAY['preferences', 'notes', 'tasks'],
--   NOW() + INTERVAL '90 days',
--   'dev-user-123'
-- );

-- ============================================================================
-- Migration complete
-- ============================================================================

