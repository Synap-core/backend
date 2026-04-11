-- Add missing columns to thread_entities
ALTER TABLE thread_entities
  ADD COLUMN IF NOT EXISTS conflict_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS source_event_id UUID,
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Add indexes for the new columns
CREATE INDEX IF NOT EXISTS thread_entities_user_id_idx ON thread_entities(user_id);
CREATE INDEX IF NOT EXISTS thread_entities_workspace_id_idx ON thread_entities(workspace_id);
CREATE INDEX IF NOT EXISTS thread_entities_conflict_idx ON thread_entities(conflict_status);

-- Add missing columns to thread_documents
ALTER TABLE thread_documents
  ADD COLUMN IF NOT EXISTS conflict_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS source_event_id UUID,
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Add indexes for the new columns
CREATE INDEX IF NOT EXISTS thread_documents_user_id_idx ON thread_documents(user_id);
CREATE INDEX IF NOT EXISTS thread_documents_workspace_id_idx ON thread_documents(workspace_id);
CREATE INDEX IF NOT EXISTS thread_documents_conflict_idx ON thread_documents(conflict_status);
