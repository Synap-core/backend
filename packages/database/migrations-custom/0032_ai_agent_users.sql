-- 0032: AI Agent Users
-- Adds user_type column to distinguish human users from AI agent users.
-- AI agents are first-class users with workspace memberships and role-based permissions.

-- 1. Add user_type column (default 'human' for all existing users)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS user_type TEXT NOT NULL DEFAULT 'human';

-- 2. Make kratos_identity_id nullable (agents have no Kratos identity)
ALTER TABLE users ALTER COLUMN kratos_identity_id DROP NOT NULL;

-- 3. Add agent-specific metadata JSONB column
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS agent_metadata JSONB;

-- 4. Index for quick agent lookups
CREATE INDEX IF NOT EXISTS idx_users_user_type ON users (user_type);
