-- Profile Entity Scope
-- Determines whether entities of a profile type are pod-wide or workspace-scoped.
-- Pod-wide entities (entityScope='pod') are visible across all workspaces.
-- Workspace-scoped entities (entityScope='workspace') are visible only in their workspace.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS entity_scope text NOT NULL DEFAULT 'workspace';

-- Set core system profiles as pod-wide
UPDATE profiles SET entity_scope = 'pod'
WHERE slug IN ('person', 'company', 'note', 'task', 'project', 'event', 'bookmark', 'website', 'article', 'contact')
  AND scope = 'system';

-- App-specific profiles stay workspace-scoped (deal, file, capture, anchor)
-- No UPDATE needed — default is already 'workspace'
