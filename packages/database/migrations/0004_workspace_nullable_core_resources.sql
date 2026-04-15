-- Relax workspace requirement for pod-wide resources.
ALTER TABLE relations
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE projects
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE inbox_items
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE message_links
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE command_runs
ALTER COLUMN workspace_id DROP NOT NULL;
