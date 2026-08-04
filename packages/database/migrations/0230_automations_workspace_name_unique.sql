-- Migration: 0230_automations_workspace_name_unique.sql
--
-- Automation name-identity (mirrors 0227 playbooks / 0208 proposals / 0216
-- knowledge_facts).
--
-- MCP `synap_create_automation` (and the tRPC automations.create door it funnels
-- through) had NO name identity: re-authoring the same automation — the common
-- case for a capability that seeds "Enrich the lead" on every reconcile, or an
-- agent re-running create — inserted a SECOND row every time. Confirmed live:
-- `Stellar Grant` materialized ×4. `.onConflictDoNothing({target: automations.id})`
-- only deduped on the primary key, never on the logical (workspace, name) identity.
--
-- This adds a partial unique index so a second non-archived automation with the
-- same case-insensitive name in the same workspace (NULL workspace = pod-wide)
-- is a DB-level impossibility: the losing INSERT hits SQLSTATE 23505 and
-- insertAutomationAfterGovernance recovers the winner (return existing).
--
-- NULL workspace_id is coalesced to a sentinel UUID (same pattern as
-- playbooks_workspace_name_active_uq / automation_claims) so pod-wide rows
-- participate in uniqueness — plain UNIQUE(workspace_id, name) treats NULLs as
-- distinct and would let pod-wide clones through.
--
-- Pre-existing active duplicates: NOT deleted. Extras are soft-archived
-- (status = 'archived') so the unique index can build. KEEP RULE: keep the
-- MOST-RECENTLY-UPDATED row per (workspace|pod-wide, lower(name)); archive the
-- rest. (Playbooks keep OLDEST; automations keep newest because a re-authored
-- automation converges on its latest flow definition — the surviving row should
-- be the freshest one.) The 23505 recovery in the app orders by updated_at DESC
-- to agree with this rule. Residual archived clone rows remain in the DB for ops
-- inspection; optional hard cleanup is a separate ops step, not this migration.
--
-- 'archived' is a new terminal value for automations.status (a plain text column,
-- no DB CHECK constraint) and is excluded from the partial index (WHERE status
-- <> 'archived'), so archive → recreate-with-same-name still works. Scheduling
-- and matching filter status = 'active', so archived rows never fire.
--
-- Additive + soft-archive only. Also mirrored into 0000_baseline_schema.sql +
-- packages/database/src/schema/automations.ts.

-- ── Soft-archive pre-existing non-archived name clones (keep most-recent) ─────
-- Residual archived rows stay; no DELETE.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(name)
      ORDER BY updated_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM automations
  WHERE status <> 'archived'
)
UPDATE automations a
SET status = 'archived',
    updated_at = now()
FROM ranked
WHERE a.id = ranked.id
  AND ranked.rn > 1;

-- ── Race-safe uniqueness among non-archived automations ──────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "automations_workspace_name_active_uq"
  ON "automations" (
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  WHERE status <> 'archived';
