-- ── Proposals — project lens-context (project-centric-scope) ─────────────────
--
-- A proposal can carry the active project lens (or a surface/cell-renderer
-- override) the same way it carries `workspace_id`. At materialization the
-- worker stamps `entity --belongs_to_project--> project` from this column
-- (falling back to the producing session's project_id when null).
--
-- Nullable: most proposals have no project context. Defensive / idempotent.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS project_id uuid;

CREATE INDEX IF NOT EXISTS proposals_project_id_idx
  ON proposals (project_id);
