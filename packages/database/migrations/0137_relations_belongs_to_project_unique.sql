-- ── Relations — belongs_to_project idempotency (project-centric-scope) ───────
--
-- The project lens reads `relations` rows of type 'belongs_to_project'. The
-- canonical writer (linkEntityToProject) uses ON CONFLICT DO NOTHING so a
-- pg-boss retry is a no-op — but `relations` had NO unique index on the edge,
-- so the conflict had no target and retries could duplicate the membership row.
--
-- 1. Dedupe any pre-existing duplicate belongs_to_project edges (keep one row per
--    source/target pair) so the unique index can be created.
-- 2. Add a partial unique index on (source_entity_id, target_entity_id) for
--    type='belongs_to_project' entity→entity edges — the conflict target.
--
-- Defensive / idempotent on re-run.

-- 1. Dedupe (NULL-safe: both endpoints are NOT NULL for these edges).
DELETE FROM relations a
USING relations b
WHERE a.ctid < b.ctid
  AND a.type = 'belongs_to_project'
  AND b.type = 'belongs_to_project'
  AND a.source_entity_id = b.source_entity_id
  AND a.target_entity_id = b.target_entity_id;

-- 2. Partial unique index = the ON CONFLICT target for linkEntityToProject.
CREATE UNIQUE INDEX IF NOT EXISTS relations_belongs_to_project_unique
  ON relations (source_entity_id, target_entity_id)
  WHERE type = 'belongs_to_project'
    AND source_entity_id IS NOT NULL
    AND target_entity_id IS NOT NULL;
