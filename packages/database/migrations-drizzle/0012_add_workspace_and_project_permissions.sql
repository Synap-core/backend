-- ============================================================================
-- CONSOLIDATED MIGRATION: Workspace Context + Project Members
-- Version: 0012 (supersedes 0011)
-- Date: 2026-01-15
-- Description: 
--   1. Adds workspaceId/projectIds to all resource tables
--   2. Creates project_members table for project-level permissions
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: Add Workspace & Project Context to Resource Tables
-- ============================================================================

-- Tags: Add workspaceId and projectIds
ALTER TABLE tags 
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Projects: Add workspaceId
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Relations: Add workspaceId and projectIds  
ALTER TABLE relations
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Entities: Add projectIds (workspaceId exists, just add array)
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Documents: Add workspaceId and projectIds
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Entity Templates: Add projectIds (workspaceId exists)
ALTER TABLE entity_templates
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Views: Add projectIds (workspaceId exists)
ALTER TABLE views
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Inbox Items: Add workspaceId and projectIds
ALTER TABLE inbox_items
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- ============================================================================
-- PART 2: Backfill Data (Use userId as workspaceId for existing data)
-- ============================================================================

-- Tags
UPDATE tags
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Projects
UPDATE projects
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Relations
UPDATE relations
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Entities
UPDATE entities
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Documents
UPDATE documents
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Inbox Items
UPDATE inbox_items
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- ============================================================================
-- PART 3: Add NOT NULL Constraints
-- ============================================================================

ALTER TABLE tags ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE relations ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE entities ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE inbox_items ALTER COLUMN workspace_id SET NOT NULL;

-- ============================================================================
-- PART 4: Add Indexes for Performance
-- ============================================================================

-- Tags
CREATE INDEX IF NOT EXISTS idx_tags_workspace_id ON tags(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tags_project_ids ON tags USING GIN(project_ids);

-- Projects
CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects(workspace_id);

-- Relations
CREATE INDEX IF NOT EXISTS idx_relations_workspace_id ON relations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_relations_project_ids ON relations USING GIN(project_ids);

-- Entities
CREATE INDEX IF NOT EXISTS idx_entities_workspace_id ON entities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_entities_project_ids ON entities USING GIN(project_ids);

-- Documents
CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_project_ids ON documents USING GIN(project_ids);

-- Entity Templates
CREATE INDEX IF NOT EXISTS idx_entity_templates_project_ids ON entity_templates USING GIN(project_ids);

-- Views
CREATE INDEX IF NOT EXISTS idx_views_project_ids ON views USING GIN(project_ids);

-- Inbox Items
CREATE INDEX IF NOT EXISTS idx_inbox_items_workspace_id ON inbox_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_project_ids ON inbox_items USING GIN(project_ids);

-- ============================================================================
-- PART 5: Create project_members Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Relationships
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  
  -- Role in project (same as workspace for consistency)
  role TEXT NOT NULL DEFAULT 'viewer', -- 'owner' | 'editor' | 'viewer'
  
  -- Metadata
  invited_by TEXT,
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  
  -- Constraints
  UNIQUE(project_id, user_id)
);

-- Indexes for project_members
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_project ON project_members(user_id, project_id);

-- ============================================================================
-- PART 6: Add Comments for Documentation
-- ============================================================================

-- Resource tables
COMMENT ON COLUMN tags.workspace_id IS 'Workspace this tag belongs to (required)';
COMMENT ON COLUMN tags.project_ids IS 'Optional: Projects this tag is scoped to (array)';

COMMENT ON COLUMN projects.workspace_id IS 'Workspace this project belongs to (required)';

COMMENT ON COLUMN relations.workspace_id IS 'Workspace this relation belongs to (required)';
COMMENT ON COLUMN relations.project_ids IS 'Optional: Projects this relation is scoped to (array)';

COMMENT ON COLUMN entities.workspace_id IS 'Workspace this entity belongs to (required)';
COMMENT ON COLUMN entities.project_ids IS 'Optional: Projects this entity belongs to (array)';

COMMENT ON COLUMN documents.workspace_id IS 'Workspace this document belongs to (required)';
COMMENT ON COLUMN documents.project_ids IS 'Optional: Projects this document belongs to (array)';

COMMENT ON COLUMN views.project_ids IS 'Optional: Projects this view is scoped to (array)';
COMMENT ON COLUMN entity_templates.project_ids IS 'Optional: Projects this template is scoped to (array)';

COMMENT ON COLUMN inbox_items.workspace_id IS 'Workspace this inbox item belongs to (required)';
COMMENT ON COLUMN inbox_items.project_ids IS 'Optional: Projects related to inbox item (array)';

-- Project members table
COMMENT ON TABLE project_members IS 'Project-level permissions (sub-workspace access control)';
COMMENT ON COLUMN project_members.role IS 'User role in this specific project (owner/editor/viewer)';
COMMENT ON COLUMN project_members.invited_by IS 'User ID who added this member to the project';

-- ============================================================================
-- Commit Transaction
-- ============================================================================

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES (Run after migration)
-- ============================================================================

-- Check for NULL workspaceIds (should return 0 for all)
-- SELECT 'tags' as table_name, COUNT(*) as null_count FROM tags WHERE workspace_id IS NULL
-- UNION ALL SELECT 'projects', COUNT(*) FROM projects WHERE workspace_id IS NULL
-- UNION ALL SELECT 'relations', COUNT(*) FROM relations WHERE workspace_id IS NULL
-- UNION ALL SELECT 'entities', COUNT(*) FROM entities WHERE workspace_id IS NULL
-- UNION ALL SELECT 'documents', COUNT(*) FROM documents WHERE workspace_id IS NULL
-- UNION ALL SELECT 'inbox_items', COUNT(*) FROM inbox_items WHERE workspace_id IS NULL;

-- Check project_members table
-- SELECT COUNT(*) FROM project_members;

-- Check indexes created
-- SELECT tablename, indexname FROM pg_indexes 
-- WHERE schemaname = 'public' 
-- AND (indexname LIKE '%workspace_id%' OR indexname LIKE '%project%')
-- ORDER BY tablename, indexname;
