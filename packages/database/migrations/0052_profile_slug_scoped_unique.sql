-- Migration: Replace pod-wide slug uniqueness with scope-aware partial indexes
--
-- Before: unique(slug) globally — prevents two workspaces from defining profiles
--         with the same slug (e.g., both templates using "project" slug).
--
-- After:
--   • system + shared profiles: still globally unique by slug (pod-wide concept)
--   • workspace + user profiles: unique per (slug, workspace_id / user_id)
--     so different workspaces can independently define a "project" profile.

-- 1. Drop old global constraint
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_slug_unique;

-- 2. Unique slug for system and shared scoped profiles (pod-wide)
CREATE UNIQUE INDEX IF NOT EXISTS profiles_global_slug_unique
  ON profiles (slug)
  WHERE scope IN ('system', 'shared');

-- 3. Unique slug per workspace for workspace-scoped profiles
CREATE UNIQUE INDEX IF NOT EXISTS profiles_workspace_slug_unique
  ON profiles (slug, workspace_id)
  WHERE scope = 'workspace';

-- 4. Unique slug per user for user-scoped profiles
CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_slug_unique
  ON profiles (slug, user_id)
  WHERE scope = 'user';
