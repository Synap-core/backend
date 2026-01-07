-- Migration: Add Roles and Sharing Tables
-- Created: 2024-12-24
-- Description: Add roles table for custom permissions and resource_shares for public/invite sharing

-- ============================================================================
-- ROLES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  
  -- Permissions as JSONB
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Example: {"entities": {"create": true, "read": true, "update": true, "delete": false}}
  
  -- ABAC filters (optional)
  filters JSONB DEFAULT '{}'::jsonb,
  -- Example: {"entity.type": ["task"], "entity.metadata.category": ["dev"]}
  
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Ensure unique names within workspace (NULL means system role)
  UNIQUE NULLS NOT DISTINCT (workspace_id, name)
);

CREATE INDEX roles_workspace_id_idx ON roles(workspace_id);
CREATE INDEX roles_name_idx ON roles(name);

-- Seed built-in system roles
INSERT INTO roles (name, description, workspace_id, permissions, created_by) VALUES
('owner', 'Full workspace control', NULL, '{
  "workspaces": {"create": true, "read": true, "update": true, "delete": true},
  "views": {"create": true, "read": true, "update": true, "delete": true},
  "entities": {"create": true, "read": true, "update": true, "delete": true},
  "relations": {"create": true, "read": true, "update": true, "delete": true}
}'::jsonb, 'system'),

('admin', 'Manage members and content', NULL, '{
  "workspaces": {"read": true, "update": true},
  "views": {"create": true, "read": true, "update": true, "delete": true},
  "entities": {"create": true, "read": true, "update": true, "delete": true},
  "relations": {"create": true, "read": true, "update": true, "delete": true}
}'::jsonb, 'system'),

('editor', 'Create and edit content', NULL, '{
  "workspaces": {"read": true},
  "views": {"create": true, "read": true, "update": true},
  "entities": {"create": true, "read": true, "update": true},
  "relations": {"create": true, "read": true, "update": true}
}'::jsonb, 'system'),

('viewer', 'Read-only access', NULL, '{
  "workspaces": {"read": true},
  "views": {"read": true},
  "entities": {"read": true},
  "relations": {"read": true}
}'::jsonb, 'system');

-- ============================================================================
-- RESOURCE SHARES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS resource_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Resource being shared
  resource_type TEXT NOT NULL, -- 'view', 'entity', 'workspace'
  resource_id UUID NOT NULL,
  
  -- Sharing mode
  visibility TEXT NOT NULL DEFAULT 'private',
  -- 'private' | 'workspace' | 'invite_only' | 'public'
  
  -- Public link
  public_token TEXT UNIQUE,
  
  -- Invited users (simple array for MVP)
  invited_users TEXT[] DEFAULT '{}'::text[],
  
  -- Permissions for shared access
  permissions JSON B DEFAULT '{"read": true}'::jsonb,
  
  -- Expiration
  expires_at TIMESTAMPTZ,
  
  -- Metadata
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Tracking
  view_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMPTZ
);

CREATE INDEX resource_shares_resource_idx ON resource_shares(resource_type, resource_id);
CREATE INDEX resource_shares_token_idx ON resource_shares(public_token) WHERE public_token IS NOT NULL;
CREATE INDEX resource_shares_visibility_idx ON resource_shares(visibility);
CREATE INDEX resource_shares_created_by_idx ON resource_shares(created_by);

-- ============================================================================
-- UPDATE WORKSPACE_MEMBERS TO USE ROLE_ID
-- ============================================================================

-- Add role_id column
ALTER TABLE workspace_members 
  ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id);

-- Migrate existing string roles to role references
UPDATE workspace_members
SET role_id = (
  SELECT id FROM roles 
  WHERE roles.name = workspace_members.role 
    AND roles.workspace_id IS NULL 
  LIMIT 1
)
WHERE role_id IS NULL;

-- Role column is kept for backward compatibility
-- Will be removed in future migration after full transition

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE roles IS 'Custom roles with fine-grained permissions (RBAC + ABAC)';
COMMENT ON COLUMN roles.permissions IS 'JSONB: {"entities": {"create": true, "read": true, ...}}';
COMMENT ON COLUMN roles.filters IS 'ABAC filters: {"entity.type": ["task"], "metadata.category": ["dev"]}';

COMMENT ON TABLE resource_shares IS 'Public and invite-based sharing for views, entities, workspaces';
COMMENT ON COLUMN resource_shares.visibility IS 'private | workspace | invite_only | public';
COMMENT ON COLUMN resource_shares.invited_users IS 'Array of user IDs who have been invited';
