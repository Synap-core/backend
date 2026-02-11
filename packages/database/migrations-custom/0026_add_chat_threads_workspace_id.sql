-- Add workspace_id to chat_threads for workspace-scoped listing and filtering.
-- Nullable: existing rows stay null (legacy user-scoped); new threads set workspace_id.

ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

CREATE INDEX IF NOT EXISTS chat_threads_workspace_id_idx
  ON chat_threads (workspace_id)
  WHERE workspace_id IS NOT NULL;
