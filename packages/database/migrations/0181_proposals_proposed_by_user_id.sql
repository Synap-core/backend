-- 0181_proposals_proposed_by_user_id.sql
-- Records the HUMAN userId that filed a proposal (the "team member proposes →
-- owner approves" loop). Nullable: agent-authored proposals leave this NULL and
-- carry `agent_user_id` instead. Distinct from the overloaded `created_by` so
-- "who proposed this" is unambiguous for the proposer-only `withdraw` gate and
-- the review UI. Idempotent per repo migration rules.

ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "proposed_by_user_id" text;
