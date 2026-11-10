-- 0417_playbook_runs_generation
--
-- A ONE-SHOT playbook run's record (plan 08e4fba7 slice 1, founder 9 Nov 2026:
-- "a one-shot run still writes a playbook_runs row: cost, model, prompt text").
-- A playbook with `executor = 'generate'` runs as ONE `ai.generate` call and
-- files its result as a proposal on its subject, with no focus session (the
-- run row's `session_id` stays NULL). The session's turn ledger
-- (`metadata.runTurns`) therefore has nowhere to live, so the run row carries
-- it here:
--
--   `generation` jsonb (`PlaybookRunGeneration`, @synap/database schema
--   playbook-runs.ts): the subject, what the prompt was made of (each context
--   read and its size), the prompt text itself, the model and tokens the IS
--   reported (NULL when it did not: never a fabricated 0), the finish reason,
--   and the proposal the result was filed as.
--
-- NULL on every other run. No backfill: no run before 0417 was a generate run.
-- `executor` is a text column with no CHECK constraint, so the new executor
-- value needs no DDL.
--
-- Fresh installs also get this from 0000_baseline_schema.sql. This file is for
-- pods that already booted. Re-runnable: IF NOT EXISTS.

ALTER TABLE "playbook_runs" ADD COLUMN IF NOT EXISTS "generation" jsonb;

-- The subject a one-shot run worked on lives in `generation` (there is no
-- session to carry it): the idempotency and cooldown checks look a run up by
-- (playbook, subject).
CREATE INDEX IF NOT EXISTS "idx_playbook_runs_generation_subject"
  ON "playbook_runs" ("playbook_id", (("generation"->>'subjectId')))
  WHERE "generation" IS NOT NULL;
