-- Migration: 0326_knowledge_form_insight_to_fact.sql
--
-- Knowledge narrowed (2026-10-12, plan 9992207a §5): `knowledgeForm` is now
-- `fact | caution | convention`. The old broad form `insight` means `fact`.
-- The seeder rewrites the def's enum on boot; this rewrites the stored values
-- so existing Knowledge rows validate under the new enum and read the same in
-- every view and filter.
--
-- Data only, no column (JSONB property). Nothing else on the row is touched:
-- the legacy `ek_type` discriminator stays exactly as stored. An old client
-- that still sends `insight` is normalised to `fact` at the write door
-- (`LEGACY_KNOWLEDGE_FORM_ALIASES`, knowledge-contract.ts), so this runs once
-- and a re-run finds nothing to change (idempotent).

UPDATE entities
SET properties = jsonb_set(properties, '{knowledgeForm}', '"fact"'::jsonb),
    updated_at = now()
WHERE type = 'knowledge'
  AND properties ->> 'knowledgeForm' = 'insight';
