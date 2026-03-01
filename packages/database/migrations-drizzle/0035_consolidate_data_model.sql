-- Migration 0035: Consolidate data model
--
-- Three targeted cleanups:
--   1. Drop documents.entity_id — the backlink was only needed for a reverse lookup
--      that is already served by entities.documentId (FK on the entities table).
--   2. Add profiles.default_values JSONB — enables per-profile default property values
--      applied at entity create time, replacing scattered caller-side defaults.
--
-- Canvas-only documentId for views is enforced at the application layer (router),
-- so no schema change is needed there.

-- 1. Drop the documents.entity_id backlink column
--    (entities.documentId already provides the reverse lookup direction we need)
ALTER TABLE documents DROP COLUMN IF EXISTS entity_id;

-- 2. Add default_values to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS default_values jsonb NOT NULL DEFAULT '{}';
