-- Migration: 0135_project_entities_pod_wide.sql
--
-- Project entities become POD-WIDE (entityScope='pod'). The `project` profile is
-- flipped to entityScope='pod' (seed-profiles.ts + ensure-system-profiles
-- POD_WIDE_SLUGS); this migration brings EXISTING project rows in line by nulling
-- their workspace_id so they are visible across every workspace (the project is
-- the cross-cutting container, not a workspace child).
--
-- Idempotent: re-running is a no-op once the rows are already NULL.
-- belongs_to_project relations are entity→entity (not entity→workspace), so they
-- are unaffected.
--
-- Design doc: synap-app/synap-team-docs/content/team/platform/project-centric-scope.mdx
-- Phase: project-centric-scope Phase 1

UPDATE entities
SET workspace_id = NULL
WHERE type = 'project'
  AND workspace_id IS NOT NULL;
