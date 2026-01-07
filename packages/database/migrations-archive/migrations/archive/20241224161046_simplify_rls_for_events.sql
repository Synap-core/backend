-- Migration: Simplify RLS for Event-Based Access Control
-- Created: 2024-12-24
-- Description: Remove INSERT/UPDATE/DELETE policies to allow event system to work.
--              Keep only SELECT policies for read protection.
--              Add UPDATE exception for documents (Yjs real-time).

-- ============================================================================
-- DROP WRITE POLICIES (Events handle write validation)
-- ============================================================================

-- Workspaces: Remove write policies
DROP POLICY IF EXISTS workspaces_insert ON workspaces;
DROP POLICY IF EXISTS workspaces_update ON workspaces;
DROP POLICY IF EXISTS workspaces_delete ON workspaces;

-- Workspace Members: Remove write policies  
DROP POLICY IF EXISTS workspace_members_insert ON workspace_members;
DROP POLICY IF EXISTS workspace_members_delete ON workspace_members;

-- Workspace Invites: Remove policies (will use events)
DROP POLICY IF EXISTS workspace_invites_select ON workspace_invites;
DROP POLICY IF EXISTS workspace_invites_insert ON workspace_invites;
DROP POLICY IF EXISTS workspace_invites_delete ON workspace_invites;

-- Views: Remove write policies
DROP POLICY IF EXISTS views_insert ON views;
DROP POLICY IF EXISTS views_update ON views;
DROP POLICY IF EXISTS views_delete ON views;

-- ============================================================================
-- KEEP SELECT POLICIES (Read protection stays at DB level)
-- ============================================================================

-- These already exist and are correct:
-- ✅ workspaces_select
-- ✅ workspace_members_select  
-- ✅ views_select
-- ✅ user_preferences_all (reads + writes for own prefs)
-- ✅ entities_select
-- ✅ relations_select
-- ✅ documents_select

-- ============================================================================
-- EXCEPTION: Documents UPDATE (for Yjs real-time collaboration)
-- ============================================================================

-- Documents need UPDATE policy because Yjs updates them directly
-- This is the ONLY table that bypasses event system for writes
CREATE POLICY IF NOT EXISTS documents_update ON documents
  FOR UPDATE
  USING (
    -- User owns the document
    user_id = current_setting('app.user_id', true)::text
    OR
    -- User has access via view
    EXISTS (
      SELECT 1 FROM views
      WHERE views.document_id = documents.id
        AND (
          -- User created the view
          views.user_id = current_setting('app.user_id', true)::text
          OR
          -- User is member of view's workspace
          EXISTS (
            SELECT 1 FROM workspace_members
            WHERE workspace_members.workspace_id = views.workspace_id
              AND workspace_members.user_id = current_setting('app.user_id', true)::text
          )
        )
    )
  );

-- ============================================================================
-- UPDATE SESSION VARIABLE NAME (standardize to app.user_id)
-- ============================================================================

-- Update all SELECT policies to use consistent variable name
-- Change: app.current_user_id → app.user_id

-- Workspaces SELECT policy
DROP POLICY IF EXISTS workspaces_select ON workspaces;
CREATE POLICY workspaces_select ON workspaces
  FOR SELECT
  USING (
    owner_id = current_setting('app.user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = workspaces.id
        AND workspace_members.user_id = current_setting('app.user_id', true)::text
    )
  );

-- Workspace Members SELECT policy
DROP POLICY IF EXISTS workspace_members_select ON workspace_members;
CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = workspace_members.workspace_id
        AND wm.user_id = current_setting('app.user_id', true)::text
    )
  );

-- Views SELECT policy
DROP POLICY IF EXISTS views_select ON views;
CREATE POLICY views_select ON views
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = views.workspace_id
        AND workspace_members.user_id = current_setting('app.user_id', true)::text
    )
  );

-- User Preferences policy
DROP POLICY IF EXISTS user_preferences_all ON user_preferences;
CREATE POLICY user_preferences_all ON user_preferences
  FOR ALL
  USING (user_id = current_setting('app.user_id', true)::text)
  WITH CHECK (user_id = current_setting('app.user_id', true)::text);

-- Entities SELECT policy
DROP POLICY IF EXISTS entities_select ON entities;
CREATE POLICY entities_select ON entities
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = entities.workspace_id
        AND workspace_members.user_id = current_setting('app.user_id', true)::text
    )
  );

-- Relations SELECT policy
DROP POLICY IF EXISTS relations_select ON relations;
CREATE POLICY relations_select ON relations
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = relations.workspace_id
        AND workspace_members.user_id = current_setting('app.user_id', true)::text
    )
  );

-- Documents SELECT policy
DROP POLICY IF EXISTS documents_select ON documents;
CREATE POLICY documents_select ON documents
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = documents.workspace_id
        AND workspace_members.user_id = current_setting('app.user_id', true)::text
    )
  );

-- ============================================================================
-- EVENTS TABLE: No RLS (everyone can insert events)
-- ============================================================================

-- Events table should have NO RLS - validation happens in event handlers
ALTER TABLE IF EXISTS events DISABLE ROW LEVEL SECURITY;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON POLICY workspaces_select ON workspaces IS 
  'Read-only: Users can see workspaces they own or are members of';

COMMENT ON POLICY documents_update ON documents IS 
  'Exception: Direct updates allowed for Yjs real-time collaboration';

-- Migration complete
-- All writes now go through event system except documents (Yjs)
-- All reads protected by RLS SELECT policies
