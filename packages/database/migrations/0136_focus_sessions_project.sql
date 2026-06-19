-- ── Focus Sessions — project-centric-scope Phase 4 ──────────────────────────
--
-- 1. Make workspace_id nullable: a project-scoped session spans workspaces
--    and is anchored by project_id instead of workspace_id. Existing rows are
--    unchanged (workspace_id stays populated for all current sessions).
--
-- 2. Add project_id: FK to entities.id (projects are entities with
--    profileSlug='project'). NULL = workspace-scoped session (the default).
--    Non-null = project-scoped; workspaceId is still set as the channel/
--    membership context even in this case.
--
-- Both operations are defensive (idempotent on re-run).

-- 1. Drop NOT NULL constraint on workspace_id (safe: existing rows keep their
--    values; only the constraint is relaxed).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'focus_sessions'
       AND column_name  = 'workspace_id'
       AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE focus_sessions ALTER COLUMN workspace_id DROP NOT NULL;
  END IF;
END;
$$;

-- 2. Add project_id column (idempotent).
ALTER TABLE focus_sessions
  ADD COLUMN IF NOT EXISTS project_id uuid;

-- 3. Index on project_id for efficient project-scoped lookups.
CREATE INDEX IF NOT EXISTS idx_focus_sessions_project_id
  ON focus_sessions (project_id);
