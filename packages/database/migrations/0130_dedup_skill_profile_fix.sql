-- 0130_dedup_skill_profile_fix.sql
-- Follow-up to 0128_dedup_skill_profile.sql, which was a no-op: it guarded on
-- `scope = 'system'`, but the dead `skill` ENTITY profile is actually
-- `scope = 'workspace'` (e.g. in the Builder workspace) — so it was never
-- deactivated. Skill is CONFIG (the `skills` table), not an entity profile;
-- the entity profile is a leftover duplicate with 0 entities.
--
-- Deactivate any active `skill` entity profile regardless of scope. Defensive +
-- idempotent. The seed no longer creates a `skill` profile (removed in the dedup),
-- so this won't fight a re-seed (the engineering_knowledge lesson).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM profiles WHERE slug = 'skill' AND is_active = true) THEN
    UPDATE profiles SET is_active = false WHERE slug = 'skill' AND is_active = true;
  END IF;
END $$;
