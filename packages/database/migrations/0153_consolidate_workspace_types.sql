-- Migration: 0153_consolidate_workspace_types.sql
--
-- Consolidates the workspace type system to a SINGLE canonical field:
--   1. Drop the dead `workspaces.type` column (legacy personal|team|enterprise, zero consumers)
--   2. Remove `workspacePurpose` from settings JSONB (redundant with workspace_type, fixed enums are bad engineering)
--
-- `workspace_type` (column, added by 0042) is THE canonical semantic type.
-- No backward-compat column is added — workspacePurpose has zero readers left.

-- ── 1. Drop dead legacy column ───────────────────────────────────────────────
ALTER TABLE workspaces DROP COLUMN IF EXISTS type;

-- ── 2. Remove workspacePurpose from settings JSONB ────────────────────────────
-- workspace_type is the single canonical semantic type. workspacePurpose was a
-- JSONB-only field with a fixed enum that overlapped workspace_type on 4 of 5
-- values and added "library" — redundant, removed.
UPDATE workspaces SET settings = settings - 'workspacePurpose' WHERE settings ? 'workspacePurpose';
