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
-- Data-only and additive (no UPDATE, no DELETE); idempotent through the
-- `idx_links_unique_edge` unique index. Writes what `linkProjectToWorkspace`
-- writes (`metadata` '{}', `created_by` NULL), never to a deleted space.

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
