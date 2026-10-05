-- 0303: an expression index on focus_sessions(metadata->>'automationRunId').
--
-- "Is there a session for this rule run?" is asked as
--   NOT EXISTS (SELECT 1 FROM focus_sessions fs
--               WHERE fs.metadata->>'automationRunId' = <run id>::text)
-- by the lens page's rule-run Happening read (`signals.ts` readRuleRuns — on
-- EVERY Home read), by the run ledger (`recent-by-flows.ts`) and by the run
-- reaper (`automation-run-reaper.ts`). With no index on the expression, each of
-- those anti-joins scans focus_sessions in full.
--
-- PARTIAL on `IS NOT NULL`: only sessions a run opened carry the key (a small
-- slice of the table), and `=` is a strict operator, so the planner proves the
-- equality implies the predicate — every one of the three shapes can use it.
-- Idempotent.

CREATE INDEX IF NOT EXISTS idx_focus_sessions_automation_run_id
  ON focus_sessions ((metadata->>'automationRunId'))
  WHERE (metadata->>'automationRunId') IS NOT NULL;
