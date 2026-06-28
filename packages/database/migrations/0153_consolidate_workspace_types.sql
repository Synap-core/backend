-- Migration: 0153_consolidate_workspace_types.sql
--
-- Consolidates the workspace type system:
--   1. Drop the dead `workspaces.type` column (legacy personal|team|enterprise, zero consumers)
--   2. Remove `workspacePurpose` from settings JSONB (redundant with workspace_type, fixed enums are bad engineering)
--   3. Promote `workspace_purpose` column from workspace_type (single canonical field)

-- ── 1. Drop dead legacy column ───────────────────────────────────────────────
ALTER TABLE workspaces DROP COLUMN IF EXISTS type;

-- ── 2. Remove workspacePurpose from settings JSONB ────────────────────────────
-- workspace_type is the single canonical semantic type.
-- workspacePurpose was a JSONB-only field with a fixed enum that overlapped
-- workspace_type on 4 of 5 values and added "library" — redundant.
UPDATE workspaces SET settings = settings - 'workspacePurpose' WHERE settings ? 'workspacePurpose';

-- ── 3. Promote workspace_purpose column (derived from workspace_type) ─────────
-- For backward compat with code that reads settings.workspacePurpose during
-- the transition, copy workspace_type → workspace_purpose column.
-- After this migration, workspace_type is THE canonical field.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS workspace_purpose text;
UPDATE workspaces SET workspace_purpose = workspace_type
  WHERE workspace_purpose IS NULL AND workspace_type IS NOT NULL;

-- ── 4. Drop workspaceSubtype from settings (also a fixed enum concept) ────────
-- workspaceSubtype was a free-form string inside settings — keep as column-backed
-- for queryability. Not dropped, just noted: the field stays free-form, no enum.
