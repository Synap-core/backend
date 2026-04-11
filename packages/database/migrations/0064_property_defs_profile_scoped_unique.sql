-- Replace the legacy GLOBAL unique index on property_defs.slug (added in
-- migration 0003 when the table was unscoped) with PROFILE-SCOPED partial
-- unique indexes that match the current code path.
--
-- Why: `PropertyDefRepository.create()` sets `profileId` on every property
-- def created from a workspace template. The schema was always intended to
-- scope uniqueness by `(slug, profile_id)`, but the old global unique was
-- never dropped. That makes it impossible for two profiles in the same pod
-- to share a common property slug (e.g. `format`, `status`, `content`),
-- which blocks templates that define the same field across multiple profiles
-- and blocks users from creating multiple spaces with similar schemas.
--
-- After this migration:
--   - Global/system defs (profile_id IS NULL) still have unique slugs.
--   - Profile-scoped defs can share a slug across different profiles,
--     but each profile can only have one def with a given slug.
--
-- Safe to re-run: uses IF EXISTS / IF NOT EXISTS throughout.

-- 0. Ensure `profile_id` exists on `property_defs`.
--
-- The column is declared in the Drizzle schema and every repository call
-- sets it, but on pods that missed an earlier drizzle-kit push (the column
-- was never added by a numbered .sql migration in this repo) the table
-- can still be living with the original 0003 shape. Add it defensively
-- before any statement below references it in a WHERE clause. ON DELETE
-- CASCADE matches the TypeScript declaration exactly.
ALTER TABLE "property_defs"
  ADD COLUMN IF NOT EXISTS "profile_id" uuid
    REFERENCES "profiles"("id") ON DELETE CASCADE;

-- Index that the Drizzle schema declares via `profileIdIdx`. Also safe to
-- create here in case the push never ran.
CREATE INDEX IF NOT EXISTS "property_defs_profile_id_idx"
  ON "property_defs" ("profile_id");

-- 1. Drop the legacy global unique constraint/index.
ALTER TABLE "property_defs"
  DROP CONSTRAINT IF EXISTS "property_defs_slug_unique_idx";

-- Some older pods may have created a plain unique index instead of a named
-- constraint. Drop either form defensively.
DROP INDEX IF EXISTS "property_defs_slug_unique_idx";
DROP INDEX IF EXISTS "property_defs_slug_key";

-- 2. Partial unique index for global defs (profile_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "property_defs_global_slug_uniq"
  ON "property_defs" ("slug")
  WHERE "profile_id" IS NULL;

-- 3. Partial unique index for profile-scoped defs.
CREATE UNIQUE INDEX IF NOT EXISTS "property_defs_profile_slug_uniq"
  ON "property_defs" ("slug", "profile_id")
  WHERE "profile_id" IS NOT NULL;
