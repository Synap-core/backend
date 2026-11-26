-- Migration: 0451_governance_floor_switches.sql
--
-- Two agent floors become pod switches, each ONE row in the ONE governance
-- store, the same shape as `@reversible` (0282) and `@own-organise` (0346b):
-- principal 'any', scope 'pod', target 'action', and the class pattern.
--
--   '@agent-defines-kinds'    rung 2.08: an agent defining a kind or role;
--   '@agent-builds-structure' the create / activate half of rung 2.09: an
--                             agent creating a playbook, an automation or a
--                             workspace, or activating an automation (also
--                             the status an agent's automation is born with).
--
-- Seeded 'propose', which is OFF: the floor holds exactly as before. A pod
-- admin switches one on from Settings › Approvals (an active 'auto' row);
-- the floor then yields to the other approval rules, and the row itself never
-- makes a write 'auto' (its pattern matches no write). A revoked, missing or
-- 'propose' row keeps the floor. FLOOR_CLASS_PATTERNS in
-- @synap/governance-policy.
--
-- And two pod number settings the governance reads, one `config_settings`
-- row each (scope 'default', no workspace, value {"value": n};
-- POD_NUMBER_SETTINGS in @synap/database), seeded at today's values:
--
--   governance.own_work_fresh_hours  24  how long an agent's own work stays
--                                         fresh for '@own-organise';
--   governance.project_evidence_min   5  the evidence an agent's project names
--                                         before it is no longer MARKED for
--                                         the reviewer (never a refusal).
--
-- Each row is seeded ONCE: only when no row of its kind has ever existed, so
-- a pod whose admin changed it is never reset. No new column.

INSERT INTO governance_rules (
  principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by
)
SELECT 'any', 'pod', 'action', p.pattern, 'propose', 'system:floor-switch-default'
FROM (VALUES ('@agent-defines-kinds'), ('@agent-builds-structure')) AS p(pattern)
WHERE NOT EXISTS (
  SELECT 1 FROM governance_rules g
  WHERE g.principal_kind = 'any'
    AND g.scope_kind = 'pod'
    AND g.target_kind = 'action'
    AND g.target_pattern = p.pattern
);

INSERT INTO config_settings (scope_kind, key, value, workspace_id, source, created_by)
SELECT 'default', s.key, s.value::jsonb, NULL, 'user', 'system:pod-setting-default'
FROM (VALUES
  ('governance.own_work_fresh_hours', '{"value": 24}'),
  ('governance.project_evidence_min', '{"value": 5}')
) AS s(key, value)
WHERE NOT EXISTS (
  SELECT 1 FROM config_settings c
  WHERE c.key = s.key
    AND c.scope_kind = 'default'
    AND c.workspace_id IS NULL
);
