-- Migration: Seed System Roles
-- Created: 2024-12-24
-- Purpose: Insert built-in system roles with predefined permissions
--          These roles are workspace-independent (workspace_id = NULL)

-- ============================================================================
-- SYSTEM ROLES
-- ============================================================================

INSERT INTO roles (name, description, workspace_id, permissions, created_by) VALUES

-- Owner: Full control over workspace and all resources
('owner', 'Full control over workspace and all resources', NULL, '{
  "workspaces": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "entities": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "views": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "documents": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "relations": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "members": {
    "invite": true,
    "remove": true,
    "update_roles": true
  },
  "roles": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "sharing": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  }
}'::jsonb, 'system'),

-- Admin: Manage members and all content
('admin', 'Manage members and all content', NULL, '{
  "workspaces": {
    "read": true,
    "update": true
  },
  "entities": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "views": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "documents": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "relations": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "members": {
    "invite": true,
    "remove": true,
    "update_roles": false
  },
  "roles": {
    "read": true
  },
  "sharing": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  }
}'::jsonb, 'system'),

-- Editor: Create and edit content
('editor', 'Create and edit content', NULL, '{
  "workspaces": {
    "read": true
  },
  "entities": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "views": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "documents": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "relations": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "members": {
    "read": true
  },
  "roles": {
    "read": true
  },
  "sharing": {
    "create": true,
    "read": true
  }
}'::jsonb, 'system'),

-- Viewer: Read-only access
('viewer', 'Read-only access to workspace resources', NULL, '{
  "workspaces": {
    "read": true
  },
  "entities": {
    "read": true
  },
  "views": {
    "read": true
  },
  "documents": {
    "read": true
  },
  "relations": {
    "read": true
  },
  "members": {
    "read": true
  },
  "roles": {
    "read": true
  },
  "sharing": {
    "read": true
  }
}'::jsonb, 'system');

-- ============================================================================
-- NOTES
-- ============================================================================
--
-- System roles (workspace_id = NULL) are available to all workspaces.
-- Workspaces can also create custom roles specific to their needs.
--
-- Permission Structure:
-- - Each resource type (workspaces, entities, views, etc.) has CRUD permissions
-- - Special permissions for members (invite, remove, update_roles)
-- - Permissions are checked by the checkPermission() function in the API layer
--
-- Role Hierarchy (most to least privileged):
-- 1. owner - Full control, can delete workspace
-- 2. admin - Manage everything except workspace deletion and owner role changes
-- 3. editor - Create and edit content, no deletion
-- 4. viewer - Read-only access
--
