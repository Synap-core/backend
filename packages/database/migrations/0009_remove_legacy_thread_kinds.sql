-- 0009_remove_legacy_thread_kinds.sql
-- Cleanup: remove legacy thread kinds that are now derived from context_object_type/id + agentType.
--
-- Before: threadKind was an 8-way enum (personal, workspace, entity, document, view, project, task, branch).
-- After: only BRANCH remains as an explicit enum value. All legacy values are set to NULL —
-- their meaning is derived from context_object_type/context_object_id and agentType fields.
--
-- IDEMPOTENT + DRIFT-FREE: the rewrite runs ONLY when a LEGACY multi-value `thread_kind` enum is
-- actually present (a label other than 'branch'). On any pod where `thread_kind` is already the
-- branch-only enum — a fresh baseline, a completed prior run, or the local PGlite pod — the whole
-- block is a clean no-op: no `enum = text` operator error, and no type-name drift (the column type
-- is left exactly as it was). Already-applied pods skip the file entirely via _migrations.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'thread_kind' AND e.enumlabel <> 'branch'
  ) THEN
    -- NULL out legacy kinds (cast to ::text so the compare never needs an `enum = text` operator).
    UPDATE channels SET thread_kind = NULL
    WHERE thread_kind::text IN (
      'personal', 'workspace', 'entity', 'document', 'view', 'project', 'task'
    );

    -- New branch-only enum (guard against a partially-applied prior run).
    BEGIN
      CREATE TYPE thread_kind_new AS ENUM ('branch');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    -- Convert the column to the new type (CASE subject cast to ::text → text compare, never enum=text).
    ALTER TABLE channels ALTER COLUMN thread_kind TYPE thread_kind_new USING
      CASE thread_kind::text
        WHEN 'branch' THEN 'branch'::thread_kind_new
        ELSE CAST(NULL AS thread_kind_new)
      END;

    -- Drop the now-unused legacy enum and promote the new type into the canonical name.
    DROP TYPE thread_kind;
    ALTER TYPE thread_kind_new RENAME TO thread_kind;
  END IF;
END $$;

-- Update indexes to reference the new enum (if any).
DROP INDEX IF EXISTS channels_thread_kind_idx;

COMMIT;
