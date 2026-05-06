-- Migration 0021: Add linked_user_id to api_keys
--
-- When an agent API key is provisioned via POST /setup/agent, the backend
-- auto-resolves the pod owner (first human user) and stores their id here.
-- The Hub Protocol auth middleware reads this column and sets it as the
-- `linkedUserId` context variable, which the memory router uses to
-- dual-write facts to both the agent's timeline and the pod owner's.
--
-- NULL = no identity link (standalone agent, pod-wide service key, etc.)

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "linked_user_id" text;
