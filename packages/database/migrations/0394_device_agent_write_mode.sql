-- 0394: how the agents of a computer being connected act (agent posture lane,
-- founder 2026-11-02: "we don't have any ways of choosing the type of
-- permissions we give").
--
-- The device approval (pod-admin `/device`) now asks how the approved agents'
-- writes land, from the ONE list `AGENT_WRITE_MODE_CHOICES`
-- (@synap-core/types/agents): 'pod-default' (normal: reversible writes act
-- with Undo), 'create-with-undo', 'ask-first'. Like `machine_name` and
-- `computer_belongs_to`, the request carries the choice until the terminal
-- collects the keys; collection applies it to each agent BEFORE its key exists.
--
-- NULL = no choice sent (an older surface): a new agent starts ask-first, as
-- before. No backfill: a decided request is never re-read for its posture.
--
-- Fresh installs get the column from 0000_baseline_schema.sql.

ALTER TABLE "device_auth_requests"
  ADD COLUMN IF NOT EXISTS "agent_write_mode" text;

DO $$ BEGIN
  ALTER TABLE "device_auth_requests"
    ADD CONSTRAINT "device_auth_requests_agent_write_mode_check"
    CHECK ("agent_write_mode" IS NULL
      OR "agent_write_mode" IN ('pod-default', 'create-with-undo', 'ask-first'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
