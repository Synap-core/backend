-- Phase 2: Workspace-scoped property extensions.
--
-- Layers a third dimension onto property_defs: `workspace_id`.
-- This lets multiple workspaces extend the same pod-wide profile (Person,
-- Task, Note, …) with their own custom properties without colliding and
-- without leaking their extensions into each other's rendering.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │  property_defs.workspace_id                                         │
-- │  ───────────────────────────                                        │
-- │  NULL → the def is "global" for the profile: every workspace        │
-- │         that uses this profile renders it. Base system fields       │
-- │         (name, email) live here.                                    │
-- │  SET  → the def is an overlay owned by that workspace. Only         │
-- │         rendered when the current workspace context matches.        │
-- │         Used when a workspace extends a profile it doesn't own      │
-- │         (e.g. Relay adds `investmentThesis` to pod-wide `person`).  │
-- └─────────────────────────────────────────────────────────────────────┘
--
-- Debug / inspection:
--   -- "Show me every property def attached to `person`, grouped by scope"
--   SELECT pd.slug, pd.workspace_id, w.name AS workspace_name
--   FROM property_defs pd
--   LEFT JOIN workspaces w ON w.id = pd.workspace_id
--   WHERE pd.profile_id = (SELECT id FROM profiles WHERE slug = 'person' LIMIT 1)
--   ORDER BY pd.workspace_id NULLS FIRST, pd.slug;
--
--   -- "What will workspace X see on profile Y?"
--   SELECT pd.slug FROM property_defs pd
--   WHERE pd.profile_id = :profile_id
--     AND (pd.workspace_id IS NULL OR pd.workspace_id = :workspace_id);
--
-- Safe to re-run: uses IF EXISTS / IF NOT EXISTS throughout.

-- 1. Column ------------------------------------------------------------------

ALTER TABLE "property_defs"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid
    REFERENCES "workspaces"("id") ON DELETE CASCADE;

-- 2. Drop 0064's indexes — they don't account for workspace scope ------------

DROP INDEX IF EXISTS "property_defs_global_slug_uniq";
DROP INDEX IF EXISTS "property_defs_profile_slug_uniq";

-- 3. New partial unique indexes — three mutually-exclusive scopes ------------

-- 3a. Global/system defs — no profile, no workspace. Each slug is unique.
--     Example: a top-level `email` def not attached to any profile.
CREATE UNIQUE INDEX IF NOT EXISTS IF NOT EXISTS "property_defs_global_slug_uniq"
  ON "property_defs" ("slug")
  WHERE "profile_id" IS NULL AND "workspace_id" IS NULL;

-- 3b. Profile-base defs — belong to a profile, visible to every workspace.
--     Example: `name`, `email` on the pod-wide `person` profile.
CREATE UNIQUE INDEX IF NOT EXISTS IF NOT EXISTS "property_defs_profile_base_slug_uniq"
  ON "property_defs" ("slug", "profile_id")
  WHERE "profile_id" IS NOT NULL AND "workspace_id" IS NULL;

-- 3c. Workspace overlay defs — workspace adds a field to a profile it doesn't
--     own. Each (slug, profile, workspace) triple is unique.
--     Example: Relay adds `investmentThesis` to pod-wide `person`; another
--     workspace adds its own `notesCount` to the same `person`.
CREATE UNIQUE INDEX IF NOT EXISTS IF NOT EXISTS "property_defs_workspace_overlay_slug_uniq"
  ON "property_defs" ("slug", "profile_id", "workspace_id")
  WHERE "profile_id" IS NOT NULL AND "workspace_id" IS NOT NULL;

-- 4. Lookup index for the hot read path -------------------------------------
--
-- Every entity render does:
--   SELECT * FROM property_defs
--   WHERE profile_id IN (…) AND (workspace_id IS NULL OR workspace_id = :ws)
--
-- This composite index makes that scan cheap for profiles with many defs.
CREATE INDEX IF NOT EXISTS "property_defs_profile_workspace_idx"
  ON "property_defs" ("profile_id", "workspace_id")
  WHERE "profile_id" IS NOT NULL;
