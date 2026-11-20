-- 0439 — backfill the `project --uses--> workspace` edge of every project's HOME.
--
-- WHY THIS EXISTS (ticket d6636ed2)
-- A project's home is a pillar: the `uses` index edge lists the spaces an
-- engagement runs through, and the pillar reads (`projects.list`, pillar
-- health, the spaces a project-only session counts in) read that edge. But
-- `createProjectGoverned` set the home to `homeWorkspaceId ?? workspaceId` and
-- stamped the edge only when `homeWorkspaceId` was named, so every project
-- created with a plain `workspaceId` (the tRPC door's ambient space, Hub REST
-- `POST /projects`, MCP `create_project`, a pack install) had a home that was
-- not one of its pillars. The door now stamps the EFFECTIVE home; this moves
-- the data for the projects made before.
--
-- SAFETY
--   • Data-only. No schema change, so no `0000_baseline_schema.sql` and no
--     `schema-coherence.ts` edit (this file adds no column).
--   • Idempotent via the `idx_links_unique_edge` unique index (spelled as its
--     column list: it is an index, not a named constraint). Re-running inserts
--     nothing; a project whose home edge already exists is skipped.
--   • Additive only: no UPDATE, no DELETE.
--   • Column-for-column what `linkProjectToWorkspace` writes through
--     `createLink`: `workspace_id` = the space, `metadata` '{}' (no purpose),
--     `created_by` NULL.
--   • Never an edge to a space that no longer exists (the door refuses
--     `workspace_not_found` the same way).

INSERT INTO links (workspace_id, from_type, from_id, to_type, to_id, link_type, metadata)
SELECT
    p.workspace_id,
    'project',
    p.id::text,
    'workspace',
    p.workspace_id::text,
    'uses',
    '{}'::jsonb
FROM projects p
WHERE p.workspace_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = p.workspace_id)
ON CONFLICT (from_type, from_id, to_type, to_id, link_type) DO NOTHING;
