-- Allow pod-wide documents (workspace_id = NULL)
ALTER TABLE documents
ALTER COLUMN workspace_id DROP NOT NULL;
