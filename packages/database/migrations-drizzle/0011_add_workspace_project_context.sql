-- ============================================================================
-- Migration: Add Workspace & Project Context to All Tables
-- Version: 2026-01-15
-- Description: Adds workspaceId (required) and projectIds (optional array) 
--              to all core resource tables for proper multi-tenant support
-- ============================================================================

-- IMPORTANT: Run this migration in a transaction
BEGIN;

-- ============================================================================
-- PHASE 1: Add Columns to Existing Tables
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

-- Entities: Make workspaceId NOT NULL, add projectIds
-- (workspaceId already exists, just making it required + adding projectIds)
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Documents: Add workspaceId and projectIds
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Entity Templates: Already has workspaceId, but add projectIds
ALTER TABLE entity_templates
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Views: Already has workspaceId, add projectIds
ALTER TABLE views
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Inbox Items: Add workspaceId and projectIds
ALTER TABLE inbox_items
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Resource Shares: Add projectIds (already has implicit workspace via resource)
ALTER TABLE resource_shares
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- ============================================================================
-- PHASE 2: Backfill Data (Use userId as temporary workspaceId for personal data)
-- ============================================================================

-- Tags: Set workspaceId to userId for existing records
UPDATE tags
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Projects: Set workspaceId to userId for existing records
UPDATE projects
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Relations: Set workspaceId to userId for existing records
UPDATE relations
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Entities: Set workspaceId to userId for existing NULL records
UPDATE entities
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Documents: Set workspaceId to userId for existing records
UPDATE documents
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Inbox Items: Set workspaceId to userId for existing records
UPDATE inbox_items
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- ============================================================================
-- PHASE 3: Add NOT NULL Constraints
-- ============================================================================

-- Now that data is backfilled, make workspaceId required
ALTER TABLE tags
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE projects
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE relations
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE entities
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE documents
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE inbox_items
ALTER COLUMN workspace_id SET NOT NULL;

-- ============================================================================
-- PHASE 4: Add Indexes for Performance
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

-- Resource Shares
CREATE INDEX IF NOT EXISTS idx_resource_shares_project_ids ON resource_shares USING GIN(project_ids);

-- ============================================================================
-- PHASE 5: Add Foreign Key Constraints (Optional - for referential integrity)
-- ============================================================================

-- Note: Only add FK constraints if you want strict enforcement
-- Comment out if you prefer flexibility

-- ALTER TABLE tags
-- ADD CONSTRAINT fk_tags_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE projects
-- ADD CONSTRAINT fk_projects_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE relations
-- ADD CONSTRAINT fk_relations_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE entities
-- ADD CONSTRAINT fk_entities_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE documents
-- ADD CONSTRAINT fk_documents_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE inbox_items
-- ADD CONSTRAINT fk_inbox_items_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ============================================================================
-- PHASE 6: Update Comments for Documentation
-- ============================================================================

COMMENT ON COLUMN tags.workspace_id IS 'Workspace this tag belongs to (required - personal workspace=userId)';
COMMENT ON COLUMN tags.project_ids IS 'Optional: Projects this tag is scoped to (array allows multi-project)';

COMMENT ON COLUMN projects.workspace_id IS 'Workspace this project belongs to';

COMMENT ON COLUMN relations.workspace_id IS 'Workspace this relation belongs to';
COMMENT ON COLUMN relations.project_ids IS 'Optional: Projects this relation is scoped to';

COMMENT ON COLUMN entities.workspace_id IS 'Workspace this entity belongs to (required)';
COMMENT ON COLUMN entities.project_ids IS 'Optional: Projects this entity belongs to (many-to-many via array)';

COMMENT ON COLUMN documents.workspace_id IS 'Workspace this document belongs to';
COMMENT ON COLUMN documents.project_ids IS 'Optional: Projects this document belongs to';

COMMENT ON COLUMN entity_templates.project_ids IS 'Optional: Projects this template is scoped to';

COMMENT ON COLUMN views.project_ids IS 'Optional: Projects this view is scoped to';

COMMENT ON COLUMN inbox_items.workspace_id IS 'Workspace this inbox item belongs to';
COMMENT ON COLUMN inbox_items.project_ids IS 'Optional: Projects related to this inbox item';

COMMENT ON COLUMN resource_shares.project_ids IS 'Optional: Projects this share is scoped to';

-- ============================================================================
-- Commit Transaction
-- ============================================================================

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- Run these after migration to verify success:

-- Check for NULL workspaceIds (should be 0)
-- SELECT 'tags' as table_name, COUNT(*) as null_workspace_ids FROM tags WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'projects', COUNT(*) FROM projects WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'relations', COUNT(*) FROM relations WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'entities', COUNT(*) FROM entities WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'documents', COUNT(*) FROM documents WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'inbox_items', COUNT(*) FROM inbox_items WHERE workspace_id IS NULL;

-- Check indexes created
-- SELECT tablename, indexname FROM pg_indexes 
-- WHERE indexname LIKE '%workspace_id%' OR indexname LIKE '%project_ids%'
-- ORDER BY tablename, indexname;
