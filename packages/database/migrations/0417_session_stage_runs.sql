-- 0417_session_stage_runs
--
-- One row per time a step of a playbook run is ENTERED: who works it, on
-- which computer, whether it waits on tools or a child run, and when it ended
-- (runner engine slice 3; spec document 7111934d §5; decision D4: a row for
-- every stage entry of every run). Written only by the stage runner
-- (`enterStage`, @synap/api services/playbooks/stage-runner.ts).
--
-- Owner-private through the session's owner floor: no workspace column. No
-- foreign keys, like `playbook_runs`: a session or run row that goes keeps
-- its history readable. No backfill: runs started before 0417 have no rows
-- for their past steps, and their next step entry writes the first one.
--
-- Fresh installs also get this from 0000_baseline_schema.sql. Re-runnable.

CREATE TABLE IF NOT EXISTS "session_stage_runs" (
  "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"           uuid        NOT NULL,
  "playbook_run_id"      uuid,
  "stage_key"            text        NOT NULL,
  "attempt"              integer     NOT NULL DEFAULT 1,
  "runner_agent_user_id" text,
  "runner_via"           text        NOT NULL,
  "preset_key"           text,
  "computer_user_id"     text,
  "child_session_id"     uuid,
  "external_agent"       jsonb,
  "status"               text        NOT NULL DEFAULT 'running',
  "requires_report"      jsonb,
  "passed_over"          jsonb,
  "started_at"           timestamptz NOT NULL DEFAULT now(),
  "ended_at"             timestamptz
);
CREATE INDEX IF NOT EXISTS "session_stage_runs_session_stage_idx"
  ON "session_stage_runs" ("session_id", "stage_key");
