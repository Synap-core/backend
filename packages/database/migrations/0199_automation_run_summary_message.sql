-- 0199 — Run narration V1 (Wave 3.N1)
--
-- One run-summary message per terminal automation run, exactly once. The column
-- doubles as the idempotency claim slot: `postRunSummary` claims it with
--   UPDATE automation_runs SET summary_message_id = $mid
--   WHERE id = $runId AND summary_message_id IS NULL RETURNING id
-- and posts ONLY when the claim wins, so the executor's finalizer and the run
-- reaper can never both narrate the same run. Soft reference to messages.id
-- (no FK — messages live on a chained/tamper-evident table and a run summary
-- must never block on message-row lifecycle).

ALTER TABLE "automation_runs"
  ADD COLUMN IF NOT EXISTS "summary_message_id" uuid;
