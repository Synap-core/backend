-- 0220: kinds are POD-WIDE by default
--
-- Doctrine (APP-DOCK-MENTAL-MODEL-PLAN.md §1b, ratified 2026-08-01):
--
--   KIND = POD-WIDE.  The entity's identity — one `person`, one `company`,
--                     shared by the whole pod.
--   ROLE = WORKSPACE-SCOPED. The space that created the role is the space that
--                     sees it. Role instances live in `entity_facets` and carry
--                     their own per-row `workspace_id`.
--
-- `profiles.entity_scope` has defaulted to 'workspace' since 0060. That is the
-- INVERSE of the doctrine: every kind a template or an agent created without an
-- explicit `entityScope` landed workspace-scoped. This flips the floor.
--
-- WHAT THIS COVERS
--   Writers that omit the column entirely: raw SQL, psql, future migrations,
--   and `sync-materializer.ts` (which inserts into `profiles` directly and never
--   sets entity_scope OR profile_kind — so 'kind' + 'pod' is the right landing).
--
-- WHAT THIS DOES **NOT** COVER — read before assuming this migration is the fix
--   1. EXISTING ROWS ARE NOT TOUCHED. A column default applies only to future
--      INSERTs that omit the column. Every profile already in this database
--      keeps whatever entity_scope it has. See "NO BACKFILL" below.
--   2. AN EXPLICIT WRONG VALUE IS STILL ACCEPTED. A writer that passes
--      entity_scope = 'workspace' for a kind still gets 'workspace'. That is
--      deliberate — workspace-scoped kinds are legitimate (Deal, Pipeline, the
--      devplane types seeded by ensureSystemProfiles).
--   3. THE "role ⇒ workspace" HALF IS NOT EXPRESSIBLE HERE. A Postgres column
--      DEFAULT cannot read a sibling column. That rule is enforced at the write
--      door — `resolveEntityScope()` in
--      `packages/database/src/repositories/profile-repository.ts`, which is
--      also the only layer that can tell "caller omitted entity_scope" apart
--      from "caller explicitly chose workspace".
--
-- NO CHECK CONSTRAINT, DELIBERATELY
--   `profile_kind = 'kind' => entity_scope = 'pod'` is NOT a true invariant —
--   see (2) above. A CHECK would refuse rows the product wants and would fail
--   on existing data.
--
-- NO BACKFILL, DELIBERATELY
--   Flipping an existing profile's entity_scope from 'workspace' to 'pod'
--   changes WHICH ENTITIES ARE VISIBLE IN WHICH WORKSPACE for every entity of
--   that type that already exists. That is a data-visibility change, not a
--   schema change, and it is the pod owner's decision — not a silent migration.
--   `ensureSystemProfiles()` already pins the 19 system profiles on every boot
--   (15 pod-wide, 4 workspace-scoped) and is unaffected either way.
--
--   To see what a backfill would touch, run (read-only):
--     SELECT profile_kind, scope, entity_scope, count(*)
--       FROM profiles
--      GROUP BY 1, 2, 3
--      ORDER BY 1, 2, 3;
--     SELECT p.slug, count(e.id) AS entities_affected
--       FROM profiles p
--       LEFT JOIN entities e ON e.profile_id = p.id
--      WHERE p.profile_kind = 'kind' AND p.entity_scope = 'workspace'
--      GROUP BY p.slug
--      ORDER BY 2 DESC;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'profiles'
       AND column_name = 'entity_scope'
  ) THEN
    ALTER TABLE "profiles" ALTER COLUMN "entity_scope" SET DEFAULT 'pod';
  END IF;
END
$$;
