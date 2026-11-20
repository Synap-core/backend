-- 0446 — a run says what was observed.
--
-- `playbook_runs.holder` / `session_stage_runs.holder`: who the run or step
-- is handed to ({kind: synap_ai|agent|person|machine|none, id, assignedAt,
-- claimedAt}). A run is born `queued`; it is `running` only once its holder
-- claimed it (`claimedAt`), and the run reaper marks one nobody claimed
-- inside its window `blocked`. NULL on rows before 0446.
--
-- `playbook_runs.agent_user_id`: the agent that started the run (the actor);
-- `created_by` is the person it is for (`ownerAndActor`). Nullable: a
-- person's own run has no agent. No backfill: earlier rows keep the agent in
-- `created_by`, which every reader already maps to its person.
--
-- The status default follows the birth: `queued`. `status` is text with no
-- CHECK, so `queued` and `blocked` need no constraint change.
--
-- Fresh installs also get this from 0000_baseline_schema.sql. Re-runnable.

ALTER TABLE "playbook_runs" ADD COLUMN IF NOT EXISTS "holder" jsonb;
ALTER TABLE "playbook_runs" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "playbook_runs" ALTER COLUMN "status" SET DEFAULT 'queued';
ALTER TABLE "session_stage_runs" ADD COLUMN IF NOT EXISTS "holder" jsonb;
