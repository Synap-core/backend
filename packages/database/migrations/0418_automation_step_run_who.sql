-- 0418_automation_step_run_who
--
-- WHO did an automation step (runner engine slice 5; spec document 7111934d
-- §5): the agent a `playbook_run` step handed its run to, that agent's
-- computer (its `host_user_id` at the hand-off), and the session of the run
-- the step started (what an awaiting step waits on, and how the run's close
-- finds it, `automation-parent-settle.ts`). NULL agent = the pod did it.
--
-- No foreign keys, like `session_stage_runs`: a user or session that goes
-- keeps the step's history readable. No backfill: earlier steps say nothing.
--
-- Fresh installs also get this from 0000_baseline_schema.sql. Re-runnable.

ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "computer_user_id" text;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "child_session_id" uuid;

-- The close of a run a step awaits finds that step by its session.
CREATE INDEX IF NOT EXISTS "automation_step_runs_child_session_idx"
  ON "automation_step_runs" ("child_session_id")
  WHERE "child_session_id" IS NOT NULL;
