-- 0315: a run dispatched to an EXTERNAL agent records its external reference.
--
-- `playbook_runs.external_agent` = { agentUserId, toolId, provider, externalId,
-- url, status, lastState?, polledAt? } — written by the external-agent executor
-- when the binding's `start` verb accepts the task (services/agent-dispatch),
-- and advanced by the status poll (the `status` verb, normalized to
-- running | needs_input | done | failed). NULL for every run that was not
-- dispatched to an external agent. Synap never spawns an agent itself; this is
-- only the receipt of the hand-off.
--
-- Nullable, no default. The partial index serves the poll's "active dispatched
-- runs" scan. Idempotent.

ALTER TABLE "playbook_runs" ADD COLUMN IF NOT EXISTS "external_agent" jsonb;
CREATE INDEX IF NOT EXISTS "idx_playbook_runs_external_agent_active"
  ON "playbook_runs" ((("external_agent"->>'status')))
  WHERE "external_agent" IS NOT NULL;
