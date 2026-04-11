-- 0039_profile_scoped_property_defs.sql
--
-- Makes property definitions profile-scoped so that each profile can define
-- its own `status`, `type`, `owner`, etc. without slug collisions across profiles.
--
-- Before: property_defs had a global unique(slug) constraint, forcing templates to
-- prefix slugs with profile names (company-status, contact-status, deal-type…).
--
-- After: property_defs.profile_id scopes each def to a profile.
-- Unique: (slug, profile_id) per profile — OR just (slug) for global system defs.
--
-- Existing global defs (profile_id IS NULL) are preserved and remain globally unique.

-- 1. Add profile_id column (nullable — null = global/system def)
ALTER TABLE property_defs
  ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE;

-- 2. Drop the old global slug unique constraint
--    It may exist as a CONSTRAINT (created via UNIQUE constraint syntax) or as a plain index.
ALTER TABLE property_defs DROP CONSTRAINT IF EXISTS property_defs_slug_unique_idx;
DROP INDEX IF EXISTS property_defs_slug_unique_idx;

-- 3. Global property defs (profile_id IS NULL): still unique by slug
CREATE UNIQUE INDEX IF NOT EXISTS IF NOT EXISTS property_defs_slug_global_unique_idx
  ON property_defs(slug)
  WHERE profile_id IS NULL;

-- 4. Profile-scoped property defs: unique per (slug, profile_id)
CREATE UNIQUE INDEX IF NOT EXISTS IF NOT EXISTS property_defs_slug_profile_unique_idx
  ON property_defs(slug, profile_id)
  WHERE profile_id IS NOT NULL;

-- 5. Index for efficient "list all properties for profile X" queries
CREATE INDEX IF NOT EXISTS property_defs_profile_id_idx
  ON property_defs(profile_id)
  WHERE profile_id IS NOT NULL;
