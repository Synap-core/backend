-- 0371 — automations.run_count backfill (tickets 85133a81, founder-approved,
-- wave session 6f8484c4)
--
-- Commit 90974df3f made the automation executor the only writer of
-- `automations.run_count`: it increments run_count together with exactly one
-- of success_count / failure_count, and a skipped run counts for neither.
-- Before that, two writers each bumped run_count per run, so every pod's
-- history reads run_count ≈ 2 × (success_count + failure_count).
--
-- One-off data fix: set run_count to the sum of the two outcome counters.
-- Idempotent: once a row agrees, the WHERE no longer matches it, and the
-- executor keeps it in agreement from then on. Schema is untouched.

UPDATE "automations"
SET "run_count" = COALESCE("success_count", 0) + COALESCE("failure_count", 0)
WHERE COALESCE("run_count", 0) <> COALESCE("success_count", 0) + COALESCE("failure_count", 0);
