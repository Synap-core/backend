-- 0009_remove_legacy_thread_kinds.sql
-- Cleanup: remove legacy thread kinds that are now derived from context_object_type/id + agentType.
--
-- Before: threadKind was an 8-way enum (personal, workspace, entity, document, view, project, task, branch).
-- After: only BRANCH remains as an explicit enum value. All legacy values are set to NULL —
-- their meaning is derived from context_object_type/context_object_id and agentType fields.

BEGIN;

-- Migrate legacy threadKinds to NULL so they are valid under the new constrained enum.

UPDATE channels SET thread_kind = NULL WHERE thread_kind = 'personal';
UPDATE channels SET thread_kind = NULL WHERE thread_kind = 'workspace';
UPDATE channels SET thread_kind = NULL WHERE thread_kind = 'entity';
UPDATE channels SET thread_kind = NULL WHERE thread_kind = 'document';
UPDATE channels SET thread_kind = NULL WHERE thread_kind = 'view';
UPDATE channels SET thread_kind = NULL WHERE thread_kind = 'project';
UPDATE channels SET thread_kind = NULL WHERE thread_kind = 'task';

-- Create the new enum type with only BRANCH.
DO $$ BEGIN
  CREATE TYPE thread_kind_new AS ENUM ('branch');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Drop the old constraint, switch to new type, then drop the old type.
ALTER TABLE channels ALTER COLUMN thread_kind TYPE thread_kind_new USING
  CASE thread_kind
    WHEN 'branch' THEN 'branch'::thread_kind_new
    ELSE CAST(NULL AS thread_kind_new)
  END;
ALTER TYPE thread_kind_new RENAME TO thread_kind;

-- Update indexes to reference the new enum (if any).
DROP INDEX IF EXISTS channels_thread_kind_idx;

COMMIT;
