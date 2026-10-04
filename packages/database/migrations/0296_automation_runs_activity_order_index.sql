-- 0296 — the activity ledger's automation-run source gets the index 0288 gave
-- every other source.
--
-- `activity.list` and `activity.daily` read automation runs at
-- `at = coalesce(completed_at, started_at)` (services/activity/list-activity.ts,
-- `readAutomationRuns`): a `[since, until)` window on that expression, ordered
-- `(at DESC, id DESC)` past a row-value cursor. `automation_runs_started_at_idx`
-- cannot serve an expression, so both reads seq-scanned the table — the
-- fastest-growing one on a cron-heavy pod, with no retention.
--
-- MEASURED on PGlite (2026-10-04), 300k runs over 3 years, the real
-- `activity.daily` query captured from the router:
--   before: Seq Scan on automation_runs — 182 days 80.3 ms, 30 days 31.5 ms
--           (254,588 / 292,588 rows removed by filter)
--   after : Bitmap Index Scan on this index — 182 days 50.9 ms, 30 days 8.3 ms
--
-- Same shape as 0288's playbook_runs index. Additive + idempotent; not declared
-- in the drizzle schema, so schema coherence neither requires nor rejects it.

CREATE INDEX IF NOT EXISTS "idx_automation_runs_activity_at_id"
  ON "automation_runs" ((coalesce("completed_at", "started_at")) DESC, "id" DESC);
