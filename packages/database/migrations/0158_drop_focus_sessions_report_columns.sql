-- Drop redundant report columns from focus_sessions.
-- verification_report is kept as the single closing report.
-- The execution_logs TABLE and executionLogRepository are unrelated and untouched.
ALTER TABLE focus_sessions DROP COLUMN IF EXISTS execution_log;
ALTER TABLE focus_sessions DROP COLUMN IF EXISTS context_report;
ALTER TABLE focus_sessions DROP COLUMN IF EXISTS plan_report;
