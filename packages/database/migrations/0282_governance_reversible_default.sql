-- Migration: 0282_governance_reversible_default.sql
--
-- Founder decision 2026-09-28: by default an agent ACTS DIRECTLY on anything
-- easily reversible (create, update, link, attach, capture…) and only
-- DISRUPTIVE writes become proposals. Pod-level, switchable in
-- Settings › Approvals (`governanceRules.setReversibleDefault`).
--
-- The setting is ONE row in the ONE governance store: principal 'any', scope
-- 'pod', target 'action', pattern '@reversible' (REVERSIBLE_CLASS_PATTERN in
-- @synap/governance-policy — the class of every door REVERSIBILITY_DOOR_CLASS
-- calls reversible), verdict 'auto'. Every floor still outranks it (rung 2.8),
-- and every more specific rule wins over it.
--
-- Seeded ONCE: only when no '@reversible' pod row has ever existed. A pod whose
-- owner switched it off keeps a revoked row, so re-running never re-enables it.
-- Existing pending proposals are untouched. No new column (no baseline /
-- schema-coherence change).

INSERT INTO governance_rules (
  principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by
)
SELECT 'any', 'pod', 'action', '@reversible', 'auto', 'system:reversible-default'
WHERE NOT EXISTS (
  SELECT 1 FROM governance_rules
  WHERE principal_kind = 'any'
    AND scope_kind = 'pod'
    AND target_kind = 'action'
    AND target_pattern = '@reversible'
);
