-- 0256 — record WHICH event fired the rule that opened this run.
--
-- `automation_runs` already answers "what fired me, roughly": `triggered_by`
-- (a userId or the literal "system") and `trigger_payload` (the matcher's
-- reconstructed envelope). Neither is a POINTER. The `events` row that actually
-- matched — the immutable audit record with its own actor, proposal_id,
-- session_id and timestamp — is not referenced from the run at all, so
-- "why did this session exist" dead-ends at a JSONB blob that was rebuilt for
-- the matcher rather than at the fact that caused it.
--
-- `events.session_id` (0241) is the same question from the other side and is
-- already indexed. The two together close the loop: event → run → session, and
-- session → event.
--
-- NULLABLE and NO FOREIGN KEY, both deliberately:
--   • nullable — a cron, manual or webhook run has no triggering event row, and
--     every run that already exists predates this column. NULL means "no event
--     row is claimed", never "the event was lost".
--   • no FK — same reasoning as the sibling `subject_entity_id` column, which
--     also carries none: `events` is an append-only audit spine subject to
--     retention pruning, and a run's provenance must not be what blocks a
--     prune, nor should a pruned event silently rewrite a run row.
ALTER TABLE "automation_runs"
  ADD COLUMN IF NOT EXISTS "trigger_event_id" uuid;

-- Partial (NOT NULL) — most runs carry no triggering event, so only the rows
-- that answer "which runs did this event fire" are indexed. Mirrors the shape
-- of `idx_events_session_id`, the reverse edge of the same question.
CREATE INDEX IF NOT EXISTS "idx_automation_runs_trigger_event_id"
  ON "automation_runs" ("trigger_event_id")
  WHERE "trigger_event_id" IS NOT NULL;
