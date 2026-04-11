-- Drop the old pod-wide unique constraint on profiles.slug left by migration 0052.
-- The correct scope-aware partial indexes were created in 0052; this removes the leftover global one.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_slug_unique_idx;
