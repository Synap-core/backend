-- Migration: 0115_focus_sessions_reports.sql
-- Adds report columns to focus_sessions for autonomous workspace sessions.
-- These JSONB columns store structured reports from the session execution:
--   - context_report: Understanding of task/domain/constraints
--   - plan_report: Decomposed plan and approach
--   - execution_log: Step-by-step execution transcript
--   - verification_report: Test results and verification outcomes

ALTER TABLE "focus_sessions"
  ADD COLUMN IF NOT EXISTS "context_report"      jsonb,
  ADD COLUMN IF NOT EXISTS "plan_report"         jsonb,
  ADD COLUMN IF NOT EXISTS "execution_log"       jsonb,
  ADD COLUMN IF NOT EXISTS "verification_report" jsonb;
