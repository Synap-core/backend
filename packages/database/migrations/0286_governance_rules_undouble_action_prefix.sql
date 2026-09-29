-- Migration: 0286_governance_rules_undouble_action_prefix.sql
--
-- The lane scanner (packages/jobs/src/workers/governance-lane-scanner.ts,
-- `computeDominantMotif`) built its motif as `${targetType}.${proposalType}`.
-- Auto-approved receipts store a DOTTED proposalType (`entity.create`), so it
-- minted `entity.entity.create` — and every `governance.widen_lane` approval
-- turned that into an `action` rule no write key can ever match. Dead rules:
-- the agent was told it earned a lane and never got it. Fixed at the scanner
-- (edec5fa4); this repairs what it already wrote.
--
-- For each ACTION rule whose pattern starts with a doubled segment
-- (`^(\w+)\.\1\.`), the corrected pattern is that segment once (`\1.`):
--   1. a corrected TWIN already exists (same principal, agent, scope,
--      workspace, target kind/profile, verdict — any revoked state): DELETE
--      the dead row. Rewriting it would make a duplicate, and if the twin was
--      revoked, reviving the dead one would undo the person's revoke.
--   2. several dead rows collapse to the same corrected rule: keep ONE (an
--      active row first, then the oldest), delete the rest.
--   3. otherwise: rewrite the pattern in place (keeps id + source_proposal_id
--      lineage).
-- Also repairs PENDING `governance.widen_lane` proposals still carrying a
-- doubled `targetPattern`, so approving one after deploy mints a live rule.
--
-- Idempotent: after one run no action pattern matches `^(\w+)\.\1\.`, so a
-- re-run selects nothing. No new column (no baseline / schema-coherence
-- change).

-- 1. Dead rows whose corrected twin already exists.
DELETE FROM governance_rules d
WHERE d.target_kind = 'action'
  AND d.target_pattern ~ '^(\w+)\.\1\.'
  AND EXISTS (
    SELECT 1 FROM governance_rules t
    WHERE t.id <> d.id
      AND t.target_kind = d.target_kind
      AND t.target_pattern = regexp_replace(d.target_pattern, '^(\w+)\.\1\.', '\1.')
      AND t.principal_kind = d.principal_kind
      AND t.agent_user_id IS NOT DISTINCT FROM d.agent_user_id
      AND t.scope_kind = d.scope_kind
      AND t.workspace_id IS NOT DISTINCT FROM d.workspace_id
      AND t.target_profile IS NOT DISTINCT FROM d.target_profile
      AND t.verdict = d.verdict
  );

-- 2. Several dead rows that collapse to the same corrected rule: keep one.
DELETE FROM governance_rules
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY
          principal_kind,
          agent_user_id,
          scope_kind,
          workspace_id,
          target_kind,
          target_profile,
          verdict,
          regexp_replace(target_pattern, '^(\w+)\.\1\.', '\1.')
        ORDER BY (revoked_at IS NULL) DESC, created_at ASC, id ASC
      ) AS rn
    FROM governance_rules
    WHERE target_kind = 'action'
      AND target_pattern ~ '^(\w+)\.\1\.'
  ) ranked
  WHERE ranked.rn > 1
);

-- 3. Rewrite the survivors in place.
UPDATE governance_rules
SET target_pattern = regexp_replace(target_pattern, '^(\w+)\.\1\.', '\1.')
WHERE target_kind = 'action'
  AND target_pattern ~ '^(\w+)\.\1\.';

-- 4. Pending widen-lane proposals that would mint another dead rule.
UPDATE proposals
SET data = jsonb_set(
  data,
  '{targetPattern}',
  to_jsonb(regexp_replace(data->>'targetPattern', '^(\w+)\.\1\.', '\1.'))
)
WHERE proposal_type = 'governance.widen_lane'
  AND status = 'pending'
  AND data->>'targetKind' = 'action'
  AND data->>'targetPattern' ~ '^(\w+)\.\1\.';
