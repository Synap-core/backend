-- 0128_dedup_skill_profile.sql
--
-- A Skill is CONFIG (AI know-how), not entity DATA. Skills live in the `skills` /
-- `agent_skills` config tables and join the graph via `links`, not `entities`.
-- The legacy `skill` ENTITY profile is dead — it has 0 entities — so this dedup
-- is purely a defensive deactivation of any remnant `skill` profile row that may
-- exist on an already-deployed pod. No entity re-pointing is needed (mirrors
-- 0127_dedup_engineering_knowledge, minus the re-home step which is unnecessary
-- here because there is nothing to absorb).
--
-- Deactivating (rather than deleting) keeps the row's history intact and lets the
-- seed's ACTIVE-only existence check treat the slug as free — the seed no longer
-- defines `skill`, so it will never re-create or re-activate it.
--
-- Defensive + idempotent: a no-op once no active `skill` profile exists. Runs
-- inside the migration runner's transaction.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM profiles
    WHERE slug = 'skill' AND scope = 'system' AND is_active = true
  ) THEN
    UPDATE profiles
    SET is_active = false
    WHERE slug = 'skill' AND scope = 'system' AND is_active = true;
  END IF;
END $$;
