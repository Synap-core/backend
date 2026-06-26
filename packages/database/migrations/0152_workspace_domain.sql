-- 0152: Workspace domain field for self-description
--
-- Adds a `domain` column to the workspaces table so workspaces can describe
-- their purpose (e.g. 'development', 'crm', 'marketing', 'brand').
-- Used by the lens model consolidation for workspace self-description.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS domain text;

-- Backfill known workspaces
UPDATE workspaces SET domain = 'development' WHERE name ILIKE '%builder%' AND domain IS NULL;
UPDATE workspaces SET domain = 'development' WHERE name ILIKE '%synap%' AND domain IS NULL;
UPDATE workspaces SET domain = 'crm' WHERE name ILIKE '%crm%' AND domain IS NULL;
UPDATE workspaces SET domain = 'marketing' WHERE name ILIKE '%marketing%' AND domain IS NULL;
UPDATE workspaces SET domain = 'brand' WHERE name ILIKE '%brand%' AND domain IS NULL;
