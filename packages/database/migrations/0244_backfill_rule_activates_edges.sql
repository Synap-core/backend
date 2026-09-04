-- 0244 — backfill the `skill --activates--> automation` membership edges.
--
-- WHY THIS EXISTS
-- The edge shipped with ZERO readers, and `createRuleGoverned` wrote it
-- BEST-EFFORT: a failure logged `"rule created but lineage edges failed (rule
-- kept)"` and kept going. The de-facto membership store was the JSONB copy at
-- `skills.metadata.rule.behaviours[].automationId`.
--
-- That copy has now been retired as a READ source: `services/rules/lineage.ts`
-- resolves a rule's automations from the edge, and `behaviours[]` keeps only
-- the divergence `flowHash`. Switching the reader without moving the DATA would
-- make every pre-existing rule whose edge is missing report ZERO automations —
-- and silently: `detectRuleDivergence` would return a clean bill of health for
-- a rule whose behaviour it never looked at, and `skills.dryRunRule` would omit
-- the real run count. A consolidation moves the data, not just the readers.
--
-- SAFETY
--   • Data-only. No schema change, so no `0000_baseline_schema.sql` and no
--     `schema-coherence.ts` edit is required (this file adds no column).
--   • Idempotent via the existing `idx_links_unique_edge` unique index. Note
--     it is a unique INDEX, not a named constraint, so the conflict target is
--     spelled as its COLUMN LIST — `ON CONFLICT ON CONSTRAINT idx_links_unique_edge`
--     is a runtime error for an index, and was the first version of this file.
--     Re-running inserts nothing. Rules created AFTER the hardening already
--     have their edge and are skipped by the conflict clause.
--   • Additive only: no UPDATE, no DELETE. A rule that is already correct is
--     untouched, and nothing is removed from `behaviours[]` (the flowHash it
--     still owns lives in the same object).
--   • Column-for-column identical to what `linkRuleHalves` writes, including
--     the NULL `created_by` it leaves for a system edge.
--
-- WHAT IT CANNOT DO
-- It can only recover a rule whose JSONB copy survived. A rule that lost BOTH
-- is unrecoverable from inside the database, and is left alone rather than
-- guessed at.

INSERT INTO links (workspace_id, from_type, from_id, to_type, to_id, link_type)
SELECT
    s.workspace_id,
    'skill',
    s.id,
    'automation',
    b.value ->> 'automationId',
    'activates'
FROM skills s
CROSS JOIN LATERAL jsonb_array_elements(s.metadata -> 'rule' -> 'behaviours') AS b(value)
WHERE s.category = 'rule'
  AND jsonb_typeof(s.metadata -> 'rule' -> 'behaviours') = 'array'
  AND b.value ->> 'automationId' IS NOT NULL
  -- Guard the CAST below. `behaviours[]` is untyped JSONB written by
  -- application code; one malformed value would abort the whole migration on
  -- `invalid input syntax for type uuid`, taking pod startup down with it.
  AND b.value ->> 'automationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
  -- Never fabricate an edge to an automation that no longer exists: a dangling
  -- polymorphic edge has no FK to catch it and would read as a live behaviour.
  AND EXISTS (
      SELECT 1 FROM automations a
      WHERE a.id = (b.value ->> 'automationId')::uuid
  )
ON CONFLICT (from_type, from_id, to_type, to_id, link_type) DO NOTHING;
