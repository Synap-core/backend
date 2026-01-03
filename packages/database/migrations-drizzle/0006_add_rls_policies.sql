-- Migration: Add RLS Policies for Event-Based Access Control
-- Created: 2024-12-24
-- Purpose: Enable Row-Level Security on key tables with SELECT-only policies
--          Writes are handled by event system, reads are protected by RLS
--          Exception: Documents table allows UPDATE for Yjs real-time collaboration

-- ============================================================================
-- ENABLE RLS ON KEY TABLES
-- ============================================================================

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- SELECT POLICIES (Read Protection)
-- ============================================================================

-- Entities: User owns it OR user is in workspace
CREATE POLICY entities_select ON entities
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Workspaces: User owns it OR user is a member
CREATE POLICY workspaces_select ON workspaces
  FOR SELECT
  USING (
    owner_id = current_setting('app.user_id', TRUE) OR
    id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Views: User owns it OR user is in workspace
CREATE POLICY views_select ON views
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Documents: User owns it OR user has access to associated view
CREATE POLICY documents_select ON documents
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    id IN (
      SELECT document_id FROM views 
      WHERE user_id = current_setting('app.user_id', TRUE) OR
      workspace_id IN (
        SELECT workspace_id FROM workspace_members 
        WHERE user_id = current_setting('app.user_id', TRUE)
      )
    )
  );

-- Workspace Members: User is the member OR user is in the workspace
CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Relations: User owns the source entity OR entity is in user's workspace
CREATE POLICY relations_select ON relations
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    source_entity_id IN (
      SELECT id FROM entities 
      WHERE workspace_id IN (
        SELECT workspace_id FROM workspace_members 
        WHERE user_id = current_setting('app.user_id', TRUE)
      )
    )
  );

-- ============================================================================
-- UPDATE POLICIES (Exceptions)
-- ============================================================================

-- Documents: Allow UPDATE for Yjs real-time collaboration
-- This is the ONLY write policy - all other writes go through events
CREATE POLICY documents_update ON documents
  FOR UPDATE
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    id IN (
      SELECT document_id FROM views 
      WHERE workspace_id IN (
        SELECT workspace_id FROM workspace_members 
        WHERE user_id = current_setting('app.user_id', TRUE)
      )
    )
  );

-- ============================================================================
-- NOTES
-- ============================================================================
-- 
-- All INSERT/DELETE operations are intentionally NOT protected by RLS.
-- These operations are handled by the event system which performs
-- permission checks before persisting data.
--
-- This migration creates a hybrid security model:
-- - Reads: Protected by RLS (this file)
-- - Writes: Protected by event-based permission checks (application layer)
-- - Exception: Document updates for Yjs (real-time collaboration requirement)
--
