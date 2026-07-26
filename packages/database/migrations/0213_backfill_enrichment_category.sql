-- Backfill the `enrichment` category onto enrichment verbs that were installed
-- BEFORE the capability templates carried a top-level `category` tag.
--
-- The CRM "Enrich" picker (useEnrichVerbs) surfaces catalog verbs filtered by
-- `category = 'enrichment'`. A verb whose backing skill was installed before the
-- template gained the tag has `skills.category = NULL`, so it is invisible to the
-- picker even when installed, connected, and runnable — the "no provider" symptom
-- despite a connected Apollo/Apify. New installs get the tag from the template
-- def (create-from-definition threads `category: s.category`); reconcile updates
-- it on re-apply. This one-shot UPDATE repairs the rows that predate the tag so
-- the fix does not depend on a reconcile happening to run.
--
-- Idempotent: only untagged rows for the known enrichment verb names transition;
-- re-running is a no-op. Data-only (no schema change) → no baseline / coherence edit.

UPDATE skills
SET category = 'enrichment'
WHERE name IN (
  'apollo_enrich_person',
  'apollo_enrich_company',
  'apify_linkedin_profile'
)
AND (category IS NULL OR category = '');
