-- 0412_playbook_on_end_retired
--
-- `subjectProfile.onEnd` is RETIRED (decision 5e377b06, 6 Nov 2026; plan
-- 73fa04b5 D1, 9 Nov): a session's end moves nothing. The close door no longer
-- applies it and the write door refuses it (`ON_END_RETIRED_MESSAGE`,
-- packages/api/src/schemas/playbook-process.ts), so a stored one is dead data
-- that would only make the next full-subject edit of its playbook refused.
--
-- Measured on the founder's pod (9 Nov): 2 active playbooks still declared a
-- move ("Fix a bug" {failed/cancelled: open}, "Build a change" {failed/
-- cancelled: spec}) and 4 an empty `{}`. This strips the key from the live
-- `subject_profile` AND from the market baseline the install recorded
-- (`metadata.marketSource.baseline.subjectProfile`), so the reconcile's
-- three-way merge still sees live == baseline and keeps managing the field.
--
-- Run snapshots (`playbook_runs.definition_snapshot`) are history and stay as
-- they were: nothing reads `onEnd` from them any more.
--
-- Idempotent: each UPDATE only touches rows that still carry the key.

UPDATE "playbooks"
SET "subject_profile" = "subject_profile" - 'onEnd'
WHERE jsonb_typeof("subject_profile") = 'object'
  AND "subject_profile" ? 'onEnd';

UPDATE "playbooks"
SET "metadata" = jsonb_set(
  "metadata",
  '{marketSource,baseline,subjectProfile}',
  ("metadata" #> '{marketSource,baseline,subjectProfile}') - 'onEnd'
)
WHERE jsonb_typeof("metadata" #> '{marketSource,baseline,subjectProfile}') = 'object'
  AND ("metadata" #> '{marketSource,baseline,subjectProfile}') ? 'onEnd';
