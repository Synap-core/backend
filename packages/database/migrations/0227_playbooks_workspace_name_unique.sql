-- Migration: 0227_playbooks_workspace_name_unique.sql
--
-- Playbook create TOCTOU race fix (mirrors 0208 proposals / 0216 knowledge_facts).
--
-- Parallel reconcile / package-apply peeks for an existing playbook by
-- (workspace_id, name), then inserts if none was found, with no DB-level
-- enforcement in between. Concurrent callers both see "no prior" and both
-- insert — confirmed live spam (11× "Qualify a CRM lead").
--
-- This adds a partial unique index so a second non-archived playbook with the
-- same case-insensitive name in the same workspace (NULL workspace = pod-wide)
-- is a DB-level impossibility: the losing concurrent INSERT hits SQLSTATE
-- 23505 and playbooks.create recovers the winner (return existing).
--
-- NULL workspace_id is coalesced to a sentinel UUID (same pattern as
-- automation_claims_workspace_namespace_key_uniq) so pod-wide rows participate
-- in uniqueness — plain UNIQUE(workspace_id, name) would treat NULLs as distinct.
--
-- Pre-existing active duplicates: NOT deleted. Extras are soft-archived
-- (status='archived', keep oldest per key by created_at, id) so the unique
-- index can build. Residual archived clone rows remain in the DB for ops
-- inspection; optional hard cleanup is a separate ops step, not this migration.
--
-- Archived playbooks free the name (partial WHERE status <> 'archived'), so
-- archive → recreate-with-same-name still works. Do not tighten the predicate
-- to status = 'active' only — draft/paused must also be unique among themselves.
--
-- Additive + soft-archive only. Also mirrored into 0000_baseline_schema.sql +
-- packages/database/src/schema/playbooks.ts.

-- ── Soft-archive pre-existing non-archived name clones (keep oldest) ─────────
-- Residual archived rows stay; no DELETE.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(name)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM playbooks
  WHERE status <> 'archived'
)
UPDATE playbooks p
SET status = 'archived',
    updated_at = now()
FROM ranked
WHERE p.id = ranked.id
  AND ranked.rn > 1;

-- ── Race-safe uniqueness among non-archived playbooks ────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "playbooks_workspace_name_active_uq"
  ON "playbooks" (
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  WHERE status <> 'archived';
