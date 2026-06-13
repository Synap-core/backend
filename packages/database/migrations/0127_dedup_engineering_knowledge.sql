-- 0127_dedup_engineering_knowledge.sql
--
-- `engineering_knowledge` is a backward-compat ALIAS of `knowledge`: same ek_*
-- property shape, same workspace scope, same displayName ("Knowledge"). The CLI
-- now writes `knowledge` (and routes `--type decision` to `decision`), so the
-- alias only holds legacy rows. This migration removes the remnant:
--   1. re-point every entity on an `engineering_knowledge` profile to the
--      canonical `knowledge` profile in the SAME workspace (and fix the legacy
--      `type` text column to match), and
--   2. deactivate the alias profile — but ONLY where a `knowledge` profile exists
--      in that workspace to absorb the rows (never orphan entities onto a hidden
--      profile).
--
-- Defensive + idempotent: a no-op once the alias has no active rows / no matching
-- `knowledge` profile. Runs inside the migration runner's transaction.

-- The target `knowledge` profile is matched by BOTH workspace_id AND scope (and
-- must be active). Matching scope too is the guard against a cross-scope/
-- cross-workspace re-home: on pods where the shared profiles carry workspace_id
-- = NULL, a NULL/NULL workspace match alone could pair a system
-- `engineering_knowledge` with a user-scoped `knowledge` (also NULL workspace) and
-- silently move entities across the scope boundary. Requiring k.scope = ek.scope
-- keeps each alias paired only with its same-scope canonical sibling.

DO $$
BEGIN
  -- 1. Re-point ALL entities (incl. soft-deleted, so none are left on the alias):
  --    engineering_knowledge -> the same-scope, same-workspace, active `knowledge`.
  UPDATE entities e
  SET profile_id = k.id,
      type = 'knowledge'
  FROM profiles ek
  JOIN profiles k
    ON k.slug = 'knowledge'
   AND k.scope = ek.scope
   AND k.is_active = true
   AND k.workspace_id IS NOT DISTINCT FROM ek.workspace_id
  WHERE ek.slug = 'engineering_knowledge'
    AND e.profile_id = ek.id;

  -- 2. Deactivate the alias, but only where a same-scope/workspace `knowledge`
  --    profile exists to absorb the rows (never orphan onto a hidden profile).
  UPDATE profiles ek
  SET is_active = false
  WHERE ek.slug = 'engineering_knowledge'
    AND ek.is_active = true
    AND EXISTS (
      SELECT 1 FROM profiles k
      WHERE k.slug = 'knowledge'
        AND k.scope = ek.scope
        AND k.is_active = true
        AND k.workspace_id IS NOT DISTINCT FROM ek.workspace_id
    );
END $$;
