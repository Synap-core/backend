-- Migration: 0346b_governance_own_organise_default.sql
--
-- FB1020 B3 (founder 2026-10-21, decision a: ON for every pod, switchable in
-- Settings › Approvals). An agent's ORGANISATIONAL moves on its OWN FRESH
-- records — filing them into a project the person named, filing its own
-- session there, closing its own task — act directly, each with a receipt and
-- Undo, instead of one approval card each.
--
-- The setting is ONE row in the ONE governance store, the same shape as the
-- `@reversible` default (0282): principal 'any', scope 'pod', target
-- 'action', pattern '@own-organise' (OWN_ORGANISE_CLASS_PATTERN in
-- @synap/governance-policy), verdict 'auto', resolved at rung 2.8 below every
-- floor. The row covers a write ONLY when its door proved the subjects are the
-- same key's work from the last 24 hours, untouched by a person
-- (`isOwnFreshWork`, @synap/database); every other write is unaffected.
--
-- Seeded ONCE: only when no '@own-organise' pod row has ever existed. A pod
-- whose owner switched it off keeps a revoked row, so re-running never
-- re-enables it. Existing pending proposals are untouched. No new column.

INSERT INTO governance_rules (
  principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by
)
SELECT 'any', 'pod', 'action', '@own-organise', 'auto', 'system:own-organise-default'
WHERE NOT EXISTS (
  SELECT 1 FROM governance_rules
  WHERE principal_kind = 'any'
    AND scope_kind = 'pod'
    AND target_kind = 'action'
    AND target_pattern = '@own-organise'
);
