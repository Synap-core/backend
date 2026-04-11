-- Migration: Security Policies
-- Description: Row-Level Security (RLS), Roles, and Sharing.

-- ============================================================================
-- 1. ROLES & SHARING
-- ============================================================================
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
    "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "resource_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL,
	"resource_type" text NOT NULL, -- 'entity', 'project', 'view'
    "resource_id" uuid NOT NULL,
    
    "shared_with_type" text NOT NULL, -- 'user', 'team', 'public'
    "shared_with_id" text, -- User ID or NULL for public
    
    "permission_level" text NOT NULL, -- 'view', 'edit'
    "expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================================
-- 2. ENABLE RLS
-- ============================================================================
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;

-- Intelligence & Skills
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_enrichments ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE reasoning_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. RLS POLICIES (Read-Only Checks)
-- Writes are generally handled by the Application Layer (Event Sourcing) or specific policies
-- ============================================================================

-- Workspaces: Access if Owner OR Member
CREATE POLICY workspaces_select ON workspaces
  FOR SELECT
  USING (
    owner_id = current_setting('app.user_id', TRUE) OR
    id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Entities: Access if User is in Workspace
CREATE POLICY entities_select ON entities
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Documents: Access if User is in Workspace
CREATE POLICY documents_select ON documents
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Documents: Yjs Updates (Exception for real-time collab)
CREATE POLICY documents_update ON documents
  FOR UPDATE
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Projects: Access if User is in Workspace
CREATE POLICY projects_select ON projects
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Views: Access if User is in Workspace
CREATE POLICY views_select ON views
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );
