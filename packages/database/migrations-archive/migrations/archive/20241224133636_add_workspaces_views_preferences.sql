-- Migration: Add Workspaces, Views, and User Preferences
-- Created: 2024-12-24
-- Description: Adds multi-user workspace support, extensible views system, and user preferences

-- ============================================================================
-- NEW TABLES
-- ============================================================================

-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'personal',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  subscription_tier TEXT,
  subscription_status TEXT,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX workspaces_owner_id_idx ON workspaces(owner_id);
CREATE INDEX workspaces_type_idx ON workspaces(type);

-- Workspace members table
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by TEXT,
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX workspace_members_workspace_id_idx ON workspace_members(workspace_id);
CREATE INDEX workspace_members_user_id_idx ON workspace_members(user_id);

-- Workspace invites table
CREATE TABLE IF NOT EXISTS workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX workspace_invites_workspace_id_idx ON workspace_invites(workspace_id);
CREATE INDEX workspace_invites_token_idx ON workspace_invites(token);
CREATE INDEX workspace_invites_email_idx ON workspace_invites(email);

-- Views table (whiteboards, timelines, etc.)
CREATE TABLE IF NOT EXISTS views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX views_workspace_id_idx ON views(workspace_id);
CREATE INDEX views_user_id_idx ON views(user_id);
CREATE INDEX views_type_idx ON views(type);
CREATE INDEX views_document_id_idx ON views(document_id);

-- User preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT 'system',
  ui_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  graph_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  onboarding_step TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- ALTER EXISTING TABLES - Add workspaceId columns
-- ============================================================================

-- Add workspace_id to entities (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'entities' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE entities ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
    CREATE INDEX entities_workspace_id_idx ON entities(workspace_id);
  END IF;
END $$;

-- Add workspace_id to relations (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'relations' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE relations ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
    CREATE INDEX relations_workspace_id_idx ON relations(workspace_id);
  END IF;
END $$;

-- Add workspace_id to documents (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE documents ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
    CREATE INDEX documents_workspace_id_idx ON documents(workspace_id);
  END IF;
END $$;

-- Add metadata column to relations (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'relations' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE relations ADD COLUMN metadata JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- ============================================================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Enable RLS on new tables
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- Workspaces: Users can read workspaces they own or are members of
CREATE POLICY workspaces_select ON workspaces
  FOR SELECT
  USING (
    owner_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = workspaces.id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
    )
  );

-- Workspaces: Users can create workspaces
CREATE POLICY workspaces_insert ON workspaces
  FOR INSERT
  WITH CHECK (owner_id = current_setting('app.current_user_id', true)::text);

-- Workspaces: Only owners/admins can update
CREATE POLICY workspaces_update ON workspaces
  FOR UPDATE
  USING (
    owner_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = workspaces.id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
        AND workspace_members.role IN ('admin')
    )
  );

-- Workspaces: Only owners can delete
CREATE POLICY workspaces_delete ON workspaces
  FOR DELETE
  USING (owner_id = current_setting('app.current_user_id', true)::text);

-- Workspace Members: Users can see members of workspaces they belong to
CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT
  USING (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = workspace_members.workspace_id
        AND wm.user_id = current_setting('app.current_user_id', true)::text
    )
  );

-- Workspace Members: Owners/admins can add members
CREATE POLICY workspace_members_insert ON workspace_members
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = workspace_members.workspace_id
        AND (
          workspaces.owner_id = current_setting('app.current_user_id', true)::text
          OR EXISTS (
            SELECT 1 FROM workspace_members wm
            WHERE wm.workspace_id = workspace_members.workspace_id
              AND wm.user_id = current_setting('app.current_user_id', true)::text
              AND wm.role IN ('owner', 'admin')
          )
        )
    )
  );

-- Workspace Members: Owners/admins can remove members
CREATE POLICY workspace_members_delete ON workspace_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = workspace_members.workspace_id
        AND (
          workspaces.owner_id = current_setting('app.current_user_id', true)::text
          OR EXISTS (
            SELECT 1 FROM workspace_members wm
            WHERE wm.workspace_id = workspace_members.workspace_id
              AND wm.user_id = current_setting('app.current_user_id', true)::text
              AND wm.role IN ('owner', 'admin')
          )
        )
    )
  );

-- Views: Users can read views in workspaces they belong to
CREATE POLICY views_select ON views
  FOR SELECT
  USING (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = views.workspace_id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
    )
  );

-- Views: Editor+ can create views
CREATE POLICY views_insert ON views
  FOR INSERT
  WITH CHECK (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = views.workspace_id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
        AND workspace_members.role IN ('owner', 'admin', 'editor')
    )
  );

-- Views: Editor+ can update views
CREATE POLICY views_update ON views
  FOR UPDATE
  USING (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = views.workspace_id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
        AND workspace_members.role IN ('owner', 'admin', 'editor')
    )
  );

-- Views: Editor+ can delete views
CREATE POLICY views_delete ON views
  FOR DELETE
  USING (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = views.workspace_id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
        AND workspace_members.role IN ('owner', 'admin', 'editor')
    )
  );

-- User Preferences: Users can only access their own preferences
CREATE POLICY user_preferences_all ON user_preferences
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::text)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::text);

-- Entities: Update policy for workspace access
DROP POLICY IF EXISTS entities_select ON entities;
CREATE POLICY entities_select ON entities
  FOR SELECT
  USING (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = entities.workspace_id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
    )
  );

-- Relations: Update policy for workspace access
DROP POLICY IF EXISTS relations_select ON relations;
CREATE POLICY relations_select ON relations
  FOR SELECT
  USING (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = relations.workspace_id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
    )
  );

-- Documents: Update policy for workspace access
DROP POLICY IF EXISTS documents_select ON documents;
CREATE POLICY documents_select ON documents
  FOR SELECT
  USING (
    user_id = current_setting('app.current_user_id', true)::text
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = documents.workspace_id
        AND workspace_members.user_id = current_setting('app.current_user_id', true)::text
    )
  );

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE workspaces IS 'Multi-user workspaces (personal, team, enterprise)';
COMMENT ON TABLE workspace_members IS 'Workspace membership with role-based access';
COMMENT ON TABLE workspace_invites IS 'Pending workspace invitations';
COMMENT ON TABLE views IS 'Extensible view system (whiteboards, timelines, kanban, etc.)';
COMMENT ON TABLE user_preferences IS 'User-specific UI and application settings';

COMMENT ON COLUMN workspaces.type IS 'Workspace type: personal, team, or enterprise';
COMMENT ON COLUMN workspace_members.role IS 'Member role: owner, admin, editor, or viewer';
COMMENT ON COLUMN views.type IS 'View type: whiteboard, timeline, kanban, table, mindmap, or graph';
COMMENT ON COLUMN views.document_id IS 'References documents table for version-controlled content storage';
